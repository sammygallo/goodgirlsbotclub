/**
 * @vitest-environment jsdom
 *
 * Render tab component suite (story-state step 3, phase 5).
 *
 * The second DOM test in this repo, and it earns the cost the same way
 * `StoryTab.test.tsx` does: what it pins is only true once the component,
 * three stores and the render engine are wired together, and getting it
 * wrong is expensive in a way a unit test cannot see.
 *
 * The rules worth that cost:
 *
 *   - **A locked bible must NOT disable the render path.** §3.3 narrows the
 *     lock invariant to user-authored bible edits and exempts render and
 *     annotate. `writesDisabled` is a three-term composite that carries
 *     `canonLocked`, so the obvious mistake — reaching for it, as every
 *     other Works surface does — would disable this tab in exactly the
 *     state §1 describes a user rendering FROM. Nothing downstream refuses
 *     on the tab's behalf, because the backend does not enforce the lock at
 *     all.
 *   - **A live or resumable WALK must disable it**, through the store's own
 *     `ingestionBlocksRender` rather than a second copy of the rule — the
 *     walk full-replaces the very scene rows a run reads, one scene at a
 *     time, on the user's key.
 *   - **Take over is offered only when the server says the lock is
 *     takeable**, and never taken implicitly. A live holder is another
 *     device actively spending money on these same chapters.
 *   - **The preflight's estimate and the run price the same range.**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project } from '../../api/client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const listRenders = vi.fn();
const listRenderUnits = vi.fn();
const readRenderProse = vi.fn();
const deleteRender = vi.fn();

vi.mock('../../api/client', () => ({
  storyApi: {
    listRenders: (...a: unknown[]) => listRenders(...a),
    listRenderUnits: (...a: unknown[]) => listRenderUnits(...a),
    readRenderProse: (...a: unknown[]) => readRenderProse(...a),
    deleteRender: (...a: unknown[]) => deleteRender(...a),
  },
}));

const showToastGlobal = vi.fn();
vi.mock('../ui/Toast', () => ({
  showToastGlobal: (...a: unknown[]) => showToastGlobal(...a),
}));

// The reader and the hints editor have their own concerns; stubbing them
// keeps every query in this file unambiguous. `RenderProgressCard` is REAL —
// the takeover affordance lives in it and reads the render store directly,
// so mocking it would mock away half of what is under test.
vi.mock('./RenderReader', () => ({
  RenderReader: ({ onRerender }: { onRerender: (id: string) => void }) => (
    <div data-testid="reader">
      <button type="button" onClick={() => onRerender('s1')}>
        rerender s1
      </button>
    </div>
  ),
}));
vi.mock('./RenderHintsEditor', () => ({
  RenderHintsEditor: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="hints-editor" data-disabled={disabled ? 'yes' : 'no'} />
  ),
}));
vi.mock('./StartRenderModal', () => ({
  StartRenderModal: ({
    estimate,
    sceneRangeLabel,
    onStart,
  }: {
    estimate: { scenes: number };
    sceneRangeLabel: string;
    onStart: (id: string | null) => void;
  }) => (
    <div data-testid="render-preflight" data-scenes={estimate.scenes}>
      <span>{sceneRangeLabel}</span>
      <button type="button" onClick={() => onStart(null)}>
        confirm render
      </button>
    </div>
  ),
}));
vi.mock('./StartIngestModal', () => ({
  StartIngestModal: ({ onStart }: { onStart: (id: string | null) => void }) => (
    <div data-testid="annotate-modal">
      <button type="button" onClick={() => onStart(null)}>
        confirm annotate
      </button>
    </div>
  ),
}));

const gatherIngestInputs = vi.fn(async () => ({ messages: [], capturedWiFired: null }));
vi.mock('./ingestSources', () => ({
  gatherIngestInputs: (...a: unknown[]) => gatherIngestInputs(...a),
  replayEntriesFrom: () => [],
  booksForChat: () => [],
}));

vi.mock('../../utils/storyIngest/llmBridge', () => ({
  makeLlmCall: () => vi.fn(),
  makeDetailedLlmCall: () => vi.fn(),
}));
vi.mock('../../utils/storyIngest/annotate', () => ({
  estimateAnnotateTokens: () => 100,
}));

// --- stores ----------------------------------------------------------------

function selectorStore<T extends Record<string, unknown>>(get: () => T) {
  return Object.assign((selector?: (s: T) => unknown) => {
    const state = get();
    return selector ? selector(state) : state;
  }, { getState: get });
}

let storyState: Record<string, unknown>;
vi.mock('../../stores/storyStore', () => ({
  useStoryStore: selectorStore(() => storyState),
}));

let ingestState: Record<string, unknown>;
vi.mock('../../stores/storyIngestStore', () => ({
  useStoryIngestStore: selectorStore(() => ingestState),
}));

let renderState: Record<string, unknown>;
vi.mock('../../stores/storyRenderStore', async () => {
  // `ingestionBlocksRender` is the REAL one: it is the gate under test, and
  // the whole point of the tab importing it from the store is that the two
  // cannot disagree. Mocking it would mock away the property being pinned.
  const actual = await vi.importActual<typeof import('../../stores/storyRenderStore')>(
    '../../stores/storyRenderStore'
  );
  return {
    ingestionBlocksRender: actual.ingestionBlocksRender,
    RENDER_CLIENT_ID: 'test-client',
    useStoryRenderStore: selectorStore(() => renderState),
  };
});

function simpleStore(state: Record<string, unknown>) {
  return Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(state) : state,
    { getState: () => state }
  );
}
vi.mock('../../stores/characterStore', () => ({
  useCharacterStore: simpleStore({ characters: [{ avatar: 'Ivy.png', name: 'Ivy' }] }),
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: simpleStore({ activeProvider: 'p', activeModel: 'm' }),
}));
vi.mock('../../stores/connectionProfileStore', () => ({
  useConnectionProfileStore: simpleStore({ getProfile: () => null }),
}));
vi.mock('../../stores/worldInfoStore', () => ({
  useWorldInfoStore: simpleStore({ scanDepth: 2 }),
}));

const { RenderTab } = await import('./RenderTab');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT = { character_avatar: 'Ivy.png', file_name: 'chat1.jsonl' };
const PROJECT = {
  id: 'p1',
  name: 'A Work',
  chats: [CHAT],
  characters: ['Ivy.png'],
} as unknown as Project;

const MREF = (id: string) => ({
  msg_id: id,
  swipe_idx: 0,
  fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
});

function sceneRow(id: string, sequence: number, annotated = true) {
  return {
    id,
    sequence,
    server_ts: 5,
    created_at: 'x',
    updated_at: 'x',
    data: {
      id,
      sequence,
      title: `Scene ${sequence + 1}`,
      summary: 's',
      detailed_summary: 'd',
      setting: { location_ref: null, time_ref: null, atmosphere: '' },
      participants: [],
      pov_character: null,
      function: annotated ? { beat: 'rising', tension: 3 } : null,
      source: {
        message_range: { start: MREF(`m${sequence}`), end: MREF(`m${sequence}`) },
        total_messages: 1,
        swipe_resolutions: [],
        excluded_segments: [],
      },
      continuity_facts_established: [],
      transformations: null,
      annotations: {
        user_notes: '',
        author_intent: '',
        flagged_issues: [],
        stale_source: false,
      },
    },
  };
}

const SCENES = [sceneRow('s1', 0), sceneRow('s2', 1)];

const storeActions = {
  load: vi.fn(async () => {}),
  loadSection: vi.fn(async () => {}),
  loadAllScenesFull: vi.fn(async () => SCENES),
  loadAllFactsById: vi.fn(async () => new Map()),
};

const renderActions = {
  start: vi.fn(async () => true),
  resume: vi.fn(async () => true),
  rerenderScene: vi.fn(async () => true),
  clear: vi.fn(),
  cancel: vi.fn(),
};

const runAnnotate = vi.fn(async () => true);
const loadCheckpoint = vi.fn(async () => {});

function setup(
  opts: {
    canonLocked?: boolean;
    checkpointStatus?: string | null;
    currentPass?: string | null;
    scenes?: ReturnType<typeof sceneRow>[];
    sceneCount?: number;
    renderRunning?: boolean;
    lockedBy?: { takeable: boolean } | null;
    renders?: Record<string, unknown>[];
    renderRow?: Record<string, unknown> | null;
  } = {}
) {
  const scenes = opts.scenes ?? SCENES;
  storeActions.loadAllScenesFull.mockResolvedValue(scenes);

  storyState = {
    manifest: {
      project_id: 'p1',
      sections: [],
      scene_count: opts.sceneCount ?? scenes.length,
      fact_count: 0,
      edit_count: 0,
    },
    sections: {
      meta: {
        section: 'meta',
        server_ts: 1,
        data: {
          source: { chat: { kind: 'chat', ref: CHAT } },
          ...(opts.canonLocked ? { canon_locked_at: '2026-08-10T12:00:00Z' } : {}),
        },
      },
      entities: { section: 'entities', server_ts: 1, data: { characters: [] } },
      world: { section: 'world', server_ts: 1, data: { rules: [] } },
    },
    isSaving: false,
    ...storeActions,
  };

  ingestState = {
    checkpoint:
      opts.checkpointStatus === undefined && opts.currentPass === undefined
        ? null
        : {
            status: opts.checkpointStatus ?? 'complete',
            current_pass: opts.currentPass ?? null,
            chunk_plan: [],
          },
    isRunning: false,
    runAnnotate,
    loadCheckpoint,
  };

  renderState = {
    projectId: 'p1',
    render: opts.renderRow ?? null,
    isRunning: opts.renderRunning ?? false,
    currentSceneId: null,
    progress: null,
    lockedBy: opts.lockedBy ?? null,
    error: opts.lockedBy ? 'Another device left a render running.' : null,
    abort: null,
    ...renderActions,
  };

  listRenders.mockResolvedValue({ items: opts.renders ?? [], has_more: false });
}

/** Mount and let the scene/render reads settle. */
async function mount(canManage = true) {
  render(<RenderTab project={PROJECT} canManage={canManage} />);
  await waitFor(() => expect(storeActions.loadAllScenesFull).toHaveBeenCalled());
  await screen.findByRole('button', { name: /write it out/i }).catch(() => null);
}

