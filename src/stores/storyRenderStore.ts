import { create } from 'zustand';
import {
  storyApi,
  RenderLockedError,
  StoryConflictError,
  type StoryRenderFormat,
  type StoryRenderOut,
  type StoryRenderUnitStatus,
  type StoryLogEntry,
  type StorySceneOut,
} from '../api/client';
import { showToastGlobal } from '../components/ui/Toast';
import { useUsageStore } from './usageStore';
import { estimateTokens } from '../utils/tokenizer';
import { assembleRenderBrief } from '../utils/storyRender/contextAssembler';
import { selectWorldRules, sceneWindow } from '../utils/storyRender/ruleSelector';
import { checkContinuity, renderSceneProse } from '../utils/storyRender/renderScene';
import { isRefusal } from '../utils/storyRender/types';
import type { DetailedLlmCall } from '../utils/storyIngest/llmBridge';
import type { ReplayEntry } from '../utils/storyIngest/wiReplay';
import type { IngestMessage, IngestCheckpoint } from '../utils/storyIngest/types';
import type {
  BibleCharacter,
  NarrativeSection,
  RenderingHintsSection,
  Scene,
  UserVoiceSection,
  WorldRule,
} from '../types/storyBible';

/**
 * Render orchestration (productization step 3, phase 4).
 *
 * Runs the renderer in the browser on the user's own key (plan Decision
 * 6), checkpointing per SCENE so a closed tab costs at most the scene in
 * flight. Deliberately the same shape as `storyIngestStore`, which is the
 * proven implementation this phase was told to copy — a soft lock with a
 * heartbeat, abort/resume, and `usageStore` accounting.
 *
 * What is NOT the same, and must not be made the same:
 *
 * - **The lock lives on the server row, not in a JSON checkpoint.** There
 *   is exactly one `ingestion` section per project, so ingestion can keep
 *   its lock inside it; renders are a per-run table with no singular row,
 *   which is why `story_renders` carries `lock_client_id` columns.
 * - **The heartbeat runs on its OWN timer, never between model calls.**
 *   The backend states this outright: a worker that beats only after each
 *   generation goes stale mid-generation on any scene slower than the
 *   interval, and gets displaced while it is actively spending money.
 * - **A unit is `complete` only on an explicit terminal `stop`.** Prose
 *   has no parser (§3.4), so everything else is `truncated`.
 *
 * Module-init hazard, same as the other two story stores: never statically
 * import `chatStore`.
 */

/** This tab's identity for the project-wide render lock. */
const CLIENT_ID =
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `render-${Math.random().toString(16).slice(2)}`;

/**
 * Heartbeat interval.
 *
 * The server expires a lock at 120s. Beating at 30s leaves room for three
 * consecutive failures — a phone changing networks mid-render — before
 * another device can take over. Do NOT derive this from the model call:
 * see the class comment.
 */
export const RENDER_HEARTBEAT_MS = 30_000;

/** Prompt shape version stamped on each run, so a later prompt change is
 *  visible on old prose rather than silently reinterpreting it. */
export const RENDER_PROMPT_VERSION = 'render-v1';

export interface RenderRunInput {
  projectId: string;
  format?: StoryRenderFormat;
  /** Inclusive scene range. */
  sceneIdStart: string;
  sceneIdEnd: string;
  /** Every scene row, in sequence order — the caller already holds these
   *  from `GET /scenes/full`, and re-fetching per run would be a second
   *  pass over the same rows. */
  scenes: StorySceneOut[];
  /** Fact log rows, tombstones included; the assembler filters them. */
  factRows: StoryLogEntry[];
  characters: BibleCharacter[];
  /** `world.rules` — every rule in the bible. The selector decides which
   *  of them reach each scene; passing the whole set is what lets it. */
  worldRules: WorldRule[];
  userVoice: UserVoiceSection | null;
  hints: RenderingHintsSection['novel'] | null;
  narrative: NarrativeSection | null;
  /**
   * The transcript and the live lorebook entries.
   *
   * Passed IN rather than gathered here, deliberately. §4's Phase 4 row
   * says this store gathers them, but both producers live in
   * `components/works/ingestSources.ts` and one (`booksForChat`) composes
   * four client-side stores — and no store in this codebase imports from
   * `components/`. `storyIngestStore` takes exactly these two as input
   * for the same reason, and copying that is what the plan actually
   * asked for when it said to copy the proven implementation.
   */
  messages: IngestMessage[];
  wiEntries: ReplayEntry[];
  wiScanDepth?: number;
  /** Calls the model on the user's key, surfacing the terminal signal. */
  llm: DetailedLlmCall;
  model?: string | null;
  /** Displace a holder whose heartbeat has aged out. Never implicit — an
   *  expired foreign lock still 423s without it, so a retry cannot
   *  ping-pong the lock during a network hiccup. */
  takeover?: boolean;
}

