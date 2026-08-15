/**
 * @vitest-environment jsdom
 *
 * Story tab component suite (story-state phase 11, plan §9 "Component —
 * StoryTab").
 *
 * THE ONLY DOM TEST IN THIS REPO, and deliberately so. Everything else
 * runs in plain node because it is pure logic; the vitest config's own
 * comment anticipates exactly this ("Add environment overrides per-file
 * if a test ever needs a DOM"), which is why the environment is set by
 * the docblock above rather than globally — no other suite pays the
 * DOM's startup cost.
 *
 * What earns a DOM test here is the set of rules that are only true
 * once the component, the stores and the drift module are wired
 * together. Two of them are the ones a mistake would be most expensive
 * in:
 *
 *   - A locked bible must never be offered "Re-ingest". That button
 *     routes through `resetBible`, which is UNGATED and wipes `meta` —
 *     including `canon_locked_at`. Nothing downstream will refuse on the
 *     banner's behalf, so if the banner offers it, the lock is
 *     destroyable by a button in a section that promises no auto-unlock.
 *   - "Update story" must not silently become a full rebuild. The
 *     watermark lives in `meta` and the chunk plan in `ingestion`, and
 *     `resetIngestState()` wipes one but not the other.
 *
 * `driftBannerState` is unit-tested in msgDrift.test.ts; this suite
 * checks that the component actually renders from it and that the
 * click-through reaches the right store call with the right arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project } from '../../api/client';

// ---------------------------------------------------------------------------
// Mocks
//
// Child components are stubbed: this suite is about the Story tab's own
// banner and actions, and rendering the whole review surface would make
// every query ambiguous. The drift module and the chunker are REAL —
// they are half of what is under test.
// ---------------------------------------------------------------------------

const getChatMessages = vi.fn();
const storyApiMock = {
  appendFact: vi.fn(),
  manifest: vi.fn(),
};

vi.mock('../../api/client', () => ({
  api: { getChatMessages: (...a: unknown[]) => getChatMessages(...a) },
  storyApi: storyApiMock,
}));

const showToastGlobal = vi.fn();
vi.mock('../ui/Toast', () => ({ showToastGlobal: (...a: unknown[]) => showToastGlobal(...a) }));

vi.mock('./IngestProgressCard', () => ({ IngestProgressCard: () => null }));
vi.mock('./ContradictionCard', () => ({ ContradictionCard: () => null }));
vi.mock('./FactReviewList', () => ({ FactReviewList: () => null }));
vi.mock('./VoiceConfidenceCard', () => ({ VoiceConfidenceCard: () => null }));
vi.mock('./LockCanonFooter', () => ({ LockCanonFooter: () => null }));
vi.mock('./SceneReviewRow', () => ({
  SceneReviewRow: ({ scene, stale }: { scene: { id: string }; stale?: boolean }) => (
    <li data-testid={`scene-${scene.id}`} data-stale={stale ? 'yes' : 'no'} />
  ),
}));
// Mounted-means-open, matching the real component — it takes no `isOpen`
// prop, so the previous `isOpen ? … : null` mock rendered null in every
// test and the modal could never be asserted on. The confirm button lets
// a test drive the flow through to the store call.
vi.mock('./StartIngestModal', () => ({
  StartIngestModal: ({
    mode = 'build',
    onStart,
  }: {
    mode?: 'build' | 'annotate';
    onStart: (profileId: string | null) => void;
  }) => (
    <div data-testid={mode === 'annotate' ? 'annotate-modal' : 'start-ingest-modal'}>
      <button type="button" onClick={() => onStart(null)}>
        confirm {mode}
      </button>
    </div>
  ),
}));

const gatherIngestInputs = vi.fn();
vi.mock('./ingestSources', () => ({
  gatherIngestInputs: (...a: unknown[]) => gatherIngestInputs(...a),
  gatherColdStartSources: () => ({ characterName: 'Ivy', characterAvatar: 'Ivy.png' }),
  replayEntriesFrom: () => [],
  // Moved out of StoryTab in step-3 phase 5 so the Render tab can replay
  // world-info activation against the SAME book set the build walked.
  booksForChat: () => [],
}));

vi.mock('../../utils/storyIngest/llmBridge', () => ({ makeLlmCall: () => vi.fn() }));
vi.mock('../../utils/worldInfoComposition', () => ({
  resolveEffectiveBooks: () => ({ effectiveBooks: [], effectiveActiveIds: [] }),
}));

// --- stores ----------------------------------------------------------------

interface StoryState {
  [k: string]: unknown;
}
let storyState: StoryState;
// Selector-aware, like the ingest mock: `StoryTab` destructures the whole
// store, but child components (BeatMapCard) subscribe with selectors, and
// a mock that ignores the selector hands them the entire state object.
const useStoryStoreMock = Object.assign(
  (selector?: (s: StoryState) => unknown) =>
    selector ? selector(storyState) : storyState,
  { getState: () => storyState }
);
vi.mock('../../stores/storyStore', async () => {
  const actual = await vi.importActual<typeof import('../../stores/storyStore')>(
    '../../stores/storyStore'
  );
  return {
    // hasBible / isCanonLocked are pure readers of data this test supplies,
    // so the real ones are used — mocking them would mock away the gate.
    hasBible: actual.hasBible,
    isCanonLocked: actual.isCanonLocked,
    useStoryStore: useStoryStoreMock,
  };
});

let ingestState: Record<string, unknown>;
const useStoryIngestStoreMock = Object.assign(
  (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(ingestState) : ingestState,
  { getState: () => ingestState }
);
vi.mock('../../stores/storyIngestStore', () => ({
  useStoryIngestStore: useStoryIngestStoreMock,
  estimateColdStartTokens: () => 100,
  hasUnreadableChecksNote: () => false,
}));

// The render store's only job in this suite is the SYMMETRIC half of
// §3.6's cross-gate: the render store refuses to start while a walk is
// live, and the Story tab has to refuse a walk while a render is live.
let renderStoreState: Record<string, unknown> = { isRunning: false };
vi.mock('../../stores/storyRenderStore', () => ({
  useStoryRenderStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(renderStoreState) : renderStoreState,
    { getState: () => renderStoreState }
  ),
}));

function simpleStore(state: Record<string, unknown>) {
  return Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(state) : state,
    { getState: () => state }
  );
}

vi.mock('../../stores/characterStore', () => ({
  useCharacterStore: simpleStore({
    characters: [{ avatar: 'Ivy.png', name: 'Ivy' }],
    getActiveBookIdsForCharacter: () => [],
  }),
}));
vi.mock('../../stores/personaStore', () => ({
  usePersonaStore: simpleStore({
    personas: [],
    getPersonaForContext: () => null,
  }),
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: simpleStore({ activeProvider: 'p', activeModel: 'm' }),
}));
vi.mock('../../stores/connectionProfileStore', () => ({
  useConnectionProfileStore: simpleStore({ getProfile: () => null }),
}));
vi.mock('../../stores/worldInfoStore', () => ({
  useWorldInfoStore: simpleStore({
    scanDepth: 2,
    books: [],
    activeBookIds: [],
    getComposableBooks: () => [],
  }),
}));
vi.mock('../../stores/chatLoreConfigStore', () => ({
  useChatLoreConfigStore: simpleStore({ getEffectiveConfig: () => null }),
}));

const { StoryTab } = await import('./StoryTab');
const { hashText } = await import('../../utils/storyBible/sourceRefs');

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

/** A raw chat message in the shape `api.getChatMessages` returns. */
function rawMsg(id: string, mes: string) {
  return { mes, send_date: 1000, swipe_id: 0, extra: { ggbc_id: id } };
}