const renderButton = () =>
  screen.queryByRole('button', { name: /write it out/i }) as HTMLButtonElement | null;
const annotateButton = () =>
  screen.queryByRole('button', { name: /^annotate$/i }) as HTMLButtonElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});
afterEach(cleanup);

// ---------------------------------------------------------------------------

describe('gating', () => {
  it('stays fully available while canon is LOCKED', async () => {
    // §3.3's narrowing, and the one most likely to be undone by someone
    // reaching for `writesDisabled` — that composite carries `canonLocked`.
    // A locked bible is exactly the state a user renders FROM, and the
    // backend enforces nothing, so this gate is the only one there is.
    setup({ canonLocked: true });
    await mount();

    expect(renderButton()!.disabled).toBe(false);
    expect(annotateButton()!.disabled).toBe(false);
    expect(screen.getByTestId('hints-editor').getAttribute('data-disabled')).toBe('no');
  });

  it('refuses while a transcript walk is live or resumable', async () => {
    // The walk full-replaces the scene rows a run reads. `error` counts too:
    // an errored walk is resumable, so resuming one does the very
    // full-replace this gate exists to prevent.
    for (const status of ['running', 'paused', 'error']) {
      cleanup();
      setup({ checkpointStatus: status, currentPass: 'transcript_walk' });
      await mount();
      expect(renderButton()!.disabled).toBe(true);
      expect(screen.getByText(/still being built/i)).toBeTruthy();
    }
  });

  it('does NOT refuse for a parked annotate — that would strand the user', async () => {
    // Annotate is the step this tab tells users to run first, and an
    // aborted one persists `paused` on the same checkpoint field. Gating on
    // `ingestion.status` alone would leave a user who took that advice
    // unable to ever render.
    setup({ checkpointStatus: 'paused', currentPass: 'annotate' });
    await mount();
    expect(renderButton()!.disabled).toBe(false);
  });

  it('offers no controls at all to a view-only user', async () => {
    setup();
    await mount(false);
    expect(renderButton()).toBeNull();
    expect(annotateButton()).toBeNull();
  });
});

