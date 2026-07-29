// Transcript walk (story-state phase 7, pass "transcript_walk").
//
// One model call per chunk (see transcriptChunker.ts for how chunks are
// planned). The model is given a NUMBERED list of the chunk's real
// (non-system) messages and asked to return scene boundaries and facts
// as LOCAL indices into that list — it never invents an id, a UUID, or a
// msg_id. Everything identity-shaped (scene/fact ids, MsgRefs, swipe
// resolutions, system-message exclusions) is resolved mechanically here
// from the actual message data, matching the plan's "mechanical boundary
// hints" framing.
//
// Kept network-free like coldStart.ts/wiReplay.ts: `processChunk` takes
// an `llm` call and returns data, but never touches storyApi. The store
// owns persistence (bulk scene upsert, fact append, checkpoint save) so
// this module stays unit-testable with a fake LLM.

import type { ProjectChatRef } from '../../api/client';
import { buildMsgRef, chatMessageSourceRef } from '../storyBible/sourceRefs';
import type {
  BibleFact,
  Confidence,
  ExcludedSegment,
  FactCategory,
  MsgRef,
  Scene,
  SwipeResolution,
} from '../../types/storyBible';
import {
  WALK_REPAIR_INSTRUCTION,
  WALK_SYSTEM,
  firstJsonObject,
  walkPrompt,
} from './prompts';
import type { IngestMessage, LlmCall } from './types';
import type { WalkChunk } from './transcriptChunker';

// ---------------------------------------------------------------------------
// Deterministic id minting
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * Deterministic UUID-shaped string from a seed. Deliberately NOT random:
 * scene/fact ids are seeded from `(chunk boundary, local position)`, so a
 * chunk retried after a transient write failure re-derives the SAME ids
 * rather than random ones. Scenes are mutable rows — a retry's
 * compare-and-set naturally reconciles a content difference. Facts are
 * append-only — a retry that lands on an already-written id safely
 * no-ops (the stored version wins) instead of duplicating. The tradeoff
 * (a retry that changes the MODEL's output for the same position keeps
 * the earlier content rather than the newer) is accepted deliberately:
 * facts are append-only by design, so "the first one recorded wins" is
 * consistent with the contract, not a bug.
 */