async function watermarkFor(id: string, text: string, count: number) {
  const { sha, hash_alg } = await hashText(text);
  return {
    message_count: count,
    last_msg: { msg_id: id, swipe_idx: 0, fingerprint: { sha, hash_alg, send_date: 1000 } },
  };
}

const MANIFEST = {
  project_id: 'p1',
  sections: [{ section: 'meta', server_ts: 1, bytes: 10, updated_at: 'x' }],
  scene_count: 1,
  fact_count: 0,
  edit_count: 0,
};

function metaSection(extra: Record<string, unknown> = {}) {
  return {
    section: 'meta',
    server_ts: 1,
    updated_at: 'x',
    data: {
      schema_version: '1.1',
      bible_id: 'b1',
      created_at: 'x',
      updated_at: 'x',
      source: {
        platform: 'ggbc',
        chat: { kind: 'chat', ref: CHAT, snapshot: { name: 'chat1.jsonl' }, captured_at: 'x' },
      },
      ...extra,
    },
  };
}

const loadBeatMap = vi.fn(async () => {});

const storeActions = {
  load: vi.fn(),
  clear: vi.fn(),
  loadMoreFacts: vi.fn(),
  loadMoreScenes: vi.fn(),
  designateSourceChat: vi.fn(async () => true),
  resetBible: vi.fn(async () => true),
  loadArchives: vi.fn(),
  loadMoreArchives: vi.fn(),
  restoreArchive: vi.fn(),
  relinkSourceChat: vi.fn(async () => true),
  loadAllScenesWithData:
    vi.fn<() => Promise<Record<string, unknown>[] | null>>(async () => []),
  loadBeatMap,
  loadSection: vi.fn(async () => {}),
  flagScenesStale: vi.fn(async () => ({ flagged: 0, alreadyFlagged: 0, failed: 0 })),
  clearSceneStale: vi.fn(async () => true),
  patchContinuity: vi.fn(async () => true),
};

