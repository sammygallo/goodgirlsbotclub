import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRender = vi.fn();
const getRender = vi.fn();
const acquireRenderLock = vi.fn();
const releaseRenderLock = vi.fn();
const setRenderStatus = vi.fn();
const putRenderUnit = vi.fn();
const listRenderUnits = vi.fn();

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
    listRenderUnits: (...a: unknown[]) => listRenderUnits(...a),
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
  listRenderUnits.mockResolvedValue({
    items: [],
    next_after_sequence: null,
    next_after_scene_id: null,
    has_more: false,
  });
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

describe('resume', () => {
  const resumeInput = (over: Record<string, unknown> = {}) =>
    ({
      projectId: 'p1',
      renderId: 'r1',
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
      ...over,
    }) as Parameters<ReturnType<typeof useStoryRenderStore.getState>['resume']>[0];

  beforeEach(() => {
    getRender.mockResolvedValue({ ...RENDER, status: 'paused', server_ts: 30 });
  });

  it('re-renders ONLY the scenes that are not banked', async () => {
    listRenderUnits.mockResolvedValue({
      items: [{ scene_id: 's1', sequence: 0, status: 'complete' }],
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });

    const ok = await useStoryRenderStore.getState().resume(resumeInput());

    expect(ok).toBe(true);
    // s1 was already paid for; only s2 costs anything.
    expect(putRenderUnit).toHaveBeenCalledTimes(1);
    expect(putRenderUnit.mock.calls[0][2]).toBe('s2');
  });

  it('does NOT re-render a truncated unit', async () => {
    // A finished call whose output hit the cap. Re-running it unchanged
    // would very likely truncate again and bill for the privilege; §3.4's
    // remedy is an explicit per-scene re-render.
    listRenderUnits.mockResolvedValue({
      items: [{ scene_id: 's1', sequence: 0, status: 'truncated' }],
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });
    await useStoryRenderStore.getState().resume(resumeInput());
    expect(putRenderUnit.mock.calls.map((c) => c[2])).toEqual(['s2']);
  });

  it('DOES re-render an errored unit', async () => {
    listRenderUnits.mockResolvedValue({
      items: [{ scene_id: 's1', sequence: 0, status: 'error' }],
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });
    await useStoryRenderStore.getState().resume(resumeInput());
    expect(putRenderUnit.mock.calls.map((c) => c[2])).toEqual(['s1', 's2']);
  });

  it('numbers a resumed scene by its place in the WHOLE range', async () => {
    // The prose prompt says "Scene X of Y". Numbering against the
    // remaining slice would tell the model that scene 2 is scene 1 of a
    // one-scene story.
    listRenderUnits.mockResolvedValue({
      items: [{ scene_id: 's1', sequence: 0, status: 'complete' }],
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });
    const llm = vi.fn(async (msgs: { content: string }[]) => {
      void msgs;
      return { text: 'Prose.', terminal: 'stop' as const, finishReason: 'stop' };
    });
    await useStoryRenderStore.getState().resume(resumeInput({ llm }));
    expect(llm.mock.calls[0][0][1].content).toContain('Scene 2 of 2');
  });

  it('gives a resumed scene its real predecessor’s summary', async () => {
    // Scene 2's predecessor is scene 1 whether or not 1 is being
    // re-rendered. Reading it from the remaining slice would hand the
    // model no preceding context at all.
    listRenderUnits.mockResolvedValue({
      items: [{ scene_id: 's1', sequence: 0, status: 'complete' }],
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });
    const llm = vi.fn(async (msgs: { content: string }[]) => {
      void msgs;
      return { text: 'Prose.', terminal: 'stop' as const, finishReason: 'stop' };
    });
    await useStoryRenderStore.getState().resume(resumeInput({ llm }));
    expect(llm.mock.calls[0][0][1].content).toContain('Immediately before this scene');
  });

  it('takes the range from the RUN ROW, not the caller', async () => {
    getRender.mockResolvedValue({
      ...RENDER,
      status: 'paused',
      scene_id_start: 's2',
      scene_id_end: 's2',
      server_ts: 30,
    });
    await useStoryRenderStore.getState().resume(resumeInput());
    // Only s2 — the run's own span — even though the caller passed both.
    expect(putRenderUnit.mock.calls.map((c) => c[2])).toEqual(['s2']);
  });

  it('refuses a run whose scene anchors have vanished', async () => {
    getRender.mockResolvedValue({
      ...RENDER,
      status: 'paused',
      scene_id_start: 'gone',
      scene_id_end: 'gone',
      server_ts: 30,
    });
    const ok = await useStoryRenderStore.getState().resume(resumeInput());
    expect(ok).toBe(false);
    expect(putRenderUnit).not.toHaveBeenCalled();
  });

  it('refuses a finished run rather than re-billing it', async () => {
    getRender.mockResolvedValue({ ...RENDER, status: 'complete', server_ts: 30 });
    const ok = await useStoryRenderStore.getState().resume(resumeInput());
    expect(ok).toBe(false);
    expect(acquireRenderLock).not.toHaveBeenCalled();
    expect(putRenderUnit).not.toHaveBeenCalled();
  });

  it('refuses when the banked units cannot be read', async () => {
    // Resuming blind would re-render — and re-bill — finished scenes.
    listRenderUnits.mockRejectedValue(new Error('network'));
    const ok = await useStoryRenderStore.getState().resume(resumeInput());
    expect(ok).toBe(false);
    expect(putRenderUnit).not.toHaveBeenCalled();
  });

  it('applies the ingestion cross-gate too', async () => {
    ingestState.checkpoint = { status: 'error', current_pass: 'transcript_walk' };
    const ok = await useStoryRenderStore.getState().resume(resumeInput());
    expect(ok).toBe(false);
    expect(acquireRenderLock).not.toHaveBeenCalled();
  });

  it('surfaces a foreign lock, with takeover left to the caller', async () => {
    acquireRenderLock.mockRejectedValueOnce(new FakeLocked(true));
    const ok = await useStoryRenderStore.getState().resume(resumeInput());
    expect(ok).toBe(false);
    expect(useStoryRenderStore.getState().lockedBy?.takeable).toBe(true);
    // Never implicit — the backend refuses an aged-out holder without it.
    expect(acquireRenderLock.mock.calls[0][2].takeover).toBe(false);
  });

  it('counts banked scenes toward progress rather than restarting at zero', async () => {
    listRenderUnits.mockResolvedValue({
      items: [{ scene_id: 's1', sequence: 0, status: 'complete' }],
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });
    await useStoryRenderStore.getState().resume(resumeInput());
    expect(useStoryRenderStore.getState().progress).toMatchObject({ done: 2, total: 2 });
  });

  it('sets the run back to running before rendering', async () => {
    await useStoryRenderStore.getState().resume(resumeInput());
    expect(setRenderStatus.mock.calls[0][2].status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Adversarial review findings (confirmed)
// ---------------------------------------------------------------------------

describe('review fixes', () => {
  /** `checkContinuity` returns early when the scene has NO facts, so a
   *  test about the continuity call has to give it one — otherwise the
   *  model is never called for it and the scenario does not occur. */
  const WITH_FACT = [
    {
      seq: 1,
      id: 'f1',
      created_at: 'x',
      data: {
        id: 'f1',
        text: 'Ivy carries an iron key.',
        category: 'reveal',
        established_in: null,
        confidence: 'explicit',
      },
    },
  ];

  /** A prose call that succeeds, then a continuity call that fails. */
  function proseThenContinuityFailure() {
    let call = 0;
    return vi.fn(async () => {
      // Per scene: renderSceneProse is the odd call, checkContinuity the
      // even one.
      if (++call % 2 === 0) throw new Error('provider 429');
      return { text: 'Good prose.', terminal: 'stop' as const, finishReason: 'stop' };
    });
  }

  it('keeps the prose’s own status when the CONTINUITY call fails', async () => {
    // The expensive call succeeded. Marking the scene `error` sent it back
    // into resume's re-render set, re-billing the 4096-token prose call
    // because the 1200-token check hit a 429.
    await useStoryRenderStore
      .getState()
      .start(runInput({ llm: proseThenContinuityFailure(), factRows: WITH_FACT }));

    const written = putRenderUnit.mock.calls.map((c) => c[3]);
    expect(written[0].status).toBe('complete');
    expect(written[0].prose).toBe('Good prose.');
    // The failure is recorded where it belongs.
    expect(written[0].continuity.unreadable).toBe(true);
    expect(written[0].continuity.continuity_error).toContain('429');
  });

  it('does not count one scene as both truncated and errored', async () => {
    await useStoryRenderStore
      .getState()
      .start(runInput({ llm: proseThenContinuityFailure(), factRows: WITH_FACT }));
    const p = useStoryRenderStore.getState().progress!;
    expect(p.truncated + p.errored).toBeLessThanOrEqual(p.total);
    expect(p.errored).toBe(0);
  });

  it('BANKS a scene whose prose finished before Stop was pressed', async () => {
    // The store promises a closed tab costs at most the scene in flight,
    // and a scene whose prose has landed is not in flight.
    const llm = vi.fn(async () => {
      const out = { text: 'Paid prose.', terminal: 'stop' as const, finishReason: 'stop' };
      useStoryRenderStore.getState().cancel();
      return out;
    });
    const ok = await useStoryRenderStore.getState().start(runInput({ llm }));

    expect(ok).toBe(false);
    // The finished scene is written despite the abort...
    expect(putRenderUnit).toHaveBeenCalledTimes(1);
    expect(putRenderUnit.mock.calls[0][3].prose).toBe('Paid prose.');
    // ...with its tokens, so the run row's receipt matches the gauge.
    expect(putRenderUnit.mock.calls[0][3].outputTokensDelta).toBeGreaterThan(0);
    expect(setRenderStatus.mock.calls.at(-1)![2].status).toBe('paused');
  });

  it('stops after consecutive failures instead of billing every scene', async () => {
    const scenes = Array.from({ length: 12 }, (_, i) => sceneRow(`s${i}`, i));
    const llm = vi.fn(async () => {
      throw new Error('402 payment required');
    });
    await useStoryRenderStore.getState().start(
      runInput({ scenes, sceneIdStart: 's0', sceneIdEnd: 's11', llm })
    );
    // Far short of twelve.
    expect(llm.mock.calls.length).toBeLessThan(12);
  });

  it('never re-reads the run row after a unit write', async () => {
    // `put_render_unit` deliberately leaves the run's server_ts alone, so
    // re-reading raced the heartbeat AND disarmed restore's staleness 409.
    await useStoryRenderStore.getState().start(runInput());
    expect(getRender).not.toHaveBeenCalled();
  });

  it('adopts the winner’s token when the terminal status write 409s', async () => {
    setRenderStatus
      .mockRejectedValueOnce(new FakeConflict(99))
      .mockImplementation(async (_p, _r, body) => ({
        ...RENDER,
        status: body.status,
        server_ts: 100,
      }));

    const ok = await useStoryRenderStore.getState().start(runInput());

    // A racing beat must not turn a fully successful run into a failure.
    expect(ok).toBe(true);
    expect(setRenderStatus.mock.calls[1][2]).toMatchObject({
      status: 'complete',
      baseTs: 99,
    });
    expect(releaseRenderLock).toHaveBeenCalled();
  });

  it('renders from the run’s hints SNAPSHOT, not the live section', async () => {
    // §3.2 stores the snapshot so a later hints edit cannot reinterpret
    // finished prose. Reading live hints gave a resumed run half a novel
    // in a different POV.
    createRender.mockResolvedValue({
      ...RENDER,
      hints: { pov: 'first', tense: 'past', compression_level: 'tight', style_anchors: [] },
    });
    const llm = vi.fn(async (msgs: { content: string }[]) => {
      void msgs;
      return { text: 'Prose.', terminal: 'stop' as const, finishReason: 'stop' };
    });

    await useStoryRenderStore.getState().start(
      runInput({
        llm,
        // The LIVE section says something else entirely.
        hints: {
          pov: 'third_omniscient',
          tense: 'present',
          compression_level: 'loose',
          style_anchors: [],
        },
      })
    );

    const prompt = llm.mock.calls[0][0][1].content;
    expect(prompt).toContain('first person');
    expect(prompt).not.toContain('third person omniscient');
  });
});

describe('review follow-ups (verified against current code)', () => {
  const resumeInput2 = (over: Record<string, unknown> = {}) =>
    ({
      projectId: 'p1',
      renderId: 'r1',
      scenes: [
        sceneRow('s1', 0),
        sceneRow('s2', 1),
        sceneRow('s3', 2),
        sceneRow('s4', 3),
        sceneRow('s5', 4),
      ],
      factRows: [],
      characters: [],
      worldRules: [],
      userVoice: null,
      hints: null,
      narrative: null,
      messages: [],
      wiEntries: [],
      llm: vi.fn(async () => ({ text: 'Prose.', terminal: 'stop', finishReason: 'stop' })),
      ...over,
    }) as Parameters<ReturnType<typeof useStoryRenderStore.getState>['resume']>[0];

  it('progress.done never goes backwards when banked scenes are not a leading run', async () => {
    // The review's probe produced 3 → 1 → 5 here. Reachable without
    // anything exotic: `start` banks a failed scene as `error` and carries
    // on, and `resume` re-renders `error` units.
    getRender.mockResolvedValue({
      ...RENDER,
      status: 'paused',
      scene_id_start: 's1',
      scene_id_end: 's5',
      server_ts: 30,
    });
    listRenderUnits.mockResolvedValue({
      items: [
        { scene_id: 's1', sequence: 0, status: 'error' },
        { scene_id: 's2', sequence: 1, status: 'complete' },
        { scene_id: 's3', sequence: 2, status: 'complete' },
        { scene_id: 's4', sequence: 3, status: 'complete' },
      ],
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });

    const seen: number[] = [];
    const unsub = useStoryRenderStore.subscribe((st) => {
      const d = st.progress?.done;
      if (typeof d === 'number' && seen[seen.length - 1] !== d) seen.push(d);
    });
    await useStoryRenderStore.getState().resume(resumeInput2());
    unsub();

    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // And it lands exactly on the total, which indexing cannot guarantee
    // when the tail is banked.
    expect(useStoryRenderStore.getState().progress).toMatchObject({ done: 5, total: 5 });
  });

  it('releases the lock it just took when the status flip fails', async () => {
    // The lock is per project AND across formats, and no heartbeat exists
    // yet — driveRender creates it and is never reached — so bailing out
    // while holding it locks every device out until the 120s expiry.
    getRender.mockResolvedValue({ ...RENDER, status: 'paused', server_ts: 30 });
    setRenderStatus.mockRejectedValue(new Error('network'));

    const ok = await useStoryRenderStore.getState().resume(resumeInput2());

    expect(ok).toBe(false);
    expect(acquireRenderLock).toHaveBeenCalled();
    expect(releaseRenderLock).toHaveBeenCalled();
  });

  it('retries the resume status flip on a 409 rather than bailing', async () => {
    // The token was read before the ingestion gate and a full page over
    // the units, so another device's heartbeat can legitimately move it.
    getRender.mockResolvedValue({ ...RENDER, status: 'paused', server_ts: 30 });
    setRenderStatus
      .mockRejectedValueOnce(new FakeConflict(88))
      .mockImplementation(async (_p, _r, body) => ({
        ...RENDER,
        status: body.status,
        server_ts: 90,
      }));

    const ok = await useStoryRenderStore.getState().resume(resumeInput2());

    expect(ok).toBe(true);
    expect(setRenderStatus.mock.calls[1][2]).toMatchObject({
      status: 'running',
      baseTs: 88,
    });
  });
});

// ---------------------------------------------------------------------------
// Per-scene re-render (step 3, phase 5)
//
// §3.4's remedy for a chapter the user did not like, and the ONLY path that
// re-bills a `truncated` unit — `resume` deliberately leaves those alone.
//
// It shares `resume`'s whole sequence (range from the run row, unit read,
// lock re-take, status flip, terminal write) because the last time two
// copies of that sequence existed they drifted, and the drift stranded the
// project-wide lock. What is NOT shared is asserted here.
// ---------------------------------------------------------------------------

describe('rerenderScene', () => {
  const rerenderInput = (over: Record<string, unknown> = {}) =>
    ({
      projectId: 'p1',
      renderId: 'r1',
      sceneId: 's1',
      scenes: [sceneRow('s1', 0), sceneRow('s2', 1)],
      factRows: [],
      characters: [],
      worldRules: [],
      userVoice: null,
      hints: null,
      narrative: null,
      messages: [],
      wiEntries: [],
      llm: vi.fn(async () => ({ text: 'Better prose.', terminal: 'stop', finishReason: 'stop' })),
      ...over,
    }) as Parameters<
      ReturnType<typeof useStoryRenderStore.getState>['rerenderScene']
    >[0];

  const banked = (items: Record<string, unknown>[]) => {
    listRenderUnits.mockResolvedValue({
      items,
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });
  };

  beforeEach(() => {
    getRender.mockResolvedValue({ ...RENDER, status: 'complete', server_ts: 30 });
  });

  it('accepts a COMPLETE run, which resume refuses', async () => {
    // The whole point: a finished book is exactly what a user re-renders one
    // chapter of. `resume` refuses `complete` because continuing one would
    // re-bill every scene; this bills exactly one, by name.
    banked([
      { scene_id: 's1', sequence: 0, status: 'complete' },
      { scene_id: 's2', sequence: 1, status: 'complete' },
    ]);

    const ok = await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    expect(ok).toBe(true);
    expect(putRenderUnit).toHaveBeenCalledTimes(1);
    expect(putRenderUnit.mock.calls[0][2]).toBe('s1');
  });

  it('re-renders a TRUNCATED unit — the one thing resume will not do', async () => {
    banked([{ scene_id: 's1', sequence: 0, status: 'truncated' }]);

    await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    expect(putRenderUnit).toHaveBeenCalledTimes(1);
    expect(putRenderUnit.mock.calls[0][2]).toBe('s1');
    expect(putRenderUnit.mock.calls[0][3]).toMatchObject({ status: 'complete' });
  });

  it('does not count the replaced chapter twice when it truncates again', async () => {
    // The seed carries the rest of the run's verdicts, so the target's OLD
    // verdict has to come back out before this attempt adds its new one.
    // Without that, one cut chapter is reported as two.
    banked([
      { scene_id: 's1', sequence: 0, status: 'truncated' },
      { scene_id: 's2', sequence: 1, status: 'complete' },
    ]);

    await useStoryRenderStore.getState().rerenderScene(
      rerenderInput({
        llm: vi.fn(async () => ({
          text: 'Still cut',
          terminal: 'length',
          finishReason: 'length',
        })),
      })
    );

    expect(useStoryRenderStore.getState().progress).toMatchObject({ truncated: 1 });
  });

  it('LEAVES THE EXISTING PROSE ALONE when the re-render fails', async () => {
    // The defect this pins is data loss, not a wrong number. `writeUnit` is
    // a full replace, so banking a failure here swaps finished, paid-for
    // prose for an empty `error` unit — destroying output because the RETRY
    // failed. A "write this chapter again" button must never be able to
    // leave the user with less than they started with.
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);

    const ok = await useStoryRenderStore.getState().rerenderScene(
      rerenderInput({
        llm: vi.fn(async () => {
          throw new Error('502 from the provider');
        }),
      })
    );

    expect(ok).toBe(true);
    // NOTHING was written over the good chapter.
    expect(putRenderUnit).not.toHaveBeenCalled();
    // And the failure is still reported rather than swallowed.
    expect(useStoryRenderStore.getState().progress).toMatchObject({ errored: 1 });
  });

  it('refuses a scene outside the run’s own range', async () => {
    // A unit written here would attach prose to a render that does not
    // claim that scene, and the reader lists units, not scenes.
    getRender.mockResolvedValue({
      ...RENDER,
      status: 'complete',
      scene_id_start: 's1',
      scene_id_end: 's1',
      server_ts: 30,
    });
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);

    const ok = await useStoryRenderStore
      .getState()
      .rerenderScene(rerenderInput({ sceneId: 's2' }));

    expect(ok).toBe(false);
    expect(putRenderUnit).not.toHaveBeenCalled();
    expect(acquireRenderLock).not.toHaveBeenCalled();
  });

  it('releases the lock when the status flip fails', async () => {
    // Identical to resume's own pin, and it has to be: no heartbeat exists
    // at this point, so bailing while holding the project-wide lock locks
    // every device and every format out for the full expiry.
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);
    setRenderStatus.mockRejectedValue(new Error('nope'));

    const ok = await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    expect(ok).toBe(false);
    expect(releaseRenderLock).toHaveBeenCalled();
  });

  it('still honours §3.6’s build cross-gate', async () => {
    ingestState.checkpoint = { status: 'paused', current_pass: 'transcript_walk' };
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);

    const ok = await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    expect(ok).toBe(false);
    expect(acquireRenderLock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regressions caught by the phase-5 adversarial review
//
// Every one of these shipped in the first cut of the Render tab and was found
// by review before merge. They are grouped together because they share a
// cause: `driveRender` was written for whole-run passes and then handed a
// one-scene pass without being told the difference.
// ---------------------------------------------------------------------------

describe('review regressions', () => {
  const rerenderInput = (over: Record<string, unknown> = {}) =>
    ({
      projectId: 'p1',
      renderId: 'r1',
      sceneId: 's1',
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
      ...over,
    }) as Parameters<
      ReturnType<typeof useStoryRenderStore.getState>['rerenderScene']
    >[0];

  const banked = (items: Record<string, unknown>[]) => {
    listRenderUnits.mockResolvedValue({
      items,
      next_after_sequence: null,
      next_after_scene_id: null,
      has_more: false,
    });
  };

  const lastStatus = () => setRenderStatus.mock.calls.at(-1)![2].status;

  it('a re-render RESTORES the run’s status instead of marking it complete', async () => {
    // The worst of the batch. `rerenderScene` accepts any status by design,
    // so re-rendering one chapter of a PAUSED run wrote `complete` over it —
    // and `resume` refuses a complete run (continuing one would re-bill every
    // scene), so the remaining scenes became unreachable. The user's only way
    // forward was a brand-new run over the same range.
    getRender.mockResolvedValue({ ...RENDER, status: 'paused', server_ts: 30 });
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);

    await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    expect(lastStatus()).toBe('paused');
  });

  it('a re-render of a COMPLETE run leaves it complete', async () => {
    getRender.mockResolvedValue({ ...RENDER, status: 'complete', server_ts: 30 });
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);

    await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    expect(lastStatus()).toBe('complete');
  });

  it('a FAILED re-render does not relabel a finished book “stopped”', async () => {
    // The catch path had the same scope-blindness as the success path: it
    // wrote `paused`/`error` unconditionally, so a transient failure while
    // re-rendering one chapter told the user their finished novel had
    // stopped partway.
    getRender.mockResolvedValue({ ...RENDER, status: 'complete', server_ts: 30 });
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);
    // The prose lands, the WRITE fails — the one way a scene-scoped pass
    // reaches driveRender's catch without the user aborting.
    putRenderUnit.mockRejectedValueOnce(new Error('network'));

    await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    expect(lastStatus()).toBe('complete');
  });

  it('a whole run still completes', async () => {
    // The restore must not leak into the normal path: `start` has no prior
    // status to go back to and must always finish the run.
    const ok = await useStoryRenderStore.getState().start(runInput());
    expect(ok).toBe(true);
    expect(lastStatus()).toBe('complete');
  });

  it('EMPTY prose with a terminal signal is a failure, not a finished chapter', async () => {
    // `renderSceneProse` returns `text.trim()` and never throws on an empty
    // completion — a content filter, a blanked refusal, a 200 with no text.
    // That reached the unit write as `complete` with empty prose, and
    // `putRenderUnit` is a full replace: the re-render overwrote a finished
    // chapter with nothing, under a SUCCESS toast.
    getRender.mockResolvedValue({ ...RENDER, status: 'complete', server_ts: 30 });
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);

    await useStoryRenderStore.getState().rerenderScene(
      rerenderInput({
        llm: vi.fn(async () => ({
          text: '   ',
          terminal: 'stop',
          finishReason: 'content_filter',
        })),
      })
    );

    expect(putRenderUnit).not.toHaveBeenCalled();
    expect(useStoryRenderStore.getState().progress).toMatchObject({ errored: 1 });
  });

  it('empty prose on a FRESH run banks an error unit, not an empty complete one', async () => {
    // Same classification, opposite handling: there is nothing to protect on
    // a first pass, so the failure is recorded — but never as `complete`,
    // which would export as a finished chapter containing nothing.
    const llm = vi.fn(async () => ({ text: '', terminal: 'stop', finishReason: 'stop' }));
    await useStoryRenderStore.getState().start(runInput({ llm }));

    for (const call of putRenderUnit.mock.calls) {
      expect(call[3].status).toBe('error');
    }
  });

  it('reports progress against what is BANKED, not against the re-render set', async () => {
    // `fullRange.length - toRender.size` is right for a resume, where
    // `toRender` is the complement of what is banked. For a re-render it is
    // always one scene, so a two-scene run with ONE chapter reported 1 of 2
    // done before it started and 2 of 2 after — regardless of the fact that
    // scene 2 has never been rendered.
    getRender.mockResolvedValue({ ...RENDER, status: 'paused', server_ts: 30 });
    banked([{ scene_id: 's1', sequence: 0, status: 'complete' }]);

    await useStoryRenderStore.getState().rerenderScene(rerenderInput());

    // s1 is the one being redone and s2 was never rendered, so exactly one
    // chapter exists when this finishes.
    expect(useStoryRenderStore.getState().progress).toMatchObject({
      done: 1,
      total: 2,
    });
  });

  it('leaves the parked run in state so the UI can offer to continue it', async () => {
    // The catch block fetched the parked row, used it for its token, and
    // threw it away. The progress card decides whether to render at all from
    // that row, so after a Stop it saw null and drew nothing — taking the
    // only "Continue render" affordance with it, on a run the server was
    // perfectly willing to resume.
    setRenderStatus.mockImplementation(async (_p, _r, body) => ({
      ...RENDER,
      status: body.status,
      server_ts: 40,
    }));
    const llm = vi.fn(async () => {
      throw new Error('provider exploded');
    });

    // Three scenes so the run trips MAX_CONSECUTIVE_SCENE_FAILURES and
    // genuinely parks, rather than recording three failures and reporting
    // itself finished.
    await useStoryRenderStore.getState().start(
      runInput({
        llm,
        scenes: [sceneRow('s1', 0), sceneRow('s2', 1), sceneRow('s3', 2)],
        sceneIdEnd: 's3',
      })
    );

    expect(useStoryRenderStore.getState().render).toMatchObject({ status: 'error' });
  });
});