export function deterministicUuid(seed: string): string {
  const rand = splitmix32(fnv1a(seed));
  const bytes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = rand();
    bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnownCastMember {
  id: string;
  name: string;
  aliases: string[];
}

/** State carried across a chunk boundary when the model reports a scene
 *  is not yet finished. Not part of the wire checkpoint (which only
 *  stores the scene id) — reconstructed from the server on resume via
 *  `storyApi.getScene`. */
export interface OpenSceneCarry {
  sceneId: string;
  sequence: number;
  title: string;
  summary: string;
  detailedSummary: string;
  participantIds: string[];
  factIds: string[];
  rangeStart: MsgRef;
  excludedSegments: ExcludedSegment[];
  swipeResolutions: SwipeResolution[];
  totalMessages: number;
  /** Last known `server_ts` for this scene row (0 = never written yet). */
  serverTs: number;
}

export interface SceneBulkItem {
  id: string;
  data: Scene;
  baseTs: number;
}

export interface ChunkWalkOutcome {
  scenes: SceneBulkItem[];
  facts: BibleFact[];
  openScene: OpenSceneCarry | null;
  nextSequence: number;
  /** True when even the repair retry failed to yield usable JSON. The
   *  chunk contributes nothing rather than aborting the whole walk —
   *  surfaced to the user as "N chunks could not be read" (no silent
   *  caps). */
  parseFailed: boolean;
  llmCalls: number;
}

export interface ProcessChunkParams {
  chunk: WalkChunk;
  /** Last couple of real messages from the PREVIOUS chunk, read-only
   *  context for pronoun/continuity resolution. Never re-extracted. */
  previousTailMessages: IngestMessage[];
  openScene: OpenSceneCarry | null;
  nextSequence: number;
  knownCast: KnownCastMember[];
  /** Recent fact texts (most-recent-last) so the model doesn't repeat
   *  itself, mirroring lorebookFromTranscript's "already extracted"
   *  digest. */
  recentFactsDigest: string[];
  chat: ProjectChatRef;
  /** Token/cost accounting happens inside this callback (the store wraps
   *  its `llm` with the SAME counting wrapper cold-start uses) — this
   *  module never touches usageStore itself. */
  llm: LlmCall;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Small normalizers — tolerant of a weak model's imprecise output. Every
// one of these fails toward "drop the ambiguous bit", never toward
// inventing structure the model didn't clearly provide.
// ---------------------------------------------------------------------------

function clampIdx(value: unknown, length: number): number | null {
  const n = typeof value === 'number' ? Math.trunc(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n < length ? n : null;
}

const FACT_CATEGORIES: FactCategory[] = [
  'reveal',
  'introduction',
  'change',
  'world_rule',
];
function normalizeFactCategory(value: unknown): FactCategory {
  return FACT_CATEGORIES.includes(value as FactCategory)
    ? (value as FactCategory)
    : 'reveal';
}

const EXCLUDE_REASONS: ExcludedSegment['reason'][] = [
  'ooc',
  'system',
  'regen_artifact',
  'user_marked',
];
function normalizeExcludeReason(value: unknown): ExcludedSegment['reason'] {
  return EXCLUDE_REASONS.includes(value as ExcludedSegment['reason'])
    ? (value as ExcludedSegment['reason'])
    : 'ooc';
}

function speakerName(m: IngestMessage): string {
  return m.name?.trim() || (m.isUser ? 'User' : 'Character');
}

function resolveParticipants(names: unknown, cast: KnownCastMember[]): string[] {
  if (!Array.isArray(names)) return [];
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const norm = raw.trim().toLowerCase();
    if (!norm) continue;
    const match = cast.find(
      (c) =>
        c.name.toLowerCase() === norm ||
        c.aliases.some((a) => a.toLowerCase() === norm)
    );
    if (match && !out.includes(match.id)) out.push(match.id);
  }
  return out;
}

const CONFIDENCE: Confidence = 'explicit';

interface SystemRun {
  startIdx: number;
  endIdx: number;
}

/** Contiguous runs of system messages across the WHOLE chunk (full
 *  chunk.messages index space), computed once so a run that falls
 *  outside every scene's own range (a gap between two scenes, or before/
 *  after all of them) can still be attached to the nearest scene
 *  afterward instead of silently vanishing. */
function systemRunsInChunk(messages: IngestMessage[]): SystemRun[] {
  const runs: SystemRun[] = [];
  let start: number | null = null;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].isSystem) {
      start ??= i;
    } else if (start !== null) {
      runs.push({ startIdx: start, endIdx: i - 1 });
      start = null;
    }
  }
  if (start !== null) runs.push({ startIdx: start, endIdx: messages.length - 1 });
  return runs;
}

// ---------------------------------------------------------------------------
// Core: process one chunk
// ---------------------------------------------------------------------------

