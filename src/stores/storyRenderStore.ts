import { create } from 'zustand';
import {
  storyApi,
  RenderLockedError,
  StoryConflictError,
  type StoryRenderFormat,
  type StoryRenderOut,
  type StoryRenderStatus,
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

/** Everything both entry points need to render a scene. Split out so
 *  `start` and `resume` cannot drift in what they feed the engine. */
export interface RenderSources {
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

export interface RenderRunInput extends RenderSources {
  projectId: string;
  format?: StoryRenderFormat;
  /** Inclusive scene range for a NEW run. */
  sceneIdStart: string;
  sceneIdEnd: string;
}

/** Continue a parked run. The range is NOT taken from here — it comes from
 *  the run row, so a resume cannot silently render a different span than
 *  the one the run was created with. */
export interface RenderResumeInput extends RenderSources {
  projectId: string;
  renderId: string;
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
  /** Continue a `paused` or `error` run, re-rendering only what is not
   *  already banked. */
  resume: (input: RenderResumeInput) => Promise<boolean>;
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
    const gate = await ingestionGateMessage(projectId);
    if (gate) {
      finish({ error: gate });
      showToastGlobal(gate, 'warning');
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

    return driveRender({
      projectId,
      render,
      fullRange: range,
      // A fresh run renders everything in range.
      toRender: new Set(range.map((r) => r.id)),
      seed: { truncated: 0, errored: 0 },
      input,
      abort,
      stillOurs,
      emit: (patch) => set(patch),
      finish,
    });
  },

  resume: async (input) => {
    const { projectId } = input;
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

    let render: StoryRenderOut;
    try {
      render = await storyApi.getRender(projectId, input.renderId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not read that render';
      finish({ error: message });
      showToastGlobal(message, 'error');
      return false;
    }

    if (render.status === 'complete' || render.status === 'aborted') {
      // Nothing to continue. Re-rendering a finished run from here would
      // silently re-bill every scene in it.
      const message = 'That render is already finished.';
      finish({ render, error: message });
      showToastGlobal(message, 'warning');
      return false;
    }

    // The range comes from the RUN ROW, not the caller: resuming a run
    // against a different range than it was created with would write
    // units the run does not own and leave its own scenes unrendered.
    const ordered = [...input.scenes].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)
    );
    const startIdx = ordered.findIndex((s) => s.id === render.scene_id_start);
    const endIdx = ordered.findIndex((s) => s.id === render.scene_id_end);
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
      // The run's anchors are gone — the scenes were re-segmented by a
      // re-walk, or deleted. Resuming would render a different story than
      // the one this run started.
      const message =
        'The scenes this render started from have changed. Start a new render.';
      finish({ render, error: message });
      showToastGlobal(message, 'error');
      return false;
    }
    const range = ordered.slice(startIdx, endIdx + 1);

    const gate = await ingestionGateMessage(projectId);
    if (gate) {
      finish({ render, error: gate });
      showToastGlobal(gate, 'warning');
      return false;
    }

    // What is already banked. ONLY `complete` counts as done:
    //
    //  - a missing unit was never rendered;
    //  - `error` is a transient failure worth one more try;
    //  - `pending` never got its call;
    //  - `truncated` is deliberately NOT re-rendered. It is a finished
    //    call whose output hit the cap, so re-running it unchanged would
    //    very likely truncate again and bill for the privilege. §3.4's
    //    remedy is an explicit per-scene re-render, which is the user's
    //    decision to make.
    const done = new Set<string>();
    let truncated = 0;
    // Errored units are RE-rendered on resume, so they start the new run's
    // tally at zero rather than carrying the old failure forward.
    const errored = 0;
    try {
      let cursor: { sequence: number; sceneId: string } | null = null;
      for (let page = 0; page < MAX_UNIT_PAGES; page++) {
        const res = await storyApi.listRenderUnits(projectId, render.id, {
          limit: UNIT_PAGE,
          ...(cursor
            ? { afterSequence: cursor.sequence, afterSceneId: cursor.sceneId }
            : {}),
        });
        for (const unit of res.items ?? []) {
          if (unit.status === 'complete') done.add(unit.scene_id);
          if (unit.status === 'truncated') {
            done.add(unit.scene_id);
            truncated++;
          }
        }
        if (
          !res.has_more ||
          res.next_after_sequence === null ||
          res.next_after_sequence === undefined ||
          res.next_after_scene_id === null ||
          res.next_after_scene_id === undefined
        ) {
          break;
        }
        cursor = {
          sequence: res.next_after_sequence,
          sceneId: res.next_after_scene_id,
        };
      }
    } catch (error) {
      // Resuming without knowing what is banked would re-render — and
      // re-bill — scenes that are already finished. Refuse instead.
      const message =
        error instanceof Error
          ? `Could not read what this render already produced: ${error.message}`
          : 'Could not read what this render already produced';
      finish({ render, error: message });
      showToastGlobal('Could not read this render’s progress — try again', 'error');
      return false;
    }

    const toRender = new Set(range.filter((r) => !done.has(r.id)).map((r) => r.id));

    // Re-take the project lock. A reload mints a new CLIENT_ID, so the
    // previous holder is this same human on the same machine — but the
    // backend still refuses without an explicit takeover, which is what
    // stops a retry loop from ping-ponging the lock. The UI asks; this
    // just carries the answer.
    let renderTs = render.server_ts;
    try {
      const locked = await storyApi.acquireRenderLock(projectId, render.id, {
        clientId: CLIENT_ID,
        baseTs: renderTs,
        takeover: input.takeover ?? false,
      });
      renderTs = locked.server_ts;
      render = locked;
    } catch (error) {
      if (error instanceof RenderLockedError) {
        finish({
          render,
          lockedBy: error,
          error: error.takeable
            ? 'Another device left this render running. You can take it over.'
            : 'This render is running on another device.',
        });
        showToastGlobal(
          error.takeable
            ? 'Another device left this render running'
            : 'This render is running on another device',
          'warning'
        );
        return false;
      }
      const message =
        error instanceof Error ? error.message : 'Could not resume the render';
      finish({ render, error: message });
      showToastGlobal(message, 'error');
      return false;
    }

    try {
      // `setStatusWithRetry`, not the raw call: the token was read before
      // the ingestion gate and a full page over the units, so another
      // device's heartbeat can legitimately have moved it in between.
      const running = await setStatusWithRetry(
        projectId,
        render.id,
        'running',
        renderTs
      );
      renderTs = running.server_ts;
      render = running;
    } catch (error) {
      // RELEASE THE LOCK WE JUST TOOK. It is per project and across
      // formats, and no heartbeat is running yet — `driveRender` creates
      // that, and we never reach it — so bailing out while holding it
      // locks every device and every format out of every render until the
      // 120s expiry, with nothing refreshing it in the meantime.
      await releaseLockQuietly(projectId, render.id, renderTs);
      const message =
        error instanceof Error ? error.message : 'Could not resume the render';
      finish({ render, error: message });
      showToastGlobal(message, 'error');
      return false;
    }

    set({
      render,
      progress: {
        done: range.length - toRender.size,
        total: range.length,
        truncated,
        errored,
      },
    });

    return driveRender({
      projectId,
      render,
      fullRange: range,
      toRender,
      seed: { truncated, errored },
      input,
      abort,
      stillOurs,
      emit: (patch) => set(patch),
      finish,
    });
  },
}));


