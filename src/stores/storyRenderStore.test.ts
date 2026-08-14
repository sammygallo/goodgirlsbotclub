import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRender = vi.fn();
const getRender = vi.fn();
const acquireRenderLock = vi.fn();
const releaseRenderLock = vi.fn();
const setRenderStatus = vi.fn();
const putRenderUnit = vi.fn();

class FakeConflict extends Error {
  currentTs: number;
  current: unknown;
  constructor(currentTs: number) {
    super('conflict');
    this.name = 'StoryConflictError';
    this.currentTs = currentTs;
    this.current = null;
  }
}

class FakeLocked extends Error {
  takeable: boolean;
  holderClientId: string | null;
  currentTs = 0;
  holderRenderId = null;
  holderHeartbeatAt = null;
  retryAfterSeconds = 0;
  constructor(takeable = false) {
    super('render locked');
    this.name = 'RenderLockedError';
    this.takeable = takeable;
    this.holderClientId = 'other-device';
  }
}

vi.mock('../api/client', () => ({
  storyApi: {
    createRender: (...a: unknown[]) => createRender(...a),
    getRender: (...a: unknown[]) => getRender(...a),
    acquireRenderLock: (...a: unknown[]) => acquireRenderLock(...a),
    releaseRenderLock: (...a: unknown[]) => releaseRenderLock(...a),
    setRenderStatus: (...a: unknown[]) => setRenderStatus(...a),
    putRenderUnit: (...a: unknown[]) => putRenderUnit(...a),
  },
  StoryConflictError: FakeConflict,
  RenderLockedError: FakeLocked,
}));
vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));
vi.mock('./usageStore', () => ({
  useUsageStore: { getState: () => ({ recordGeneration: vi.fn() }) },
}));

const ingestState: Record<string, unknown> = {
  projectId: 'p1',
  checkpoint: null,
  loadCheckpoint: vi.fn(async () => {}),
};
vi.mock('./storyIngestStore', () => ({
  useStoryIngestStore: { getState: () => ingestState },
}));

const { useStoryRenderStore, ingestionBlocksRender, unitStatusFor } = await import(
  './storyRenderStore'
);

const MREF = (id: string) => ({
  msg_id: id,
  swipe_idx: 0,
  fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
});

