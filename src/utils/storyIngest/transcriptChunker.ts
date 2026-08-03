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
 * This deliberately does not attempt reconciliation (that is Phase 10's
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