/** Consecutive scene failures that end a run. One blip costs one scene; a
 *  provider that has stopped answering must not be billed for the input
 *  tokens of every remaining one. Same constant, and the same reasoning,
 *  as `MAX_CONSECUTIVE_ANNOTATE_FAILURES` in `storyIngestStore`. */
const MAX_CONSECUTIVE_SCENE_FAILURES = 3;

/** Units per page when reading back what a run already produced. */
const UNIT_PAGE = 200;
/** Backstop against a server that never stops saying `has_more`. */
const MAX_UNIT_PAGES = 100;

/**
 * §3.6's cross-gate as a reusable check. Returns the refusal message, or
 * null when rendering may proceed.
 *
 * A failed READ returns a refusal, deliberately: the gate exists because a
 * concurrent walk silently replaces the rows a run is about to read, and
 * "we could not check" is not "it is safe".
 *
 * Lazy import for the reason every reach between these stores is lazy — a
 * static edge between two zustand stores TDZ-crashes at boot.
 */
async function ingestionGateMessage(projectId: string): Promise<string | null> {
  try {
    const mod = await import('./storyIngestStore');
    const ingest = mod.useStoryIngestStore.getState();
    // Read the CURRENT checkpoint rather than whatever this tab holds:
    // the walk may have been started on another device since it looked.
    if (ingest.projectId !== projectId || !ingest.checkpoint) {
      await ingest.loadCheckpoint(projectId);
    }
    if (ingestionBlocksRender(mod.useStoryIngestStore.getState().checkpoint)) {
      return 'The story is still being built. Finish or clear that build before rendering.';
    }
    return null;
  } catch (error) {
    return error instanceof Error
      ? `Could not check the build state: ${error.message}`
      : 'Could not check the build state';
  }
}

