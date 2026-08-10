// Reconcile judge (story-state phase 8, pass "reconcile").
//
// The LLM half of reconcile. `reconcile.ts` groups facts mechanically into
// plausible-conflict buckets; this module packs those groups into batched
// model calls, reads the answers back tolerantly, and turns them into
// `Contradiction` rows for the `continuity` section.
//
// Kept network-free like coldStart.ts / transcriptWalk.ts: everything here
// takes an `LlmCall` and returns data, never touching storyApi, so the
// packing, the parsing and the merge are all unit-testable with a fake
// model and no fake backend. The store owns persistence (fact append,
// section GET/merge/PUT, checkpointing).
//
// Two doctrines run through the whole file:
//
//  - EVERY malformation fails toward DROPPING the entry, never toward
//    inventing one. A weak model that emits garbage costs the user two
//    wasted calls and produces zero contradictions; it never produces a
//    fabricated one, and it never aborts the run.
//  - Nothing durable is ever seeded from a model's response POSITION or
//    WORDING. Contradiction ids come from the sorted fact ids they cite,
//    which the walk already content-seeded — so a re-judge on resume, a
//    differently-shaped retry, and the same pair surfacing from two
//    entity groups all converge on one id.

import type {
  BibleFact,
  Confidence,
  Contradiction,
  ContradictionType,
  FactCategory,
  SourceRef,
} from '../../types/storyBible';
import { capturedAt, deterministicUuid } from '../storyBible/sourceRefs';
import { estimateTokens } from '../tokenizer';
import {
  CARD_CHECK_SYSTEM,
  RECONCILE_REPAIR_INSTRUCTION,
  RECONCILE_SYSTEM,
  cardCheckPrompt,
  firstJsonObject,
  reconcilePrompt,
} from './prompts';
import { WORLD_ENTITY, factEntities, type FactGroup } from './reconcile';
import type { KnownCastMember } from './transcriptWalk';
import type { LlmCall } from './types';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Estimated prompt tokens a single judge call may carry. Deliberately
 *  modest: the judge runs on the user's own key after a full transcript
 *  walk has already been paid for, and a bigger batch buys throughput at
 *  the cost of a weak model losing track of which group is which. */
export const BATCH_TOKEN_BUDGET = 4000;

/** Hard cap on groups per call, independent of the token budget — a call
 *  carrying thirty tiny groups is cheap and useless. */
export const MAX_GROUPS_PER_BATCH = 12;

/** Per-fact prompt clamp. Fact text is a model-authored sentence; a
 *  runaway one must not eat a whole batch's budget. */
export const FACT_TEXT_CLAMP = 300;

/** Facts per window when a single group is too big for one call —
 *  realistically only the WORLD_ENTITY buckets, which collect every
 *  unattributed fact in the story. Pairs that straddle two windows go
 *  unjudged; the count is reported, never silently swallowed. */
export const WINDOW_MAX_FACTS = 40;

/** Card text sent with a card-vs-transcript check. */
export const CARD_TEXT_CLAMP = 1500;

/** Emitted description clamp. The backend takes any length under the
 *  section cap, but a paragraph here is the model padding, not detail. */
export const DESCRIPTION_CLAMP = 400;

/** Card claim clamp — it becomes a fact row's text and a snapshot excerpt. */
export const CARD_CLAIM_CLAMP = 200;

/** Budget for the continuity section's own bytes, against the server's
 *  256 KiB section cap. Enforced BEFORE the PUT: a 413 lands after every
 *  judge call is already paid for, and every retry fails identically. */
export const CONTINUITY_BYTE_BUDGET = 200 * 1024;

/** Belt to the byte budget's braces. Two hundred open contradictions is
 *  already far past what a human will review. */
export const MAX_CONTRADICTIONS = 200;

const SUBJECT_UNATTRIBUTED = '(world / unattributed)';

const CONTRADICTION_TYPES: ContradictionType[] = [
  'character_attribute',
  'world_rule',
  'timeline',
  'relationship',
  'object_state',
];

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

export interface LabelledFact {
  /** Short per-call handle (`f1`, `f2`, …). Models mangle UUIDs, and a
   *  mangled UUID that happens to resolve is worse than one that
   *  obviously doesn't. Positional and disposable — never a seed. */
  label: string;
  id: string;
  text: string;
  confidence: Confidence;
}

export interface LabelledGroup {
  entity: string;
  category: FactCategory;
  /** Display name for the prompt; the world bucket is named as such so
   *  the model knows the facts may not share a subject. */
  subject: string;
  facts: LabelledFact[];
}