export interface RenderProgress {
  done: number;
  total: number;
  /** Scenes that came back `truncated` — the export blocker (§3.4). */
  truncated: number;
  /** Scenes whose model call failed outright. */
  errored: number;
}

interface StoryRenderState {
  projectId: string | null;
  render: StoryRenderOut | null;
  isRunning: boolean;
  currentSceneId: string | null;
  progress: RenderProgress | null;
  /** Set when another device holds the lock, carrying whether it is
   *  takeable so the UI can offer that rather than just refusing. */
  lockedBy: RenderLockedError | null;
  error: string | null;
  abort: AbortController | null;

  start: (input: RenderRunInput) => Promise<boolean>;
  cancel: () => void;
  clear: () => void;
}

function abortError(): Error {
  const e = new Error('Render cancelled');
  e.name = 'AbortError';
  return e;
}

/**
 * §3.6's cross-gate, evaluated CLIENT-side because the backend reads no
 * checkpoint contents for control flow.
 *
 * Pass-aware on purpose. A gate on `ingestion.status` alone would strand
 * users: annotate parks on that same checkpoint, and an aborted pass
 * persists `paused` or `error`, so a user who started annotate — the step
 * the Render tab tells them to run first — could then never render at
 * all.
 *
 * So it refuses only for the passes that REWRITE the rows a render reads:
 * `transcript_walk` (which full-replaces scene rows) and `cold_start`
 * (which full-replaces sections). For those it refuses on `error` too,
 * because an errored walk is resumable — `resumableWalk` has no status
 * check — so resuming one does the very full-replace this gate exists to
 * prevent. That triple matches `storyStore.isBuildActiveNow`.
 */
export function ingestionBlocksRender(
  checkpoint: IngestCheckpoint | null | undefined
): boolean {
  if (!checkpoint) return false;
  const pass = checkpoint.current_pass;
  if (pass !== 'transcript_walk' && pass !== 'cold_start') return false;
  return (
    checkpoint.status === 'running' ||
    checkpoint.status === 'paused' ||
    checkpoint.status === 'error'
  );
}

/** The unit status a finished model call earns.
 *
 *  `complete` requires an EXPLICIT terminal stop. `length` is the output
 *  cap; `absent` is a stream that ended without saying why, which
 *  `collectStream` cannot distinguish from a finished one by its text.
 *  Both store as `truncated` (§3.4) — the whole reason the bridge exists. */
export function unitStatusFor(
  terminal: 'stop' | 'length' | 'other' | 'absent'
): StoryRenderUnitStatus {
  return terminal === 'stop' ? 'complete' : 'truncated';
}

