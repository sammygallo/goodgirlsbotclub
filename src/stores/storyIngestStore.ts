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
  extendChunkPlan,
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
import { groupFacts } from '../utils/storyIngest/reconcile';
import {
  buildCardContradiction,
  buildCardFact,
  buildCardCheckTargets,
  buildContradiction,
  continuityUnchanged,
  mergeContinuity,
  readCardCharacters,
  readContinuitySection,
  runCardChecks,
  runGroupJudge,
} from '../utils/storyIngest/reconcileJudge';
import { isFactTombstone } from '../types/storyBible';
import type { BibleFact, Contradiction, FactCategory, Scene } from '../types/storyBible';
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
 *  from this. `review` is deliberately absent: it is a phase-10 human
 *  checkpoint, not something this pipeline can tick off. */
export const INGEST_PASSES: IngestPass[] = [
  'cold_start',
  'wi_replay',
  'transcript_walk',
  'reconcile',
];

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
  /** Tier-1 drift detection says the chat has grown past the watermark
   *  (phase 11). Two things turn on it, and both are safety rather than
   *  optimisation:
   *
   *  - It promotes a completed build into an INCREMENTAL walk instead of
   *    a from-scratch rebuild.
   *  - It OUTRANKS `resumableReconcile`. A checkpoint parked mid-reconcile
   *    would otherwise skip the walk block entirely, so "Update story" on
   *    a bible whose last build died during reconcile would never walk the
   *    new messages and would still report success. */
  hasNewMessages?: boolean;
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

/** True only for "this section has never been written".
 *
 *  `apiRequest` surfaces the backend's detail string but not the status
 *  code, so the message is all there is to go on — the load-bearing fact
 *  is that a missing story section 404s with the literal
 *  "section not written yet" (ggbc-backend app/routers/story.py). If that
 *  string ever changes, this starts throwing on legitimate absences,
 *  which is the safe direction to fail.
 *
 *  Every caller must distinguish this from a transient failure: reading
 *  a blip as "never written" zeroes a base_ts or empties a cast, and both
 *  are silent data loss rather than a retryable error. */