/**
 * The render loop, shared by `start` and `resume`.
 *
 * Takes the FULL scene range plus the subset still to render, rather than
 * a pre-filtered slice, and that distinction is load-bearing for resume:
 *
 *  - **Position.** The prose prompt says "Scene X of Y". Numbering against
 *    the remaining slice would tell the model a resumed scene 12 is scene
 *    1 of a much shorter story.
 *  - **The preceding summary.** Scene 12's predecessor is scene 11 whether
 *    or not 11 is being re-rendered. Reading it from the slice would hand
 *    the model the wrong scene, or none.
 */
async function driveRender(opts: {
  projectId: string;
  render: StoryRenderOut;
  fullRange: StorySceneOut[];
  toRender: Set<string>;
  seed: { truncated: number; errored: number };
  input: RenderSources;
  abort: AbortController;
  stillOurs: () => boolean;
  emit: (patch: Partial<StoryRenderState>) => void;
  finish: (patch: Partial<StoryRenderState>) => void;
}): Promise<boolean> {
  const { projectId, fullRange, toRender, input, abort, stillOurs, emit, finish } = opts;
  let render = opts.render;

  let renderTs = render.server_ts;
  let inputTokens = 0;
  let outputTokens = 0;
  let truncated = opts.seed.truncated;
  let errored = opts.seed.errored;
  let consecutiveFailures = 0;

  // A COUNT of finished scenes, seeded with what a previous run banked —
  // NOT the loop's positional index. The two disagree whenever the banked
  // scenes are not a leading run of the range, and `i + 1` then emits a
  // value BELOW the seed, so the progress bar visibly goes backwards.
  //
  // Reachable without anything exotic: `start` records a failed scene as
  // an `error` unit and carries on, and `resume` re-renders `error` units,
  // so one transient failure followed by a stop is enough. A probe during
  // review produced the sequence 3 → 1 → 5 on a five-scene run.
  //
  // Counting instead of indexing also makes the final value land exactly
  // on `total`, which indexing cannot guarantee when the tail is banked.
  let completed = fullRange.length - toRender.size;

  // Novel-shaped, and it is the run's own record of how it was
  // configured. A screenplay run's snapshot is screenplay-shaped, which
  // is Phase 7's problem; until then a missing/other-shaped snapshot
  // falls back to the live section rather than rendering with nothing.
  const snapshotHints = (Object.keys(render.hints ?? {}).length > 0
    ? (render.hints as unknown as RenderingHintsSection['novel'])
    : input.hints) as RenderingHintsSection['novel'] | null;

  // INDEPENDENT of the loop, per the backend's explicit instruction. A
  // heartbeat that only fired between scenes would go stale during any
  // scene slower than the expiry and get this worker displaced
  // mid-generation, while it is actively spending the user's key.
  //
  // Beats are SERIALISED. `_claim_project_render_lock` sets
  // `server_ts = base_ts + 1`, so the heartbeat is itself a token writer:
  // two beats in flight with the same `base_ts` means the second 409s
  // through no fault of the server. That matters because the 409 handler
  // below aborts the run — a self-inflicted conflict would kill a healthy
  // paid render. Skipping a beat while one is outstanding costs nothing
  // (the next one is 30s away against a 120s expiry) and leaves 409
  // meaning only what the backend intends it to mean.
  let beatInFlight = false;
  const heartbeat = setInterval(() => {
    if (!stillOurs()) {
      clearInterval(heartbeat);
      return;
    }
    if (beatInFlight) return;
    beatInFlight = true;
    void storyApi
      .acquireRenderLock(projectId, render.id, {
        clientId: CLIENT_ID,
        baseTs: renderTs,
      })
      .then((row) => {
        renderTs = row.server_ts;
        render = row;
        if (stillOurs()) emit({ render: row });
      })
      .catch((error) => {
        // A missed beat is not fatal — the next one recovers it. A 409
        // IS: the unit write deliberately leaves this token alone, and
        // beats no longer overlap, so the only thing that moves it out
        // from under us is restore marking every run stale. That is
        // exactly the signal it is meant to carry.
        if (error instanceof StoryConflictError) abort.abort();
      })
      .finally(() => {
        beatInFlight = false;
      });
  }, RENDER_HEARTBEAT_MS);

  try {
    const countingLlm: DetailedLlmCall = async (msgs, callOpts) => {
      const sent = msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
      try {
        const result = await input.llm(msgs, { ...callOpts, signal: abort.signal });
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

    for (let i = 0; i < fullRange.length; i++) {
      if (abort.signal.aborted) throw abortError();
      if (!stillOurs()) return false;

      const row = fullRange[i];
      // Already banked by an earlier run of this render. Counted toward
      // progress, never re-billed.
      if (!toRender.has(row.id)) continue;

      const scene = row.data as unknown as Scene;
      emit({ currentSceneId: row.id });

      const previous = i > 0 ? (fullRange[i - 1].data as unknown as Scene) : null;
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
        totalScenes: fullRange.length,
        precedingSummary: previous?.detailed_summary ?? '',
        characters: input.characters,
        userVoice: input.userVoice,
        factRows: input.factRows,
        rules,
        // The RUN'S SNAPSHOT, not the live section. §3.2 stores `hints`
        // on the run precisely "so a later hints edit does not silently
        // reinterpret finished prose" — and the server already folded
        // `narrative`'s pov/tense defaults into it at create time, which
        // is why `narrative` is null here rather than passed again.
        //
        // Reading the live section instead meant a user who changed POV
        // mid-run — or simply resumed after editing hints — got half a
        // novel in first person and half in third, with nothing recording
        // that it happened.
        hints: snapshotHints,
        narrative: null,
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
        });
        completed++;
        emit({
          progress: { done: completed, total: fullRange.length, truncated, errored },
        });
        continue;
      }

      let prose = '';
      let status: StoryRenderUnitStatus;
      let continuity: Record<string, unknown> | null = null;
      const spentBefore = { input: inputTokens, output: outputTokens };

      // The prose call and the continuity call get SEPARATE try blocks.
      // Sharing one let a failed continuity check overwrite the prose
      // call's status with 'error' — and `resume` re-renders `error`
      // units, so a 429 on the cheap 1200-token check re-billed the
      // expensive 4096-token prose call and overwrote the good prose
      // already banked.
      let abortAfterProse = false;
      try {
        const out = await renderSceneProse({
          brief,
          llm: countingLlm,
          signal: abort.signal,
        });
        prose = out.prose;
        status = unitStatusFor(out.terminal);
        if (status === 'truncated') truncated++;
        consecutiveFailures = 0;
        continuity = {
          verdicts: [],
          // Not yet checked. Distinct from "checked and clean", which is
          // `unreadable: false` with an empty verdict list.
          unreadable: true,
          terminal: out.terminal,
          finish_reason: out.finishReason,
          drops: brief.drops,
          caveats: brief.caveats,
          rules_not_active: brief.rulesNotActive,
        };
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        errored++;
        consecutiveFailures++;
        status = 'error';
        continuity = {
          error: error instanceof Error ? error.message.slice(0, 500) : 'failed',
        };
      }

      // Stop pressed while the prose was in flight. The scene is FINISHED
      // and BILLED, so it is banked below before the abort propagates —
      // the store promises a closed tab costs at most the scene in
      // flight, and a scene whose prose has landed is not in flight.
      if (status !== 'error' && abort.signal.aborted) abortAfterProse = true;

      // The continuity check is skipped on empty prose (nothing to check)
      // and on an abort (the user is not waiting on a second call), but
      // NOT on truncated prose: a cut chapter can still contradict canon,
      // and the user may keep it.
      if (status !== 'error' && prose && !abortAfterProse) {
        try {
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
            ...(continuity ?? {}),
            verdicts: verdict.verdicts,
            // "Could not read the check" is NOT "clean" — storing them
            // the same way would report an unchecked chapter as verified.
            unreadable: verdict.unreadable,
          };
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') {
            abortAfterProse = true;
          } else {
            // The prose KEEPS its own status. A transient failure on the
            // check is not a failure of the scene.
            continuity = {
              ...(continuity ?? {}),
              unreadable: true,
              continuity_error:
                error instanceof Error ? error.message.slice(0, 300) : 'failed',
            };
          }
        }
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
      });

      completed++;
      emit({
        progress: { done: completed, total: fullRange.length, truncated, errored },
      });

      // Banked first, THEN the abort propagates — that ordering is the
      // whole point of deferring it.
      if (abortAfterProse) throw abortError();

      // A dead provider must not bill input tokens for every remaining
      // scene. `storyIngestStore` guards the identical case with the same
      // constant, and plan §6 says per-render spend is LARGER than
      // ingestion's.
      if (consecutiveFailures >= MAX_CONSECUTIVE_SCENE_FAILURES) {
        throw new Error(
          `The model stopped responding after ${consecutiveFailures} scenes — render stopped. Everything already rendered is saved.`
        );
      }
    }

    // Disarm the heartbeat BEFORE the terminal writes. A beat landing
    // between them moves the token and 409s the status set — which, on
    // the old code, reported a fully successful render as a failure and
    // left the project lock held until it expired.
    clearInterval(heartbeat);
    const done = await setStatusWithRetry(projectId, render.id, 'complete', renderTs);
    renderTs = done.server_ts;
    await releaseLockQuietly(projectId, render.id, renderTs);

    const total = fullRange.length;
    finish({
      render: done,
      progress: { done: total, total, truncated, errored },
    });
    showToastGlobal(
      truncated > 0
        ? `Rendered ${total} scenes — ${truncated} came back cut short`
        : errored > 0
          ? `Rendered ${total - errored} of ${total} scenes`
          : `Rendered ${total} ${total === 1 ? 'scene' : 'scenes'}`,
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
    clearInterval(heartbeat);
    try {
      // Paused, not aborted: the run keeps its finished units and can be
      // resumed. `aborted` is reserved for a user discarding the run.
      const row = await setStatusWithRetry(
        projectId,
        render.id,
        aborted ? 'paused' : 'error',
        renderTs
      );
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
    // The ONLY place the heartbeat is cancelled — the bare `return false`
    // bail-outs above skip every other exit point, and an immortal timer
    // would keep PUTting a dead run's lock against whatever project is
    // open by then.
    clearInterval(heartbeat);
    finish({});
  }
}

