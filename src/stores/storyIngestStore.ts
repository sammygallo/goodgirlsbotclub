import { create } from 'zustand';
import {
  storyApi,
  StoryConflictError,
  type StorySectionOut,
} from '../api/client';
import { showToastGlobal } from '../components/ui/Toast';
import { useUsageStore } from './usageStore';
import { estimateTokens } from '../utils/tokenizer';
import { runColdStart } from '../utils/storyIngest/coldStart';
import { PROMPT_VERSION } from '../utils/storyIngest/prompts';
import { replaySupported, replayWorldInfo } from '../utils/storyIngest/wiReplay';
import type { ReplayEntry } from '../utils/storyIngest/wiReplay';
import {
  emptyCheckpoint,
  type ColdStartSources,
  type IngestCheckpoint,
  type IngestMessage,
  type IngestPass,
} from '../utils/storyIngest/types';

/**
 * Ingestion orchestration (story-state phase 6).
 *
 * Runs the bible-building passes in the browser on the user's own API
 * key (plan Decision 3), checkpointing to the server after each one so a
 * closed tab costs at most the pass in flight. Phase 6 ships passes 1
 * (cold start) and 1.5 (world-info replay); the transcript walk and
 * reconcile land in phases 7–8 behind the same checkpoint contract.
 *
 * Module-init hazard: like storyStore, this must never statically import
 * `chatStore` — `lovenseStore` subscribes to it at module scope and the
 * cycle TDZ-crashes. Callers hand us plain message/card data instead.
 */

/** Passes phase 6 runs, in order — the progress checklist renders from
 *  this, so adding phase 7's walk here is what makes it appear. */
export const PHASE6_PASSES: IngestPass[] = ['cold_start', 'wi_replay'];

export const PASS_LABELS: Record<IngestPass, string> = {
  cold_start: 'Reading the character and lorebooks',
  wi_replay: 'Checking which lore the story used',
  transcript_walk: 'Reading the chat',
  reconcile: 'Checking for contradictions',
  review: 'Ready for review',
};

/** A soft lock older than this is treated as abandoned (tab closed
 *  without cleanup) rather than as another device actively working. */
export const LOCK_STALE_MS = 5 * 60 * 1000;

export interface IngestRunInput {
  projectId: string;
  sources: ColdStartSources;
  messages: IngestMessage[];
  /** Raw `header.wi_fired` telemetry from the phase-0 capture. */
  capturedWiFired?: unknown;
  wiEntries: ReplayEntry[];
  wiScanDepth?: number;
  isGroupChat: boolean;
  /** Calls the model on the user's key. Omitted = mechanical only. */
  llm?: (
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    opts: { maxTokens?: number; signal?: AbortSignal }
  ) => Promise<string>;
  model?: string | null;
}

interface StoryIngestState {
  projectId: string | null;
  checkpoint: IngestCheckpoint | null;
  checkpointTs: number;
  isRunning: boolean;
  currentPass: IngestPass | null;
  /** Passes finished in THIS run — drives the progress checklist. */
  completed: IngestPass[];
  error: string | null;
  abort: AbortController | null;

  loadCheckpoint: (projectId: string) => Promise<void>;
  run: (input: IngestRunInput) => Promise<boolean>;
  cancel: () => void;
  /** Escape hatch: clear a wedged checkpoint (stale lock, error state,
   *  prompt-version mismatch) without touching the bible itself. */
  resetIngestState: () => Promise<boolean>;
  clear: () => void;
}

/** This tab's identity for the advisory lock. */
const CLIENT_ID =
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `client-${Math.random().toString(16).slice(2)}`;

function abortError(): Error {
  const e = new Error('Build cancelled');
  e.name = 'AbortError';
  return e;
}

function lockIsStale(checkpoint: IngestCheckpoint | null): boolean {
  const lock = checkpoint?.lock;
  if (!lock) return true;
  if (lock.client_id === CLIENT_ID) return true;
  const age = Date.now() - new Date(lock.heartbeat_at).getTime();
  return !Number.isFinite(age) || age > LOCK_STALE_MS;
}

/** Rough preflight estimate: what the cold-start pass will send. Framed
 *  as "estimated" everywhere it surfaces — it comes from a tokenizer
 *  profile, not the provider's own count. */
