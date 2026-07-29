import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSection = vi.fn();
const putSection = vi.fn();

class FakeConflict extends Error {
  currentTs: number;
  current: unknown;
  constructor(currentTs: number, current: unknown) {
    super('conflict');
    this.name = 'StoryConflictError';
    this.currentTs = currentTs;
    this.current = current;
  }
}

vi.mock('../api/client', () => ({
  storyApi: {
    getSection: (...a: unknown[]) => getSection(...a),
    putSection: (...a: unknown[]) => putSection(...a),
  },
  StoryConflictError: FakeConflict,
}));
vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));
vi.mock('./usageStore', () => ({
  useUsageStore: { getState: () => ({ recordGeneration: vi.fn() }) },
}));

const { useStoryIngestStore, LOCK_STALE_MS, estimateColdStartTokens } =
  await import('./storyIngestStore');
const { PROMPT_VERSION } = await import('../utils/storyIngest/prompts');

const SOURCES = {
  characterName: 'Ivy',
  characterAvatar: 'Ivy.png',
  description: 'An archivist.',
  personality: 'Dry.',
  scenario: 'The Reach.',
  mesExample: '',
  firstMessage: '',
  persona: null,
  lorebooks: [],
};

function runInput(over: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    sources: SOURCES,
    messages: [],
    wiEntries: [],
    isGroupChat: false,
    ...over,
  } as Parameters<ReturnType<typeof useStoryIngestStore.getState>['run']>[0];
}

/** Section writes: return an incrementing server_ts like the real API. */
function wireHappyPath() {
  let ts = 0;
  getSection.mockRejectedValue(new Error('404'));
  putSection.mockImplementation(async (_p, section, data) => ({
    section,
    data,
    server_ts: ++ts,
    updated_at: 'x',
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useStoryIngestStore.getState().clear();
});

describe('checkpoint round-trip', () => {
  it('writes a running checkpoint, then a complete one', async () => {
    wireHappyPath();
    await useStoryIngestStore.getState().run(runInput());

    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    expect(ingestWrites.length).toBeGreaterThanOrEqual(2);

    const first = ingestWrites[0][2];
    expect(first.status).toBe('running');
    expect(first.prompt_version).toBe(PROMPT_VERSION);
    // The lock is claimed while work is in flight...
    expect(first.lock?.client_id).toBeTruthy();

    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.status).toBe('complete');
    // ...and released when it isn't, so another device isn't blocked.
    expect(last.lock).toBeNull();
  });

  it('writes the three cold-start sections', async () => {
    wireHappyPath();
    await useStoryIngestStore.getState().run(runInput());
    const sections = putSection.mock.calls.map((c) => c[1]);
    expect(sections).toContain('entities');
    expect(sections).toContain('world');
    expect(sections).toContain('rendering_hints');
  });

  it('records an aborted run as paused, not failed', async () => {
    wireHappyPath();
    const llm = vi.fn(async () => {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    });
    await useStoryIngestStore.getState().run(runInput({ llm }));

    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.status).toBe('paused');
    // A cancel is a user decision, not an error to display.
    expect(last.error).toBe('');
    expect(useStoryIngestStore.getState().error).toBeNull();
  });

  it('records a real failure with its message and releases the lock', async () => {
    let ts = 0;
    getSection.mockRejectedValue(new Error('404'));
    putSection.mockImplementation(async (_p, section, data) => {
      if (section === 'entities') throw new Error('server on fire');
      return { section, data, server_ts: ++ts, updated_at: 'x' };
    });

    const ok = await useStoryIngestStore.getState().run(runInput());
    expect(ok).toBe(false);

    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.status).toBe('error');
    expect(last.error).toContain('server on fire');
    expect(last.lock).toBeNull();
  });
});