export const useStoryRenderStore = create<StoryRenderState>((set, get) => ({
  projectId: null,
  render: null,
  isRunning: false,
  currentSceneId: null,
  progress: null,
  lockedBy: null,
  error: null,
  abort: null,

  clear: () => {
    // Same rule as storyIngestStore: NEVER drop a genuinely in-flight run.
    // Wiping `isRunning` here orphaned ingestion runs — Stop stopped
    // reaching them and a second press started a second paid run.
    const { isRunning, abort } = get();
    if (isRunning && abort && !abort.signal.aborted) {
      set({ error: null, lockedBy: null });
      return;
    }
    set({
      projectId: null,
      render: null,
      isRunning: false,
      currentSceneId: null,
      progress: null,
      lockedBy: null,
      error: null,
      abort: null,
    });
  },

  cancel: () => {
    get().abort?.abort();
  },

  start: async (input) => {
    const { projectId } = input;
    // Claimed SYNCHRONOUSLY, before any await: reading and setting either
    // side of a suspension point lets two clicks in one tick both start a
    // paid run.
    if (get().isRunning) return false;
    const abort = new AbortController();
    set({
      isRunning: true,
      abort,
      projectId,
      error: null,
      lockedBy: null,
      currentSceneId: null,
      progress: null,
    });

    const stillOurs = () => get().projectId === projectId && get().abort === abort;
    const finish = (patch: Partial<StoryRenderState>) => {
      if (get().abort === abort) {
        set({ isRunning: false, abort: null, currentSceneId: null, ...patch });
      }
    };

    // Scene range, resolved against the rows the caller handed us. Doing
    // this BEFORE the run is created means a bad range costs nothing.
    const ordered = [...input.scenes].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)
    );
    const startIdx = ordered.findIndex((s) => s.id === input.sceneIdStart);
    const endIdx = ordered.findIndex((s) => s.id === input.sceneIdEnd);
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
      const message = 'That scene range could not be resolved — reload and try again.';
      finish({ error: message });
      showToastGlobal(message, 'error');
      return false;
    }
    const range = ordered.slice(startIdx, endIdx + 1);

    // §3.6's cross-gate, BEFORE the run row exists — a walk that is about
    // to full-replace these scene rows makes the whole render worthless,
    // and refusing after creating the run would leave a dead row behind.
    //
    // Lazy import for the reason every reach between these stores is
    // lazy: a static edge between two zustand stores TDZ-crashes at boot.
    try {
      const mod = await import('./storyIngestStore');
      const ingest = mod.useStoryIngestStore.getState();
      // Read the CURRENT checkpoint from the server rather than whatever
      // this tab happens to hold: the walk may have been started on
      // another device since this tab last looked.
      if (ingest.projectId !== projectId || !ingest.checkpoint) {
        await ingest.loadCheckpoint(projectId);
      }
      if (ingestionBlocksRender(mod.useStoryIngestStore.getState().checkpoint)) {
        const message =
          'The story is still being built. Finish or clear that build before rendering.';
        finish({ error: message });
        showToastGlobal(message, 'warning');
        return false;
      }
    } catch (error) {
      // A failed READ must not authorise the render: the gate exists
      // because a concurrent walk silently replaces the rows this run is
      // about to read, and "we could not check" is not "it is safe".
      const message =
        error instanceof Error
          ? `Could not check the build state: ${error.message}`
          : 'Could not check the build state';
      finish({ error: message });
      showToastGlobal('Could not check the build state — try again', 'error');
      return false;
    }

    let render: StoryRenderOut;
    try {
      render = await storyApi.createRender(projectId, {
        // Minted here so a transport retry re-sends the same id and the
        // server's idempotency absorbs it — one press can never become
        // two paid runs.
        id: crypto.randomUUID(),
        format: input.format ?? 'novel',
        sceneIdStart: input.sceneIdStart,
        sceneIdEnd: input.sceneIdEnd,
        clientId: CLIENT_ID,
        takeover: input.takeover ?? false,
        model: input.model ?? null,
        promptVersion: RENDER_PROMPT_VERSION,
      });
    } catch (error) {
      if (error instanceof RenderLockedError) {
        finish({
          lockedBy: error,
          error: error.takeable
            ? 'Another device left a render running. You can take it over.'
            : 'This story is being rendered on another device.',
        });
        showToastGlobal(
          error.takeable
            ? 'Another device left a render running'
            : 'This story is being rendered on another device',
          'warning'
        );
        return false;
      }
      const message =
        error instanceof Error ? error.message : 'Could not start the render';
      finish({ error: message });
      showToastGlobal(message, 'error');
      return false;
    }

    set({ render, progress: { done: 0, total: range.length, truncated: 0, errored: 0 } });

    // `server_ts` moves on every write to the run row — the unit writes
    // bump it through the token counters — so this is the single mutable
    // token every subsequent guarded call must use.
    let renderTs = render.server_ts;
    let inputTokens = 0;
    let outputTokens = 0;

    // INDEPENDENT of the render loop, per the backend's explicit
    // instruction. A heartbeat that only fired between scenes would go
    // stale during any scene slower than the expiry and get this worker
    // displaced mid-generation.
    const heartbeat = setInterval(() => {
      if (!stillOurs()) {
        clearInterval(heartbeat);
        return;
      }
      void storyApi
        .acquireRenderLock(projectId, render.id, {
          clientId: CLIENT_ID,
          baseTs: renderTs,
        })
        .then((row) => {
          renderTs = row.server_ts;
          if (stillOurs()) set({ render: row });
        })
        .catch((error) => {
          // A missed beat is not fatal — the next one recovers it. A 409
          // is: restore bumps every run's server_ts when it marks them
          // stale, so this says the bible was replaced underneath us.
          if (error instanceof StoryConflictError) abort.abort();
        });
    }, RENDER_HEARTBEAT_MS);

    try {
      const countingLlm: DetailedLlmCall = async (msgs, opts) => {
        const sent = msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
        try {
          const result = await input.llm(msgs, { ...opts, signal: abort.signal });
          const got = estimateTokens(result.text);
          inputTokens += sent;
          outputTokens += got;
          useUsageStore.getState().recordGeneration(sent, got);
          return result;
        } catch (error) {
          // A request that reached the provider costs money even when the
          // response never arrives.
          if ((error as Error)?.name !== 'AbortError') {
            inputTokens += sent;
            useUsageStore.getState().recordGeneration(sent, 0);
          }
          throw error;
        }
      };

      let truncated = 0;
      let errored = 0;

      for (let i = 0; i < range.length; i++) {
        if (abort.signal.aborted) throw abortError();
        if (!stillOurs()) return false;

        const row = range[i];
        const scene = row.data as unknown as Scene;
        set({ currentSceneId: row.id });

        const previous = i > 0 ? (range[i - 1].data as unknown as Scene) : null;
        const rules = selectWorldRules({
          rules: input.worldRules,
          entries: input.wiEntries,
          window: sceneWindow(
            input.messages,
            scene.source.message_range.start.msg_id,
            scene.source.message_range.end.msg_id,
            input.wiScanDepth
          ),
          scanDepth: input.wiScanDepth,
        });

        const brief = assembleRenderBrief({
          scene,
          position: i + 1,
          totalScenes: range.length,
          precedingSummary: previous?.detailed_summary ?? '',
          characters: input.characters,
          userVoice: input.userVoice,
          factRows: input.factRows,
          rules,
          hints: input.hints,
          narrative: input.narrative,
        });

        if (isRefusal(brief)) {
          // The mandatory core alone busts the cap. Recorded as an errored
          // unit rather than aborting the run: the next scene may be fine,
          // and a run that stops on scene 3 of 40 has spent the user's key
          // for nothing.
          errored++;
          await writeUnit({
            projectId,
            renderId: render.id,
            sceneId: row.id,
            clientId: CLIENT_ID,
            sequence: row.sequence,
            prose: '',
            status: 'error',
            sourceSceneTs: row.server_ts,
            continuity: {
              refused: brief.reason,
              core_tokens: brief.coreTokens,
              cap_tokens: brief.capTokens,
            },
            onTs: (ts) => {
              renderTs = ts;
            },
          });
          set({ progress: { done: i + 1, total: range.length, truncated, errored } });
          continue;
        }

        let prose = '';
        let status: StoryRenderUnitStatus;
        let continuity: Record<string, unknown> | null = null;
        const spentBefore = { input: inputTokens, output: outputTokens };

        try {
          const out = await renderSceneProse({
            brief,
            llm: countingLlm,
            signal: abort.signal,
          });
          prose = out.prose;
          status = unitStatusFor(out.terminal);
          if (status === 'truncated') truncated++;

          if (abort.signal.aborted) throw abortError();

          // The continuity call is skipped on empty prose — there is
          // nothing to check — but NOT on truncated prose: a cut chapter
          // can still contradict canon, and the user may keep it.
          if (prose) {
            const facts = [
              ...brief.facts.own,
              ...brief.facts.sceneAttributed,
              ...brief.facts.unattributed,
            ];
            const verdict = await checkContinuity({
              prose,
              facts,
              llm: countingLlm,
              signal: abort.signal,
            });
            continuity = {
              verdicts: verdict.verdicts,
              // "Could not read the check" is NOT "clean" — storing them
              // the same way would report an unchecked chapter as verified.
              unreadable: verdict.unreadable,
              terminal: out.terminal,
              finish_reason: out.finishReason,
              drops: brief.drops,
              caveats: brief.caveats,
              rules_not_active: brief.rulesNotActive,
            };
          }
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') throw error;
          errored++;
          status = 'error';
          continuity = {
            error: error instanceof Error ? error.message.slice(0, 500) : 'failed',
          };
        }

        if (!stillOurs()) return false;

        await writeUnit({
          projectId,
          renderId: render.id,
          sceneId: row.id,
          clientId: CLIENT_ID,
          sequence: row.sequence,
          prose,
          status,
          sourceSceneTs: row.server_ts,
          continuity,
          // Deltas, not totals: the server accumulates them onto the run
          // row, so sending totals would multiply the bill by the scene
          // count.
          inputTokensDelta: inputTokens - spentBefore.input,
          outputTokensDelta: outputTokens - spentBefore.output,
          onTs: (ts) => {
            renderTs = ts;
          },
        });

        set({ progress: { done: i + 1, total: range.length, truncated, errored } });
      }

      const done = await storyApi.setRenderStatus(projectId, render.id, {
        status: 'complete',
        baseTs: renderTs,
      });
      renderTs = done.server_ts;
      await releaseLockQuietly(projectId, render.id, renderTs);

      finish({ render: done, progress: { done: range.length, total: range.length, truncated, errored } });
      showToastGlobal(
        truncated > 0
          ? `Rendered ${range.length} scenes — ${truncated} came back cut short`
          : errored > 0
            ? `Rendered ${range.length - errored} of ${range.length} scenes`
            : `Rendered ${range.length} ${range.length === 1 ? 'scene' : 'scenes'}`,
        truncated > 0 || errored > 0 ? 'warning' : 'success'
      );
      return true;
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      const locked = error instanceof RenderLockedError;
      const message = aborted
        ? 'Render stopped'
        : locked
          ? 'Another device took over this render.'
          : error instanceof Error
            ? error.message
            : 'The render failed';
      try {
        // Paused, not aborted: the run keeps its finished units and can be
        // resumed. `aborted` is reserved for a user discarding the run.
        const row = await storyApi.setRenderStatus(projectId, render.id, {
          status: aborted ? 'paused' : 'error',
          baseTs: renderTs,
        });
        renderTs = row.server_ts;
        if (!locked) await releaseLockQuietly(projectId, render.id, renderTs);
      } catch {
        // Nothing further to try; the in-memory error below is what the
        // user sees.
      }
      finish({
        error: aborted ? null : message,
        lockedBy: locked ? (error as RenderLockedError) : null,
      });
      showToastGlobal(message, aborted ? 'warning' : 'error');
      return false;
    } finally {
      // The ONLY place the heartbeat is cancelled — the bare `return
      // false` bail-outs above skip every other exit point, and an
      // immortal timer would keep PUTting a dead run's lock against
      // whatever project is open by then.
      clearInterval(heartbeat);
      finish({});
    }
  },
}));