export function estimateColdStartTokens(sources: ColdStartSources): number {
  return (
    estimateTokens(sources.description) +
    estimateTokens(sources.personality) +
    estimateTokens(sources.mesExample) +
    400 // system prompts + JSON scaffolding, both calls
  );
}

export const useStoryIngestStore = create<StoryIngestState>((set, get) => ({
  projectId: null,
  checkpoint: null,
  checkpointTs: 0,
  isRunning: false,
  currentPass: null,
  completed: [],
  error: null,
  abort: null,

  clear: () => {
    // NEVER drop a genuinely in-flight run. Leaving the Story tab used
    // to wipe `isRunning` and the abort controller, which orphaned the
    // run: Stop no longer reached it, and pressing Build again started a
    // SECOND paid build on the user's key. Viewing state is cleared; the
    // run owns its lifecycle and cleans up when it finishes.
    //
    // "In flight" means there is a live abort controller — a bare
    // `isRunning` with nothing behind it is stale bookkeeping, and
    // preserving THAT would wedge the store into never building again.
    const { isRunning, abort } = get();
    if (isRunning && abort && !abort.signal.aborted) {
      set({ checkpoint: null, checkpointTs: 0, error: null });
      return;
    }
    set({
      projectId: null,
      checkpoint: null,
      checkpointTs: 0,
      isRunning: false,
      currentPass: null,
      completed: [],
      error: null,
      abort: null,
    });
  },

  loadCheckpoint: async (projectId) => {
    set({ projectId });
    try {
      const section = await storyApi.getSection(projectId, 'ingestion');
      if (get().projectId !== projectId) return;
      set({
        checkpoint: section.data as unknown as IngestCheckpoint,
        checkpointTs: section.server_ts,
      });
    } catch (error) {
      if (get().projectId !== projectId) return;
      // Only a genuine 404 means "never ingested". Treating a network
      // blip the same way would zero base_ts AND blind the lock check,
      // so a transient failure could authorise a second paid build.
      const message = error instanceof Error ? error.message : '';
      const missing = /not written yet|404/i.test(message);
      if (missing) {
        set({ checkpoint: null, checkpointTs: 0 });
      } else {
        throw error;
      }
    }
  },

  run: async (input) => {
    const { projectId } = input;
    // Claim the flag SYNCHRONOUSLY, before any await: reading it and
    // setting it either side of a suspension point let two clicks in one
    // tick both start a full paid build.
    if (get().isRunning) return false;
    const abort = new AbortController();
    set({ isRunning: true, abort, error: null, completed: [], projectId });

    const stillOurs = () => get().projectId === projectId && get().abort === abort;
    const finish = (patch: Partial<StoryIngestState>) => {
      // Only the owning run may clear the shared flags — a later run
      // must not have its state stomped by an older one unwinding.
      if (get().abort === abort) {
        set({ isRunning: false, abort: null, currentPass: null, ...patch });
      }
    };

    // Refuse to trample another device mid-run. The lock is advisory —
    // the server's mandatory base_ts is what actually prevents damage —
    // but respecting it stops two tabs double-spending the user's key.
    try {
      await get().loadCheckpoint(projectId);
    } catch (error) {
      finish({
        error: error instanceof Error ? error.message : 'Failed to read build state',
      });
      showToastGlobal('Could not read the build state — try again', 'error');
      return false;
    }
    const existing = get().checkpoint;
    if (existing?.status === 'running' && !lockIsStale(existing)) {
      showToastGlobal(
        'This story is already being built on another device',
        'warning'
      );
      finish({});
      return false;
    }
    // A checkpoint written by different prompts can't be safely
    // continued — half the bible would come from each. Phase 6 always
    // runs its passes from the start, so this only guards resume once
    // phase 7 lands; recording it now keeps the contract visible.
    if (existing && existing.prompt_version !== PROMPT_VERSION) {
      showToastGlobal('Story tooling changed — starting a fresh build', 'warning');
    }

    set({ currentPass: 'cold_start' });

    let checkpoint: IngestCheckpoint = {
      ...emptyCheckpoint(PROMPT_VERSION),
      status: 'running',
      current_pass: 'cold_start',
      model: input.model ?? null,
      lock: { client_id: CLIENT_ID, heartbeat_at: new Date().toISOString() },
    };

    const saveCheckpoint = async (next: IngestCheckpoint) => {
      checkpoint = next;
      try {
        const section = await putIngestion(projectId, next, get().checkpointTs);
        set({ checkpoint: next, checkpointTs: section.server_ts });
      } catch (error) {
        if (error instanceof StoryConflictError) {
          // Another writer moved the section. Adopt its token and retry
          // once so our progress isn't silently dropped.
          const winnerTs = error.currentTs;
          const section = await putIngestion(projectId, next, winnerTs);
          set({ checkpoint: next, checkpointTs: section.server_ts });
        } else {
          throw error;
        }
      }
    };

    // The lock is only as good as its heartbeat: a pass slower than
    // LOCK_STALE_MS would otherwise look abandoned while it is still
    // spending the user's money.
    const heartbeat = setInterval(() => {
      if (!get().isRunning) return;
      void saveCheckpoint({
        ...checkpoint,
        lock: { client_id: CLIENT_ID, heartbeat_at: new Date().toISOString() },
      }).catch(() => {
        // A missed heartbeat is not fatal — the next one, or the pass
        // boundary write, will refresh it.
      });
    }, LOCK_STALE_MS / 2);

    try {
      await saveCheckpoint(checkpoint);

      // ---- pass 1: cold start ---------------------------------------
      let inputTokens = 0;
      let outputTokens = 0;
      let llmAttempts = 0;
      let llmFailures = 0;
      const countingLlm = input.llm
        ? async (
            msgs: { role: 'system' | 'user' | 'assistant'; content: string }[],
            opts: { maxTokens?: number; signal?: AbortSignal }
          ) => {
            llmAttempts++;
            const sent = msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
            try {
              const reply = await input.llm!(msgs, { ...opts, signal: abort.signal });
              // Estimated, not measured — same basis as the rest of the
              // fuel gauge (see usageStore's "tokens-only, estimated").
              const got = estimateTokens(reply);
              inputTokens += sent;
              outputTokens += got;
              useUsageStore.getState().recordGeneration(sent, got);
              // Surface the running total NOW: a subtotal that only
              // appears at pass boundaries is invisible during exactly
              // the window where the user's money is being spent.
              set((st) => ({
                checkpoint: st.checkpoint
                  ? {
                      ...st.checkpoint,
                      token_usage: {
                        ...st.checkpoint.token_usage,
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                      },
                    }
                  : st.checkpoint,
              }));
              return reply;
            } catch (error) {
              // A request that reached the provider still costs money
              // even when the response never arrives, so bill the input.
              if ((error as Error)?.name !== 'AbortError') {
                llmFailures++;
                inputTokens += sent;
                useUsageStore.getState().recordGeneration(sent, 0);
              }
              throw error;
            }
          }
        : undefined;

      const cold = await runColdStart(input.sources, countingLlm, abort.signal);
      // Stop pressed while the last call was in flight: bail before
      // writing, rather than completing and toasting success.
      if (abort.signal.aborted) throw abortError();
      if (!stillOurs()) return false;

      if (cold.rulesDropped > 0) {
        // A silently truncated bible reads as a complete one.
        showToastGlobal(
          `${cold.rulesDropped} lorebook ${cold.rulesDropped === 1 ? 'entry' : 'entries'} didn't fit and were left out`,
          'warning'
        );
      }

      await writeSection(projectId, 'entities', cold.entities);
      await writeSection(projectId, 'world', cold.world);
      await writeSection(projectId, 'rendering_hints', cold.renderingHints);

      if (abort.signal.aborted) throw abortError();
      set({ completed: ['cold_start'], currentPass: 'wi_replay' });
      await saveCheckpoint({
        ...checkpoint,
        current_pass: 'wi_replay',
        token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        lock: { client_id: CLIENT_ID, heartbeat_at: new Date().toISOString() },
      });

      // ---- pass 1.5: world-info replay (no LLM) ---------------------
      let approximate = false;
      if (replaySupported(input.isGroupChat) && input.wiEntries.length > 0) {
        const replay = replayWorldInfo(input.messages, input.wiEntries, {
          scanDepth: input.wiScanDepth,
          capturedFired: input.capturedWiFired,
        });
        approximate = replay.approximate;

        // Promote rules whose entry demonstrably fired: a selective entry
        // the story was actually played under is established, not latent.
        const fired = new Set(Object.keys(replay.fired));
        const promoted = {
          ...cold.world,
          rules: (cold.world.rules ?? []).map((rule) =>
            rule.source.kind === 'lorebook_entry' &&
            fired.has(`${rule.source.ref.book_id}:${rule.source.ref.entry_id}`)
              ? { ...rule, confidence: 'explicit' as const }
              : rule
          ),
        };
        await writeSection(projectId, 'world', promoted);
      }

      if (abort.signal.aborted) throw abortError();
      set({ completed: ['cold_start', 'wi_replay'], currentPass: null });
      const allCallsFailed = llmAttempts > 0 && llmFailures === llmAttempts;
      await saveCheckpoint({
        ...checkpoint,
        status: 'complete',
        error: allCallsFailed
          ? 'The model could not be reached, so only the mechanical parts were built.'
          : '',
        current_pass: null,
        token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        replay_approx: approximate,
        // Released: a completed run holds nothing.
        lock: null,
      });

      clearInterval(heartbeat);
      finish({});
      showToastGlobal(
        allCallsFailed
          ? 'Built the basics — the model could not be reached'
          : 'Story groundwork built',
        allCallsFailed ? 'warning' : 'success'
      );
      return true;
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      const message = aborted
        ? 'Build cancelled'
        : error instanceof Error
          ? error.message
          : 'Failed to build the story';
      try {
        await saveCheckpoint({
          ...checkpoint,
          status: aborted ? 'paused' : 'error',
          error: aborted ? '' : message.slice(0, 500),
          lock: null,
        });
      } catch {
        // The checkpoint write itself failed — nothing further to try,
        // and the in-memory error below is what the user sees.
      }
      clearInterval(heartbeat);
      finish({ error: aborted ? null : message });
      showToastGlobal(message, aborted ? 'warning' : 'error');
      return false;
    }
  },

  cancel: () => {
    get().abort?.abort();
  },

  resetIngestState: async () => {
    const { projectId, checkpointTs } = get();
    if (!projectId) return false;
    const fresh = emptyCheckpoint(PROMPT_VERSION);
    try {
      let section: StorySectionOut;
      try {
        section = await putIngestion(projectId, fresh, checkpointTs);
      } catch (error) {
        if (error instanceof StoryConflictError) {
          // The other device moved the row — which is precisely the
          // situation this button exists to unstick, so adopt its token
          // and clear anyway.
          section = await putIngestion(projectId, fresh, error.currentTs);
        } else {
          throw error;
        }
      }
      set({
        checkpoint: section.data as unknown as IngestCheckpoint,
        checkpointTs: section.server_ts,
        error: null,
      });
      showToastGlobal('Build state cleared', 'success');
      return true;
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to clear build state',
        'error'
      );
      return false;
    }
  },
}));

