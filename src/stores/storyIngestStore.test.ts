import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSection = vi.fn();
const putSection = vi.fn();
const getScene = vi.fn();
const bulkWriteScenes = vi.fn();
const appendFact = vi.fn();
const manifest = vi.fn();

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

class FakeBulkConflict extends Error {
  conflicts: { id: string; currentTs: number }[];
  constructor(conflicts: { id: string; currentTs: number }[]) {
    super('bulk conflict');
    this.name = 'SceneBulkConflictError';
    this.conflicts = conflicts;
  }
}

vi.mock('../api/client', () => ({
  storyApi: {
    getSection: (...a: unknown[]) => getSection(...a),
    putSection: (...a: unknown[]) => putSection(...a),
    getScene: (...a: unknown[]) => getScene(...a),
    bulkWriteScenes: (...a: unknown[]) => bulkWriteScenes(...a),
    appendFact: (...a: unknown[]) => appendFact(...a),
    manifest: (...a: unknown[]) => manifest(...a),
  },
  StoryConflictError: FakeConflict,
  SceneBulkConflictError: FakeBulkConflict,
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
    chat: { character_avatar: 'Ivy.png', file_name: 'chat1.jsonl' },
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

/** A transcript long enough to matter for chunking: alternating user/AI
 *  turns, each with enough content to be a plausible message. */
function longMessages(n: number, contentLength = 20) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    name: i % 2 === 0 ? 'Sam' : 'Ivy',
    isUser: i % 2 === 0,
    isSystem: false,
    content:
      i % 2 === 0
        ? `User line ${i} ${'padding '.repeat(contentLength)}`
        : `Ivy line ${i} ${'padding '.repeat(contentLength)}`,
    timestamp: i,
    swipeIdx: 0,
    swipesCount: 1,
  }));
}