function sceneRow(id: string, sequence: number) {
  return {
    id,
    sequence,
    server_ts: 5,
    updated_at: 'x',
    data: {
      id,
      sequence,
      title: `Scene ${sequence}`,
      summary: 's',
      detailed_summary: 'd',
      setting: { location_ref: null, time_ref: null, atmosphere: '' },
      participants: [],
      pov_character: null,
      function: null,
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

const RENDER = {
  id: 'r1',
  format: 'novel',
  status: 'running',
  stale_bible: false,
  scene_id_start: 's1',
  scene_id_end: 's2',
  model: 'm',
  prompt_version: 'render-v1',
  input_tokens: 0,
  output_tokens: 0,
  lock_client_id: 'me',
  lock_heartbeat_at: null,
  lock_is_stale: false,
  unit_count: 0,
  complete_unit_count: 0,
  server_ts: 10,
  created_at: 'x',
  updated_at: 'x',
  hints: {},
};

function runInput(over: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    sceneIdStart: 's1',
    sceneIdEnd: 's2',
    scenes: [sceneRow('s1', 0), sceneRow('s2', 1)],
    factRows: [],
    characters: [],
    worldRules: [],
    userVoice: null,
    hints: null,
    narrative: null,
    messages: [],
    wiEntries: [],
    llm: vi.fn(async () => ({ text: 'Prose.', terminal: 'stop', finishReason: 'stop' })),
    model: 'm',
    ...over,
  } as Parameters<ReturnType<typeof useStoryRenderStore.getState>['start']>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  ingestState.checkpoint = null;
  createRender.mockResolvedValue({ ...RENDER });
  getRender.mockImplementation(async () => ({ ...RENDER, server_ts: 11 }));
  setRenderStatus.mockImplementation(async (_p, _r, body) => ({
    ...RENDER,
    status: body.status,
    server_ts: 20,
  }));
  putRenderUnit.mockResolvedValue({ scene_id: 's1', server_ts: 1 });
  acquireRenderLock.mockResolvedValue({ ...RENDER, server_ts: 12 });
  releaseRenderLock.mockResolvedValue(undefined);
  useStoryRenderStore.getState().clear();
});

describe('unitStatusFor', () => {
  it('is complete ONLY on an explicit terminal stop', () => {
    expect(unitStatusFor('stop')).toBe('complete');
    // Prose has no parser: a cut chapter and a severed stream both read
    // as finished text, which is the whole reason the bridge exists.
    expect(unitStatusFor('length')).toBe('truncated');
    expect(unitStatusFor('absent')).toBe('truncated');
    expect(unitStatusFor('other')).toBe('truncated');
  });
});

describe('ingestionBlocksRender', () => {
  const cp = (over: Record<string, unknown>) =>
    ({ status: 'complete', current_pass: null, ...over }) as never;

  it('blocks a walk that is running, paused OR errored', () => {
    // `error` matters: an errored walk is resumable, so resuming one does
    // the very full-replace this gate exists to prevent.
    for (const status of ['running', 'paused', 'error']) {
      expect(ingestionBlocksRender(cp({ status, current_pass: 'transcript_walk' }))).toBe(
        true
      );
    }
    expect(ingestionBlocksRender(cp({ status: 'running', current_pass: 'cold_start' }))).toBe(
      true
    );
  });

  it('does NOT block a parked annotate or reconcile', () => {
    // The stranding §3.6 exists to avoid: annotate is the step the Render
    // tab tells users to run first, and an aborted one persists `paused`.
    expect(ingestionBlocksRender(cp({ status: 'paused', current_pass: 'annotate' }))).toBe(
      false
    );
    expect(ingestionBlocksRender(cp({ status: 'error', current_pass: 'reconcile' }))).toBe(
      false
    );
  });

  it('does not block a settled or absent checkpoint', () => {
    expect(ingestionBlocksRender(cp({ status: 'complete' }))).toBe(false);
    expect(ingestionBlocksRender(null)).toBe(false);
  });
});

describe('start', () => {
  it('renders each scene in range and completes the run', async () => {
    const ok = await useStoryRenderStore.getState().start(runInput());
    expect(ok).toBe(true);
    expect(putRenderUnit).toHaveBeenCalledTimes(2);
    expect(setRenderStatus.mock.calls.at(-1)![2].status).toBe('complete');
    expect(releaseRenderLock).toHaveBeenCalled();
    expect(useStoryRenderStore.getState().progress).toMatchObject({ done: 2, total: 2 });
  });

  it('stores a truncated scene as `truncated`, never `complete`', async () => {
    const llm = vi.fn(async () => ({
      text: 'The door gave w',
      terminal: 'length',
      finishReason: 'length',
    }));
    await useStoryRenderStore.getState().start(runInput({ llm }));
    const statuses = putRenderUnit.mock.calls.map((c) => c[3].status);
    expect(statuses).toEqual(['truncated', 'truncated']);
    expect(useStoryRenderStore.getState().progress?.truncated).toBe(2);
  });

  it('treats an ABSENT terminal signal as truncated too', async () => {
    const llm = vi.fn(async () => ({
      text: 'half a sen',
      terminal: 'absent',
      finishReason: null,
    }));
    await useStoryRenderStore.getState().start(runInput({ llm }));
    expect(putRenderUnit.mock.calls[0][3].status).toBe('truncated');
  });

  it('sends token DELTAS, not running totals', async () => {
    // Totals would multiply the user's bill by the scene count, since the
    // server accumulates each write onto the run row.
    await useStoryRenderStore.getState().start(runInput());
    const first = putRenderUnit.mock.calls[0][3];
    const second = putRenderUnit.mock.calls[1][3];
    expect(first.inputTokensDelta).toBeGreaterThan(0);
    // Two identical scenes cost about the same; a totals bug would make
    // the second roughly double the first.
    expect(second.inputTokensDelta).toBeLessThanOrEqual(first.inputTokensDelta * 1.5);
  });

  it('refuses while a transcript walk is parked', async () => {
    ingestState.checkpoint = { status: 'paused', current_pass: 'transcript_walk' };
    const ok = await useStoryRenderStore.getState().start(runInput());
    expect(ok).toBe(false);
    // Refused BEFORE the run row exists — no dead row left behind.
    expect(createRender).not.toHaveBeenCalled();
  });

  it('refuses when the build state cannot be READ', async () => {
    // "We could not check" is not "it is safe": a concurrent walk
    // silently replaces the rows this run is about to read.
    (ingestState.loadCheckpoint as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network')
    );
    ingestState.projectId = 'other';
    const ok = await useStoryRenderStore.getState().start(runInput());
    expect(ok).toBe(false);
    expect(createRender).not.toHaveBeenCalled();
    ingestState.projectId = 'p1';
  });

  it('surfaces a foreign lock with its takeable flag', async () => {
    createRender.mockRejectedValueOnce(new FakeLocked(true));
    const ok = await useStoryRenderStore.getState().start(runInput());
    expect(ok).toBe(false);
    expect(useStoryRenderStore.getState().lockedBy?.takeable).toBe(true);
  });

  it('refuses an unresolvable scene range before spending anything', async () => {
    const ok = await useStoryRenderStore
      .getState()
      .start(runInput({ sceneIdEnd: 'not-a-scene' }));
    expect(ok).toBe(false);
    expect(createRender).not.toHaveBeenCalled();
  });

  it('does not start a second run while one is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const llm = vi.fn(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    const running = useStoryRenderStore.getState().start(runInput({ llm }));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(await useStoryRenderStore.getState().start(runInput())).toBe(false);
    // Exactly one run row, not two.
    expect(createRender).toHaveBeenCalledTimes(1);

    release({ text: 'x', terminal: 'stop', finishReason: 'stop' });
    useStoryRenderStore.getState().cancel();
    await running;
  });

  it('parks a stopped run as `paused`, keeping its finished units', async () => {
    const llm = vi.fn(async () => {
      useStoryRenderStore.getState().cancel();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const ok = await useStoryRenderStore.getState().start(runInput({ llm }));
    expect(ok).toBe(false);
    expect(setRenderStatus.mock.calls.at(-1)![2].status).toBe('paused');
  });

  it('records a failed scene as an errored unit and keeps going', async () => {
    let call = 0;
    const llm = vi.fn(async () => {
      if (++call === 1) throw new Error('provider 500');
      return { text: 'Prose.', terminal: 'stop', finishReason: 'stop' };
    });
    const ok = await useStoryRenderStore.getState().start(runInput({ llm }));
    expect(ok).toBe(true);
    const statuses = putRenderUnit.mock.calls.map((c) => c[3].status);
    expect(statuses[0]).toBe('error');
    // A run that stopped on scene 1 of 2 would have spent the key for
    // nothing.
    expect(statuses[1]).toBe('complete');
  });

  it('adopts the winner’s token on a 409 unit write', async () => {
    putRenderUnit
      .mockRejectedValueOnce(new FakeConflict(77))
      .mockResolvedValue({ scene_id: 's1', server_ts: 2 });
    await useStoryRenderStore.getState().start(runInput());
    expect(putRenderUnit.mock.calls[1][3].baseTs).toBe(77);
  });

  it('clear() does not drop a live run', async () => {
    let release: (v: unknown) => void = () => {};
    const llm = vi.fn(
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    const running = useStoryRenderStore.getState().start(runInput({ llm }));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    useStoryRenderStore.getState().clear();
    expect(useStoryRenderStore.getState().isRunning).toBe(true);

    release({ text: 'x', terminal: 'stop', finishReason: 'stop' });
    useStoryRenderStore.getState().cancel();
    await running;
  });
});