async function putIngestion(
  projectId: string,
  checkpoint: IngestCheckpoint,
  baseTs: number
): Promise<StorySectionOut> {
  return storyApi.putSection(
    projectId,
    'ingestion',
    checkpoint as unknown as Record<string, unknown>,
    baseTs
  );
}

/**
 * Write a bible section, creating or updating as needed.
 *
 * Section writes require the CURRENT server_ts and there is no
 * unconditional path, so we read first. A 409 here means another writer
 * moved the section between our read and write; we adopt and retry once,
 * the same shape projectStore and storyStore use.
 */
async function writeSection(
  projectId: string,
  name: string,
  data: unknown
): Promise<void> {
  let baseTs = 0;
  try {
    const existing = await storyApi.getSection(projectId, name);
    baseTs = existing.server_ts;
  } catch {
    // 404 — section doesn't exist yet, so base_ts 0 (create) is right.
  }
  try {
    await storyApi.putSection(
      projectId,
      name,
      data as Record<string, unknown>,
      baseTs
    );
  } catch (error) {
    if (error instanceof StoryConflictError) {
      // Someone wrote this section between our read and our write. A
      // section PUT is a FULL REPLACE, so re-PUTting our body over the
      // winner's would silently revert their work. An ingestion pass
      // owns the sections it writes, so re-issuing with the winner's
      // token is correct HERE — but only because we are rebuilding the
      // whole section from source, not editing part of it.
      await storyApi.putSection(
        projectId,
        name,
        data as Record<string, unknown>,
        error.currentTs
      );
      return;
    }
    throw error;
  }
}

export { PROMPT_VERSION };