export async function processChunk(
  params: ProcessChunkParams
): Promise<ChunkWalkOutcome> {
  const {
    chunk,
    previousTailMessages,
    openScene,
    nextSequence,
    knownCast,
    recentFactsDigest,
    chat,
    llm,
    signal,
  } = params;

  const realIndices: number[] = [];
  chunk.messages.forEach((m, i) => {
    if (!m.isSystem) realIndices.push(i);
  });
  const realMessages = realIndices.map((i) => chunk.messages[i]);

  // A chunk that is ENTIRELY system messages (rare, but chunker doesn't
  // rule it out) has nothing for the model to read.
  if (realMessages.length === 0) {
    return {
      scenes: [],
      facts: [],
      openScene,
      nextSequence,
      parseFailed: false,
      llmCalls: 0,
    };
  }

  const numberedTranscript = realMessages
    .map((m, i) => `${i}: ${speakerName(m)}: ${m.content}`)
    .join('\n');
  const previousContext = previousTailMessages
    .map((m) => `${speakerName(m)}: ${m.content}`)
    .join('\n');
  const knownCastNote = knownCast
    .map((c) => `- ${c.name}${c.aliases.length ? ` (aka ${c.aliases.join(', ')})` : ''}`)
    .join('\n');
  const openSceneNote = openScene ? `"${openScene.title}" — ${openScene.summary}` : '';
  const knownFactsDigest = recentFactsDigest
    .slice(-20)
    .map((t) => `- ${t}`)
    .join('\n');

  const userPrompt = walkPrompt({
    numberedTranscript,
    previousContext,
    openSceneNote,
    knownCastNote,
    knownFactsDigest,
  });
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: WALK_SYSTEM },
    { role: 'user', content: userPrompt },
  ];

  let llmCalls = 0;
  let raw = await llm(messages, { maxTokens: 4096, signal });
  llmCalls++;
  let parsed = firstJsonObject(raw);
  let scenesRaw = parsed && Array.isArray(parsed.scenes) ? (parsed.scenes as unknown[]) : null;

  if (!scenesRaw) {
    const repairMessages = [
      ...messages,
      { role: 'assistant' as const, content: raw },
      { role: 'user' as const, content: WALK_REPAIR_INSTRUCTION },
    ];
    raw = await llm(repairMessages, { maxTokens: 4096, signal });
    llmCalls++;
    parsed = firstJsonObject(raw);
    scenesRaw = parsed && Array.isArray(parsed.scenes) ? (parsed.scenes as unknown[]) : null;
  }

  if (!scenesRaw) {
    return {
      scenes: [],
      facts: [],
      openScene,
      nextSequence,
      parseFailed: true,
      llmCalls,
    };
  }

  const outScenes: SceneBulkItem[] = [];
  const outFacts: BibleFact[] = [];
  // Parallel to outScenes: the [startFullIdx, endFullIdx] range each
  // written scene actually covers, so an orphaned system-message run can
  // be attached to the nearest one afterward.
  const sceneRanges: { startFullIdx: number; endFullIdx: number }[] = [];
  let carry = openScene;
  // True once the open scene coming in was EXPLICITLY continued. If it
  // never is (the model ignores it, or the continuing entry is
  // malformed), the original openScene is returned untouched rather than
  // silently dropped or overwritten by this chunk's own new-scene
  // bookkeeping.
  let sawContinuation = false;
  let sequence = nextSequence;

  const allSysRuns = systemRunsInChunk(chunk.messages);
  const usedSysRuns = new Set<number>();

  for (let si = 0; si < scenesRaw.length; si++) {
    const item = scenesRaw[si] as Record<string, unknown>;
    const startLocal = clampIdx(item.start_local_idx, realMessages.length);
    const endLocal = clampIdx(item.end_local_idx, realMessages.length);
    if (startLocal === null || endLocal === null || startLocal > endLocal) {
      // Malformed scene entry — skip it, don't abort the whole chunk.
      continue;
    }

    const isContinuing = si === 0 && carry !== null && item.continues_open_scene === true;
    if (isContinuing) sawContinuation = true;
    const isLast = si === scenesRaw.length - 1;
    const closed = isLast ? item.closed !== false : true;

    const startFullIdx = realIndices[startLocal];
    const endFullIdx = realIndices[endLocal];
    const rangeMessages = chunk.messages.slice(startFullIdx, endFullIdx + 1);
    const rangeStartMsg = chunk.messages[startFullIdx];
    const rangeEndMsg = chunk.messages[endFullIdx];
    const endRef = await buildMsgRef(rangeEndMsg);

    // Mechanical: swipe resolutions from the real messages in range.
    const swipeRes: SwipeResolution[] = [];
    for (const m of rangeMessages) {
      if (!m.isSystem && m.swipesCount > 1) {
        swipeRes.push({
          msg: await buildMsgRef(m),
          alternate_swipes_available: m.swipesCount - 1,
        });
      }
    }

    // System-message runs FULLY CONTAINED in this scene's range — marked
    // used so the leftover pass after the loop doesn't double-attach
    // them. A run straddling two scenes (shouldn't happen if the model's
    // ranges are contiguous, but not guaranteed) is left for that pass.
    const mechanicalExcluded: ExcludedSegment[] = [];
    for (let ri = 0; ri < allSysRuns.length; ri++) {
      if (usedSysRuns.has(ri)) continue;
      const run = allSysRuns[ri];
      if (run.startIdx >= startFullIdx && run.endIdx <= endFullIdx) {
        usedSysRuns.add(ri);
        mechanicalExcluded.push({
          range: {
            start: await buildMsgRef(chunk.messages[run.startIdx]),
            end: await buildMsgRef(chunk.messages[run.endIdx]),
          },
          reason: 'system',
        });
      }
    }

    // Model-flagged exclusions (ooc / user_marked / regen_artifact) —
    // only honored inside THIS scene's own local range; an index the
    // model attributed to a different scene is dropped rather than
    // silently attached to the wrong one.
    const modelExcluded: ExcludedSegment[] = [];
    const rawExcluded = Array.isArray(item.excluded_local_idxs)
      ? (item.excluded_local_idxs as unknown[])
      : [];
    for (const excludeItem of rawExcluded) {
      const obj = excludeItem as Record<string, unknown>;
      const idx = clampIdx(obj?.idx, realMessages.length);
      if (idx === null || idx < startLocal || idx > endLocal) continue;
      const m = realMessages[idx];
      const ref = await buildMsgRef(m);
      modelExcluded.push({
        range: { start: ref, end: ref },
        reason: normalizeExcludeReason(obj?.reason),
      });
    }

    let sceneId: string;
    let sceneSequence: number;
    let rangeStartRef: MsgRef;
    let baseTs: number;
    if (isContinuing) {
      sceneId = carry!.sceneId;
      sceneSequence = carry!.sequence;
      rangeStartRef = carry!.rangeStart;
      baseTs = carry!.serverTs;
    } else {
      // Seeded from the scene's own first REAL message — mechanically
      // stable no matter how many scenes the model returns or in what
      // order. Seeding from an ORDINAL position in the model's own
      // response (the earlier approach) let a differently-shaped retry
      // land unrelated content on the same id, since position 0 in one
      // call's response isn't necessarily the same scene as position 0
      // in another.
      sceneId = deterministicUuid(`scene:${rangeStartMsg.id}`);
      sceneSequence = sequence++;
      rangeStartRef = await buildMsgRef(rangeStartMsg);
      baseTs = 0;
    }

    const resolvedParticipants = resolveParticipants(item.participants, knownCast);
    const participantIds = Array.from(
      new Set([...(isContinuing ? carry!.participantIds : []), ...resolvedParticipants])
    );
    const excludedSegments = [
      ...(isContinuing ? carry!.excludedSegments : []),
      ...mechanicalExcluded,
      ...modelExcluded,
    ];
    const swipeResolutions = [
      ...(isContinuing ? carry!.swipeResolutions : []),
      ...swipeRes,
    ];
    const totalMessages = (isContinuing ? carry!.totalMessages : 0) + rangeMessages.length;

    const title =
      (typeof item.title === 'string' && item.title.trim()) ||
      (isContinuing ? carry!.title : '') ||
      '(untitled scene)';
    const summary =
      (typeof item.summary === 'string' && item.summary.trim()) ||
      (isContinuing ? carry!.summary : '');
    const detailedSummary =
      (typeof item.detailed_summary === 'string' && item.detailed_summary.trim()) ||
      (isContinuing ? carry!.detailedSummary : '');

    // Facts this scene establishes in THIS chunk.
    const sceneFactIds: string[] = isContinuing ? [...carry!.factIds] : [];
    const rawFacts = Array.isArray(item.facts) ? (item.facts as unknown[]) : [];
    for (const f of rawFacts) {
      const obj = f as Record<string, unknown>;
      const text = typeof obj.text === 'string' ? obj.text.trim() : '';
      if (!text) continue;
      const category = normalizeFactCategory(obj.category);
      const rawLocalIdx = clampIdx(obj.local_idx, realMessages.length);
      // Clamp into THIS scene's own range rather than trusting an index
      // the model attributed to a different scene.
      const localIdx =
        rawLocalIdx !== null && rawLocalIdx >= startLocal && rawLocalIdx <= endLocal
          ? rawLocalIdx
          : endLocal;
      const sourceMsg = realMessages[localIdx];
      const msgRef = await buildMsgRef(sourceMsg);
      // Seeded from the source message + the fact's own text: a retry
      // that re-derives the SAME fact from the SAME message is a safe
      // no-op (append-only, existing id wins); a retry that derives a
      // DIFFERENT fact never collides with unrelated already-written
      // content the way an ordinal-position seed could.
      const factId = deterministicUuid(
        `fact:${sourceMsg.id}:${text.slice(0, 80).toLowerCase().trim()}`
      );
      outFacts.push({
        id: factId,
        text,
        category,
        established_in: sceneId,
        source: chatMessageSourceRef(chat, msgRef, sourceMsg.content),
        confidence: CONFIDENCE,
      });
      sceneFactIds.push(factId);
    }

    const sceneData: Scene = {
      id: sceneId,
      sequence: sceneSequence,
      title,
      summary,
      detailed_summary: detailedSummary,
      setting: { location_ref: null, time_ref: null, atmosphere: '' },
      participants: participantIds,
      pov_character: null,
      function: null,
      source: {
        message_range: { start: rangeStartRef, end: endRef },
        total_messages: totalMessages,
        swipe_resolutions: swipeResolutions,
        excluded_segments: excludedSegments,
      },
      continuity_facts_established: sceneFactIds,
      transformations: null,
      annotations: {
        user_notes: '',
        author_intent: '',
        flagged_issues: [],
        stale_source: false,
      },
    };

    outScenes.push({ id: sceneId, data: sceneData, baseTs });
    sceneRanges.push({ startFullIdx, endFullIdx });

    carry =
      isLast && !closed
        ? {
            sceneId,
            sequence: sceneSequence,
            title,
            summary,
            detailedSummary,
            participantIds,
            factIds: sceneFactIds,
            rangeStart: rangeStartRef,
            excludedSegments,
            swipeResolutions,
            totalMessages,
            // PLACEHOLDER — this is the base_ts we're ABOUT to write with,
            // not the resulting server_ts. The caller MUST overwrite this
            // field with the real `server_ts` from the bulk-write response
            // before this carry is used as `openScene` input to the next
            // chunk, or the following chunk's continuation write will use
            // a stale token and 409.
            serverTs: baseTs,
          }
        : null;
  }

  // Any system-message run no scene's range fully contained (before the
  // first scene, a gap between two scenes, or after the last one) is
  // attached to the nearest scene rather than silently vanishing —
  // imprecise attribution beats total data loss. Dropped only when the
  // chunk produced zero valid scenes at all (nothing to attach to).
  if (outScenes.length > 0) {
    for (let ri = 0; ri < allSysRuns.length; ri++) {
      if (usedSysRuns.has(ri)) continue;
      const run = allSysRuns[ri];
      let nearest = 0;
      let bestDist = Infinity;
      sceneRanges.forEach((r, i) => {
        const dist =
          run.startIdx > r.endFullIdx
            ? run.startIdx - r.endFullIdx
            : r.startFullIdx - run.endIdx;
        if (dist < bestDist) {
          bestDist = dist;
          nearest = i;
        }
      });
      outScenes[nearest].data.source.excluded_segments.push({
        range: {
          start: await buildMsgRef(chunk.messages[run.startIdx]),
          end: await buildMsgRef(chunk.messages[run.endIdx]),
        },
        reason: 'system',
      });
    }
  }

  return {
    scenes: outScenes,
    facts: outFacts,
    // If the open scene coming in was never explicitly continued (the
    // model ignored it, or the continuing entry was malformed), return
    // it untouched rather than letting it be silently dropped or
    // overwritten by this chunk's own unrelated new-scene bookkeeping.
    openScene: sawContinuation ? carry : (openScene ?? carry),
    nextSequence: sequence,
    parseFailed: false,
    llmCalls,
  };
}