function wireScenesAndFacts() {
  let sceneTs = 0;
  bulkWriteScenes.mockImplementation(async (_p: string, scenes: { id: string; data: { sequence: number } }[]) => ({
    written: scenes.length,
    scenes: scenes.map((s) => ({
      id: s.id,
      sequence: s.data.sequence,
      data: s.data,
      server_ts: ++sceneTs,
      updated_at: 'x',
    })),
  }));
  let factSeq = 0;
  appendFact.mockImplementation(async (_p: string, data: { id: string }) => ({
    seq: ++factSeq,
    id: data.id,
    data,
    created_at: 'x',
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

describe('transcript walk (phase 7)', () => {
  it('walks a multi-chunk transcript, writing scenes and facts per chunk', async () => {
    wireHappyPath();
    wireScenesAndFacts();

    // 65 messages forces a force-split at WALK_FORCE_SPLIT_MESSAGES=60:
    // chunk 1 = messages 0-59, chunk 2 = messages 60-64.
    const messages = longMessages(65);
    const chunk1Json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'Scene A',
          summary: 'a',
          detailed_summary: '',
          participants: ['Ivy'],
          start_local_idx: 0,
          end_local_idx: 59,
          closed: true,
          excluded_local_idxs: [],
          facts: [{ text: 'A fact was established.', category: 'reveal', local_idx: 30 }],
        },
      ],
    });
    const chunk2Json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'Scene B',
          summary: 'b',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 4,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const voiceJson = JSON.stringify({
      style_summary: 'terse',
      register: 'pulp',
      rhetorical_devices: [],
      tendency: 'directive',
    });
    // Cold-start's 2 calls (attributes, voice) get trivial responses;
    // then one call per chunk, then the user_voice synthesis call.
    const responses = ['{}', '{}', chunk1Json, chunk2Json, voiceJson];
    let callIdx = 0;
    const llm = vi.fn(async () => responses[Math.min(callIdx++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));
    expect(ok).toBe(true);
    expect(bulkWriteScenes).toHaveBeenCalledTimes(2);
    expect(appendFact).toHaveBeenCalledTimes(1);

    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.status).toBe('complete');
    expect(last.chunk_index).toBe(2);
    expect(last.chunk_plan).toHaveLength(2);

    const userVoiceWrite = putSection.mock.calls.find((c) => c[1] === 'user_voice');
    expect(userVoiceWrite).toBeTruthy();
    expect(userVoiceWrite![2].register).toBe('pulp');
  });

  it('resumes from chunk_index without rerunning cold_start', async () => {
    const messages = longMessages(65);
    const chunkPlan = [
      { start_msg_id: 'm0', end_msg_id: 'm59', est_tokens: 100 },
      { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
    ];
    getSection.mockImplementation(async (_p: string, name: string) => {
      if (name === 'ingestion') {
        return {
          section: 'ingestion',
          server_ts: 10,
          updated_at: 'x',
          data: {
            status: 'error', // an earlier attempt was interrupted
            current_pass: 'transcript_walk',
            prompt_version: PROMPT_VERSION,
            chunk_index: 1,
            chunk_plan: chunkPlan,
            last_ingested: {
              msg_id: 'm59',
              swipe_idx: 0,
              fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
            },
            open_scene: null,
            lock: null,
            token_usage: { input_tokens: 5, output_tokens: 5 },
            replay_approx: false,
            error: '',
          },
        };
      }
      if (name === 'entities') {
        return {
          section: 'entities',
          server_ts: 1,
          updated_at: 'x',
          data: {
            characters: [{ id: 'char-ivy', canonical_name: 'Ivy', aliases: [] }],
            objects: [],
            factions: [],
          },
        };
      }
      throw new Error('404');
    });
    let ts = 10;
    putSection.mockImplementation(async (_p, section, data) => ({
      section,
      data,
      server_ts: ++ts,
      updated_at: 'x',
    }));
    manifest.mockResolvedValue({
      project_id: 'p1',
      sections: [],
      scene_count: 1,
      fact_count: 0,
      edit_count: 0,
    });
    wireScenesAndFacts();

    const chunk2Json = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'Scene B',
          summary: 'b',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 4,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const voiceJson = JSON.stringify({
      style_summary: '',
      register: 'mixed',
      rhetorical_devices: [],
      tendency: 'reactive',
    });
    // NO cold-start calls expected — only the remaining chunk + voice.
    const responses = [chunk2Json, voiceJson];
    let callIdx = 0;
    const llm = vi.fn(async () => responses[Math.min(callIdx++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));
    expect(ok).toBe(true);
    // Only chunk 1 (the unfinished one) is walked — chunk 0 already done.
    expect(bulkWriteScenes).toHaveBeenCalledTimes(1);
    expect(llm).toHaveBeenCalledTimes(2);

    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.chunk_index).toBe(2);
  });

  /** An interrupted walk whose checkpoint still reads chunk_index 0.
   *
   *  This is the state the loop leaves behind whenever chunk 0's scenes
   *  and facts are committed but the index has not advanced yet — the
   *  window between the bulk write and the per-chunk checkpoint save,
   *  which for a chunk with N facts spans N+1 HTTP calls. */
  function interruptedAtChunkZero(chunkPlan: unknown[]) {
    return (_p: string, name: string) => {
      if (name === 'ingestion') {
        return Promise.resolve({
          section: 'ingestion',
          server_ts: 10,
          updated_at: 'x',
          data: {
            status: 'error',
            current_pass: 'transcript_walk',
            prompt_version: PROMPT_VERSION,
            chunk_index: 0,
            chunk_plan: chunkPlan,
            last_ingested: null,
            open_scene: null,
            lock: null,
            token_usage: { input_tokens: 5, output_tokens: 5 },
            replay_approx: false,
            error: 'HTTP 500',
          },
        });
      }
      if (name === 'entities') {
        return Promise.resolve({
          section: 'entities',
          server_ts: 1,
          updated_at: 'x',
          data: {
            characters: [{ id: 'char-ivy', canonical_name: 'Ivy', aliases: [] }],
            objects: [],
            factions: [],
          },
        });
      }
      return Promise.reject(new Error('404'));
    };
  }

  it('does not rerun cold_start when interrupted at chunk_index 0', async () => {
    // The off-by-one this covers: chunk 0's scenes are DURABLY committed
    // before chunk_index leaves 0, so gating resume on `chunk_index > 0`
    // classified that window as a fresh build. cold_start would then
    // remint every character id and full-replace the entities section,
    // orphaning the participants of the scene already on the server.
    const messages = longMessages(65);
    const chunkPlan = [
      { start_msg_id: 'm0', end_msg_id: 'm59', est_tokens: 100 },
      { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
    ];
    getSection.mockImplementation(interruptedAtChunkZero(chunkPlan));
    let ts = 10;
    putSection.mockImplementation(async (_p, section, data) => ({
      section,
      data,
      server_ts: ++ts,
      updated_at: 'x',
    }));
    manifest.mockResolvedValue({
      project_id: 'p1',
      sections: [],
      scene_count: 1,
      fact_count: 0,
      edit_count: 0,
    });
    wireScenesAndFacts();

    const sceneJson = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'Scene',
          summary: 's',
          detailed_summary: '',
          participants: ['Ivy'],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const llm = vi.fn(async () => sceneJson);

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));

    expect(ok).toBe(true);
    // cold_start never ran: it is the only thing that writes 'entities'.
    expect(putSection.mock.calls.some((c) => c[1] === 'entities')).toBe(false);
    // And the cast was READ BACK rather than reminted — the scene written
    // carries the id already on the server, not a fresh random one.
    const writtenScenes = bulkWriteScenes.mock.calls.flatMap((c) => c[1]);
    expect(writtenScenes[0].data.participants).toContain('char-ivy');
  });

  it('re-plans instead of diverging when interrupted at chunk_index 0', async () => {
    // At index 0 nothing has been checkpointed, so there is nothing to
    // reconcile against the pinned plan. Reusing it would mean a user who
    // deleted a message after a failed first chunk gets dead-ended into
    // "Reset story" — which deletes their whole bible — where today they
    // just click Build. So the walk keeps `chunk_index > 0` for plan
    // REUSE even though the store drops it for cold-start skipping.
    const messages = longMessages(65);
    const chunkPlan = [
      // A boundary that no longer exists in `messages`.
      { start_msg_id: 'gone-forever', end_msg_id: 'm59', est_tokens: 100 },
      { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
    ];
    getSection.mockImplementation(interruptedAtChunkZero(chunkPlan));
    let ts = 10;
    putSection.mockImplementation(async (_p, section, data) => ({
      section,
      data,
      server_ts: ++ts,
      updated_at: 'x',
    }));
    manifest.mockResolvedValue({
      project_id: 'p1',
      sections: [],
      scene_count: 0,
      fact_count: 0,
      edit_count: 0,
    });
    wireScenesAndFacts();
    const llm = vi.fn(async () =>
      JSON.stringify({
        scenes: [
          {
            continues_open_scene: false,
            title: 'Scene',
            summary: 's',
            detailed_summary: '',
            participants: [],
            start_local_idx: 0,
            end_local_idx: 1,
            closed: true,
            excluded_local_idxs: [],
            facts: [],
          },
        ],
      })
    );

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));

    // Completed rather than reporting divergence, and still without
    // rerunning cold_start.
    expect(ok).toBe(true);
    expect(putSection.mock.calls.some((c) => c[1] === 'entities')).toBe(false);
    expect(bulkWriteScenes).toHaveBeenCalled();
  });

  it('aborts the resume when the entities read fails transiently', async () => {
    // A blip here is NOT "this bible has no cast". Swallowing it stripped
    // participants from every scene in every remaining chunk, and the
    // per-chunk checkpoint advance made that unrecoverable. Failing costs
    // nothing: the read happens before the chunk loop and before any LLM
    // call, so no tokens are spent and chunk_index is untouched.
    const messages = longMessages(65);
    const chunkPlan = [
      { start_msg_id: 'm0', end_msg_id: 'm59', est_tokens: 100 },
      { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
    ];
    getSection.mockImplementation(async (_p: string, name: string) => {
      if (name === 'ingestion') {
        return {
          section: 'ingestion',
          server_ts: 10,
          updated_at: 'x',
          data: {
            status: 'error',
            current_pass: 'transcript_walk',
            prompt_version: PROMPT_VERSION,
            chunk_index: 1,
            chunk_plan: chunkPlan,
            last_ingested: {
              msg_id: 'm59',
              swipe_idx: 0,
              fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
            },
            open_scene: null,
            lock: null,
            token_usage: { input_tokens: 5, output_tokens: 5 },
            replay_approx: false,
            error: '',
          },
        };
      }
      if (name === 'entities') throw new Error('HTTP 503');
      throw new Error('404');
    });
    let ts = 10;
    putSection.mockImplementation(async (_p, section, data) => ({
      section,
      data,
      server_ts: ++ts,
      updated_at: 'x',
    }));
    wireScenesAndFacts();
    const llm = vi.fn(async () => '{}');

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));

    expect(ok).toBe(false);
    // Nothing walked, nothing paid for.
    expect(llm).not.toHaveBeenCalled();
    expect(bulkWriteScenes).not.toHaveBeenCalled();
    // And the index is preserved, so Build resumes from the same chunk.
    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.chunk_index).toBe(1);
    expect(last.status).toBe('error');
    expect(last.error).toContain('503');
  });

  it('does not leave a heartbeat running after the run loses ownership', async () => {
    // The heartbeat used to be cleared at each exit point, which missed
    // the bare `return false` bail-outs inside run()'s try. A leaked timer
    // keeps firing for the life of the page and PUTs the DEAD run's
    // checkpoint — against whichever project is open by then, using that
    // project's server_ts as the base. It corrupts the wrong Work's tab
    // and can 409 a healthy build into 'error'.
    vi.useFakeTimers();
    try {
      wireHappyPath();
      wireScenesAndFacts();
      manifest.mockResolvedValue({
        project_id: 'p1',
        sections: [],
        scene_count: 0,
        fact_count: 0,
        edit_count: 0,
      });
      // The user switches Works while the first model call is in flight.
      const llm = vi.fn(async () => {
        useStoryIngestStore.setState({ projectId: 'p2' });
        return '{}';
      });

      const ok = await useStoryIngestStore
        .getState()
        .run(runInput({ messages: longMessages(10), llm }));
      expect(ok).toBe(false);

      // The same bail-outs also skipped finish(), so the run's own flags
      // were never released — and clear() deliberately refuses to reset a
      // run it believes is still live, wedging the store into never
      // building again.
      expect(useStoryIngestStore.getState().isRunning).toBe(false);
      expect(useStoryIngestStore.getState().abort).toBeNull();

      const callsAtBail = putSection.mock.calls.length;
      // Well past two heartbeat periods.
      await vi.advanceTimersByTimeAsync(LOCK_STALE_MS * 3);

      expect(putSection.mock.calls.length).toBe(callsAtBail);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports divergence and does not touch scenes/facts when a resumed plan boundary is gone', async () => {
    const chunkPlan = [
      { start_msg_id: 'm0', end_msg_id: 'm59', est_tokens: 100 },
      { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
    ];
    getSection.mockImplementation(async (_p: string, name: string) => {
      if (name === 'ingestion') {
        return {
          section: 'ingestion',
          server_ts: 10,
          updated_at: 'x',
          data: {
            status: 'error',
            current_pass: 'transcript_walk',
            prompt_version: PROMPT_VERSION,
            chunk_index: 1,
            chunk_plan: chunkPlan,
            last_ingested: {
              msg_id: 'm59',
              swipe_idx: 0,
              fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
            },
            open_scene: null,
            lock: null,
            token_usage: { input_tokens: 0, output_tokens: 0 },
            replay_approx: false,
            error: '',
          },
        };
      }
      throw new Error('404');
    });
    let ts = 10;
    putSection.mockImplementation(async (_p, section, data) => ({
      section,
      data,
      server_ts: ++ts,
      updated_at: 'x',
    }));

    // m59 (the checkpoint's last_ingested) no longer exists in the
    // current transcript — simulates history changing under the walk.
    const messages = longMessages(65).filter((m) => m.id !== 'm59');
    const llm = vi.fn(async () => '{}');

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));
    expect(ok).toBe(false);
    expect(bulkWriteScenes).not.toHaveBeenCalled();
    expect(appendFact).not.toHaveBeenCalled();

    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.status).toBe('error');
    expect(last.error).toContain('Reset story');
  });

  it('refuses a walk exceeding the soft cap before any chunk model call, without confirmation', async () => {
    wireHappyPath();
    wireScenesAndFacts();

    // Long enough per-message content that each message alone blows the
    // per-chunk token budget, forcing > WALK_CHUNK_SOFT_CAP (200) chunks.
    const messages = longMessages(201, 3000);
    const llm = vi.fn(async () => '{}');

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));
    expect(ok).toBe(false);
    expect(bulkWriteScenes).not.toHaveBeenCalled();

    const ingestWrites = putSection.mock.calls.filter((c) => c[1] === 'ingestion');
    const last = ingestWrites[ingestWrites.length - 1][2];
    expect(last.status).toBe('paused');
    expect(last.error).toContain('chunks');
  });

  it('bulkWriteScenesWithRetry adopts a 409 conflict and retries once', async () => {
    wireHappyPath();
    let attempt = 0;
    bulkWriteScenes.mockImplementation(
      async (_p: string, scenes: { id: string; data: { sequence: number } }[]) => {
        attempt++;
        if (attempt === 1) {
          throw new FakeBulkConflict(scenes.map((s) => ({ id: s.id, currentTs: 5 })));
        }
        return {
          written: scenes.length,
          scenes: scenes.map((s) => ({
            id: s.id,
            sequence: s.data.sequence,
            data: s.data,
            server_ts: 6,
            updated_at: 'x',
          })),
        };
      }
    );
    appendFact.mockResolvedValue({ seq: 1, id: 'f1', data: {}, created_at: 'x' });

    const messages = longMessages(2);
    const sceneJson = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'A',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 1,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const voiceJson = JSON.stringify({
      style_summary: '',
      register: 'mixed',
      rhetorical_devices: [],
      tendency: 'reactive',
    });
    const responses = ['{}', '{}', sceneJson, voiceJson];
    let callIdx = 0;
    const llm = vi.fn(async () => responses[Math.min(callIdx++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(runInput({ messages, llm }));
    expect(ok).toBe(true);
    expect(attempt).toBe(2);
  });
});