describe('advisory lock', () => {
  it('refuses to start when another device holds a fresh lock', async () => {
    getSection.mockResolvedValue({
      section: 'ingestion',
      server_ts: 3,
      updated_at: 'x',
      data: {
        status: 'running',
        prompt_version: PROMPT_VERSION,
        lock: {
          client_id: 'some-other-tab',
          heartbeat_at: new Date().toISOString(),
        },
        token_usage: { input_tokens: 0, output_tokens: 0 },
        chunk_index: 0,
        chunk_plan: [],
        replay_approx: false,
        error: '',
      },
    });

    const ok = await useStoryIngestStore.getState().run(runInput());
    expect(ok).toBe(false);
    expect(putSection).not.toHaveBeenCalled();
  });

  it('takes over a stale lock — a closed tab must not wedge the story', async () => {
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString();
    let ts = 3;
    getSection.mockResolvedValue({
      section: 'ingestion',
      server_ts: 3,
      updated_at: 'x',
      data: {
        status: 'running',
        prompt_version: PROMPT_VERSION,
        lock: { client_id: 'dead-tab', heartbeat_at: stale },
        token_usage: { input_tokens: 0, output_tokens: 0 },
        chunk_index: 0,
        chunk_plan: [],
        replay_approx: false,
        error: '',
      },
    });
    putSection.mockImplementation(async (_p, section, data) => ({
      section,
      data,
      server_ts: ++ts,
      updated_at: 'x',
    }));

    const ok = await useStoryIngestStore.getState().run(runInput());
    expect(ok).toBe(true);
  });

  it('refuses a second concurrent run in the same tab', async () => {
    wireHappyPath();
    useStoryIngestStore.setState({ isRunning: true });
    expect(await useStoryIngestStore.getState().run(runInput())).toBe(false);
  });
});

describe('conflict handling on the checkpoint', () => {
  it('adopts the winner token and retries once', async () => {
    let ts = 0;
    getSection.mockRejectedValue(new Error('404'));
    let firstIngestWrite = true;
    putSection.mockImplementation(async (_p, section, data, baseTs) => {
      if (section === 'ingestion' && firstIngestWrite) {
        firstIngestWrite = false;
        throw new FakeConflict(9, null);
      }
      if (section === 'ingestion' && baseTs === 9) {
        return { section, data, server_ts: 10, updated_at: 'x' };
      }
      return { section, data, server_ts: ++ts, updated_at: 'x' };
    });

    const ok = await useStoryIngestStore.getState().run(runInput());
    expect(ok).toBe(true);
    const retried = putSection.mock.calls.find(
      (c) => c[1] === 'ingestion' && c[3] === 9
    );
    expect(retried).toBeTruthy();
  });
});

describe('resetIngestState', () => {
  it('clears a wedged checkpoint without touching the bible', async () => {
    putSection.mockResolvedValue({
      section: 'ingestion',
      data: {},
      server_ts: 5,
      updated_at: 'x',
    });
    useStoryIngestStore.setState({ projectId: 'p1', checkpointTs: 4 });

    expect(await useStoryIngestStore.getState().resetIngestState()).toBe(true);
    const [, section, data] = putSection.mock.calls[0];
    expect(section).toBe('ingestion');
    expect(data.status).toBe('idle');
    expect(data.lock).toBeNull();
    // Only the ingestion section is touched.
    expect(putSection.mock.calls.every((c) => c[1] === 'ingestion')).toBe(true);
  });
});

describe('preflight estimate', () => {
  it('scales with the card text it will send', () => {
    const small = estimateColdStartTokens(SOURCES);
    const big = estimateColdStartTokens({
      ...SOURCES,
      description: 'x '.repeat(5000),
    });
    expect(big).toBeGreaterThan(small);
  });
});