describe('annotate entry point', () => {
  // Moved here from `StoryTab`, where phase 2 parked it as explicitly
  // temporary scaffolding. The rules it pins are not temporary.

  it('leads with annotate when no scene has been annotated', async () => {
    // §3.3's stated mitigation for the extra pass: the renderer reads
    // `function` and `transformations`, so prose written without them is
    // flatter, and this tab is what knows they are missing.
    setup({ scenes: [sceneRow('s1', 0, false), sceneRow('s2', 1, false)] });
    await mount();
    expect(screen.getByText(/annotate the scenes first/i)).toBeTruthy();
  });

  it('does not nag once the scenes are annotated', async () => {
    await mount();
    expect(screen.queryByText(/annotate the scenes first/i)).toBeNull();
    expect(annotateButton()).not.toBeNull();
  });

  it('mirrors runAnnotate’s refusal on a checkpoint parked mid-pipeline', async () => {
    // `current_pass` is one field: writing 'annotate' over a parked walk
    // destroys the signal `resumableWalk` reads.
    setup({ checkpointStatus: 'paused', currentPass: 'transcript_walk' });
    await mount();
    expect(annotateButton()!.disabled).toBe(true);
    expect(screen.getByText(/finish or clear the story build first/i)).toBeTruthy();
  });

  it('stays available when ANNOTATE itself is parked — that is resumable', async () => {
    setup({ checkpointStatus: 'paused', currentPass: 'annotate' });
    await mount();
    expect(annotateButton()!.disabled).toBe(false);
  });

  it('runs the pass and reloads the bible after', async () => {
    await mount();
    await userEvent.click(annotateButton()!);
    await userEvent.click(await screen.findByRole('button', { name: /confirm annotate/i }));

    await waitFor(() => expect(runAnnotate).toHaveBeenCalled());
    expect(runAnnotate.mock.calls[0][0]).toMatchObject({ projectId: 'p1', model: 'm' });
    // The pass rewrites scene rows and may add the `narrative` section.
    await waitFor(() => expect(storeActions.load).toHaveBeenCalledWith('p1'));
  });
});

