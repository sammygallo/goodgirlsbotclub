// Transcript chunking (story-state phase 7).
//
// Named `transcriptChunker`, not `chunker`: a Phase-8.5 Data Bank
// `src/utils/chunker.ts` already exists (character-budgeted, unrelated).
// The chunk PLANNING approach mirrors `lorebookFromTranscript.planChunks`
// (message-grain, token-budgeted groups) — but this module additionally
// pins the plan into `ingestion.chunk_plan` by message id, because the
// walk (unlike the one-shot lorebook extractor) must be able to resume a
// half-finished pass across a closed tab.
//
// Boundaries never split a message: a chunk is always a contiguous slice
// of whole messages, so "does this id still exist" is the only question
// resume ever has to ask.

import { estimateTokens } from '../tokenizer';
import type { ChunkPlanEntry } from './types';
import type { IngestMessage } from './types';

/** Roughly how many transcript tokens to feed the model per chunk. */
export const WALK_CHUNK_TOKEN_BUDGET = 6000;
/** Soft cap on chunk count. Exceeding it does not truncate the transcript
 *  (a "no silent caps" transcript is worse than an expensive one) — the
 *  caller must get an explicit confirmation before starting a walk this
 *  long, per the plan's Phase 7 spec. */
export const WALK_CHUNK_SOFT_CAP = 200;
/** However token-light a run of messages is, force a new chunk once this
 *  many messages have accumulated — bounds how much rolling context one
 *  model call has to hold regardless of message length. */
export const WALK_FORCE_SPLIT_MESSAGES = 60;

export interface WalkChunk {
  messages: IngestMessage[];
  startMsgId: string;
  endMsgId: string;
  estTokens: number;
}

export interface WalkChunkPlan {
  chunks: WalkChunk[];
  chunkPlan: ChunkPlanEntry[];
  /** True when `chunks.length` exceeds `WALK_CHUNK_SOFT_CAP` — the caller
   *  must not start spending money without an explicit confirmation. */
  exceedsSoftCap: boolean;
}

/** System messages contribute nothing to the token budget (they are never
 *  canon), but they still occupy a slot in the chunk so `message_range`
 *  and `excluded_segments` account for them mechanically rather than the
 *  chunker silently dropping them from the record. */
function messageTokens(m: IngestMessage): number {
  return m.isSystem ? 0 : estimateTokens(m.content);
}

/**
 * Plan the full transcript into token-budgeted, message-atomic chunks.
 *
 * Unlike `lorebookFromTranscript.planChunks`, this NEVER truncates —
 * every message ends up in some chunk. A transcript long enough to blow
 * the soft cap is surfaced via `exceedsSoftCap`, not silently cut.
 */
export function planTranscriptChunks(messages: IngestMessage[]): WalkChunkPlan {
  const chunks: WalkChunk[] = [];
  let current: IngestMessage[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      messages: current,
      startMsgId: current[0].id,
      endMsgId: current[current.length - 1].id,
      estTokens: currentTokens,
    });
    current = [];
    currentTokens = 0;
  };

  for (const m of messages) {
    const tokens = messageTokens(m);
    const wouldOverflowBudget =
      current.length > 0 && currentTokens + tokens > WALK_CHUNK_TOKEN_BUDGET;
    const wouldOverflowCount = current.length >= WALK_FORCE_SPLIT_MESSAGES;
    if (wouldOverflowBudget || wouldOverflowCount) flush();
    current.push(m);
    currentTokens += tokens;
  }
  flush();

  return {
    chunks,
    chunkPlan: chunks.map((c) => ({
      start_msg_id: c.startMsgId,
      end_msg_id: c.endMsgId,
      est_tokens: c.estTokens,
    })),
    exceedsSoftCap: chunks.length > WALK_CHUNK_SOFT_CAP,
  };
}

