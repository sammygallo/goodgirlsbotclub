import { create } from 'zustand';
import {
  storyApi,
  StoryConflictError,
  SceneBulkConflictError,
  type ProjectChatRef,
  type StorySceneOut,
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
  planTranscriptChunks,
  sliceChunksFromPlan,
  type WalkChunk,
} from '../utils/storyIngest/transcriptChunker';
import { buildMsgRef } from '../utils/storyBible/sourceRefs';
import {
  processChunk,
  type KnownCastMember,
  type OpenSceneCarry,
  type SceneBulkItem,
} from '../utils/storyIngest/transcriptWalk';
import { runUserVoiceSynthesis } from '../utils/storyIngest/userVoice';
import type { Scene } from '../types/storyBible';
import {
  emptyCheckpoint,
  type ColdStartSources,
  type IngestCheckpoint,
  type IngestMessage,
  type IngestPass,
  type LlmCall,
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

/** Passes the pipeline runs, in order — the progress checklist renders
 *  from this. */
export const PHASE6_PASSES: IngestPass[] = ['cold_start', 'wi_replay', 'transcript_walk'];

/** A walk longer than this many chunks needs an explicit confirmation
 *  before it starts (plan Phase 7: "no silent caps" on a very long RP) —
 *  checked again here even though the UI already gates on it, since this
 *  pathway spends the user's own API key. */
const WALK_CONFIRM_MESSAGE = (chunkCount: number) =>
  `This chat is long — about ${chunkCount} chunks to read, which will take a while and spend more of your key than usual. Build again to confirm.`;

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
  /** The bible's source chat — needed by the transcript walk (phase 7)
   *  to build `chat_message` SourceRefs on facts and sample passages. */
  chat: ProjectChatRef;
  /** Required once a walk would exceed `WALK_CHUNK_SOFT_CAP` chunks — the
   *  UI must get an explicit "yes, this one's long" before it starts. */
  confirmLongWalk?: boolean;
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

    // A walk already in progress must NOT be treated as a fresh build:
    // cold_start mints brand-new random character ids on every call, and
    // an already-open scene on the server references the ids from the
    // ORIGINAL run — rerunning cold_start would silently orphan them.
    // Re-initializing the checkpoint from emptyCheckpoint() here would
    // also destroy chunk_plan/chunk_index the moment pass 1 hit any
    // failure, discarding potentially hours of already-paid-for progress.
    const resumableWalk =
      existing !== null &&
      existing.prompt_version === PROMPT_VERSION &&
      existing.current_pass === 'transcript_walk' &&
      existing.chunk_index > 0 &&
      existing.chunk_plan.length > 0;

    set({
      currentPass: resumableWalk ? 'transcript_walk' : 'cold_start',
      // cold_start/wi_replay genuinely completed in the ORIGINAL run —
      // show them as done rather than reverting the checklist.
      completed: resumableWalk ? ['cold_start', 'wi_replay'] : [],
    });

    let checkpoint: IngestCheckpoint = resumableWalk
      ? {
          ...existing!,
          status: 'running',
          lock: { client_id: CLIENT_ID, heartbeat_at: new Date().toISOString() },
        }
      : {
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

      // Seeded from the checkpoint (0 for a fresh build) so a resume's
      // running total keeps accumulating rather than reverting to 0 and
      // undercounting everything spent before the tab closed.
      let inputTokens = checkpoint.token_usage.input_tokens;
      let outputTokens = checkpoint.token_usage.output_tokens;
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

      let cast: KnownCastMember[];
      let approximate = checkpoint.replay_approx;

      if (resumableWalk) {
        // Cold start / world-info replay already ran in the ORIGINAL
        // run — rerunning them would mint brand-new random character ids
        // (orphaning the ones an already-open scene references on the
        // server) and re-walk facts already accounted for. Read back the
        // cast cold_start already wrote instead of recomputing it.
        if (!countingLlm) {
          clearInterval(heartbeat);
          finish({ error: 'A connected model is needed to continue this build.' });
          showToastGlobal('A connected model is needed to continue this build', 'error');
          return false;
        }
        let entities: { characters: { id: string; canonical_name: string; aliases: string[] }[] };
        try {
          const section = await storyApi.getSection(projectId, 'entities');
          entities = section.data as unknown as typeof entities;
        } catch {
          entities = { characters: [] };
        }
        cast = entities.characters.map((c) => ({
          id: c.id,
          name: c.canonical_name,
          aliases: c.aliases,
        }));
      } else {
        // ---- pass 1: cold start ---------------------------------------
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
        if (replaySupported(input.isGroupChat) && input.wiEntries.length > 0) {
          const replay = replayWorldInfo(input.messages, input.wiEntries, {
            scanDepth: input.wiScanDepth,
            capturedFired: input.capturedWiFired,
          });
          approximate = replay.approximate;

          // Promote rules whose entry demonstrably fired: a selective
          // entry the story was actually played under is established,
          // not latent.
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
        set({ completed: ['cold_start', 'wi_replay'] });
        const allCallsFailed = llmAttempts > 0 && llmFailures === llmAttempts;

        // No model, or the model never answered a single cold-start
        // call: stop here with exactly phase 6's original behavior.
        // Reading the full transcript needs a working model far more
        // than the mechanical cold-start mapping does.
        if (!countingLlm || allCallsFailed) {
          set({ currentPass: null });
          await saveCheckpoint({
            ...checkpoint,
            status: 'complete',
            error: allCallsFailed
              ? 'The model could not be reached, so only the mechanical parts were built.'
              : '',
            current_pass: null,
            token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            replay_approx: approximate,
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
        }

        cast = cold.entities.characters.map((c) => ({
          id: c.id,
          name: c.canonical_name,
          aliases: c.aliases,
        }));
      }

      // ---- pass 2: transcript walk -----------------------------------
      set({ currentPass: 'transcript_walk' });
      checkpoint = {
        ...checkpoint,
        current_pass: 'transcript_walk',
        token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        replay_approx: approximate,
      };
      await saveCheckpoint({
        ...checkpoint,
        lock: { client_id: CLIENT_ID, heartbeat_at: new Date().toISOString() },
      });

      const walkOutcome = await runTranscriptWalkPass({
        projectId,
        chat: input.chat,
        messages: input.messages,
        cast,
        llm: countingLlm,
        checkpoint,
        priorCheckpoint: existing,
        confirmLongWalk: input.confirmLongWalk ?? false,
        abort,
        stillOurs,
        saveCheckpoint,
      });
      checkpoint = walkOutcome.checkpoint;

      // Another run took over (the user switched Works mid-flight) — its
      // owner is responsible for the outcome now, not us.
      if (walkOutcome.status === 'aborted') return false;

      if (walkOutcome.status === 'needs_confirmation') {
        const message = WALK_CONFIRM_MESSAGE(walkOutcome.chunkCount ?? 0);
        await saveCheckpoint({ ...checkpoint, status: 'paused', error: message, lock: null });
        clearInterval(heartbeat);
        finish({ error: message });
        showToastGlobal(message, 'warning');
        return false;
      }

      if (walkOutcome.status === 'diverged') {
        // "Reset ingestion state" only clears this checkpoint, not the
        // scenes/facts already written — pointing at it here would leave
        // stale, pre-divergence content in place for a rebuild to
        // duplicate on top of. The full "Reset story" action clears
        // scenes/facts too, which divergence genuinely needs.
        const message =
          'The chat changed since this build started. Use "Reset story" below, then build again.';
        await saveCheckpoint({ ...checkpoint, status: 'error', error: message, lock: null });
        clearInterval(heartbeat);
        finish({ error: message });
        showToastGlobal(message, 'error');
        return false;
      }

      if (abort.signal.aborted) throw abortError();
      if (!stillOurs()) return false;

      // ---- post-walk: user_voice synthesis ---------------------------
      const voice = await runUserVoiceSynthesis({
        messages: input.messages,
        chat: input.chat,
        llm: countingLlm,
        signal: abort.signal,
      });
      if (abort.signal.aborted) throw abortError();
      if (!stillOurs()) return false;
      await writeSection(projectId, 'user_voice', voice.section);

      set({ completed: ['cold_start', 'wi_replay', 'transcript_walk'], currentPass: null });
      const notes: string[] = [];
      if (walkOutcome.unreadableChunks > 0) {
        notes.push(
          `${walkOutcome.unreadableChunks} of ${walkOutcome.totalChunks} chunks could not be read and were skipped.`
        );
      }
      if (walkOutcome.trailingUnwalked > 0) {
        // The user kept chatting while a build was paused — the plan
        // this resume continued was pinned before those messages
        // existed, so they were never walked (see runTranscriptWalkPass).
        notes.push(
          `${walkOutcome.trailingUnwalked} newer ${walkOutcome.trailingUnwalked === 1 ? 'message wasn’t' : 'messages weren’t'} included — rebuild to pick them up.`
        );
      }
      const unreadableNote = notes.join(' ');
      await saveCheckpoint({
        ...checkpoint,
        status: 'complete',
        error: unreadableNote,
        current_pass: null,
        // Released: a completed run holds nothing.
        lock: null,
      });

      clearInterval(heartbeat);
      finish({});
      showToastGlobal(
        unreadableNote ? 'Story built — some of the chat could not be read' : 'Story built',
        unreadableNote ? 'warning' : 'success'
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

/** All-or-nothing scene batch write with the standard adopt-and-retry-once
 *  pattern: a bulk 409 lists every conflicting row's CURRENT server_ts,
 *  so a single retry with corrected base_ts values resolves it without
 *  a second round-trip per row. */
async function bulkWriteScenesWithRetry(
  projectId: string,
  scenes: SceneBulkItem[]
): Promise<StorySceneOut[]> {
  const payload = scenes.map((s) => ({
    id: s.id,
    data: s.data as unknown as Record<string, unknown>,
    baseTs: s.baseTs,
  }));
  try {
    const res = await storyApi.bulkWriteScenes(projectId, payload);
    return res.scenes;
  } catch (error) {
    if (error instanceof SceneBulkConflictError) {
      const currentTsById = new Map(error.conflicts.map((c) => [c.id, c.currentTs]));
      const retried = payload.map((s) =>
        currentTsById.has(s.id) ? { ...s, baseTs: currentTsById.get(s.id)! } : s
      );
      const res = await storyApi.bulkWriteScenes(projectId, retried);
      return res.scenes;
    }
    throw error;
  }
}

interface WalkPassOutcome {
  status: 'complete' | 'needs_confirmation' | 'diverged' | 'aborted';
  chunkCount?: number;
  checkpoint: IngestCheckpoint;
  unreadableChunks: number;
  totalChunks: number;
  /** Messages added to the chat AFTER a resumed walk's plan was pinned —
   *  the plan isn't extended mid-resume (that's incremental re-ingestion,
   *  Phase 10's job), so these are never walked. Reported rather than
   *  silently dropped; 0 for a fresh walk (whose plan always covers
   *  every current message). */
  trailingUnwalked: number;
}

/**
 * Orchestrate the transcript walk across all chunks: resume-or-plan,
 * then per chunk call `processChunk`, persist (bulk scene upsert + fact
 * append), and advance the checkpoint. Kept as a module-level helper
 * (like `writeSection`/`putIngestion` above) rather than inlined in
 * `run()`, which is already a long pass sequence.
 *
 * Resume is INTENTIONALLY conservative: it only continues when the
 * persisted `chunk_plan` still slices cleanly against the current
 * messages AND `last_ingested` still exists. Anything else is reported
 * as `diverged` rather than guessed at — reconciling a transcript that
 * changed mid-walk is Phase 10's job (incremental re-ingestion), not
 * this pass's.
 */
async function runTranscriptWalkPass(opts: {
  projectId: string;
  chat: ProjectChatRef;
  messages: IngestMessage[];
  cast: KnownCastMember[];
  llm: LlmCall;
  checkpoint: IngestCheckpoint;
  /** The checkpoint as it stood BEFORE this run() call started — used to
   *  decide whether an in-progress walk can be resumed. */
  priorCheckpoint: IngestCheckpoint | null;
  confirmLongWalk: boolean;
  abort: AbortController;
  stillOurs: () => boolean;
  saveCheckpoint: (next: IngestCheckpoint) => Promise<void>;
}): Promise<WalkPassOutcome> {
  const { projectId, chat, messages, cast, llm, abort, stillOurs, saveCheckpoint } = opts;
  let cp = opts.checkpoint;

  const resumable =
    opts.priorCheckpoint !== null &&
    opts.priorCheckpoint.prompt_version === PROMPT_VERSION &&
    opts.priorCheckpoint.current_pass === 'transcript_walk' &&
    opts.priorCheckpoint.chunk_index > 0 &&
    opts.priorCheckpoint.chunk_plan.length > 0;

  let chunks: WalkChunk[];
  let startIndex = 0;
  let openScene: OpenSceneCarry | null = null;
  let nextSequence = 0;
  let trailingUnwalked = 0;

  if (resumable) {
    const prior = opts.priorCheckpoint!;
    const sliced = sliceChunksFromPlan(messages, prior.chunk_plan);
    const lastId = prior.last_ingested?.msg_id;
    const stillExists = !lastId || messages.some((m) => m.id === lastId);
    if (!sliced || !stillExists) {
      return {
        status: 'diverged',
        checkpoint: cp,
        unreadableChunks: 0,
        totalChunks: 0,
        trailingUnwalked: 0,
      };
    }
    chunks = sliced;
    startIndex = prior.chunk_index;
    cp = { ...cp, chunk_plan: prior.chunk_plan, chunk_index: startIndex, open_scene: prior.open_scene };

    // The plan was pinned against an EARLIER fetch of this chat; the
    // user may have kept roleplaying while the build was paused. Those
    // trailing messages aren't part of any plan entry and are never
    // walked here — surfaced below rather than silently unaccounted for.
    const lastPlannedId = prior.chunk_plan[prior.chunk_plan.length - 1]?.end_msg_id;
    const lastPlannedIdx = lastPlannedId
      ? messages.findIndex((m) => m.id === lastPlannedId)
      : -1;
    trailingUnwalked = lastPlannedIdx >= 0 ? messages.length - 1 - lastPlannedIdx : 0;

    if (prior.open_scene) {
      const sceneRow = await storyApi.getScene(projectId, prior.open_scene);
      const data = sceneRow.data as unknown as Scene;
      openScene = {
        sceneId: sceneRow.id,
        sequence: sceneRow.sequence,
        title: data.title,
        summary: data.summary,
        detailedSummary: data.detailed_summary,
        participantIds: data.participants,
        factIds: data.continuity_facts_established,
        rangeStart: data.source.message_range.start,
        excludedSegments: data.source.excluded_segments,
        swipeResolutions: data.source.swipe_resolutions,
        totalMessages: data.source.total_messages,
        serverTs: sceneRow.server_ts,
      };
      nextSequence = sceneRow.sequence + 1;
    } else {
      const manifest = await storyApi.manifest(projectId);
      nextSequence = manifest.scene_count;
    }
  } else {
    const planned = planTranscriptChunks(messages);
    if (planned.exceedsSoftCap && !opts.confirmLongWalk) {
      return {
        status: 'needs_confirmation',
        chunkCount: planned.chunks.length,
        checkpoint: cp,
        unreadableChunks: 0,
        totalChunks: planned.chunks.length,
        trailingUnwalked: 0,
      };
    }
    chunks = planned.chunks;
    cp = { ...cp, chunk_plan: planned.chunkPlan, chunk_index: 0, open_scene: null };
    await saveCheckpoint(cp);
  }

  let previousTail: IngestMessage[] =
    startIndex > 0 && chunks[startIndex - 1]
      ? chunks[startIndex - 1].messages.filter((m) => !m.isSystem).slice(-2)
      : [];
  const recentFactsDigest: string[] = [];
  let unreadableChunks = 0;

  for (let i = startIndex; i < chunks.length; i++) {
    if (abort.signal.aborted) throw abortError();
    if (!stillOurs()) {
      return {
        status: 'aborted',
        checkpoint: cp,
        unreadableChunks,
        totalChunks: chunks.length,
        trailingUnwalked,
      };
    }

    const chunk = chunks[i];
    const result = await processChunk({
      chunk,
      previousTailMessages: previousTail,
      openScene,
      nextSequence,
      knownCast: cast,
      recentFactsDigest,
      chat,
      llm,
      signal: abort.signal,
    });

    if (result.parseFailed) {
      unreadableChunks++;
    } else {
      if (result.scenes.length > 0) {
        const written = await bulkWriteScenesWithRetry(projectId, result.scenes);
        if (result.openScene) {
          const match = written.find((s) => s.id === result.openScene!.sceneId);
          if (match) result.openScene.serverTs = match.server_ts;
        }
      }
      for (const fact of result.facts) {
        await storyApi.appendFact(projectId, fact as unknown as Record<string, unknown>);
        recentFactsDigest.push(fact.text);
      }
      openScene = result.openScene;
      nextSequence = result.nextSequence;
    }

    previousTail = chunk.messages.filter((m) => !m.isSystem).slice(-2);
    const lastMsg = chunk.messages[chunk.messages.length - 1];
    cp = {
      ...cp,
      chunk_index: i + 1,
      last_ingested: await buildMsgRef(lastMsg),
      open_scene: openScene?.sceneId ?? null,
      lock: { client_id: CLIENT_ID, heartbeat_at: new Date().toISOString() },
    };
    await saveCheckpoint(cp);
  }

  return {
    status: 'complete',
    checkpoint: cp,
    unreadableChunks,
    totalChunks: chunks.length,
    trailingUnwalked,
  };
}

export { PROMPT_VERSION };