export interface JudgeBatch {
  groups: LabelledGroup[];
  /** label → fact id, for THIS call only. */
  labels: Map<string, string>;
  /** fact id → the indices of the groups in this batch it appears in. A
   *  fact naming two characters is in both their groups by design, so
   *  "same group" is an intersection test, not an equality one. */
  groupsByFact: Map<string, number[]>;
}

export interface PackedGroups {
  batches: JudgeBatch[];
  /** Groups that had to be windowed — their cross-window pairs were never
   *  compared, which the run reports rather than hiding. */
  windowedGroups: number;
}

function clampFactText(text: string): string {
  return text.trim().slice(0, FACT_TEXT_CLAMP);
}

/** Rough prompt cost of one group, including its header and per-fact
 *  label/confidence scaffolding. Only has to rank sizes consistently —
 *  the real spend is measured by `countingLlm` either way. */
function groupTokens(group: FactGroup): number {
  let n = 24;
  for (const fact of group.facts) {
    n += estimateTokens(clampFactText(fact.text)) + 8;
  }
  return n;
}

/** Split a group too big for one call into consecutive windows.
 *
 *  A trailing window with a single fact is folded back into its
 *  predecessor rather than shipped: one fact cannot contradict anything,
 *  so it would be a paid call that can only return an empty list. */
function windowGroup(group: FactGroup): FactGroup[] {
  if (group.facts.length <= WINDOW_MAX_FACTS && groupTokens(group) <= BATCH_TOKEN_BUDGET) {
    return [group];
  }
  const windows: FactGroup[] = [];
  for (let i = 0; i < group.facts.length; i += WINDOW_MAX_FACTS) {
    windows.push({ ...group, facts: group.facts.slice(i, i + WINDOW_MAX_FACTS) });
  }
  if (windows.length > 1 && windows[windows.length - 1].facts.length < 2) {
    const tail = windows.pop()!;
    windows[windows.length - 1] = {
      ...tail,
      facts: [...windows[windows.length - 1].facts, ...tail.facts],
    };
  }
  return windows;
}

function labelBatch(groups: FactGroup[], subjectOf: (g: FactGroup) => string): JudgeBatch {
  const labels = new Map<string, string>();
  const labelByFactId = new Map<string, string>();
  const groupsByFact = new Map<string, number[]>();
  const out: LabelledGroup[] = [];

  groups.forEach((group, groupIdx) => {
    const facts: LabelledFact[] = [];
    for (const fact of group.facts) {
      // One label per fact id per CALL, even when the fact sits in two of
      // this batch's groups — two labels for one fact would let a model
      // "contradict" a fact with itself and satisfy the >= 2 rule.
      let label = labelByFactId.get(fact.id);
      if (!label) {
        label = `f${labelByFactId.size + 1}`;
        labelByFactId.set(fact.id, label);
        labels.set(label, fact.id);
      }
      const seen = groupsByFact.get(fact.id);
      if (seen) seen.push(groupIdx);
      else groupsByFact.set(fact.id, [groupIdx]);
      facts.push({
        label,
        id: fact.id,
        text: clampFactText(fact.text),
        confidence: fact.confidence,
      });
    }
    out.push({
      entity: group.entity,
      category: group.category,
      subject: subjectOf(group),
      facts,
    });
  });

  return { groups: out, labels, groupsByFact };
}

/**
 * Pack grouped facts into judge calls.
 *
 * Greedy first-fit over `groupFacts`'s already-deterministic order, so
 * the same bible always produces the same batches in the same sequence —
 * which is what makes a mid-pass resume's whole-pass re-judge converge
 * instead of drifting.
 */
export function packGroups(
  groups: FactGroup[],
  cast: KnownCastMember[]
): PackedGroups {
  const nameById = new Map<string, string>();
  for (const member of cast ?? []) {
    if (member?.id) nameById.set(member.id, member.name || member.id);
  }
  const subjectOf = (g: FactGroup) =>
    g.entity === WORLD_ENTITY ? SUBJECT_UNATTRIBUTED : (nameById.get(g.entity) ?? g.entity);

  let windowedGroups = 0;
  const windowed: FactGroup[] = [];
  for (const group of groups) {
    const windows = windowGroup(group);
    if (windows.length > 1) windowedGroups++;
    windowed.push(...windows);
  }

  const bins: { groups: FactGroup[]; tokens: number }[] = [];
  for (const group of windowed) {
    const cost = groupTokens(group);
    let bin = bins.find(
      (b) => b.groups.length < MAX_GROUPS_PER_BATCH && b.tokens + cost <= BATCH_TOKEN_BUDGET
    );
    if (!bin) {
      bin = { groups: [], tokens: 0 };
      bins.push(bin);
    }
    bin.groups.push(group);
    bin.tokens += cost;
  }

  return {
    batches: bins.map((b) => labelBatch(b.groups, subjectOf)),
    windowedGroups,
  };
}