describe('preflight and start', () => {
  it('prices the whole story by default and starts on that same range', async () => {
    // Defaulting to anything narrower would be the app choosing part of the
    // user's book for them — and the estimate has to price exactly what the
    // run will render, or the number authorises the wrong spend.
    await mount();
    await userEvent.click(renderButton()!);

    const modal = await screen.findByTestId('render-preflight');
    expect(modal.getAttribute('data-scenes')).toBe('2');
    // The label the modal was handed, not the one the range picker shows.
    expect(modal.textContent).toMatch(/the whole story/i);

    await userEvent.click(screen.getByRole('button', { name: /confirm render/i }));
    await waitFor(() => expect(renderActions.start).toHaveBeenCalled());
    expect(renderActions.start.mock.calls[0][0]).toMatchObject({
      projectId: 'p1',
      format: 'novel',
      sceneIdStart: 's1',
      sceneIdEnd: 's2',
    });
  });

  it('reads the source chat before estimating, not after starting', async () => {
    // The rule selector needs the transcript for every scene, so a preflight
    // computed without it would quote a run assembled from different inputs
    // than the one it authorises.
    await mount();
    await userEvent.click(renderButton()!);
    await screen.findByTestId('render-preflight');
    expect(gatherIngestInputs).toHaveBeenCalledWith(CHAT);
    expect(renderActions.start).not.toHaveBeenCalled();
  });
});

describe('a lock held elsewhere', () => {
  const LOCKED_RUN = {
    id: 'r1',
    status: 'running',
    stale_bible: false,
    unit_count: 2,
    complete_unit_count: 1,
    model: 'm',
    created_at: '2026-08-14T10:00:00Z',
    server_ts: 3,
  };

  it('offers Take over only when the server says the lock is takeable', async () => {
    setup({
      lockedBy: { takeable: true },
      renders: [LOCKED_RUN],
      renderRow: LOCKED_RUN,
    });
    await mount();
    expect(screen.getByRole('button', { name: /take over/i })).toBeTruthy();
  });

  it('withholds Take over from a LIVE holder', async () => {
    // A live holder is another device actively spending the user's key on
    // these same chapters. Displacing it is offering to pay twice.
    setup({
      lockedBy: { takeable: false },
      renders: [LOCKED_RUN],
      renderRow: LOCKED_RUN,
    });
    await mount();
    expect(screen.queryByRole('button', { name: /take over/i })).toBeNull();
  });

  it('never takes over implicitly — the flag comes from the click', async () => {
    setup({
      lockedBy: { takeable: true },
      renders: [LOCKED_RUN],
      renderRow: LOCKED_RUN,
    });
    await mount();
    await userEvent.click(screen.getByRole('button', { name: /take over/i }));

    await waitFor(() => expect(renderActions.resume).toHaveBeenCalled());
    expect(renderActions.resume.mock.calls[0][0]).toMatchObject({
      renderId: 'r1',
      takeover: true,
    });
  });
});

describe('per-scene re-render', () => {
  it('targets the run being read, by scene id', async () => {
    const RUN = {
      id: 'r1',
      status: 'complete',
      stale_bible: false,
      unit_count: 2,
      complete_unit_count: 2,
      model: 'm',
      created_at: '2026-08-14T10:00:00Z',
      server_ts: 3,
    };
    setup({ renders: [RUN] });
    await mount();

    await userEvent.click(await screen.findByRole('button', { name: /rerender s1/i }));
    await waitFor(() => expect(renderActions.rerenderScene).toHaveBeenCalled());
    expect(renderActions.rerenderScene.mock.calls[0][0]).toMatchObject({
      projectId: 'p1',
      renderId: 'r1',
      sceneId: 's1',
    });
  });
});

describe('empty state', () => {
  it('sends the user to the Story tab when there is nothing to render', async () => {
    setup({ sceneCount: 0, scenes: [] });
    render(<RenderTab project={PROJECT} canManage />);
    expect(await screen.findByText(/nothing to write out yet/i)).toBeTruthy();
    expect(renderButton()).toBeNull();
  });
});