function isMissingSection(error: unknown): boolean {
  return /not written yet|404/i.test(error instanceof Error ? error.message : '');
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
      if (isMissingSection(error)) {
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

    // A walk already in progress must NOT be treated as a fresh build.
    // Re-initializing the checkpoint from emptyCheckpoint() here would
    // destroy chunk_plan/chunk_index the moment pass 1 hit any failure,
    // discarding potentially hours of already-paid-for progress — and
    // rerunning cold_start re-bills its LLM pass and full-replaces the
    // `entities`, `world` and `rendering_hints` sections. (Character ids
    // themselves SURVIVE a rerun: cold start mints them deterministically
    // from stable seeds via createIdMinter, so scene `participants` stay
    // attached. Earlier comments here claimed random ids and orphaning;
    // that stopped being true when ids became derived.)
    //
    // The predicate is "the plan has been pinned", NOT "the index has
    // advanced". chunk 0's scenes and facts are committed to the server
    // BEFORE chunk_index leaves 0 (the loop in runTranscriptWalkPass
    // writes, then checkpoints — correct ordering, since checkpointing
    // first would turn an interrupt into silent chunk loss). Gating on
    // `chunk_index > 0` classified that window as a fresh build and
    // reran cold_start, reminting every character id and orphaning the
    // scene already on the server. chunk_plan is written only after
    // cold_start and wi_replay have durably landed, so it is the honest
    // signal that their ids are load-bearing.
    //
    // Note this is deliberately NOT the same predicate runTranscriptWalkPass
    // uses to decide whether to REUSE the pinned plan — see the
    // `resumable` gate there, which still requires chunk_index > 0.
    const resumableWalk =
      existing !== null &&
      existing.prompt_version === PROMPT_VERSION &&
      existing.current_pass === 'transcript_walk' &&
      existing.chunk_plan.length > 0;

    // The walk's twin, and mandatory once reconcile writes
    // `current_pass: 'reconcile'` — without it, a paused reconcile is
    // classified a FRESH build and re-pays cold_start plus the entire
    // walk. The tempting one-line fix (widening resumableWalk to accept
    // 'reconcile') is worse than it looks: runTranscriptWalkPass's own
    // inner gate still demands 'transcript_walk', so it falls through to
    // the fresh-plan branch and silently re-walks — re-bills — the whole
    // chat. Widening BOTH gates then lands in sliceChunksFromPlan, where
    // a user who deleted a chunk-boundary message after the walk finished
    // trips 'diverged' and is told to Reset story, destroying a complete,
    // fully-paid bible over a divergence reconcile does not even care
    // about (it reads the server-side fact log, never the chat).
    //
    // No status check, mirroring resumableWalk, so both 'paused' and
    // 'error' reconcile checkpoints resume cheaply.
    //
    // `hasNewMessages` narrows it (phase 11 plan §6). Skipping the walk is
    // only safe while there is nothing new to walk: on a bible whose last
    // build died during reconcile, an Update press would otherwise re-judge
    // contradictions, never touch the new messages, and still report
    // "Story built".
    const resumableReconcile =
      existing !== null &&
      existing.prompt_version === PROMPT_VERSION &&
      existing.current_pass === 'reconcile' &&
      !input.hasNewMessages;

    // Phase 11's third mode: a bible that already walked this chat to
    // completion (or parked in reconcile) and has since grown. It shares
    // resumableWalk's "cold start's output is load-bearing, read it back"
    // conclusion, but reaches it from a checkpoint whose `current_pass` is
    // null rather than 'transcript_walk'. Without this, an incremental run
    // is classified a fresh build and re-walks — re-bills — the entire
    // chat, which is the whole thing this phase exists to stop.
    const incrementalWalk =
      !resumableWalk &&
      existing !== null &&
      existing.prompt_version === PROMPT_VERSION &&
      existing.chunk_plan.length > 0 &&
      !!input.hasNewMessages;

    /** Any mode that continues an existing bible rather than rebuilding. */
    const continuingBuild = resumableWalk || resumableReconcile || incrementalWalk;

    set({
      currentPass: resumableReconcile
        ? 'reconcile'
        : resumableWalk || incrementalWalk
          ? 'transcript_walk'
          : 'cold_start',
      // Passes that genuinely completed in the ORIGINAL run — show them
      // as done rather than reverting the checklist.
      completed: resumableReconcile
        ? ['cold_start', 'wi_replay', 'transcript_walk']
        : resumableWalk || incrementalWalk
          ? ['cold_start', 'wi_replay']
          : [],
    });

    let checkpoint: IngestCheckpoint = continuingBuild
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

    // Declared HERE, above saveCheckpoint, for two reasons: the fold
    // below reads them on every write (including the very first one and
    // every heartbeat), and countingLlm updates them as it bills. Seeded
    // from the checkpoint — 0 for a fresh build, the persisted subtotal
    // for a resume, so a continued run keeps accumulating rather than
    // reverting to 0 and undercounting everything already spent.
    let inputTokens = checkpoint.token_usage.input_tokens;
    let outputTokens = checkpoint.token_usage.output_tokens;

    const saveCheckpoint = async (next: IngestCheckpoint) => {
      // The single choke point where live spend becomes durable spend.
      // Callers used to pass token_usage themselves, which meant only the
      // handful that remembered to did: the per-chunk walk saves carried
      // the totals as of walk ENTRY, so a mid-walk pause persisted a
      // figure missing most of the walk, and "resume seeds its running
      // total from the checkpoint" was quietly false. Folding here fixes
      // every write at once, including the heartbeat's.
      const folded: IngestCheckpoint = {
        ...next,
        token_usage: {
          ...next.token_usage,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      };
      checkpoint = folded;
      try {
        const section = await putIngestion(projectId, folded, get().checkpointTs);
        set({ checkpoint: folded, checkpointTs: section.server_ts });
      } catch (error) {
        if (error instanceof StoryConflictError) {
          // Another writer moved the section. Adopt its token and retry
          // once so our progress isn't silently dropped.
          const winnerTs = error.currentTs;
          const section = await putIngestion(projectId, folded, winnerTs);
          set({ checkpoint: folded, checkpointTs: section.server_ts });
        } else {
          throw error;
        }
      }
    };

    // The lock is only as good as its heartbeat: a pass slower than
    // LOCK_STALE_MS would otherwise look abandoned while it is still
    // spending the user's money.
    const heartbeat = setInterval(() => {
      // `isRunning` is a SHARED flag, so it goes true again as soon as any
      // later run starts — it cannot tell "this run is alive" from "some
      // other run is". stillOurs() is this run's own identity, and a timer
      // that has outlived its run must stop rather than PUT a dead run's
      // checkpoint (with the CURRENT project's server_ts) over whatever
      // Work is open now. The finally below is the primary guarantee; this
      // is the backstop for a timer that somehow escapes it.
      if (!stillOurs()) {
        clearInterval(heartbeat);
        return;
      }
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
      // The entities section's raw character objects, kept alongside the
      // narrowed cast: reconcile's card check needs the card-derived text
      // and provenance cold start stamped on them, which `cast` drops.
      let rawCharacters: unknown[];
      let approximate = checkpoint.replay_approx;

      if (continuingBuild) {
        // Cold start / world-info replay already ran in the ORIGINAL run.
        // Rerunning them re-bills cold start's LLM pass and full-replaces
        // `entities`, `world` and `rendering_hints` — clobbering sections
        // this bible has been reviewed against. Read back the cast
        // cold_start already wrote instead of recomputing it.
        //
        // This is also the path phase 11's incremental walk MUST take
        // (plan §5.2): falling through to the fresh branch on an Update
        // press would re-pay for the whole chat.
        if (!countingLlm) {
          finish({ error: 'A connected model is needed to continue this build.' });
          showToastGlobal('A connected model is needed to continue this build', 'error');
          return false;
        }
        type EntitiesShape = {
          characters: { id: string; canonical_name: string; aliases: string[] }[];
        };
        let entities: EntitiesShape;
        try {
          const section = await storyApi.getSection(projectId, 'entities');
          const data = section.data as unknown as Partial<EntitiesShape>;
          // A 200 carrying an unexpected body is no more trustworthy than
          // a 503 — validate before adopting, and fail with something the
          // user can act on rather than a bare TypeError from .map().
          if (!Array.isArray(data?.characters)) {
            throw new Error("The story bible's character list could not be read.");
          }
          entities = data as EntitiesShape;
        } catch (error) {
          // A transient blip is NOT "this bible has no cast". Swallowing
          // it strips participants from every scene in every remaining
          // chunk, and the per-chunk checkpoint advance makes that
          // unrecoverable without a full reset. Only a genuine absence
          // degrades to an empty cast.
          //
          // Failing here is nearly free: this read happens before the
          // chunk loop and before any LLM call, so nothing has been
          // walked and no tokens have been spent. The throw unwinds into
          // run()'s catch, which writes status 'error' and leaves
          // chunk_index untouched — pressing Build again resumes from the
          // same chunk with a correctly-read cast.
          if (!isMissingSection(error)) throw error;
          entities = { characters: [] };
        }
        cast = entities.characters.map((c) => ({
          id: c.id,
          name: c.canonical_name,
          aliases: c.aliases ?? [],
        }));
        rawCharacters = entities.characters as unknown[];
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
            replay_approx: approximate,
            lock: null,
          });
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
        rawCharacters = cold.entities.characters as unknown[];
      }

      const notes: string[] = [];
      // Facts this run's walk appended, for phase 11's group-level
      // reconcile restriction. Null means "judge everything" and is the
      // safe default — every path that cannot prove it walked the entire
      // extension leaves it null.
      let newFactIds: Set<string> | null = null;

      // A reconcile-resume skips this entire block. It must NEVER call
      // runTranscriptWalkPass (which would re-bill the whole chat) and
      // never re-synthesize user_voice — both are already durable, which
      // is exactly what `current_pass: 'reconcile'` records.
      if (!resumableReconcile) {
        // ---- pass 2: transcript walk ---------------------------------
        set({ currentPass: 'transcript_walk' });
        checkpoint = {
          ...checkpoint,
          current_pass: 'transcript_walk',
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
          incremental: incrementalWalk,
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
          finish({ error: message });
          showToastGlobal(message, 'error');
          return false;
        }

        if (abort.signal.aborted) throw abortError();
        if (!stillOurs()) return false;

        // ---- post-walk: user_voice synthesis -------------------------
        const voice = await runUserVoiceSynthesis({
          messages: input.messages,
          chat: input.chat,
          llm: countingLlm,
          signal: abort.signal,
        });
        if (abort.signal.aborted) throw abortError();
        if (!stillOurs()) return false;
        await writeSection(projectId, 'user_voice', voice.section);

        if (walkOutcome.unreadableChunks > 0) {
          notes.push(
            `${walkOutcome.unreadableChunks} of ${walkOutcome.totalChunks} chunks could not be read and were skipped.`
          );
        }

        // The walk pass is durable, so record how far the chat has been
        // read. This is the ONE write that makes every future build
        // incremental, and it goes to `meta` rather than the checkpoint
        // because "Reset ingestion state" wipes the whole `ingestion`
        // section — a user clearing a wedged build would otherwise lose
        // their read position and re-pay for the entire chat.
        //
        // Once per completed pass, not per chunk: `last_ingested` already
        // carries the fine-grained position for crash recovery, and the
        // two only disagree while a run is in flight.
        //
        // Lazy import for the same reason storyStore reaches back this
        // way — neither store may statically edge to the other.
        const lastWalked = input.messages[input.messages.length - 1];
        if (lastWalked) {
          try {
            const mod = await import('./storyStore');
            await mod.useStoryStore.getState().advanceIngestWatermark(
              {
                message_count: input.messages.length,
                last_msg: await buildMsgRef(lastWalked),
              },
              { projectId }
            );
          } catch {
            // Never fatal: a missed watermark costs a redundant re-walk
            // next time, where throwing here would discard a pass the
            // user already paid for.
          }
        }

        // Only claim to know which facts are new when this run's walk
        // actually covered the WHOLE extension. A run that resumed into
        // the middle of a pinned plan appended some of the new facts in
        // an earlier process, and judging only the ids from THIS process
        // would under-judge while reporting success. `null` falls back to
        // a full reconcile, which is safe — deterministic contradiction
        // ids plus the existing-wins merge make over-judging cost tokens
        // and nothing else.
        const coveredWholeExtension =
          walkOutcome.extensionStart !== null &&
          walkOutcome.walkedFrom <= walkOutcome.extensionStart;
        newFactIds = coveredWholeExtension ? walkOutcome.appendedFactIds : null;
      }

      // ---- pass 3: reconcile -----------------------------------------
      //
      // Checkpointed only now, mirroring "the chunk plan is pinned only
      // after cold_start landed": `current_pass: 'reconcile'` is the
      // honest signal that cold-start's ids, every walk chunk and
      // user_voice are all durable on the server.
      //
      // A crash in the window between the user_voice write and this save
      // leaves 'transcript_walk' fully advanced — the resume takes the
      // walk path, runs a zero-iteration chunk loop, reruns user_voice
      // (idempotent, one cheap call) and arrives here fresh. Correct by
      // construction rather than by a second checkpoint field.
      set({
        completed: ['cold_start', 'wi_replay', 'transcript_walk'],
        currentPass: 'reconcile',
      });
      checkpoint = { ...checkpoint, current_pass: 'reconcile' };
      await saveCheckpoint({
        ...checkpoint,
        lock: { client_id: CLIENT_ID, heartbeat_at: new Date().toISOString() },
      });

      const reconciled = await runReconcilePass({
        projectId,
        cast,
        rawCharacters,
        llm: countingLlm,
        abort,
        stillOurs,
        newFactIds,
      });
      if (reconciled === null) return false;

      if (abort.signal.aborted) throw abortError();
      if (!stillOurs()) return false;

      set({
        completed: ['cold_start', 'wi_replay', 'transcript_walk', 'reconcile'],
        currentPass: null,
      });

      if (reconciled.unreadableChecks > 0) {
        notes.push(unreadableChecksNote(reconciled.unreadableChecks));
      }
      if (reconciled.windowedGroups > 0) {
        notes.push(
          `${reconciled.windowedGroups} very large fact ${reconciled.windowedGroups === 1 ? 'group was' : 'groups were'} checked in slices, so some pairs weren’t compared.`
        );
      }
      if (reconciled.truncatedCharacters > 0) {
        notes.push(
          `${reconciled.truncatedCharacters} ${reconciled.truncatedCharacters === 1 ? 'character had' : 'characters had'} more facts than one card check could hold, so the oldest weren’t compared against the card.`
        );
      }
      if (reconciled.suppressedCardConflicts > 0) {
        notes.push(
          `${reconciled.suppressedCardConflicts} card ${reconciled.suppressedCardConflicts === 1 ? 'conflict was' : 'conflicts were'} left out because you deleted the ${reconciled.suppressedCardConflicts === 1 ? 'fact it would have cited' : 'facts they would have cited'}.`
        );
      }
      if (reconciled.dropped > 0) {
        notes.push(
          `${reconciled.dropped} ${reconciled.dropped === 1 ? 'contradiction' : 'contradictions'} didn’t fit and were left out.`
        );
      }
      const unreadableNote = notes.join(' ').slice(0, 500);
      await saveCheckpoint({
        ...checkpoint,
        status: 'complete',
        error: unreadableNote,
        current_pass: null,
        // Released: a completed run holds nothing.
        lock: null,
      });

      finish({});
      showToastGlobal(
        reconciled.found > 0
          ? `Story built — ${reconciled.found} possible ${reconciled.found === 1 ? 'contradiction' : 'contradictions'} flagged`
          : unreadableNote
            ? 'Story built — some of it could not be read'
            : 'Story built',
        unreadableNote || reconciled.found > 0 ? 'warning' : 'success'
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
      finish({ error: aborted ? null : message });
      showToastGlobal(message, aborted ? 'warning' : 'error');
      return false;
    } finally {
      // The ONLY place the heartbeat is cancelled. It used to be cleared
      // at each exit point, which missed the four bare `return false`
      // bail-outs inside this try (a lost ownership race, and an aborted
      // walk) — leaving an immortal timer that kept PUTting a dead run's
      // checkpoint every LOCK_STALE_MS/2, against whichever project was
      // open by then, with that project's server_ts as the base.
      clearInterval(heartbeat);
      // Same reasoning for the run's own flags: those bail-outs skipped
      // finish() as well, so `isRunning`/`abort` were never released and
      // clear() deliberately refuses to reset a run it believes is live —
      // wedging the store into never building again. finish() is a no-op
      // once it has already run (it checks abort identity), and a no-op
      // when a LATER run legitimately owns the store, so this is safe on
      // every path.
      finish({});
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

// ---------------------------------------------------------------------------
// Reconcile (phase 8)
// ---------------------------------------------------------------------------

/** The completion note for judge calls whose answer was unreadable.
 *
 *  Load-bearing wording: with a weak model EVERY check can be unreadable
 *  and the pass still completes, so a bare "0 contradictions" tile would
 *  read as "checked, clean" rather than "could not check". The Story tab
 *  matches this note in the persisted checkpoint to keep those two
 *  states distinguishable after the toast has faded. */
function unreadableChecksNote(count: number): string {
  return `${count} contradiction ${count === 1 ? 'check' : 'checks'} could not be read.`;
}

/** Whether a persisted completion note carries the caveat above. Exported
 *  for the Story tab — the note lives in `ingestion.error`, a plain
 *  string, so this is the one place that knows its shape. */
export function hasUnreadableChecksNote(note: string | null | undefined): boolean {
  return /contradiction checks? could not be read/i.test(note ?? '');
}

/** Facts per listFacts page. */
const FACT_PAGE_LIMIT = 200;
/** Backstop against a server that never stops saying `has_more` — at 200
 *  a page this is 100k facts, far past anything a chat produces. */
const MAX_FACT_PAGES = 500;

const FACT_CATEGORIES: FactCategory[] = ['reveal', 'introduction', 'change', 'world_rule'];

/** Page the whole fact log, shape-checking every row.
 *
 *  Rows cross the network as `unknown`; a malformed one that reached
 *  `groupFacts` would either crash on `.text` or, worse, be grouped as a
 *  fact with no subject and judged. Skipped rather than trusted.
 *
 *  `existingIds` is deliberately every LIVE row's id, including the ones
 *  the shape check rejected. It answers a different question from
 *  `facts`: "does this fact row still exist on the server?", which is
 *  what the merge's dangling-source prune needs. Building that set from
 *  the parsed list instead would make an unreadable-but-present row look
 *  deleted, and the prune would silently drop a perfectly valid
 *  contradiction that cites it. */
async function loadAllFacts(
  projectId: string
): Promise<{ facts: BibleFact[]; existingIds: Set<string> }> {
  const out: BibleFact[] = [];
  const existingIds = new Set<string>();
  let afterSeq: number | undefined;
  for (let page = 0; page < MAX_FACT_PAGES; page++) {
    const res = await storyApi.listFacts(projectId, {
      limit: FACT_PAGE_LIMIT,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
    for (const row of res.items ?? []) {
      const data = row?.data as Record<string, unknown> | undefined;
      // A tombstone is a surviving ROW, not a surviving fact (phase 10
      // §4.1 keeps it for cursor stability), so it must reach neither
      // set. Counting it as existing would tell the prune a deleted fact
      // is still live and leave every entry citing it immortal — the
      // exact opposite of what the user's delete asked for.
      if (isFactTombstone(data)) continue;
      const id =
        data && typeof data.id === 'string' ? data.id : (row?.id as string | undefined);
      if (id) existingIds.add(id);
      if (!data || typeof data !== 'object') continue;
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!id || !text) continue;
      out.push({
        id,
        text,
        category: FACT_CATEGORIES.includes(data.category as FactCategory)
          ? (data.category as FactCategory)
          : 'reveal',
        established_in: typeof data.established_in === 'string' ? data.established_in : null,
        source: (data.source ?? null) as BibleFact['source'],
        confidence: (data.confidence === 'inferred' || data.confidence === 'contested'
          ? data.confidence
          : 'explicit') as BibleFact['confidence'],
      });
    }
    if (!res.has_more || res.next_after_seq === null || res.next_after_seq === undefined) break;
    afterSeq = res.next_after_seq;
  }
  return { facts: out, existingIds };
}

/** How many recent fact texts to seed an incremental walk's digest with.
 *  Matches the rolling window `processChunk` maintains, so a continued
 *  walk starts with the same amount of context a mid-walk chunk has. */
const RECENT_FACT_SEED = 20;

/**
 * The most recent fact texts, for seeding a continued walk's duplicate
 * suppression.
 *
 * Best-effort by design: a failure here costs some redundant facts on one
 * chunk, and throwing would abort a walk over a nicety. The log has no
 * reverse cursor, so this pages forward and keeps the tail — cheap in
 * practice (HTTP only, no model calls) and bounded by MAX_FACT_PAGES.
 */
async function loadRecentFactTexts(projectId: string): Promise<string[]> {
  try {
    const texts: string[] = [];
    let afterSeq: number | undefined;
    for (let page = 0; page < MAX_FACT_PAGES; page++) {
      const res = await storyApi.listFacts(projectId, {
        limit: FACT_PAGE_LIMIT,
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      for (const row of res.items ?? []) {
        const data = row?.data as Record<string, unknown> | undefined;
        if (isFactTombstone(data)) continue;
        if (data && typeof data.text === 'string' && data.text.trim()) {
          texts.push(data.text.trim());
        }
      }
      if (!res.has_more || res.next_after_seq === null || res.next_after_seq === undefined) {
        break;
      }
      afterSeq = res.next_after_seq;
    }
    return texts.slice(-RECENT_FACT_SEED);
  } catch {
    return [];
  }
}

/**
 * Merge fresh detections into the `continuity` section.
 *
 * Deliberately NOT `writeSection`: that helper does a BLIND adopt-winner
 * re-PUT on 409, which is correct only for sections a pass rebuilds
 * wholesale. Continuity is co-owned — phase 10 writes user resolutions
 * into it and users add their own entries — so a blind re-PUT would
 * revert a resolution written seconds earlier in another tab. The 409
 * path here re-merges against the winner instead, which is the whole
 * difference.
 */
async function writeContinuityMerged(
  projectId: string,
  detected: Contradiction[],
  liveFactIds: ReadonlySet<string>,
  cardFactIds: ReadonlySet<string>
): Promise<{ dropped: number }> {
  let section: StorySectionOut | null = null;
  try {
    section = await storyApi.getSection(projectId, 'continuity');
  } catch (error) {
    // A network blip must NOT be read as "never written" — that would
    // zero base_ts and full-replace whatever is actually stored.
    if (!isMissingSection(error)) throw error;
  }

  // Outside the catch on purpose: a malformed section must throw, and
  // throwing inside would risk isMissingSection swallowing it.
  const existing = section ? readContinuitySection(section.data) : [];
  const merged = mergeContinuity(existing, detected, liveFactIds, cardFactIds);

  if (section && continuityUnchanged(existing, merged.contradictions)) {
    // The backend bumps server_ts on every PUT regardless, and a
    // gratuitous bump forces a 409-and-merge on the next write from any
    // open review tab.
    return { dropped: merged.dropped };
  }

  // Spread the read payload so a future additive backend field isn't
  // wiped by this full-replace PUT (the phase-5 content_rating lesson).
  const payload = {
    ...((section?.data as Record<string, unknown>) ?? {}),
    contradictions: merged.contradictions,
  };
  try {
    await storyApi.putSection(projectId, 'continuity', payload, section?.server_ts ?? 0);
  } catch (error) {
    if (!(error instanceof StoryConflictError)) throw error;

    // Someone wrote continuity between our read and our write. Re-merge
    // against THEIR data, not ours — the loser's job is to add its
    // detections to the winner, never to replace it.
    let winner = error.current;
    if (!winner || typeof winner.data !== 'object' || winner.data === null) {
      winner = await storyApi.getSection(projectId, 'continuity');
    }
    const winnerExisting = readContinuitySection(winner.data);
    const remerged = mergeContinuity(winnerExisting, detected, liveFactIds, cardFactIds);
    if (continuityUnchanged(winnerExisting, remerged.contradictions)) {
      return { dropped: remerged.dropped };
    }
    // A second 409 throws: the detections are recomputable on the next
    // build and the winner's data is intact, so retrying forever would
    // only spin.
    await storyApi.putSection(
      projectId,
      'continuity',
      { ...(winner.data as Record<string, unknown>), contradictions: remerged.contradictions },
      winner.server_ts ?? error.currentTs
    );
    return { dropped: remerged.dropped };
  }
  return { dropped: merged.dropped };
}

export interface ReconcilePassOutcome {
  /** Contradictions this run detected (before the merge's own drops). */
  found: number;
  unreadableChecks: number;
  windowedGroups: number;
  /** Card-backed characters with more facts than one card check could
   *  carry (see buildCardCheckTargets). */
  truncatedCharacters: number;
  /** Card conflicts dropped because the user had deleted the card fact
   *  they would have cited (phase 10 §4.4). */
  suppressedCardConflicts: number;
  dropped: number;
  llmCalls: number;
}

/**
 * The reconcile pass: judge the fact log for contradictions and write
 * them to `continuity`.
 *
 * Returns null when this run lost ownership mid-pass — the caller bails
 * bare, exactly as the walk does, because the new owner is responsible
 * for the store's state now.
 *
 * Cost is bounded at roughly 2·(batches + eligible characters) — one
 * repair round each, worst case — which is why a mid-pass resume simply
 * re-judges the whole pass rather than persisting a cursor: the
 * deterministic ids and the merge make the re-judge produce zero
 * duplicates, and it costs about one walk chunk.
 */
async function runReconcilePass(opts: {
  projectId: string;
  cast: KnownCastMember[];
  rawCharacters: unknown[];
  llm: LlmCall;
  abort: AbortController;
  stillOurs: () => boolean;
  /** Phase 11: ids this run's walk just appended. Null = judge
   *  everything, which is what every full build does. */
  newFactIds?: ReadonlySet<string> | null;
}): Promise<ReconcilePassOutcome | null> {
  const { projectId, cast, rawCharacters, llm, abort, stillOurs } = opts;

  // The whole log, every time — including on an incremental run.
  //
  // This is NOT a missed optimisation. `mergeContinuity`'s dangling-source
  // prune drops any unresolved agent entry whose sources are not all in
  // `liveFactIds`, so handing it a partial id set would silently delete
  // valid contradictions that cite older facts. `cardFactIds` likewise has
  // to cover EARLIER builds' card facts. What an incremental run saves is
  // judge calls (model tokens), not HTTP.
  const { facts: allFacts, existingIds } = await loadAllFacts(projectId);
  if (abort.signal.aborted) throw abortError();
  if (!stillOurs()) return null;

  // HARD INVARIANT, and the reason this filter is applied ONCE here
  // rather than at each consumer: reconcile's own synthetic card facts
  // (§6) must never be fed back into either the group judge or the card
  // check. Filtering only one of them would let a re-run litigate card
  // facts against card facts and shift every batch under them.
  const facts = allFacts.filter((f) => f.source?.kind !== 'card_field');

  // Group the FULL log, then judge only the groups a new fact landed in.
  //
  // Restricting at the FACT level instead — grouping only post-watermark
  // facts — looks equivalent and is not: `groupFacts` drops singleton
  // groups, so a lone new fact contradicting a lone old one never forms a
  // pair and the run reports "no contradictions". That new-vs-old case is
  // the entire point of an incremental reconcile, so the restriction has
  // to happen at the group level, after grouping.
  //
  // Cast matters here too: attribution is text-derived, so a walk that
  // introduced a new character can re-attribute previously world-bucketed
  // old facts. Group membership is therefore computed against the CURRENT
  // cast every run and never cached.
  const allGroups = groupFacts(facts, cast);
  const newFactIds = opts.newFactIds;
  const groups =
    newFactIds && newFactIds.size > 0
      ? allGroups.filter((g) => g.facts.some((f) => newFactIds.has(f.id)))
      : allGroups;

  const groupOutcome = await runGroupJudge({
    groups,
    cast,
    llm,
    signal: abort.signal,
  });
  if (abort.signal.aborted) throw abortError();
  if (!stillOurs()) return null;

  // Card checks follow the same rule: only characters whose attributed
  // facts actually changed. The recent-40 window stays computed over ALL
  // their facts, so the card claim is still judged against the character's
  // full picture rather than just the new lines.
  const allCardTargets = buildCardCheckTargets(
    readCardCharacters(rawCharacters),
    facts,
    cast
  );
  const cardTargets =
    newFactIds && newFactIds.size > 0
      ? allCardTargets.filter((t) => t.facts.some((f) => newFactIds.has(f.id)))
      : allCardTargets;

  const cardOutcome = await runCardChecks({
    targets: cardTargets,
    llm,
    signal: abort.signal,
  });
  if (abort.signal.aborted) throw abortError();
  if (!stillOurs()) return null;

  const detected: Contradiction[] = groupOutcome.detected.map(buildContradiction);
  const liveFactIds = new Set(existingIds);

  // The card fact is appended BEFORE the section write so `sources` never
  // dangles, even transiently: a crash between the two leaves an orphan
  // fact row (harmless, and re-derived to the same id next run) rather
  // than a contradiction citing a fact that does not exist.
  const cardContradictions: { cardFactRowId: string }[] = [];
  let suppressedCardConflicts = 0;
  for (const conflict of cardOutcome.detected) {
    const fact = buildCardFact(conflict);
    const row = await storyApi.appendFact(
      projectId,
      fact as unknown as Record<string, unknown>
    );
    if (abort.signal.aborted) throw abortError();
    if (!stillOurs()) return null;
    // The card fact's id is deterministic and the append is idempotent by
    // id, so a card fact the user DELETED comes back as its tombstone.
    // Citing it would resurrect the exact claim they adjudicated away, on
    // every rebuild, with no way to make it stop. The delete IS the
    // resolution: drop the conflict and report the count below.
    if (isFactTombstone(row?.data)) {
      suppressedCardConflicts++;
      continue;
    }
    // Append-only: re-posting a known id returns the STORED row, so this
    // is the id to cite even on a re-run that reworded the claim.
    const rowId = typeof row?.id === 'string' ? row.id : fact.id;
    liveFactIds.add(rowId);
    cardContradictions.push({ cardFactRowId: rowId });
    detected.push(buildCardContradiction(conflict, rowId));
  }

  // Collapse anything that landed on the same id (the same pair reached
  // from two entity groups, or a card conflict re-derived twice) before
  // the merge sees it. First wins — they are byte-identical by
  // construction anyway.
  const byId = new Map<string, Contradiction>();
  for (const c of detected) if (!byId.has(c.id)) byId.set(c.id, c);
  const unique = [...byId.values()];

  // Every card fact in the bible, not just this run's: the merge compares
  // against entries an EARLIER build wrote, whose card facts are already
  // in the log.
  const cardFactIds = new Set(
    allFacts.filter((f) => f.source?.kind === 'card_field').map((f) => f.id)
  );
  for (const c of cardContradictions) cardFactIds.add(c.cardFactRowId);

  const { dropped } = await writeContinuityMerged(
    projectId,
    unique,
    liveFactIds,
    cardFactIds
  );

  return {
    found: unique.length,
    unreadableChecks: groupOutcome.unreadableBatches + cardOutcome.unreadableChecks,
    windowedGroups: groupOutcome.windowedGroups,
    truncatedCharacters: cardOutcome.truncatedCharacters,
    suppressedCardConflicts,
    dropped,
    llmCalls: groupOutcome.llmCalls + cardOutcome.llmCalls,
  };
}

interface WalkPassOutcome {
  status: 'complete' | 'needs_confirmation' | 'diverged' | 'aborted';
  chunkCount?: number;
  checkpoint: IngestCheckpoint;
  unreadableChunks: number;
  totalChunks: number;
  /** Chunks this pass actually walked, and the plan index it started
   *  from. Phase 11's reconcile needs to know whether the walk covered
   *  the WHOLE extension: a run that resumed into the middle of a plan
   *  appended only some of the new facts, and judging only "new" facts
   *  from a partial set would under-judge while reporting success. */
  walkedFrom: number;
  extensionStart: number | null;
  /** Fact ids THIS process appended. Only meaningful when the pass
   *  covered the whole extension — see `run()`'s `coveredWholeExtension`. */
  appendedFactIds: Set<string>;
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
 * as `diverged` rather than guessed at — a transcript whose EXISTING
 * messages changed is not something this pass will try to repair.
 *
 * What it now does handle (phase 11) is a transcript that only GREW:
 * the pinned plan is reused AND extended over everything past its last
 * boundary. That single mechanism serves two features that are really
 * one computation — Phase 7's resume gap (a paused walk whose plan was
 * pinned before the user kept roleplaying) and the incremental update
 * of a completed walk.
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
  /** Phase 11: continue a bible whose walk already finished, over the
   *  messages added since. Reuses the pinned plan the same way a resume
   *  does, but starts from a checkpoint whose `current_pass` is null. */
  incremental: boolean;
  abort: AbortController;
  stillOurs: () => boolean;
  saveCheckpoint: (next: IngestCheckpoint) => Promise<void>;
}): Promise<WalkPassOutcome> {
  const { projectId, chat, messages, cast, llm, abort, stillOurs, saveCheckpoint } = opts;
  let cp = opts.checkpoint;
  const appendedFactIds = new Set<string>();

  // Deliberately a DIFFERENT predicate from run()'s `resumableWalk`,
  // which answers "are cold_start's ids durable?" and so drops the index
  // condition. This one answers "should the pinned plan be reused, and
  // the walk restarted mid-way through it?" — which additionally needs
  // chunk_index > 0.
  //
  // Keeping the index condition here is what stops a resume at index 0
  // from being dead-ended: sliceChunksFromPlan returns null the moment
  // any pinned boundary msg_id is missing, which routes run() into the
  // 'diverged' branch and tells the user to Reset story — destroying
  // their whole bible. At index 0 nothing has been checkpointed, so
  // there is nothing to reconcile: fall through to the fresh-plan branch
  // below, re-plan from the CURRENT messages (picking up anything the
  // user added while the build was broken), and leave nextSequence at 0
  // and openScene null, exactly as a first run would.
  const resumable =
    opts.priorCheckpoint !== null &&
    opts.priorCheckpoint.prompt_version === PROMPT_VERSION &&
    opts.priorCheckpoint.chunk_plan.length > 0 &&
    ((opts.priorCheckpoint.current_pass === 'transcript_walk' &&
      opts.priorCheckpoint.chunk_index > 0) ||
      // Phase 11: a finished (or reconcile-parked) walk being continued
      // over new messages. There is no chunk_index condition because a
      // completed walk's index already sits at chunk_plan.length, which
      // is exactly where the extension begins.
      opts.incremental);

  let chunks: WalkChunk[];
  let startIndex = 0;
  let openScene: OpenSceneCarry | null = null;
  let nextSequence = 0;
  let extensionStart: number | null = null;

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
        walkedFrom: 0,
        extensionStart: null,
        appendedFactIds,
      };
    }

    // Extend the pinned plan over everything the user added after it was
    // pinned. This is the fix for Phase 7's resume gap: those messages
    // used to be counted, reported as "rebuild to pick them up", and then
    // never walked.
    //
    // The pinned prefix is never rewritten — extension only appends — so
    // "plan pinned ⇒ those upstream ids are load-bearing" still holds for
    // everything already walked.
    const extension = extendChunkPlan(messages, prior.chunk_plan);
    if (extension.lastPlannedIndex < 0) {
      // sliceChunksFromPlan would already have caught this; belt and
      // braces so an empty extension can never be misread as "nothing new".
      return {
        status: 'diverged',
        checkpoint: cp,
        unreadableChunks: 0,
        totalChunks: 0,
        walkedFrom: 0,
        extensionStart: null,
        appendedFactIds,
      };
    }

    if (extension.chunks.length > 0) {
      // The cap is scoped to the EXTENSION, not the cumulative plan: this
      // confirmation authorises new spend, and asking again for chunks the
      // user already paid for would re-prompt on every message they add to
      // a long chat.
      if (extension.exceedsSoftCap && !opts.confirmLongWalk) {
        return {
          status: 'needs_confirmation',
          chunkCount: extension.chunks.length,
          checkpoint: cp,
          unreadableChunks: 0,
          totalChunks: extension.chunks.length,
          walkedFrom: 0,
          extensionStart: null,
          appendedFactIds,
        };
      }
      extensionStart = prior.chunk_plan.length;
    }

    // Re-open the tail scene only for a walk that is genuinely in flight.
    //
    // `open_scene` alone is the WRONG discriminator: nothing force-closes
    // the final chunk's scene, so a completed bible whose chat ends
    // mid-scene routinely carries a non-null open_scene. Re-opening on
    // that would let an incremental run rewrite the tail scene's title and
    // summary from the model — over a title the user may have set in the
    // phase-10 review UI. A walk parked at `transcript_walk` has had the
    // review surface gated shut the whole time, so nothing there can have
    // been reviewed.
    const reopenSceneId =
      prior.current_pass === 'transcript_walk' ? (prior.open_scene ?? null) : null;

    chunks = [...sliced, ...extension.chunks];
    startIndex = prior.chunk_index;
    cp = {
      ...cp,
      chunk_plan: [...prior.chunk_plan, ...extension.entries],
      chunk_index: startIndex,
      open_scene: reopenSceneId,
    };
    // Persist the EXTENDED plan before the loop consumes startIndex — the
    // old code echoed the prior plan here, so a crash mid-extension would
    // resume against a plan that no longer covered the tail.
    if (extension.entries.length > 0) await saveCheckpoint(cp);

    if (reopenSceneId) {
      const sceneRow = await storyApi.getScene(projectId, reopenSceneId);
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
      // Take the max rather than trusting open_scene to be the tail.
      // processChunk now guarantees it is, but a checkpoint written by an
      // older build may still point at a non-tail row — and seeding from
      // that alone re-issues sequence numbers already on the server.
      // scene_count is a plain COUNT of scene rows, so it exceeds
      // max(sequence) whenever duplicates already exist.
      const manifest = await storyApi.manifest(projectId);
      nextSequence = Math.max(sceneRow.sequence + 1, manifest.scene_count);
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
        walkedFrom: 0,
        extensionStart: null,
        appendedFactIds,
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
  // Seeded from the fact log when this run continues an existing bible.
  // An incremental walk of five new messages would otherwise start with
  // zero fact context, and the id seed includes the fact text, so
  // near-duplicates do NOT collide and do NOT dedupe — the digest is the
  // only thing stopping the model from re-emitting what it already knows.
  const recentFactsDigest: string[] =
    startIndex > 0 ? await loadRecentFactTexts(projectId) : [];
  let unreadableChunks = 0;

  for (let i = startIndex; i < chunks.length; i++) {
    if (abort.signal.aborted) throw abortError();
    if (!stillOurs()) {
      return {
        status: 'aborted',
        checkpoint: cp,
        unreadableChunks,
        totalChunks: chunks.length,
        walkedFrom: startIndex,
        extensionStart,
        appendedFactIds,
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
        appendedFactIds.add(fact.id);
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
    walkedFrom: startIndex,
    extensionStart,
    appendedFactIds,
  };
}

export { PROMPT_VERSION };