describe('review regressions', () => {
  it('leaving the tab does not orphan a live run (would double-spend)', async () => {
    wireHappyPath();
    let gateOpen = false;
    const waiters: (() => void)[] = [];
    const openGate = () => {
      gateOpen = true;
      waiters.splice(0).forEach((w) => w());
    };
    // Every model call parks until the gate opens, so the run is
    // genuinely mid-flight while we simulate leaving the tab.
    const llm = vi.fn(async () => {
      if (!gateOpen) await new Promise<void>((r) => waiters.push(r));
      return '{}';
    });

    const running = useStoryIngestStore.getState().run(runInput({ llm }));
    // Let run() reach its first parked model call.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // User navigates away — the component unmounts and calls clear().
    useStoryIngestStore.getState().clear();
    expect(useStoryIngestStore.getState().isRunning).toBe(true);
    expect(useStoryIngestStore.getState().abort).not.toBeNull();

    // And a second Build must NOT start another paid run.
    expect(await useStoryIngestStore.getState().run(runInput())).toBe(false);

    openGate();
    await running;
    expect(useStoryIngestStore.getState().isRunning).toBe(false);
  });

  it('clear() still resets a store with stale isRunning and no controller', () => {
    // Otherwise a wedged flag would block building forever.
    useStoryIngestStore.setState({ isRunning: true, abort: null, projectId: 'p1' });
    useStoryIngestStore.getState().clear();
    expect(useStoryIngestStore.getState().isRunning).toBe(false);
    expect(useStoryIngestStore.getState().projectId).toBeNull();
  });

  it('does not report success when every model call failed', async () => {
    wireHappyPath();
    const llm = vi.fn(async () => {
      throw new Error('402 payment required');
    });
    const ok = await useStoryIngestStore.getState().run(runInput({ llm }));

    // The mechanical bible still landed, so the run is not a failure...
    expect(ok).toBe(true);
    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    // ...but it must not silently claim the model contributed.
    expect(last.status).toBe('complete');
    expect(last.error).toContain('could not be reached');
  });

  it('bills the input tokens of a call that failed after being sent', async () => {
    wireHappyPath();
    const llm = vi.fn(async () => {
      throw new Error('provider 500');
    });
    await useStoryIngestStore.getState().run(runInput({ llm }));
    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.token_usage.input_tokens).toBeGreaterThan(0);
  });

  it('a stale-lock takeover still refreshes the lock as its own', async () => {
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString();
    let ts = 3;
    getSection.mockResolvedValue({
      section: 'ingestion', server_ts: 3, updated_at: 'x',
      data: {
        status: 'running', prompt_version: PROMPT_VERSION,
        lock: { client_id: 'dead-tab', heartbeat_at: stale },
        token_usage: { input_tokens: 0, output_tokens: 0 },
        chunk_index: 0, chunk_plan: [], replay_approx: false, error: '',
      },
    });
    putSection.mockImplementation(async (_p, section, data) => ({
      section, data, server_ts: ++ts, updated_at: 'x',
    }));

    await useStoryIngestStore.getState().run(runInput());
    const firstWrite = putSection.mock.calls.find((c) => c[1] === 'ingestion')![2];
    expect(firstWrite.lock.client_id).not.toBe('dead-tab');
  });

  it('resetIngestState survives a 409 — it exists for the wedged case', async () => {
    putSection
      .mockRejectedValueOnce(new FakeConflict(12, null))
      .mockResolvedValueOnce({
        section: 'ingestion', data: {}, server_ts: 13, updated_at: 'x',
      });
    useStoryIngestStore.setState({ projectId: 'p1', checkpointTs: 4 });

    expect(await useStoryIngestStore.getState().resetIngestState()).toBe(true);
    expect(putSection.mock.calls[1][3]).toBe(12);
  });

  it('a transient checkpoint read failure aborts rather than assuming "never built"', async () => {
    // Treating a network blip as "no checkpoint" would blind the lock
    // check and authorise a second concurrent paid build.
    getSection.mockRejectedValue(new Error('NetworkError: fetch failed'));
    const ok = await useStoryIngestStore.getState().run(runInput());
    expect(ok).toBe(false);
    expect(putSection).not.toHaveBeenCalled();
    expect(useStoryIngestStore.getState().isRunning).toBe(false);
  });
});
