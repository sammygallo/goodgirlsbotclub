// Ingestion pipeline types (story-state phase 6).
//
// The pipeline runs in the browser on the user's own API key (plan
// Decision 3), so every pass must be resumable: a closed tab, a dead
// laptop or a switched network should cost at most the chunk in flight.
// That makes the checkpoint — persisted server-side in the `ingestion`
// section after every unit of work — the load-bearing type here.

import type { MsgRef } from '../../types/storyBible';

/** Passes in the order they run. `annotate` is deliberately absent: its
 *  only consumer is a step-3 renderer, so running it now would spend the
 *  user's tokens on output nothing reads (plan scope). */
export type IngestPass =
  | 'cold_start'
  | 'wi_replay'
  | 'transcript_walk'
  | 'reconcile'
  | 'review';

export type IngestStatus = 'idle' | 'running' | 'paused' | 'complete' | 'error';

export interface ChunkPlanEntry {
  start_msg_id: string;
  end_msg_id: string;
  est_tokens: number;
}

/** Advisory soft lock. Prevents two devices double-spending the user's
 *  key on the same bible; a force-resume can still override it, so the
 *  server's mandatory base_ts is what actually bounds the damage. */
export interface IngestLock {
  client_id: string;
  heartbeat_at: string;
}

export interface IngestTokenUsage {
  input_tokens: number;
  output_tokens: number;
  est_cost_usd?: number | null;
}

/** The `ingestion` section's payload — mirrors IngestionSection in
 *  ggbc-backend's app/schemas/story.py (extra="forbid", so field names
 *  must match exactly). */
export interface IngestCheckpoint {
  status: IngestStatus;
  current_pass?: IngestPass | null;
  chunk_index: number;
  chunk_plan: ChunkPlanEntry[];
  last_ingested?: MsgRef | null;
  open_scene?: string | null;
  lock?: IngestLock | null;
  token_usage: IngestTokenUsage;
  prompt_version: string;
  model?: string | null;
  /** True when world-info fired-state was RECONSTRUCTED by replay rather
   *  than captured live — probability rolls and sticky/cooldown state
   *  can't be reproduced after the fact, so downstream consumers must
   *  not treat it as exact. */
  replay_approx: boolean;
  error: string;
}

export function emptyCheckpoint(promptVersion: string): IngestCheckpoint {
  return {
    status: 'idle',
    current_pass: null,
    chunk_index: 0,
    chunk_plan: [],
    last_ingested: null,
    open_scene: null,
    lock: null,
    token_usage: { input_tokens: 0, output_tokens: 0 },
    prompt_version: promptVersion,
    model: null,
    replay_approx: false,
    error: '',
  };
}

/** Minimal message shape the passes need — deliberately decoupled from
 *  chatStore's ChatMessage so this module never imports that store (its
 *  module-init cycle with lovenseStore would TDZ-crash anything that
 *  pulls it in transitively). */
export interface IngestMessage {
  /** Permanent `extra.ggbc_id` from phases 1–2. */
  id: string;
  name: string;
  isUser: boolean;
  isSystem: boolean;
  content: string;
  timestamp: number;
  swipeIdx: number;
  /** Total swipes recorded on this message (>=1). The transcript walk
   *  (phase 7) derives `alternate_swipes_available` from this mechanically
   *  — never asks the model to count swipes. */
  swipesCount: number;
}

/** What the cold-start pass reads. Everything is optional because a
 *  bible can legitimately be built from a chat whose card was deleted. */
export interface ColdStartSources {
  characterName: string;
  characterAvatar: string;
  description: string;
  personality: string;
  scenario: string;
  mesExample: string;
  firstMessage: string;
  persona?: { name: string; description: string } | null;
  lorebooks: {
    bookId: string;
    bookName: string;
    entries: {
      id: string;
      keys: string[];
      content: string;
      constant: boolean;
      /** A disabled entry never reaches a prompt, so it is not canon. */
      enabled: boolean;
    }[];
  }[];
}

export interface PassProgress {
  pass: IngestPass;
  /** 0–1 within this pass; null when the pass has no meaningful ratio. */
  fraction: number | null;
  label: string;
}

export interface LlmCall {
  (
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    opts: { maxTokens?: number; signal?: AbortSignal }
  ): Promise<string>;
}