const runIngest =
  vi.fn<(input: Record<string, unknown>) => Promise<boolean>>(async () => true);
const runAnnotate =
  vi.fn<(input: Record<string, unknown>) => Promise<boolean>>(async () => true);

/** Assemble both stores for one scenario. */
function setup(opts: {
  watermark?: unknown;
  canonLocked?: boolean;
  chunkPlan?: unknown[];
  checkpointStatus?: string | null;
  currentPass?: string | null;
  sceneCount?: number;
  beatMap?: Record<string, unknown>[] | null;
  scenes?: { id: string; sequence: number; title: string; summary: string }[];
}) {
  storyState = {
    manifest:
      opts.sceneCount === undefined
        ? MANIFEST
        : { ...MANIFEST, scene_count: opts.sceneCount },
    sections: {
      meta: metaSection({
        ...(opts.watermark ? { ingest_watermark: opts.watermark } : {}),
        ...(opts.canonLocked ? { canon_locked_at: '2026-08-10T12:00:00Z' } : {}),
      }),
    },
    scenes: opts.scenes ?? [],
    scenesHasMore: false,
    beatMap: opts.beatMap ?? null,
    beatMapLoading: false,
    facts: [],
    factsHasMore: false,
    archives: [],
    archivesLoaded: true,
    archivesHasMore: false,
    isLoading: false,
    isSaving: false,
    error: null,
    ...storeActions,
  };
  ingestState = {
    run: runIngest,
    runAnnotate,
    isRunning: false,
    loadCheckpoint: vi.fn(),
    clear: vi.fn(),
    resetIngestState: vi.fn(),
    checkpoint:
      opts.chunkPlan === undefined && opts.checkpointStatus === undefined
        ? null
        : {
            status: opts.checkpointStatus ?? 'complete',
            current_pass: opts.currentPass ?? null,
            chunk_plan: opts.chunkPlan ?? [],
            chunk_index: (opts.chunkPlan ?? []).length,
            error: '',
          },
  };
}

/** A pinned plan of `n` entries — what an incremental Update extends. */
function pinnedPlan(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    start_msg_id: `m${i}`,
    end_msg_id: `m${i}`,
    est_tokens: 10,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  renderStoreState = { isRunning: false };
  storyApiMock.manifest.mockResolvedValue(MANIFEST);
  gatherIngestInputs.mockResolvedValue({ messages: [], capturedWiFired: null });
});

afterEach(() => {
  cleanup();
});

/** Click the confirm button INSIDE a dialog.
 *
 *  The banner's trigger and the dialog's confirm deliberately share a
 *  label ("Re-ingest"), so an unscoped query matches both. Scoping to the
 *  dialog is also what a user does — the modal is on top. */
async function confirmInDialog(titleRe: RegExp, confirmRe: RegExp) {
  const title = await screen.findByText(titleRe);
  const dialog = title.closest('div.fixed') as HTMLElement | null;
  if (!dialog) throw new Error('confirm dialog container not found');
  await userEvent.click(within(dialog).getByRole('button', { name: confirmRe }));
}