/** Render a batch as the judge's user message body. */
export function renderBatch(batch: JudgeBatch): string {
  return batch.groups
    .map((group, i) => {
      const header = `Group ${i + 1} — subject: ${group.subject} — category: ${group.category}`;
      const lines = group.facts.map((f) => `${f.label}: ${f.text} [${f.confidence}]`);
      return [header, ...lines].join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface DetectedConflict {
  /** Sorted, deduped fact ids — at least two. */
  sources: string[];
  type: ContradictionType;
  description: string;
}

function normalizeType(value: unknown, fallbackCategory: FactCategory): ContradictionType {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    const hit = CONTRADICTION_TYPES.find((t) => t === lower);
    if (hit) return hit;
  }
  // No usable label from the model: the group's own category is the only
  // evidence left, and it distinguishes the one case that matters.
  return fallbackCategory === 'world_rule' ? 'world_rule' : 'character_attribute';
}

function normalizeDescription(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim().slice(0, DESCRIPTION_CLAMP) : '';
  // The backend enforces min_length 1, so an empty description is a 422
  // that would fail the whole section write over one bad entry.
  return text || fallback;
}

/** The `contradictions` array out of a response, or null when even the
 *  repair round produced nothing shaped like one. */
function contradictionsArray(raw: string): unknown[] | null {
  const parsed = firstJsonObject(raw);
  return parsed && Array.isArray(parsed.contradictions)
    ? (parsed.contradictions as unknown[])
    : null;
}

/**
 * Turn one judge response into conflicts, dropping anything that does not
 * survive the checks.
 *
 * Returns null only when the response could not be read AT ALL — the
 * caller's cue to spend the one repair round, then count the batch
 * unreadable. An empty array means "read fine, nothing conflicts", which
 * is the common and correct answer.
 */
export function parseJudgeResponse(
  raw: string,
  batch: JudgeBatch
): DetectedConflict[] | null {
  const entries = contradictionsArray(raw);
  if (!entries) return null;

  const out: DetectedConflict[] = [];
  for (const entry of entries) {
    const obj = entry as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') continue;

    const rawLabels = Array.isArray(obj.facts) ? (obj.facts as unknown[]) : [];
    const ids: string[] = [];
    for (const label of rawLabels) {
      if (typeof label !== 'string') continue;
      const id = batch.labels.get(label.trim());
      // An unknown label is an invented citation. Drop it rather than
      // guessing which fact was meant.
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length < 2) continue;

    // Mechanical enforcement of "never pair facts from two groups": every
    // cited fact must share at least one group within this call. A
    // multi-entity fact legitimately sits in several, hence the
    // intersection rather than an equality test.
    let shared: number[] | null = null;
    for (const id of ids) {
      const groups = batch.groupsByFact.get(id) ?? [];
      shared = shared === null ? [...groups] : shared.filter((g) => groups.includes(g));
      if (shared.length === 0) break;
    }
    if (!shared || shared.length === 0) continue;

    const group = batch.groups[Math.min(...shared)];
    out.push({
      sources: [...ids].sort(),
      type: normalizeType(obj.type, group.category),
      description: normalizeDescription(
        obj.description,
        `Conflicting ${group.category.replace(/_/g, ' ')} facts about ${group.subject}`
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Group judge
// ---------------------------------------------------------------------------

export interface GroupJudgeOutcome {
  detected: DetectedConflict[];
  /** Batches whose response was unreadable even after the repair round.
   *  They contribute nothing and the pass continues — a weak BYO model
   *  must not be able to fail a build it has already been paid for. */
  unreadableBatches: number;
  windowedGroups: number;
  batches: number;
  llmCalls: number;
}

async function askJudge(
  llm: LlmCall,
  system: string,
  user: string,
  signal: AbortSignal | undefined,
  read: (raw: string) => DetectedConflict[] | null
): Promise<{ conflicts: DetectedConflict[] | null; calls: number }> {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let calls = 0;
  let raw = await llm(messages, { maxTokens: 1500, signal });
  calls++;
  let conflicts = read(raw);
  if (!conflicts) {
    raw = await llm(
      [
        ...messages,
        { role: 'assistant', content: raw },
        { role: 'user', content: RECONCILE_REPAIR_INSTRUCTION },
      ],
      { maxTokens: 1500, signal }
    );
    calls++;
    conflicts = read(raw);
  }
  return { conflicts, calls };
}

/**
 * Judge every multi-fact group.
 *
 * Cross-batch duplicates are collapsed here by source set: a fact naming
 * two characters is in both their groups by design, so the same pair can
 * genuinely surface twice. (The deterministic id would collapse them at
 * the merge anyway; doing it here keeps the emitted list honest about how
 * many distinct findings there are.)
 */
export async function runGroupJudge(opts: {
  groups: FactGroup[];
  cast: KnownCastMember[];
  llm: LlmCall;
  signal?: AbortSignal;
}): Promise<GroupJudgeOutcome> {
  const { batches, windowedGroups } = packGroups(opts.groups, opts.cast);
  const detected: DetectedConflict[] = [];
  const seen = new Set<string>();
  let unreadableBatches = 0;
  let llmCalls = 0;

  for (const batch of batches) {
    const { conflicts, calls } = await askJudge(
      opts.llm,
      RECONCILE_SYSTEM,
      reconcilePrompt(renderBatch(batch)),
      opts.signal,
      (raw) => parseJudgeResponse(raw, batch)
    );
    llmCalls += calls;
    if (!conflicts) {
      unreadableBatches++;
      continue;
    }
    for (const conflict of conflicts) {
      const key = conflict.sources.join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      detected.push(conflict);
    }
  }

  return {
    detected,
    unreadableBatches,
    windowedGroups,
    batches: batches.length,
    llmCalls,
  };
}

// ---------------------------------------------------------------------------
// Card-vs-transcript check
// ---------------------------------------------------------------------------

/** A card-backed character, as the bible's own `entities` snapshot
 *  records it. Deliberately read back from the section rather than from
 *  raw card sources: the resume path has no card in hand, and the two
 *  paths must judge the same text. */
export interface CardCharacter {
  id: string;
  name: string;
  /** `character_avatar` for the minted fact's `card_field` ref. */
  avatar: string;
  cardText: string;
}

function isCardFieldRef(value: unknown): value is { ref?: { character_avatar?: unknown } } {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'card_field';
}

/**
 * Card-backed characters out of an `entities` section payload.
 *
 * "Card-backed" is exactly what cold start stamps: a `card_field`
 * provenance ref. Transcript-introduced NPCs have none and cost zero
 * calls, which is what keeps a big cast cheap.
 *
 * Tolerant by design — this reads a section that a much older build may
 * have written, so anything unrecognisable is skipped rather than thrown
 * over. (The section's own readability is the store's check, not this
 * one's: it already validated `characters` is an array before calling.)
 */
export function readCardCharacters(characters: unknown): CardCharacter[] {
  if (!Array.isArray(characters)) return [];
  const out: CardCharacter[] = [];
  for (const raw of characters) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : '';
    if (!id) continue;

    const provenance = Array.isArray(c.provenance) ? c.provenance : [];
    const cardRefs = provenance.filter(isCardFieldRef);
    if (cardRefs.length === 0) continue;

    const name =
      (typeof c.canonical_name === 'string' && c.canonical_name.trim()) || id;

    // `character_avatar` is min_length 1 server-side, so a ref built from
    // an empty avatar would 422 the fact append. Fall back through the
    // character source ref, then the name — a card_field ref may dangle
    // by contract, so a stale-but-present identity beats no fact at all.
    let avatar = '';
    for (const ref of cardRefs) {
      const candidate = (ref as { ref?: { character_avatar?: unknown } }).ref?.character_avatar;
      if (typeof candidate === 'string' && candidate.trim()) {
        avatar = candidate.trim();
        break;
      }
    }
    if (!avatar) {
      const source = c.source as { kind?: unknown; ref?: unknown } | undefined;
      if (source?.kind === 'character' && typeof source.ref === 'string' && source.ref.trim()) {
        avatar = source.ref.trim();
      }
    }
    if (!avatar) avatar = name;

    // NOT `background`: cold start always leaves it '', so reading it
    // would quietly make every card check compare against nothing.
    const parts: string[] = [];
    const physical = c.physical_description as { summary?: unknown } | undefined;
    if (typeof physical?.summary === 'string' && physical.summary.trim()) {
      parts.push(physical.summary.trim());
    }
    const personality = c.personality as { traits?: unknown } | undefined;
    if (Array.isArray(personality?.traits)) {
      for (const trait of personality.traits) {
        const text = (trait as { trait?: unknown })?.trait;
        if (typeof text === 'string' && text.trim()) parts.push(text.trim());
      }
    }
    for (const ref of cardRefs) {
      const excerpt = (ref as { snapshot?: { excerpt?: unknown } }).snapshot?.excerpt;
      if (typeof excerpt === 'string' && excerpt.trim()) parts.push(excerpt.trim());
    }

    const deduped: string[] = [];
    for (const part of parts) {
      if (!deduped.some((p) => p === part || p.includes(part))) deduped.push(part);
    }
    const cardText = deduped.join('\n').slice(0, CARD_TEXT_CLAMP);
    // Nothing on the card to contradict — not a skipped check, just no
    // check to run.
    if (!cardText) continue;

    out.push({ id, name, avatar, cardText });
  }
  return out;
}

export interface CardCheckTarget {
  character: CardCharacter;
  facts: BibleFact[];
  /** Facts this character has that did not fit the single call §6 allows.
   *  Counted so the run can report it — a cap nobody counts reads to the
   *  user as "checked, clean". */
  omittedFacts: number;
}

/**
 * Which card-backed characters have transcript facts worth checking.
 *
 * Singleton facts count here even though `groupFacts` drops them for the
 * group judge: one fact cannot contradict another fact, but it can very
 * much contradict the card.
 */
export function buildCardCheckTargets(
  cardCharacters: CardCharacter[],
  facts: BibleFact[],
  cast: KnownCastMember[]
): CardCheckTarget[] {
  const byCharacter = new Map<string, BibleFact[]>();
  for (const fact of facts) {
    for (const id of factEntities(fact, cast)) {
      const list = byCharacter.get(id);
      if (list) list.push(fact);
      else byCharacter.set(id, [fact]);
    }
  }
  const out: CardCheckTarget[] = [];
  for (const character of cardCharacters) {
    const own = byCharacter.get(character.id);
    if (!own || own.length === 0) continue;
    // §6 buys a big cast's affordability with ONE call per character, so
    // a character with hundreds of facts has to be trimmed rather than
    // windowed. Take the MOST RECENT: a card override is by definition
    // something the story established later, so the tail is where the
    // contradicting claim lives. The remainder is counted, not dropped
    // quietly.
    const facts = own.length > WINDOW_MAX_FACTS ? own.slice(-WINDOW_MAX_FACTS) : own;
    out.push({ character, facts, omittedFacts: own.length - facts.length });
  }
  return out;
}

export interface DetectedCardConflict {
  character: CardCharacter;
  /** Sorted, deduped transcript fact ids — at least one. */
  citedFactIds: string[];
  cardClaim: string;
  type: ContradictionType;
  description: string;
}

/** Label map for one card check: local labels over that character's own
 *  facts, same discipline as the group judge. */
function labelFacts(facts: BibleFact[]): {
  rendered: string;
  byLabel: Map<string, string>;
} {
  const byLabel = new Map<string, string>();
  const lines: string[] = [];
  facts.forEach((fact, i) => {
    const label = `f${i + 1}`;
    byLabel.set(label, fact.id);
    lines.push(`${label}: ${clampFactText(fact.text)} [${fact.confidence}]`);
  });
  return { rendered: lines.join('\n'), byLabel };
}

export interface CardCheckOutcome {
  detected: DetectedCardConflict[];
  unreadableChecks: number;
  /** Characters whose fact list didn't fit one card check (see
   *  `buildCardCheckTargets`). Reported by the run, never silent. */
  truncatedCharacters: number;
  llmCalls: number;
}

/** One call per eligible character. */
export async function runCardChecks(opts: {
  targets: CardCheckTarget[];
  llm: LlmCall;
  signal?: AbortSignal;
}): Promise<CardCheckOutcome> {
  const detected: DetectedCardConflict[] = [];
  let unreadableChecks = 0;
  let truncatedCharacters = 0;
  let llmCalls = 0;

  for (const target of opts.targets) {
    if (target.omittedFacts > 0) truncatedCharacters++;
    const { rendered, byLabel } = labelFacts(target.facts);
    // The card check emits a `card_claim` the group judge has no notion
    // of, so it parses through its own reader rather than reusing
    // parseJudgeResponse's >= 2-labels rule (the card is the second side
    // here, and it has no label).
    const read = (raw: string): DetectedConflict[] | null => {
      const entries = contradictionsArray(raw);
      if (!entries) return null;
      for (const entry of entries) {
        const obj = entry as Record<string, unknown>;
        if (!obj || typeof obj !== 'object') continue;
        const claim =
          typeof obj.card_claim === 'string'
            ? obj.card_claim.trim().slice(0, CARD_CLAIM_CLAMP)
            : '';
        // Without the card's own words there is nothing to append as the
        // second source, so the entry has no way to satisfy sources >= 2.
        if (!claim) continue;
        const ids: string[] = [];
        for (const label of Array.isArray(obj.facts) ? (obj.facts as unknown[]) : []) {
          if (typeof label !== 'string') continue;
          const id = byLabel.get(label.trim());
          if (id && !ids.includes(id)) ids.push(id);
        }
        if (ids.length === 0) continue;
        detected.push({
          character: target.character,
          citedFactIds: [...ids].sort(),
          cardClaim: claim,
          type: normalizeType(obj.type, 'reveal'),
          description: normalizeDescription(
            obj.description,
            `The card and the story disagree about ${target.character.name}`
          ),
        });
      }
      // Signals "readable", which is all the caller needs; the conflicts
      // themselves were pushed above because they carry card-only fields.
      return [];
    };

    const { conflicts, calls } = await askJudge(
      opts.llm,
      CARD_CHECK_SYSTEM,
      cardCheckPrompt({
        characterName: target.character.name,
        cardText: target.character.cardText,
        facts: rendered,
      }),
      opts.signal,
      read
    );
    llmCalls += calls;
    if (!conflicts) unreadableChecks++;
  }

  return { detected, unreadableChecks, truncatedCharacters, llmCalls };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Deterministic id for the synthetic fact that carries the CARD's side
 *  of a card-vs-transcript conflict. ONE row per card-backed character,
 *  for the whole life of the bible.
 *
 *  DELIBERATE DEVIATION from the plan's §6 formula, which seeds this from
 *  the character AND the cited transcript fact ids. That formula defends
 *  against claim-WORDING drift (which it does), but it is defeated by
 *  CITATION drift — and citation drift is the very thing §7's dampener
 *  exists to absorb. With the card fact in `sources`, run 1's {CF1,A,B}
 *  and run 2's {CF2,A} each hold a card id the other lacks, so they are
 *  mutually incomparable and `strictSubset` can never fire: the ONE drift
 *  shape §7 promises to collapse is converted, by construction, into the
 *  incomparable residue §10 merely tolerates. Every rebuild then adds
 *  another near-duplicate entry and another orphan fact row.
 *
 *  Seeding on the character alone restores comparability — {CF,A,B} vs
 *  {CF,A} is a clean strict subset — so the existing dampener does its
 *  job and the fact log holds exactly one card row per character.
 *
 *  Accepted edge: a character with two genuinely distinct conflicting
 *  card claims shares one fact row, whose text is whichever claim was
 *  detected first. Nothing is lost — `buildCardContradiction` carries the
 *  specific claim in each contradiction's own description — and the two
 *  conflicts stay separate entries, since their transcript citations
 *  differ and so remain incomparable. Fewer rows is the safe direction in
 *  an append-only log. */
export function cardFactId(characterId: string): string {
  return deterministicUuid(`fact:card:${characterId}`);
}

/** The card's side of a conflict, as an appendable fact row.
 *
 *  This is an APPEND, not a mutation — which is the only reason
 *  `contradicts` can be populated at all. Facts are append-only with no
 *  update path, so back-refs cannot be added to the transcript facts
 *  already on the server; `continuity.contradictions[].sources` carries
 *  the cross-reference in both directions instead. */
export function buildCardFact(conflict: DetectedCardConflict): BibleFact {
  const source: SourceRef = {
    kind: 'card_field',
    ref: { character_avatar: conflict.character.avatar, field: 'description' },
    snapshot: { excerpt: conflict.cardClaim.slice(0, 500) },
    captured_at: capturedAt(),
  };
  return {
    id: cardFactId(conflict.character.id),
    text: `Card: ${conflict.cardClaim}`,
    // The card is where a character is introduced, whatever the claim.
    category: 'introduction',
    confidence: 'explicit',
    established_in: null,
    source,
    contradicts: [...conflict.citedFactIds],
  };
}

/**
 * Deterministic contradiction id.
 *
 * Seeded from the SORTED participating fact ids and nothing else. Every
 * load-bearing property of the pass falls out of that choice: a
 * differently-shaped retry produces the identical id set, the same pair
 * surfacing from two entity groups collapses to one entry, a resume's
 * whole-pass re-judge merges to zero duplicates, and a phase-10
 * resolution keyed by id survives an idempotent re-reconcile.
 *
 * `type` is deliberately NOT in the seed: a model that re-labels the kind
 * of conflict on a later run must not orphan the user's resolution.
 */
export function contradictionId(sources: string[]): string {
  return deterministicUuid(`contradiction:${[...sources].sort().join(':')}`);
}

/** Sent fully explicit and byte-equal to the server's materialized
 *  defaults, so a merge that changes nothing produces identical bytes and
 *  the no-op PUT can be skipped. */
function unresolved(): Contradiction['resolution'] {
  return {
    status: 'unresolved',
    canonical_choice: null,
    rationale: '',
    // Never a naive datetime — the backend wants an aware one or null.
    resolved_at: null,
  };
}

export function buildContradiction(conflict: DetectedConflict): Contradiction {
  const sources = [...conflict.sources].sort();
  return {
    id: contradictionId(sources),
    type: conflict.type,
    description: conflict.description,
    sources,
    detected_by: 'agent',
    resolution: unresolved(),
  };
}

/** The contradiction for a card conflict, once its card fact exists.
 *
 *  The claim is folded into the description when the model's own sentence
 *  doesn't already carry it. That is what makes the shared per-character
 *  card fact row safe: two distinct claims about one character reuse the
 *  same row (whose text is the first claim seen), so the entry itself has
 *  to say which claim THIS conflict is about. */
export function buildCardContradiction(
  conflict: DetectedCardConflict,
  cardFactRowId: string
): Contradiction {
  const claim = conflict.cardClaim.trim();
  const mentionsClaim =
    !claim || conflict.description.toLowerCase().includes(claim.toLowerCase());
  const description = mentionsClaim
    ? conflict.description
    : `${conflict.description} (card: “${claim}”)`.slice(0, DESCRIPTION_CLAMP);
  return buildContradiction({
    sources: [cardFactRowId, ...conflict.citedFactIds],
    type: conflict.type,
    description,
  });
}

// ---------------------------------------------------------------------------
// Reading and merging the continuity section
// ---------------------------------------------------------------------------

function isContradiction(value: unknown): value is Contradiction {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  const resolution = c.resolution as Record<string, unknown> | undefined;
  return (
    typeof c.id === 'string' &&
    typeof c.type === 'string' &&
    typeof c.description === 'string' &&
    Array.isArray(c.sources) &&
    c.sources.every((s) => typeof s === 'string') &&
    (c.detected_by === 'agent' || c.detected_by === 'user') &&
    !!resolution &&
    typeof resolution === 'object' &&
    typeof resolution.status === 'string'
  );
}

/**
 * Read an existing `continuity` payload.
 *
 * THROWS on anything malformed rather than treating it as empty. The
 * section is not pass-owned: phase 10 writes user resolutions into it and
 * users add their own entries, so silently replacing an unreadable
 * section would destroy work no rebuild can recover. A loud, resumable
 * error is the correct failure — the detections are recomputable, the
 * user's resolutions are not.
 */
export function readContinuitySection(data: unknown): Contradiction[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('The story bible’s contradiction list could not be read.');
  }
  const raw = (data as Record<string, unknown>).contradictions;
  // A section written before anything was detected legitimately has no
  // entries; only a PRESENT-but-wrong value is malformed.
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every(isContradiction)) {
    throw new Error('The story bible’s contradiction list could not be read.');
  }
  return raw as Contradiction[];
}

/** Entries the merge must never drop: a human either wrote them or acted
 *  on them. Phase 10 owns their lifecycle, not this pass. */
function isProtected(c: Contradiction): boolean {
  return c.detected_by === 'user' || c.resolution?.status !== 'unresolved';
}

function sourceSet(c: Contradiction): Set<string> {
  return new Set(c.sources);
}

function strictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size >= b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function sectionBytes(list: Contradiction[]): number {
  return new TextEncoder().encode(JSON.stringify({ contradictions: list })).length;
}

export interface ContinuityMerge {
  contradictions: Contradiction[];
  /** Entries the byte/count budget refused. Reported, never silent. */
  dropped: number;
}

/**
 * Merge fresh detections into whatever the section already holds.
 *
 * The continuity section is NOT a pass-owned full-rebuild section, so the
 * store's blind adopt-and-re-PUT `writeSection` is wrong here — it would
 * revert a resolution a user wrote seconds ago in another tab. The rules,
 * in order:
 *
 *  1. Existing entries win on id collision, which is what preserves a
 *     resolution across a re-detection.
 *  2. Entries that were NOT re-detected are KEPT. Facts are append-only
 *     today, so an old contradiction between two facts that both still
 *     exist is still true; judge nondeterminism must never silently
 *     un-surface one (schema principle 5).
 *  3. Dangling-source prune: a kept, agent-detected, UNRESOLVED entry
 *     whose sources no longer all exist is dropped. Without it, a phase-10
 *     fact hard-delete leaves immortal entries pointing at 404s that can
 *     never be re-detected. Resolved and user entries are exempt —
 *     cleaning those up at delete time is phase 10's obligation.
 *  4. Drift dampener: models trim citations nondeterministically, so run 1
 *     reports {A,B,C} and run 2 {A,B} — different ids, near-duplicate
 *     entries piling up across rebuilds. When two entries' source sets are
 *     strict subset/superset, keep one: the protected entry if either is,
 *     otherwise the superset.
 */
export function mergeContinuity(
  existing: Contradiction[],
  detected: Contradiction[],
  liveFactIds: ReadonlySet<string>,
  /** Ids of synthetic card facts. The dampener only ever compares two
   *  entries of the SAME KIND — see `sameKind`. */
  cardFactIds: ReadonlySet<string> = new Set()
): ContinuityMerge {
  const merged: Contradiction[] = [];
  const byId = new Set<string>();

  for (const entry of existing) {
    if (byId.has(entry.id)) continue;
    if (
      !isProtected(entry) &&
      !entry.sources.every((id) => liveFactIds.has(id))
    ) {
      continue;
    }
    byId.add(entry.id);
    merged.push(entry);
  }
  const freshIds = new Set<string>();
  for (const entry of detected) {
    if (byId.has(entry.id)) continue; // rule 1: existing wins
    byId.add(entry.id);
    freshIds.add(entry.id);
    merged.push(entry);
  }

  // Rule 4. O(n^2) over a list the count cap holds near 200 — and it runs
  // once per build, against a section a human is going to read.
  //
  // Survivorship is a function of CONTENT ONLY — deliberately no
  // "skip b if b is already dropped". That skip looked like a harmless
  // optimisation and was not: a protected entry breaks strict-subset's
  // transitivity, so a dropped-but-suppressing entry could shield a third
  // entry that nothing else covered, and whether it did depended on
  // array position. Since an entry MOVES from the detected half to the
  // existing half the moment it is written, the outcome then flipped on
  // alternate rebuilds — an entry dropped, re-added, dropped — which also
  // meant continuityUnchanged never short-circuited and every single
  // rebuild bumped server_ts. Found by permutation-fuzzing this function.
  const dropped = new Set<string>();
  const sets = new Map(merged.map((c) => [c.id, sourceSet(c)]));
  // A card-vs-transcript conflict cites [cardFact, ...transcriptFacts], so
  // a transcript-only entry over those same facts is ALWAYS a strict
  // subset of it — and the dampener would eat a completely unrelated
  // finding, silently, depending only on how widely the card check
  // happened to cite. (Surfaced by the manual smoke test, where a real
  // "Ivy both seals and never seals the north wing" entry vanished the
  // moment the card check widened its citations. Inherent to the design,
  // not to any one id formula.) The dampener exists to collapse ONE
  // finding restated with drifted citations — never two different ones
  // that merely nest, so it only compares entries of the same kind.
  const isCardEntry = (c: Contradiction) => c.sources.some((id) => cardFactIds.has(id));
  const sameKind = (a: Contradiction, b: Contradiction) =>
    isCardEntry(a) === isCardEntry(b);
  for (const a of merged) {
    if (isProtected(a)) continue;
    for (const b of merged) {
      if (b.id === a.id || !sameKind(a, b)) continue;
      const setA = sets.get(a.id)!;
      const setB = sets.get(b.id)!;
      if (!strictSubset(setA, setB) && !strictSubset(setB, setA)) continue;
      if (isProtected(b) || strictSubset(setA, setB)) {
        dropped.add(a.id);
        break;
      }
    }
  }
  let list = merged.filter((c) => !dropped.has(c.id));

  // The byte bound, enforced here rather than discovered as a 413 after
  // every judge call has been paid for. Newly detected entries go first
  // (they are recomputable next build); protected entries are never
  // touched.
  let budgetDropped = 0;
  const droppable = () => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (freshIds.has(list[i].id) && !isProtected(list[i])) return i;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (!isProtected(list[i])) return i;
    }
    return -1;
  };
  while (list.length > MAX_CONTRADICTIONS) {
    const idx = droppable();
    if (idx < 0) break;
    list = [...list.slice(0, idx), ...list.slice(idx + 1)];
    budgetDropped++;
  }
  while (sectionBytes(list) > CONTINUITY_BYTE_BUDGET) {
    const idx = droppable();
    if (idx < 0) break;
    list = [...list.slice(0, idx), ...list.slice(idx + 1)];
    budgetDropped++;
  }

  return { contradictions: list, dropped: budgetDropped };
}

/** True when the merge produced exactly what is already stored — the cue
 *  to skip the PUT entirely. The backend bumps `server_ts` on every write
 *  regardless, and a gratuitous bump forces a 409-and-merge on the next
 *  write from any open review tab. */
export function continuityUnchanged(
  existing: Contradiction[],
  merged: Contradiction[]
): boolean {
  return JSON.stringify(existing) === JSON.stringify(merged);
}