/**
 * Write one unit, adopting the server's token once on a 409.
 *
 * A 409 here means the run row moved — most often our own heartbeat
 * landing between this call being built and being sent. Re-reading and
 * retrying once is right; blindly re-PUTting is not, because the second
 * attempt must carry the CURRENT base_ts or it 409s forever.
 */
async function writeUnit(opts: {
  projectId: string;
  renderId: string;
  sceneId: string;
  clientId: string;
  sequence: number;
  prose: string;
  status: StoryRenderUnitStatus;
  sourceSceneTs: number;
  continuity: Record<string, unknown> | null;
  inputTokensDelta?: number;
  outputTokensDelta?: number;
  onTs: (ts: number) => void;
}): Promise<void> {
  const body = {
    clientId: opts.clientId,
    baseTs: 0,
    sequence: opts.sequence,
    prose: opts.prose,
    status: opts.status,
    sourceSceneTs: opts.sourceSceneTs,
    continuity: opts.continuity,
    inputTokensDelta: opts.inputTokensDelta ?? 0,
    outputTokensDelta: opts.outputTokensDelta ?? 0,
  };
  try {
    await storyApi.putRenderUnit(opts.projectId, opts.renderId, opts.sceneId, body);
  } catch (error) {
    if (error instanceof StoryConflictError) {
      await storyApi.putRenderUnit(opts.projectId, opts.renderId, opts.sceneId, {
        ...body,
        baseTs: error.currentTs,
      });
      return;
    }
    throw error;
  }
  // The run row's server_ts advanced (the write folds the token deltas
  // into it), so re-read it for the next guarded call.
  try {
    const row = await storyApi.getRender(opts.projectId, opts.renderId);
    opts.onTs(row.server_ts);
  } catch {
    // Non-fatal: the next heartbeat's 409 path recovers the token.
  }
}

/** Release the lock without letting a failure mask the run's own outcome.
 *  A lock left held expires on its own in 120s; a thrown error here would
 *  turn a finished render into a reported failure. */
async function releaseLockQuietly(
  projectId: string,
  renderId: string,
  baseTs: number
): Promise<void> {
  try {
    await storyApi.releaseRenderLock(projectId, renderId, {
      clientId: CLIENT_ID,
      baseTs,
    });
  } catch {
    // Deliberately swallowed — see above.
  }
}

export { CLIENT_ID as RENDER_CLIENT_ID };