/**
 * Rebuild chunk message arrays from a PERSISTED `chunk_plan` against the
 * CURRENT message fetch, for resuming an interrupted walk.
 *
 * Returns `null` when any boundary id from the plan can no longer be
 * found (or is now out of order) — the caller must treat that as history
 * having diverged under the pass and refuse to resume rather than guess.
 * This deliberately does not attempt reconciliation (see
 * `extendChunkPlan` and `utils/storyBible/msgDrift` for phase 11's
 * incremental re-ingestion); it only answers "is it still safe to keep
 * going from where we stopped".
 */
export function sliceChunksFromPlan(
  messages: IngestMessage[],
  plan: ChunkPlanEntry[]
): WalkChunk[] | null {
  const indexById = new Map<string, number>();
  messages.forEach((m, i) => indexById.set(m.id, i));

  const chunks: WalkChunk[] = [];
  for (const entry of plan) {
    const startIdx = indexById.get(entry.start_msg_id);
    const endIdx = indexById.get(entry.end_msg_id);
    if (startIdx === undefined || endIdx === undefined || startIdx > endIdx) {
      return null;
    }
    chunks.push({
      messages: messages.slice(startIdx, endIdx + 1),
      startMsgId: entry.start_msg_id,
      endMsgId: entry.end_msg_id,
      estTokens: entry.est_tokens,
    });
  }
  return chunks;
}

export interface ChunkPlanExtension {
  /** Entries to CONCATENATE onto the pinned plan. Empty when the plan
   *  already covers every current message. */
  entries: ChunkPlanEntry[];
  /** Chunks the extension adds, in the same shape a fresh plan produces. */
  chunks: WalkChunk[];
  /** Index into the live array of the last message the pinned plan
   *  covered, or -1 when that boundary is gone. */
  lastPlannedIndex: number;
  /** True when the EXTENSION ALONE exceeds the soft cap.
   *
   *  Scoped to the extension rather than the cumulative total on purpose:
   *  the confirmation this drives asks the user to authorise NEW spend,
   *  and re-prompting on a cumulative count would ask them to
   *  re-authorise chunks they already paid for every time they add a
   *  message to a long chat. */
  exceedsSoftCap: boolean;
}

/**
 * Plan the messages that arrived AFTER a pinned plan's last boundary.
 *
 * This is the one mechanism behind two features (phase 11 plan §5.1):
 * Phase 7's resume gap — a paused walk whose plan was pinned before the
 * user kept roleplaying, whose trailing messages were counted into
 * `trailingUnwalked` and then never walked — and the incremental update
 * of a completed walk. Both are the same question: what comes after the
 * last boundary, and how does it chunk?
 *
 * Returns `lastPlannedIndex: -1` when the plan's final boundary id is no
 * longer present. That is divergence, not extension, and the caller must
 * NOT treat an empty `entries` in that case as "nothing new" — check the
 * index. (`sliceChunksFromPlan` would independently return `null` for the
 * same plan, so the ordinary walk path refuses first; this is belt and
 * braces for callers that extend without slicing.)
 *
 * The pinned prefix is never rewritten. "Plan pinned ⇒ those upstream ids
 * are load-bearing" still holds for everything already walked; extension
 * only appends.
 */
export function extendChunkPlan(
  messages: IngestMessage[],
  plan: ChunkPlanEntry[]
): ChunkPlanExtension {
  const empty = (lastPlannedIndex: number): ChunkPlanExtension => ({
    entries: [],
    chunks: [],
    lastPlannedIndex,
    exceedsSoftCap: false,
  });

  const lastEntry = plan[plan.length - 1];
  if (!lastEntry) return empty(-1);

  const lastPlannedIndex = messages.findIndex((m) => m.id === lastEntry.end_msg_id);
  if (lastPlannedIndex < 0) return empty(-1);
  if (lastPlannedIndex >= messages.length - 1) return empty(lastPlannedIndex);

  // `planTranscriptChunks` is pure and takes any slice, so the tail plans
  // exactly as a fresh transcript would — same budget, same force-split,
  // same well-formed entries.
  const tail = planTranscriptChunks(messages.slice(lastPlannedIndex + 1));
  return {
    entries: tail.chunkPlan,
    chunks: tail.chunks,
    lastPlannedIndex,
    exceedsSoftCap: tail.exceedsSoftCap,
  };
}