/** Render and let the deferred drift effect settle. */
async function renderTab(canManage = true) {
  render(<StoryTab project={PROJECT} canManage={canManage} />);
  // The drift check is intentionally deferred off the render path, so
  // nothing is asserted until it has had a chance to run.
  await waitFor(() => expect(getChatMessages).toHaveBeenCalled(), { timeout: 2000 }).catch(
    () => undefined
  );
}

// ---------------------------------------------------------------------------
// The fetch budget (plan §3.4)
// ---------------------------------------------------------------------------

describe('drift detection fetch budget', () => {
  it('a never-walked bible costs ZERO chat fetches', async () => {
    // Decidable from `meta` alone. This gate is what keeps the eager
    // fetch off users who never built a story.
    setup({});
    render(<StoryTab project={PROJECT} canManage />);

    await new Promise((r) => setTimeout(r, 50));
    expect(getChatMessages).not.toHaveBeenCalled();
    expect(screen.queryByText(/new message/i)).toBeNull();
  });

  it('a walked bible costs exactly ONE chat fetch per visit', async () => {
    // Before phase 11 a normal visit cost zero — phase 10's evidence
    // fetch is lazy. This is a real new cost and the test states it
    // rather than letting it drift upward unnoticed.
    getChatMessages.mockResolvedValue({ messages: [rawMsg('m0', 'one')] });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    await renderTab();
    await new Promise((r) => setTimeout(r, 50));
    expect(getChatMessages).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

describe('drift banner', () => {
  it('says nothing when the chat is unchanged', async () => {
    getChatMessages.mockResolvedValue({ messages: [rawMsg('m0', 'one')] });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    await renderTab();
    expect(screen.queryByText(/new message/i)).toBeNull();
    expect(screen.queryByText(/history changed/i)).toBeNull();
  });

  it('offers Update when the chat grew', async () => {
    getChatMessages.mockResolvedValue({
      messages: [rawMsg('m0', 'one'), rawMsg('m1', 'two'), rawMsg('m2', 'three')],
    });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    await renderTab();
    expect(await screen.findByText(/2 new messages since this story was built/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /update story/i })).toBeTruthy();
  });

  it('says nothing when the anchor cannot be verified', async () => {
    // A djb2-vs-sha256 comparison says nothing about whether the message
    // changed, so the banner must not speak — not even to claim the
    // chat grew, since it cannot trust the anchor it would measure from.
    getChatMessages.mockResolvedValue({
      messages: [rawMsg('m0', 'one'), rawMsg('m1', 'two')],
    });
    setup({
      watermark: {
        message_count: 1,
        last_msg: {
          msg_id: 'm0',
          swipe_idx: 0,
          fingerprint: { sha: 'ff', hash_alg: 'djb2', send_date: 1000 },
        },
      },
      chunkPlan: pinnedPlan(1),
    });

    await renderTab();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/new message/i)).toBeNull();
    expect(screen.queryByText(/history changed/i)).toBeNull();
  });

  it('warns and offers Re-ingest when history diverged', async () => {
    // The anchor's text changed under a stable id.
    getChatMessages.mockResolvedValue({ messages: [rawMsg('m0', 'EDITED')] });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    await renderTab();
    expect(await screen.findByText(/history changed/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /re-ingest/i })).toBeTruthy();
  });

  it('can be dismissed', async () => {
    getChatMessages.mockResolvedValue({
      messages: [rawMsg('m0', 'one'), rawMsg('m1', 'two')],
    });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    await renderTab();
    await screen.findByText(/1 new message since this story was built/i);
    await userEvent.click(screen.getByRole('button', { name: /^dismiss$/i }));
    expect(screen.queryByText(/new message/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The canon lock — the expensive mistakes
// ---------------------------------------------------------------------------

describe('canon lock suppression', () => {
  it('locked + new messages: tells the user, withholds Update', async () => {
    getChatMessages.mockResolvedValue({
      messages: [rawMsg('m0', 'one'), rawMsg('m1', 'two')],
    });
    setup({
      watermark: await watermarkFor('m0', 'one', 1),
      chunkPlan: pinnedPlan(1),
      canonLocked: true,
    });

    await renderTab();
    expect(await screen.findByText(/1 new message since this story was built/i)).toBeTruthy();
    expect(screen.getByText(/canon is locked — unlock to bring them in/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /update story/i })).toBeNull();
  });

  it('locked + diverged: withholds BOTH Re-ingest and Mark', async () => {
    // Re-ingest routes through the UNGATED `resetBible`, which wipes
    // `meta` and takes `canon_locked_at` with it. Nothing downstream
    // refuses on the banner's behalf, so the suppression has to be here.
    getChatMessages.mockResolvedValue({ messages: [rawMsg('m0', 'EDITED')] });
    setup({
      watermark: await watermarkFor('m0', 'one', 1),
      chunkPlan: pinnedPlan(1),
      canonLocked: true,
    });

    await renderTab();
    expect(await screen.findByText(/history changed/i)).toBeTruthy();
    expect(screen.getByText(/unlock canon to re-ingest/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /re-ingest/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mark affected scenes/i })).toBeNull();
    expect(storeActions.resetBible).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Update: the incremental press
// ---------------------------------------------------------------------------

describe('Update story', () => {
  it('runs incrementally, telling the store the chat has new messages', async () => {
    const messages = [rawMsg('m0', 'one'), rawMsg('m1', 'two')];
    getChatMessages.mockResolvedValue({ messages });
    gatherIngestInputs.mockResolvedValue({
      messages: [
        { id: 'm0', name: 'a', isUser: true, isSystem: false, content: 'one', timestamp: 1000, swipeIdx: 0, swipesCount: 1 },
        { id: 'm1', name: 'b', isUser: false, isSystem: false, content: 'two', timestamp: 1000, swipeIdx: 0, swipesCount: 1 },
      ],
      capturedWiFired: null,
    });
    setup({
      watermark: await watermarkFor('m0', 'one', 1),
      chunkPlan: [{ start_msg_id: 'm0', end_msg_id: 'm0', est_tokens: 10 }],
    });

    await renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /update story/i }));

    await waitFor(() => expect(runIngest).toHaveBeenCalled());
    expect(runIngest.mock.calls[0][0]).toMatchObject({
      projectId: 'p1',
      hasNewMessages: true,
      confirmLongWalk: false,
    });
  });

  it('does NOT re-prompt the long-walk confirm for a small extension on a huge plan', async () => {
    // The cap is scoped to the extension. A cumulative check would ask
    // the user to re-authorise 250 chunks they already paid for, every
    // time they add one message.
    const live = Array.from({ length: 251 }, (_, i) => rawMsg(`m${i}`, `line ${i}`));
    getChatMessages.mockResolvedValue({ messages: live });
    gatherIngestInputs.mockResolvedValue({
      messages: live.map((_m, i) => ({
        id: `m${i}`,
        name: 'a',
        isUser: i % 2 === 0,
        isSystem: false,
        content: `line ${i}`,
        timestamp: 1000,
        swipeIdx: 0,
        swipesCount: 1,
      })),
      capturedWiFired: null,
    });
    setup({
      watermark: await watermarkFor('m249', 'line 249', 250),
      chunkPlan: pinnedPlan(250),
    });

    await renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /update story/i }));

    await waitFor(() => expect(runIngest).toHaveBeenCalled());
    expect(screen.queryByText(/that’s a lot of new messages/i)).toBeNull();
    expect(screen.queryByText(/this chat is long/i)).toBeNull();
  });

  it('is withheld — with honest copy — when the build plan was cleared', async () => {
    // `resetIngestState()` wipes the `ingestion` section (and the plan
    // with it) while the watermark in `meta` survives. An Update offered
    // here cannot be served incrementally: it would rerun cold start and
    // re-walk the whole chat, behind a button promising the opposite.
    getChatMessages.mockResolvedValue({
      messages: [rawMsg('m0', 'one'), rawMsg('m1', 'two')],
    });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: [] });

    await renderTab();
    expect(await screen.findByText(/1 new message since this story was built/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /update story/i })).toBeNull();
    expect(screen.getByText(/needs a full rebuild/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Re-ingest
// ---------------------------------------------------------------------------

describe('Re-ingest from scratch', () => {
  it('archives under the reingest reason, then re-designates the same chat', async () => {
    getChatMessages.mockResolvedValue({ messages: [rawMsg('m0', 'EDITED')] });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    await renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /re-ingest/i }));

    // Destructive, so it goes behind a confirm.
    await confirmInDialog(/re-ingest from scratch\?/i, /^re-ingest$/i);

    await waitFor(() => expect(storeActions.resetBible).toHaveBeenCalledWith('reingest'));
    expect(storeActions.designateSourceChat).toHaveBeenCalled();
  });

  it('does not open the build modal when the re-designation fails', async () => {
    // reset wipes `meta`, so a failed re-designate leaves no source chat
    // and no cold-start sources — opening the modal anyway strands it.
    storeActions.designateSourceChat.mockResolvedValueOnce(false);
    getChatMessages.mockResolvedValue({ messages: [rawMsg('m0', 'EDITED')] });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    await renderTab();
    await userEvent.click(await screen.findByRole('button', { name: /re-ingest/i }));
    await confirmInDialog(/re-ingest from scratch\?/i, /^re-ingest$/i);

    await waitFor(() => expect(storeActions.designateSourceChat).toHaveBeenCalled());
    expect(screen.queryByTestId('start-ingest-modal')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stale scenes
// ---------------------------------------------------------------------------

describe('stale scene flagging', () => {
  const SCENES = [
    { id: 's1', sequence: 0, title: 'One', summary: '' },
    { id: 's2', sequence: 1, title: 'Two', summary: '' },
  ];

  async function divergedWithScenes() {
    getChatMessages.mockResolvedValue({ messages: [rawMsg('m0', 'EDITED')] });
    const wm = await watermarkFor('m0', 'one', 1);
    storeActions.loadAllScenesWithData.mockResolvedValue([
      {
        id: 's2',
        sequence: 1,
        server_ts: 1,
        updated_at: 'x',
        data: {
          id: 's2',
          sequence: 1,
          source: { message_range: { start: wm.last_msg, end: wm.last_msg } },
        },
      },
    ]);
    setup({ watermark: wm, chunkPlan: pinnedPlan(1), scenes: SCENES });
  }

  it('marks the localised scenes and badges them in the list', async () => {
    await divergedWithScenes();
    storeActions.flagScenesStale.mockResolvedValue({
      flagged: 1,
      alreadyFlagged: 0,
      failed: 0,
    });

    await renderTab();
    const mark = await screen.findByRole('button', { name: /mark affected scenes/i });

    // The badge comes from the same derived set the button acts on.
    await waitFor(() =>
      expect(screen.getByTestId('scene-s2').getAttribute('data-stale')).toBe('yes')
    );
    expect(screen.getByTestId('scene-s1').getAttribute('data-stale')).toBe('no');

    await userEvent.click(mark);
    await waitFor(() => expect(storeActions.flagScenesStale).toHaveBeenCalledWith(['s2']));
  });
});

// ---------------------------------------------------------------------------
// Scheduling of the drift check
// ---------------------------------------------------------------------------

describe('drift check scheduling', () => {
  it('schedules with a TIMEOUT so an idle callback cannot starve', async () => {
    // The bug this pins: `requestIdleCallback(cb)` with no `timeout` is
    // run only when the browser feels idle, and it is entitled to never
    // feel idle. On production the banner stayed hidden until a full
    // page reload for exactly this reason.
    //
    // jsdom does not implement requestIdleCallback, so the rest of this
    // suite silently exercises the setTimeout fallback and could never
    // have caught it. Install a stub so the real branch is taken.
    const calls: ({ timeout?: number } | undefined)[] = [];
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    w.requestIdleCallback = (_cb, opts) => {
      calls.push(opts);
      // Deliberately NEVER invoke cb — this models a page that never
      // goes idle, which is the failing condition.
      return 1;
    };
    w.cancelIdleCallback = () => {};

    try {
      getChatMessages.mockResolvedValue({
        messages: [rawMsg('m0', 'one'), rawMsg('m1', 'two')],
      });
      setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

      render(<StoryTab project={PROJECT} canManage />);
      await waitFor(() => expect(calls.length).toBeGreaterThan(0));

      // Every scheduling must carry a bounded deadline.
      for (const opts of calls) {
        expect(opts?.timeout).toBeTypeOf('number');
        expect(opts!.timeout).toBeGreaterThan(0);
      }
    } finally {
      delete w.requestIdleCallback;
      delete w.cancelIdleCallback;
    }
  });

  it('still runs the check when requestIdleCallback is unavailable', async () => {
    // The fallback path jsdom actually takes. Guards against a fix that
    // makes the idle path correct while breaking the plain-timeout one.
    getChatMessages.mockResolvedValue({
      messages: [rawMsg('m0', 'one'), rawMsg('m1', 'two')],
    });
    setup({ watermark: await watermarkFor('m0', 'one', 1), chunkPlan: pinnedPlan(1) });

    render(<StoryTab project={PROJECT} canManage />);
    expect(await screen.findByText(/1 new message since this story was built/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Beat map panel (step 3 phase 2)
// ---------------------------------------------------------------------------

describe('beat map panel', () => {
  const SCENES = [{ id: 's1', sequence: 0, title: 'One', summary: '' }];

  const entry = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    sequence: 0,
    title: 'Arrival',
    beat: 'crisis',
    tension: 9,
    mood: 'tight',
    stakes: 'the door',
    compression: 'compress',
    compressionRatio: 0.4,
    pacingNotes: '',
    stale: false,
    ...over,
  });

  it('does not fetch until it is opened', async () => {
    // Reading a beat means pulling whole scene rows, since the list
    // projection carries no `data`. A bible with hundreds of scenes must
    // not pay that on every Story-tab open.
    setup({ scenes: SCENES });
    await renderTab();

    expect(loadBeatMap).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /beat map/i }));
    await waitFor(() => expect(loadBeatMap).toHaveBeenCalled());
  });

  it('renders each scene’s beat, tension and compression once loaded', async () => {
    setup({ scenes: SCENES, beatMap: [entry()] });
    await renderTab();
    await userEvent.click(screen.getByRole('button', { name: /beat map/i }));

    expect(screen.getByText(/crisis/)).toBeTruthy();
    expect(screen.getByText(/tension 9\/10/)).toBeTruthy();
    expect(screen.getByText(/compress to 40%/)).toBeTruthy();
    expect(screen.getByText(/1 of 1 scene annotated/)).toBeTruthy();
  });

  it('flags a scene the walk marked stale, and counts it', async () => {
    setup({ scenes: SCENES, beatMap: [entry({ stale: true })] });
    await renderTab();
    await userEvent.click(screen.getByRole('button', { name: /beat map/i }));

    expect(screen.getByText(/1 to re-check/)).toBeTruthy();
    expect(screen.getByText(/grew after it was annotated/i)).toBeTruthy();
  });

  it('shows an unannotated scene as such rather than hiding it', async () => {
    setup({
      scenes: SCENES,
      beatMap: [entry(), entry({ id: 's2', sequence: 1, beat: null, tension: null })],
    });
    await renderTab();
    await userEvent.click(screen.getByRole('button', { name: /beat map/i }));

    expect(screen.getByText(/not annotated/)).toBeTruthy();
    expect(screen.getByText(/1 of 2 scenes annotated/)).toBeTruthy();
  });

  it('is hidden for a bible with no scenes', async () => {
    setup({ sceneCount: 0 });
    await renderTab();
    expect(screen.queryByRole('button', { name: /beat map/i })).toBeNull();
  });

  it('is available to a view-only user — reads take project:view', async () => {
    setup({ scenes: SCENES, beatMap: [entry()] });
    await renderTab(false);
    expect(screen.queryByRole('button', { name: /beat map/i })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The render cross-gate, from this side (step 3 phase 5)
// ---------------------------------------------------------------------------

describe('build vs. a render in flight', () => {
  const buildButton = () =>
    screen.getByRole('button', { name: /^build$/i }) as HTMLButtonElement;

  it('refuses a build while a render is running', async () => {
    // The symmetric half of §3.6. `transcript_walk` full-replaces the very
    // scene rows the run in flight is reading one at a time, on the user's
    // key — so the gate has to hold from both ends, not just the one the
    // render store enforces.
    renderStoreState = { isRunning: true };
    setup({});
    await renderTab();

    expect(buildButton().disabled).toBe(true);
    expect(screen.getByText(/being written out right now/i)).toBeTruthy();
  });

  it('allows a build when no render is in flight', async () => {
    // A PARKED render is data at rest: it reads nothing until someone
    // continues it, and blocking on one would strand a user who abandoned a
    // render behind a bible they can never update again.
    setup({});
    await renderTab();
    expect(buildButton().disabled).toBe(false);
  });
});