/**
 * Write one unit, adopting the server's token once on a 409.
 *
 * It does NOT re-read the run row afterwards, and that omission is
 * load-bearing rather than an optimisation. `put_render_unit`
 * DELIBERATELY does not bump the run's `server_ts` — the router says so
 * at length — because that token is what the HEARTBEAT is guarded on. If
 * a unit write moved it, every heartbeat after every scene would 409 and
 * the client would learn to treat 409 as routine. And 409 on the
 * heartbeat is precisely the signal restore relies on to tell a live
 * worker its bible was replaced underneath it.
 *
 * So re-reading here did two harmful things: it raced the heartbeat's own
 * update and could REGRESS `renderTs`, and by adopting whatever token the
 * row currently carried it silently re-armed the worker after a restore —
 * disarming the one mechanism that stops a render finishing against a
 * bible that no longer exists.
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
}

/**
 * Set the run's status, adopting the winner's token once on a 409.
 *
 * The heartbeat is disarmed before every call site, so a conflict here
 * should be rare — but a beat already in flight can still land first, and
 * the old code turned that into a reported failure on a render whose every
 * scene had succeeded, with the project lock stranded until it expired.
 *
 * Retrying is right even when the conflict came from a restore: staleness
 * is orthogonal to the run lifecycle (§3.2 keeps `stale_bible` in its own
 * column precisely so a finished run stays `complete`), so recording what
 * actually happened is never the wrong answer.
 */
async function setStatusWithRetry(
  projectId: string,
  renderId: string,
  status: StoryRenderStatus,
  baseTs: number
): Promise<StoryRenderOut> {
  try {
    return await storyApi.setRenderStatus(projectId, renderId, { status, baseTs });
  } catch (error) {
    if (error instanceof StoryConflictError) {
      return storyApi.setRenderStatus(projectId, renderId, {
        status,
        baseTs: error.currentTs,
      });
    }
    throw error;
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
