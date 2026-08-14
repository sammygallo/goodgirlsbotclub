import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Contradiction } from '../types/storyBible';

const getSection = vi.fn();
const putSection = vi.fn();
const getScene = vi.fn();
const putScene = vi.fn();
const listScenesFull = vi.fn();
const bulkWriteScenes = vi.fn();
const appendFact = vi.fn();
const listFacts = vi.fn();
const listScenes = vi.fn();
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
    putScene: (...a: unknown[]) => putScene(...a),
    listScenesFull: (...a: unknown[]) => listScenesFull(...a),
    bulkWriteScenes: (...a: unknown[]) => bulkWriteScenes(...a),
    appendFact: (...a: unknown[]) => appendFact(...a),
    listFacts: (...a: unknown[]) => listFacts(...a),
    listScenes: (...a: unknown[]) => listScenes(...a),
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
const {
  PROMPT_VERSION,
  CARD_CHECK_SYSTEM,
  RECONCILE_SYSTEM,
  USER_VOICE_SYSTEM,
  WALK_SYSTEM,
} = await import('../utils/storyIngest/prompts');
const { cardFactId, contradictionId } = await import(
  '../utils/storyIngest/reconcileJudge'
);
const { estimateTokens } = await import('../utils/tokenizer');
const { showToastGlobal } = await import('../components/ui/Toast');

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

// ---------------------------------------------------------------------------
// Reconcile (phase 8) harness.
//
// Every earlier pass BLIND-WRITES the sections it owns, so a putSection
// that accepts anything is a good enough fake for them. Reconcile is the
// first read-modify-write on this side — GET continuity, merge, PUT with
// the read's base_ts — and a merge bug is invisible to a mock that never
// 409s and never remembers what it stored. These fakes enforce base_ts the
// way the server does, hand the 409 its winner body, and keep the fact log
// append-only with id idempotency (re-posting a known id returns the
// STORED row), which is the contract the card fact's determinism rests on.
// ---------------------------------------------------------------------------

interface FakeSections {
  data: (name: string) => Record<string, unknown> | undefined;
  ts: (name: string) => number;
  /** Write out-of-band, the way another tab would. */
  inject: (name: string, data: Record<string, unknown>) => void;
  hooks: { beforePut?: (name: string, baseTs: number) => void };
}

function wireStatefulSections(
  seed: Record<string, Record<string, unknown>> = {}
): FakeSections {
  const rows = new Map<string, { data: Record<string, unknown>; server_ts: number }>();
  // Deliberately not 1: a section's server_ts must never coincide with a
  // base_ts of 0 ("create"), or a stale-token bug reads as a pass.
  let ts = 100;
  const hooks: FakeSections['hooks'] = {};
  const out = (name: string) => {
    const row = rows.get(name)!;
    return { section: name, data: row.data, server_ts: row.server_ts, updated_at: 'x' };
  };
  for (const [name, data] of Object.entries(seed)) rows.set(name, { data, server_ts: ++ts });

  getSection.mockImplementation(async (_p: string, name: string) => {
    // The literal 404 string isMissingSection matches — anything else has
    // to be treated as a transient failure by the caller.
    if (!rows.has(name)) throw new Error('section not written yet');
    return out(name);
  });
  putSection.mockImplementation(
    async (_p: string, name: string, data: Record<string, unknown>, baseTs: number) => {
      hooks.beforePut?.(name, baseTs);
      const current = rows.get(name)?.server_ts ?? 0;
      if (baseTs !== current) {
        throw new FakeConflict(current, rows.has(name) ? out(name) : null);
      }
      rows.set(name, { data, server_ts: ++ts });
      return out(name);
    }
  );

  return {
    data: (name) => rows.get(name)?.data,
    ts: (name) => rows.get(name)?.server_ts ?? 0,
    inject: (name, data) => rows.set(name, { data, server_ts: ++ts }),
    hooks,
  };
}

interface FakeFactRow {
  seq: number;
  id: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** Append-only fact log with the server's id idempotency. Returns the live
 *  row array so a test can assert how many rows actually exist — the
 *  difference between "appendFact was called twice" and "two facts were
 *  stored" is the whole point of the card fact's deterministic id. */
function wireFactLog(seed: Record<string, unknown>[] = []): FakeFactRow[] {
  const rows: FakeFactRow[] = [];
  const append = (data: Record<string, unknown>): FakeFactRow => {
    const id = String(data.id);
    const known = rows.find((r) => r.id === id);
    if (known) return known;
    const row = { seq: rows.length + 1, id, data, created_at: 'x' };
    rows.push(row);
    return row;
  };
  seed.forEach(append);
  appendFact.mockImplementation(async (_p: string, data: Record<string, unknown>) =>
    append(data)
  );
  listFacts.mockImplementation(
    async (_p: string, opts: { afterSeq?: number; limit?: number } = {}) => {
      const after = opts.afterSeq ?? 0;
      const page = rows.filter((r) => r.seq > after).slice(0, opts.limit ?? 200);
      const last = page[page.length - 1];
      return {
        items: page,
        next_after_seq: last ? last.seq : null,
        has_more: last ? rows.some((r) => r.seq > last.seq) : false,
      };
    }
  );
  return rows;
}

function transcriptFact(id: string, text: string, over: Record<string, unknown> = {}) {
  return {
    id,
    text,
    category: 'reveal',
    confidence: 'explicit',
    established_in: null,
    source: {
      kind: 'chat_message',
      ref: { chat_file: 'chat1.jsonl', msg_id: 'm1', swipe_idx: 0 },
      snapshot: { excerpt: text },
      captured_at: '2026-01-01T00:00:00.000Z',
    },
    ...over,
  };
}

/** Two facts about Ivy in one category — the smallest input that produces
 *  a judgeable group (`groupFacts` drops singletons). */
const IVY_FACTS = [
  transcriptFact('fact-a', 'Ivy keeps the north wing sealed.'),
  transcriptFact('fact-b', 'Ivy has never sealed the north wing.'),
];

/** An `entities` character shaped the way cold start stamps a card-backed
 *  one: a `card_field` provenance ref (what makes it eligible for the card
 *  check) plus the card-derived text the check compares against. */
function cardBackedIvy(over: Record<string, unknown> = {}) {
  return {
    id: 'char-ivy',
    canonical_name: 'Ivy',
    aliases: [],
    physical_description: { summary: 'An archivist who never leaves the Reach.' },
    personality: { traits: [{ trait: 'Dry.' }] },
    provenance: [
      {
        kind: 'card_field',
        ref: { character_avatar: 'Ivy.png', field: 'description' },
        snapshot: { excerpt: 'An archivist who never leaves the Reach.' },
        captured_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...over,
  };
}

/** A checkpoint parked at reconcile: cold start's ids, every walk chunk and
 *  user_voice are all durable, which is exactly what `current_pass:
 *  'reconcile'` claims. */
function reconcileCheckpoint(over: Record<string, unknown> = {}) {
  return {
    status: 'paused',
    current_pass: 'reconcile',
    prompt_version: PROMPT_VERSION,
    chunk_index: 2,
    chunk_plan: [
      { start_msg_id: 'm0', end_msg_id: 'm59', est_tokens: 100 },
      { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
    ],
    last_ingested: {
      msg_id: 'm64',
      swipe_idx: 0,
      fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
    },
    open_scene: null,
    lock: null,
    token_usage: { input_tokens: 900, output_tokens: 400 },
    model: null,
    replay_approx: false,
    error: '',
    ...over,
  };
}

/** The server state a mid-reconcile resume starts from. */
function seedReconcileResume(extra: Record<string, Record<string, unknown>> = {}) {
  return wireStatefulSections({
    ingestion: reconcileCheckpoint(),
    entities: { characters: [cardBackedIvy()], objects: [], factions: [] },
    ...extra,
  });
}

function existingContradiction(
  sources: string[],
  over: Partial<Contradiction> = {}
): Contradiction {
  return {
    id: contradictionId(sources),
    type: 'character_attribute',
    description: 'Recorded by an earlier build.',
    sources: [...sources].sort(),
    detected_by: 'agent',
    resolution: {
      status: 'unresolved',
      canonical_choice: null,
      rationale: '',
      resolved_at: null,
    },
    ...over,
  };
}

function contradictionsOf(sections: FakeSections): Contradiction[] {
  const data = sections.data('continuity') as
    | { contradictions?: Contradiction[] }
    | undefined;
  return data?.contradictions ?? [];
}

interface PersistedCheckpoint {
  status: string;
  current_pass: string | null;
  chunk_index: number;
  chunk_plan: unknown[];
  token_usage: { input_tokens: number; output_tokens: number };
  lock: { client_id: string } | null;
  error: string;
}

/** Every ingestion checkpoint payload that actually reached the server —
 *  the only copy phase 8's token-usage fold can be judged by. */
function ingestWrites(): PersistedCheckpoint[] {
  return putSection.mock.calls.filter((c) => c[1] === 'ingestion').map((c) => c[2]);
}

type LlmKind = 'cold' | 'walk' | 'voice' | 'judge' | 'card';
interface LlmCallCtx {
  /** The last message's content — the rendered prompt for a fresh call,
   *  the repair instruction on a repair round. */
  user: string;
  call: number;
  signal?: AbortSignal;
}
type LlmHandler = (ctx: LlmCallCtx) => string | Promise<string>;

/** A fake model that routes by SYSTEM PROMPT rather than call ordinal, so
 *  a fixture doesn't silently mis-answer when a pass gains or loses a call.
 *
 *  `billed` re-derives what a correct biller owes, independently of the
 *  store: a call that returns bills input+output, a call that fails after
 *  being sent bills its input only, and a CANCELLED call bills nothing
 *  (pressing Stop is a user decision, not a purchase). Tests compare the
 *  PERSISTED totals against it. */
function scriptedLlm(script: Partial<Record<LlmKind, LlmHandler>>) {
  const counts: Record<LlmKind, number> = { cold: 0, walk: 0, voice: 0, judge: 0, card: 0 };
  const billed = { input: 0, output: 0 };
  const llm = vi.fn(
    async (
      msgs: { role: string; content: string }[],
      opts: { signal?: AbortSignal }
    ) => {
      const system = msgs[0]?.content ?? '';
      const kind: LlmKind =
        system === RECONCILE_SYSTEM
          ? 'judge'
          : system === CARD_CHECK_SYSTEM
            ? 'card'
            : system === WALK_SYSTEM
              ? 'walk'
              : system === USER_VOICE_SYSTEM
                ? 'voice'
                : 'cold';
      counts[kind]++;
      const sent = msgs.reduce((n, m) => n + estimateTokens(m.content), 0);
      try {
        const handler = script[kind];
        const reply = handler
          ? await handler({
              user: msgs[msgs.length - 1]?.content ?? '',
              call: counts[kind],
              signal: opts?.signal,
            })
          : '{}';
        billed.input += sent;
        billed.output += estimateTokens(reply);
        return reply;
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') billed.input += sent;
        throw error;
      }
    }
  );
  return { llm, counts, billed };
}

/** The per-group labels the prompt actually carried, so a fixture answer
 *  cites what the model would have seen instead of assuming a numbering
 *  (labels are per-CALL and positional — nothing durable is seeded from
 *  them, and a test that hardcodes them stops testing the label map). */
function groupLabels(prompt: string): string[][] {
  return prompt
    .split('\n\n')
    .map((block) => [...block.matchAll(/^(f\d+):/gm)].map((m) => m[1]))
    .filter((labels) => labels.length > 0);
}

/** Flag the first group's first two facts as conflicting. */
function judgeReply(prompt: string): string {
  const [first] = groupLabels(prompt);
  return JSON.stringify({
    contradictions:
      first && first.length >= 2
        ? [
            {
              facts: [first[0], first[1]],
              type: 'character_attribute',
              description: 'Two claims about the north wing that cannot both hold.',
            },
          ]
        : [],
  });
}

const NOTHING_CONFLICTS = JSON.stringify({ contradictions: [] });

/** Flag the card against the first fact shown. */
function cardReply(prompt: string, claim = 'Ivy has never left the Reach.'): string {
  const [first] = groupLabels(prompt);
  return JSON.stringify({
    contradictions: first?.length
      ? [
          {
            facts: [first[0]],
            card_claim: claim,
            type: 'character_attribute',
            description: 'The card and the story disagree about Ivy.',
          },
        ]
      : [],
  });
}

/** A chunk the model read fine and found nothing worth recording in — the
 *  cheapest honest walk answer (one billed call, no scene/fact writes). */
const EMPTY_CHUNK = JSON.stringify({ scenes: [] });
const VOICE_JSON = JSON.stringify({
  style_summary: '',
  register: 'mixed',
  rhetorical_devices: [],
  tendency: 'reactive',
});

beforeEach(() => {
  vi.clearAllMocks();
  // `nextFreeSequence` scans scene rows to find max(sequence); an empty
  // page means "no scenes yet", so scene_count remains the floor.
  listScenes.mockResolvedValue({
    items: [],
    next_after_sequence: null,
    next_after_id: null,
    has_more: false,
  });
  // Reconcile (phase 8) pages the fact log on every completed run, so an
  // empty log is the default for every test that isn't about reconcile.
  listFacts.mockResolvedValue({ items: [], next_after_seq: null, has_more: false });
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

    // And the real shape of that bug: two clicks in ONE tick, driven all
    // the way through reconcile. The flag is claimed synchronously before
    // any await precisely so the second click can't start a second paid
    // build — which for phase 8 would also mean a second judge pass and a
    // second continuity merge racing the first.
    useStoryIngestStore.getState().clear();
    const sections = wireStatefulSections();
    wireFactLog(IVY_FACTS);
    const { llm, counts } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });

    const first = useStoryIngestStore.getState().run(runInput({ llm }));
    const second = useStoryIngestStore.getState().run(runInput({ llm }));
    expect(await second).toBe(false);
    expect(await first).toBe(true);

    expect(counts.judge).toBe(1);
    expect(counts.card).toBe(1);
    expect(putSection.mock.calls.filter((c) => c[1] === 'continuity')).toHaveLength(1);
    expect(contradictionsOf(sections)).toHaveLength(1);
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

describe('reconcile (phase 8)', () => {
  it('runs after user_voice, writes continuity, and appends each card fact once', async () => {
    // The pass ORDER is load-bearing, not cosmetic: `current_pass:
    // 'reconcile'` is the checkpoint's claim that cold start's ids, every
    // walk chunk and user_voice are all durable. Writing it before
    // user_voice landed would make a resume skip a pass that never ran.
    const sections = wireStatefulSections();
    const rows = wireFactLog(IVY_FACTS);
    const { llm, counts } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: (ctx) => cardReply(ctx.user),
    });

    // No messages: the walk plans zero chunks and user_voice needs no
    // model call, so this exercises the pass boundary itself rather than
    // re-testing the walk.
    const ok = await useStoryIngestStore.getState().run(runInput({ llm }));
    expect(ok).toBe(true);

    const order = putSection.mock.calls.map((c) => c[1]);
    expect(order.indexOf('continuity')).toBeGreaterThan(order.indexOf('user_voice'));
    expect(useStoryIngestStore.getState().completed).toEqual([
      'cold_start',
      'wi_replay',
      'transcript_walk',
      'reconcile',
    ]);

    // Exactly one card fact row, cited by the contradiction that needed
    // it — the card side has no fact of its own, and a second row per
    // re-detection is what the deterministic id exists to prevent.
    const ivyId = (sections.data('entities') as { characters: { id: string }[] })
      .characters[0].id;
    const cardRows = rows.filter(
      (r) => (r.data.source as { kind?: string } | undefined)?.kind === 'card_field'
    );
    expect(cardRows).toHaveLength(1);
    expect(cardRows[0].id).toBe(cardFactId(ivyId));
    expect(cardRows[0].data.contradicts).toEqual(['fact-a']);
    expect(appendFact).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);

    expect(contradictionsOf(sections).map((c) => c.id)).toEqual([
      contradictionId(['fact-a', 'fact-b']),
      contradictionId([cardRows[0].id, 'fact-a']),
    ]);
    // Synthetic card facts are excluded from grouping, so the judge saw
    // only the two transcript facts: one batch, one character.
    expect(counts.judge).toBe(1);
    expect(counts.card).toBe(1);

    const last = ingestWrites()[ingestWrites().length - 1];
    expect(last.status).toBe('complete');
    expect(last.lock).toBeNull();
  });

  it('resumes a paused reconcile without re-paying cold_start or the walk', async () => {
    // THE expensive regression. Without `resumableReconcile`, a paused
    // reconcile checkpoint is classified a FRESH build and re-pays cold
    // start plus the entire chat. The tempting one-line fix (widening
    // resumableWalk to accept 'reconcile') is worse: the walk's own inner
    // gate still demands 'transcript_walk', so it falls through to the
    // fresh-plan branch and silently re-walks — re-bills — everything.
    const resolvedAlready = existingContradiction(['fact-a', 'fact-b'], {
      resolution: {
        status: 'user_chose',
        canonical_choice: 'fact-a',
        rationale: 'The north wing is sealed.',
        resolved_at: '2026-08-09T00:00:00Z',
      },
    });
    const sections = seedReconcileResume({
      // An earlier run recorded this pair and the user has since resolved
      // it; the whole-pass re-judge must merge onto that, not beside it.
      continuity: { contradictions: [resolvedAlready] },
    });
    wireFactLog(IVY_FACTS);
    const { llm, counts } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });

    const ok = await useStoryIngestStore
      .getState()
      .run(runInput({ messages: longMessages(65), llm }));
    expect(ok).toBe(true);

    expect(counts.cold).toBe(0);
    expect(counts.walk).toBe(0);
    expect(counts.voice).toBe(0);
    expect(bulkWriteScenes).not.toHaveBeenCalled();
    // cold_start is the only writer of these three; user_voice is the
    // only thing the post-walk synthesis writes.
    const written = putSection.mock.calls.map((c) => c[1]);
    expect(written).not.toContain('entities');
    expect(written).not.toContain('world');
    expect(written).not.toContain('rendering_hints');
    expect(written).not.toContain('user_voice');
    // Nor may it touch the chat at all — the resume reads the server-side
    // fact log, and getScene is the walk's message-side read.
    expect(getScene).not.toHaveBeenCalled();

    expect(counts.judge).toBe(1);
    const final = contradictionsOf(sections);
    const ids = final.map((c) => c.id);
    expect(ids).toEqual([contradictionId(['fact-a', 'fact-b'])]);
    expect(new Set(ids).size).toBe(ids.length);
    // Existing wins on id collision — which is the whole reason a resume
    // can re-judge the entire pass: a phase-10 resolution must survive an
    // idempotent re-detection rather than being reverted to unresolved.
    expect(final[0].resolution).toEqual(resolvedAlready.resolution);
    expect(useStoryIngestStore.getState().completed).toContain('reconcile');
  });

  it('persists the walk AND reconcile spend at every save point, then resumes from it', async () => {
    // The inherited bug §4 fixes: run()'s `checkpoint.token_usage` was
    // last written at walk ENTRY, and the per-chunk saves re-sent that
    // stale object, so a mid-walk pause persisted totals missing most of
    // the walk and a mid-reconcile pause missed the walk entirely. The
    // in-memory copy was always right, which is exactly why only the
    // PERSISTED payloads can catch it.
    const sections = wireStatefulSections({
      continuity: { contradictions: [existingContradiction(['fact-a', 'fact-b'])] },
    });
    wireFactLog(IVY_FACTS);
    const messages = longMessages(65); // two chunks

    const first = scriptedLlm({
      walk: () => EMPTY_CHUNK,
      voice: () => VOICE_JSON,
      judge: (ctx) => judgeReply(ctx.user),
      // The tab is closed while the card check is in flight — after the
      // group judge has already been paid for.
      card: () => {
        const e = new Error('Aborted');
        e.name = 'AbortError';
        throw e;
      },
    });
    expect(
      await useStoryIngestStore.getState().run(runInput({ messages, llm: first.llm }))
    ).toBe(false);

    const writes = ingestWrites();
    const walkEntry = writes.find((w) => w.current_pass === 'transcript_walk')!;
    const afterChunk0 = writes.find((w) => w.chunk_index === 1)!;
    const reconcileEntry = writes.find(
      (w) => w.current_pass === 'reconcile' && w.status === 'running'
    )!;
    const paused = writes[writes.length - 1];

    // A mid-walk chunk-boundary save now carries the chunk it just paid
    // for, not the totals as of walk entry.
    expect(afterChunk0.token_usage.input_tokens).toBeGreaterThan(
      walkEntry.token_usage.input_tokens
    );
    // ...and the reconcile boundary carries the whole walk plus the
    // user_voice call.
    expect(reconcileEntry.token_usage.input_tokens).toBeGreaterThan(
      afterChunk0.token_usage.input_tokens
    );
    expect(paused.status).toBe('paused');
    expect(paused.current_pass).toBe('reconcile');
    // Exact, not merely larger: the group judge's spend is included and
    // the cancelled card check's is not.
    expect(paused.token_usage).toEqual({
      input_tokens: first.billed.input,
      output_tokens: first.billed.output,
    });
    expect(paused.token_usage.input_tokens).toBeGreaterThan(
      reconcileEntry.token_usage.input_tokens
    );

    // ---- resume ---------------------------------------------------
    const beforeResume = putSection.mock.calls.length;
    const second = scriptedLlm({
      walk: () => EMPTY_CHUNK,
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });
    expect(
      await useStoryIngestStore.getState().run(runInput({ messages, llm: second.llm }))
    ).toBe(true);
    expect(second.counts.walk).toBe(0);
    expect(second.counts.cold).toBe(0);

    const resumeWrites = putSection.mock.calls
      .slice(beforeResume)
      .filter((c) => c[1] === 'ingestion')
      .map((c) => c[2] as PersistedCheckpoint);
    // "Resume seeds its running totals from the checkpoint" — only true
    // because the fold made the paused figure honest in the first place.
    expect(resumeWrites[0].token_usage).toEqual(paused.token_usage);
    const done = resumeWrites[resumeWrites.length - 1];
    expect(done.status).toBe('complete');
    expect(done.token_usage).toEqual({
      input_tokens: paused.token_usage.input_tokens + second.billed.input,
      output_tokens: paused.token_usage.output_tokens + second.billed.output,
    });

    // The re-judge merged onto the entry that was already there.
    const ids = contradictionsOf(sections).map((c) => c.id);
    expect(ids).toEqual([contradictionId(['fact-a', 'fact-b'])]);
  });

  it('re-appends the same card fact row after a crash before the section write', async () => {
    // The card fact is appended BEFORE the continuity PUT so `sources`
    // never dangles even transiently. The cost of that ordering is an
    // orphan fact row when the write fails — which is only acceptable
    // because the id is seeded from the character and the cited fact ids
    // (never the model's wording), so the retry re-derives it and the
    // append-only log returns the STORED row instead of a duplicate.
    const sections = seedReconcileResume();
    const rows = wireFactLog(IVY_FACTS);

    let crashed = false;
    sections.hooks.beforePut = (name) => {
      if (name === 'continuity' && !crashed) {
        crashed = true;
        throw new Error('server on fire');
      }
    };
    const firstRun = scriptedLlm({
      judge: () => NOTHING_CONFLICTS,
      card: (ctx) => cardReply(ctx.user, 'Ivy has never left the Reach.'),
    });
    expect(
      await useStoryIngestStore.getState().run(runInput({ llm: firstRun.llm }))
    ).toBe(false);

    const cardId = cardFactId('char-ivy');
    expect(rows.map((r) => r.id)).toEqual(['fact-a', 'fact-b', cardId]);
    expect(sections.data('continuity')).toBeUndefined();
    const failed = ingestWrites()[ingestWrites().length - 1];
    expect(failed.status).toBe('error');
    // Still resumable as reconcile — a reconcile failure must never
    // re-bill the walk.
    expect(failed.current_pass).toBe('reconcile');

    // Resume, with the model rewording the same claim.
    const rejudged: string[] = [];
    const secondRun = scriptedLlm({
      judge: (ctx) => {
        rejudged.push(ctx.user);
        return NOTHING_CONFLICTS;
      },
      card: (ctx) => {
        rejudged.push(ctx.user);
        return cardReply(ctx.user, 'The card says she has never left.');
      },
    });
    expect(
      await useStoryIngestStore.getState().run(runInput({ llm: secondRun.llm }))
    ).toBe(true);

    // HARD INVARIANT: the orphan card fact is filtered out of the loaded
    // log before ANY consumer sees it. Filtering only the group judge
    // looks fine here — a lone 'introduction' fact is a singleton group
    // and never reaches it — so the CARD check is where a half-applied
    // filter actually shows, litigating the card fact against itself.
    expect(rejudged.join('\n')).not.toContain('Card: ');

    expect(appendFact).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(3);
    // The stored row wins: one card fact, with the first run's wording.
    expect(rows[2].data.text).toBe('Card: Ivy has never left the Reach.');
    expect(contradictionsOf(sections).map((c) => c.id)).toEqual([
      contradictionId([cardId, 'fact-a']),
    ]);
  });

  it('merges against the winner when another tab resolves a contradiction mid-write', async () => {
    // `writeSection`'s blind adopt-and-re-PUT is correct for sections a
    // pass rebuilds wholesale and CATASTROPHIC here: continuity is
    // co-owned with phase 10, so a blind re-PUT would revert a resolution
    // the user wrote seconds ago in another tab.
    const sections = seedReconcileResume();
    wireFactLog(IVY_FACTS);

    const userResolved = existingContradiction(['fact-a', 'fact-b'], {
      id: 'user-entry',
      description: 'The user filed this one themselves.',
      detected_by: 'user',
      resolution: {
        status: 'user_chose',
        canonical_choice: 'fact-a',
        rationale: 'The north wing is sealed.',
        resolved_at: '2026-08-09T00:00:00Z',
      },
    });
    let bumps = 0;
    sections.hooks.beforePut = (name) => {
      // Lands between reconcile's GET and its PUT — the exact window the
      // merge-aware 409 path exists for.
      if (name === 'continuity' && bumps === 0) {
        bumps++;
        sections.inject('continuity', { contradictions: [userResolved] });
      }
    };

    const { llm } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    const final = contradictionsOf(sections);
    expect(putSection.mock.calls.filter((c) => c[1] === 'continuity')).toHaveLength(2);
    // The user's resolution survived, and the fresh detection joined it.
    expect(final.map((c) => c.id)).toEqual([
      'user-entry',
      contradictionId(['fact-a', 'fact-b']),
    ]);
    expect(final[0].resolution).toEqual(userResolved.resolution);
  });

  it('gives up after a second 409 rather than spinning, leaving the winner intact', async () => {
    const sections = seedReconcileResume();
    wireFactLog(IVY_FACTS);

    let bumps = 0;
    const injected = () => ({
      contradictions: [
        existingContradiction(['fact-a', 'fact-b'], {
          id: `user-entry-${bumps}`,
          detected_by: 'user' as const,
        }),
      ],
    });
    sections.hooks.beforePut = (name) => {
      if (name !== 'continuity') return;
      bumps++;
      sections.inject('continuity', injected());
    };

    const { llm } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(false);

    // Two attempts, then a resumable error: the detections are
    // recomputable on the next build and the winner's data is intact, so
    // retrying forever would only spin against a busy tab.
    expect(putSection.mock.calls.filter((c) => c[1] === 'continuity')).toHaveLength(2);
    expect(contradictionsOf(sections).map((c) => c.id)).toEqual(['user-entry-2']);
    const last = ingestWrites()[ingestWrites().length - 1];
    expect(last.status).toBe('error');
    expect(last.current_pass).toBe('reconcile');
  });

  it('prunes only unresolved agent entries whose facts are gone', async () => {
    // Without the prune, phase 10's fact hard-delete leaves immortal
    // entries citing 404s that can never be re-detected. With too MUCH
    // prune, a user's own entry or a resolved one disappears — and those
    // are the two things this pass must never destroy (phase 10 owns
    // their cleanup at delete time).
    const stale = existingContradiction(['fact-a', 'fact-gone'], { id: 'stale-agent' });
    const resolved = existingContradiction(['fact-b', 'fact-gone'], {
      id: 'resolved-agent',
      resolution: {
        status: 'user_chose',
        canonical_choice: 'fact-b',
        rationale: '',
        resolved_at: '2026-08-09T00:00:00Z',
      },
    });
    const byUser = existingContradiction(['fact-a', 'fact-gone'], {
      id: 'user-filed',
      detected_by: 'user',
    });
    const sections = seedReconcileResume({
      continuity: { contradictions: [stale, resolved, byUser] },
    });
    wireFactLog(IVY_FACTS);

    const { llm } = scriptedLlm({
      judge: () => NOTHING_CONFLICTS,
      card: () => NOTHING_CONFLICTS,
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    expect(contradictionsOf(sections).map((c) => c.id)).toEqual([
      'resolved-agent',
      'user-filed',
    ]);
  });

  it('an UNREADABLE fact row still counts as existing, so the prune leaves its entry alone', async () => {
    // The prune answers "does this fact row still exist on the server?".
    // loadAllFacts shape-checks every row before handing it to the judge —
    // correct, since a malformed row would be grouped as a subject-less
    // fact and judged — but building the live-id set from that FILTERED
    // list conflates "we could not parse it" with "it was deleted", and
    // silently destroys a perfectly good contradiction that cites it.
    // Nothing else in the pipeline notices: the entry just stops existing.
    const readable = transcriptFact('fact-a', 'Ivy keeps the north wing sealed.');
    // Present, addressable, and cited by a real entry — but with no usable
    // text, so it never reaches the judge.
    const unreadable = { id: 'fact-mangled', category: 'reveal', confidence: 'explicit' };
    const entry = existingContradiction(['fact-a', 'fact-mangled'], { id: 'cites-mangled' });

    const sections = seedReconcileResume({ continuity: { contradictions: [entry] } });
    wireFactLog([readable, unreadable]);

    const { llm } = scriptedLlm({ judge: () => NOTHING_CONFLICTS, card: () => NOTHING_CONFLICTS });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    expect(contradictionsOf(sections).map((c) => c.id)).toEqual(['cites-mangled']);
  });

  it('a DELETED fact row is neither live nor judgeable', async () => {
    // The delete leaves the ROW behind (phase 10 §4.1 — cursor stability),
    // so every reader of the log has to discriminate, and both halves of
    // that matter. An id that still reads as live leaves the entry citing
    // it immortal, because the prune can then never fire; a payload that
    // still reads as a fact puts the claim the user deleted back in front
    // of the judge, which re-detects it and files it all over again.
    const deleted = { id: 'fact-gone', deleted_at: '2026-08-10T00:00:00.000Z' };
    // Deliberately fatter than the wire contract, which replaces `data`
    // wholesale with exactly two keys: what this pins is that the
    // tombstone check decides, not the shape check that follows it.
    const deletedButReadable = {
      ...transcriptFact('fact-wing', 'Ivy sealed the north wing herself.'),
      deleted_at: '2026-08-10T00:00:00.000Z',
    };
    const entry = existingContradiction(['fact-a', 'fact-gone'], {
      id: 'cites-deleted',
    });

    const sections = seedReconcileResume({ continuity: { contradictions: [entry] } });
    wireFactLog([...IVY_FACTS, deleted, deletedButReadable]);

    let judgePrompt = '';
    const { llm } = scriptedLlm({
      judge: (ctx) => {
        judgePrompt = ctx.user;
        return NOTHING_CONFLICTS;
      },
      card: () => NOTHING_CONFLICTS,
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    expect(contradictionsOf(sections)).toEqual([]);
    // The two live Ivy facts and nothing else: a third label in the group
    // would mean the deleted claim was handed to the judge anyway.
    expect(groupLabels(judgePrompt)[0]).toHaveLength(2);
    expect(judgePrompt).not.toContain('sealed the north wing herself');
  });

  it('suppresses — and reports — a card conflict whose card fact was deleted', async () => {
    // The card fact's id is deterministic and appendFact is idempotent by
    // id, so a card fact the user DELETED comes back as its tombstone.
    // Citing it would re-file the exact claim they adjudicated away, on
    // every rebuild, with nothing they could do to make it stop. The
    // delete is the resolution — and the suppression is reported, because
    // "no silent caps" covers suppression too.
    const cardTombstone = {
      id: cardFactId('char-ivy'),
      deleted_at: '2026-08-10T00:00:00.000Z',
    };
    // What the build BEFORE the delete wrote — it must go too, or the
    // deleted claim survives in the section that the user reads.
    const staleCardEntry = existingContradiction([cardFactId('char-ivy'), 'fact-a'], {
      id: 'stale-card-entry',
    });

    const sections = seedReconcileResume({
      continuity: { contradictions: [staleCardEntry] },
    });
    const rows = wireFactLog([...IVY_FACTS, cardTombstone]);

    const { llm, counts } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: (ctx) => cardReply(ctx.user),
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    // The card check ran and flagged something; the append hit the
    // tombstone, so nothing it flagged reached the section and no row was
    // resurrected.
    expect(counts.card).toBe(1);
    expect(appendFact).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);
    expect(contradictionsOf(sections).map((c) => c.id)).toEqual([
      contradictionId(['fact-a', 'fact-b']),
    ]);

    const last = ingestWrites()[ingestWrites().length - 1];
    expect(last.status).toBe('complete');
    expect(last.error).toContain('1 card conflict was left out');
  });

  it('collapses a drifted citation set into one entry', async () => {
    // Models trim citations nondeterministically: run 1 reports {a,b,c},
    // run 2 {a,b}. Different sorted-source seeds mean different ids, so
    // without the dampener every rebuild piles another near-duplicate
    // onto a list a human has to read.
    const wide = existingContradiction(['fact-a', 'fact-b', 'fact-c'], {
      id: 'wide-entry',
    });
    const sections = seedReconcileResume({
      continuity: { contradictions: [wide] },
    });
    wireFactLog([
      ...IVY_FACTS,
      transcriptFact('fact-c', 'Ivy sealed the north wing years ago.'),
    ]);

    const { llm } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user), // cites the first two only
      card: () => NOTHING_CONFLICTS,
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    const ids = contradictionsOf(sections).map((c) => c.id);
    expect(ids).toEqual(['wide-entry']);
    expect(ids).not.toContain(contradictionId(['fact-a', 'fact-b']));
  });

  it('issues no PUT when the merge changes nothing', async () => {
    // The backend bumps server_ts on EVERY put, and a gratuitous bump
    // forces a 409-and-merge on the next write from any open review tab.
    const sections = seedReconcileResume({
      continuity: { contradictions: [existingContradiction(['fact-a', 'fact-b'])] },
    });
    wireFactLog(IVY_FACTS);
    const before = sections.ts('continuity');

    const { llm } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    expect(putSection.mock.calls.filter((c) => c[1] === 'continuity')).toHaveLength(0);
    expect(sections.ts('continuity')).toBe(before);
  });

  it('bails bare when the run loses ownership mid-reconcile', async () => {
    // The user switched Works while the judge was in flight. The new
    // owner is responsible for the store's state now, so this run must
    // not set(), toast, or PUT anything for the project it no longer
    // owns — and its heartbeat must be dead, or it keeps PUTting a dead
    // run's checkpoint against whichever Work is open by then.
    vi.useFakeTimers();
    try {
      const sections = seedReconcileResume();
      wireFactLog(IVY_FACTS);
      const { llm, counts } = scriptedLlm({
        judge: (ctx) => {
          useStoryIngestStore.setState({ projectId: 'p2' });
          return judgeReply(ctx.user);
        },
        card: () => NOTHING_CONFLICTS,
      });

      expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(false);

      expect(counts.card).toBe(0); // bailed at the first ownership check
      expect(putSection.mock.calls.filter((c) => c[1] === 'continuity')).toHaveLength(0);
      expect(sections.data('continuity')).toBeUndefined();
      expect(showToastGlobal).not.toHaveBeenCalled();
      expect(useStoryIngestStore.getState().completed).not.toContain('reconcile');
      // The flags are still released, or clear() would refuse to reset a
      // run it believes is live and wedge the store forever.
      expect(useStoryIngestStore.getState().isRunning).toBe(false);
      expect(useStoryIngestStore.getState().abort).toBeNull();

      const callsAtBail = putSection.mock.calls.length;
      await vi.advanceTimersByTimeAsync(LOCK_STALE_MS * 3);
      expect(putSection.mock.calls.length).toBe(callsAtBail);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels mid-judge without leaving a half-merged section', async () => {
    const sections = seedReconcileResume();
    wireFactLog(IVY_FACTS);

    let reachedJudge!: () => void;
    const atJudge = new Promise<void>((r) => {
      reachedJudge = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { llm, billed } = scriptedLlm({
      judge: async (ctx) => {
        reachedJudge();
        await gate;
        // What a real provider bridge does once the signal trips.
        if (ctx.signal?.aborted) {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          throw e;
        }
        return judgeReply(ctx.user);
      },
    });

    const running = useStoryIngestStore.getState().run(runInput({ llm }));
    await atJudge;
    useStoryIngestStore.getState().cancel();
    release();
    expect(await running).toBe(false);

    const last = ingestWrites()[ingestWrites().length - 1];
    // A cancel is a user decision, not an error to display — and it
    // resumes as reconcile, never as a fresh build.
    expect(last.status).toBe('paused');
    expect(last.current_pass).toBe('reconcile');
    expect(last.error).toBe('');
    expect(useStoryIngestStore.getState().error).toBeNull();
    // Nothing partial: the section is absent, because the merge write is
    // a single PUT that either happened or did not.
    expect(sections.data('continuity')).toBeUndefined();
    // Billing is exact against the resumed subtotal: the cancelled call
    // adds nothing at all (countingLlm bills a FAILED call's input, but a
    // user pressing Stop is not a purchase), and the persisted figure
    // still carries every token the earlier passes spent.
    expect(billed).toEqual({ input: 0, output: 0 });
    expect(last.token_usage).toEqual({
      input_tokens: 900 + billed.input,
      output_tokens: 400 + billed.output,
    });
  });

  it('clear() mid-reconcile drops viewing state only, and Stop still lands', async () => {
    // Leaving the Story tab must not orphan a paid run: clear() wipes the
    // checkpoint it was displaying, and the run keeps its own lifecycle —
    // including a Stop that has to survive checkpointTs being reset to 0
    // (the next save 409s and adopts the winner's token).
    const sections = seedReconcileResume();
    wireFactLog(IVY_FACTS);

    let reachedJudge!: () => void;
    const atJudge = new Promise<void>((r) => {
      reachedJudge = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { llm } = scriptedLlm({
      judge: async (ctx) => {
        reachedJudge();
        await gate;
        if (ctx.signal?.aborted) {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          throw e;
        }
        return judgeReply(ctx.user);
      },
    });

    const running = useStoryIngestStore.getState().run(runInput({ llm }));
    await atJudge;
    useStoryIngestStore.getState().clear();
    expect(useStoryIngestStore.getState().isRunning).toBe(true);
    expect(useStoryIngestStore.getState().abort).not.toBeNull();
    expect(useStoryIngestStore.getState().checkpoint).toBeNull();

    useStoryIngestStore.getState().cancel();
    release();
    expect(await running).toBe(false);
    expect(useStoryIngestStore.getState().isRunning).toBe(false);

    const last = ingestWrites()[ingestWrites().length - 1];
    expect(last.status).toBe('paused');
    expect(last.current_pass).toBe('reconcile');
    // It really landed on the server despite the zeroed base_ts.
    expect((sections.data('ingestion') as { status: string }).status).toBe('paused');
    expect(sections.data('continuity')).toBeUndefined();
  });

  it('does not report divergence when a chunk boundary was deleted after the walk', async () => {
    // The trap the second predicate dodges. Widening the walk's gates to
    // cover 'reconcile' lands in sliceChunksFromPlan, where a user who
    // deleted a chunk-boundary message AFTER the walk finished trips
    // 'diverged' → "Use Reset story", destroying a complete, fully-paid
    // bible over a divergence reconcile does not care about: it reads the
    // server-side fact log, never the chat. (A delete is the fixture that
    // pins it — edits never trip the slice at all, since ids are
    // permanent and content is not compared.)
    const sections = seedReconcileResume();
    wireFactLog(IVY_FACTS);
    const messages = longMessages(65).filter((m) => m.id !== 'm59');

    const { llm } = scriptedLlm({
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });
    expect(
      await useStoryIngestStore.getState().run(runInput({ messages, llm }))
    ).toBe(true);

    const last = ingestWrites()[ingestWrites().length - 1];
    expect(last.status).toBe('complete');
    expect(last.error).not.toContain('Reset story');
    expect(contradictionsOf(sections)).toHaveLength(1);
  });

  it('reaches reconcile via the walk path when the crash preceded its checkpoint', async () => {
    // The window between the user_voice write and the reconcile
    // checkpoint save. `current_pass` still reads 'transcript_walk', fully
    // advanced, so the resume takes the walk path, runs a zero-iteration
    // chunk loop, re-synthesizes user_voice (idempotent, one cheap call)
    // and arrives at reconcile fresh — correct by construction rather
    // than by a second checkpoint field.
    const sections = wireStatefulSections({
      ingestion: reconcileCheckpoint({
        status: 'error',
        current_pass: 'transcript_walk',
        error: 'HTTP 500',
      }),
      entities: { characters: [cardBackedIvy()], objects: [], factions: [] },
    });
    wireFactLog(IVY_FACTS);
    manifest.mockResolvedValue({
      project_id: 'p1',
      sections: [],
      scene_count: 2,
      fact_count: 2,
      edit_count: 0,
    });

    const { llm, counts } = scriptedLlm({
      voice: () => VOICE_JSON,
      judge: (ctx) => judgeReply(ctx.user),
      card: () => NOTHING_CONFLICTS,
    });
    expect(
      await useStoryIngestStore
        .getState()
        .run(runInput({ messages: longMessages(65), llm }))
    ).toBe(true);

    expect(counts.cold).toBe(0);
    expect(counts.walk).toBe(0); // every chunk was already done
    expect(bulkWriteScenes).not.toHaveBeenCalled();
    expect(counts.voice).toBe(1);
    expect(putSection.mock.calls.map((c) => c[1])).toContain('user_voice');
    expect(contradictionsOf(sections)).toHaveLength(1);
    expect(useStoryIngestStore.getState().completed).toContain('reconcile');
  });

  it('never reaches reconcile with no model, or when every call failed', async () => {
    // Reading the whole fact log and judging it needs a working model far
    // more than the mechanical cold-start mapping does, so both early
    // completions must exit before the walk — and therefore before
    // reconcile — exactly as they did in phase 6.
    const noLlm = wireStatefulSections();
    wireFactLog(IVY_FACTS);
    expect(await useStoryIngestStore.getState().run(runInput())).toBe(true);
    expect(listFacts).not.toHaveBeenCalled();
    expect(noLlm.data('continuity')).toBeUndefined();
    expect(useStoryIngestStore.getState().completed).toEqual(['cold_start', 'wi_replay']);

    useStoryIngestStore.getState().clear();
    const allFail = wireStatefulSections();
    wireFactLog(IVY_FACTS);
    const llm = vi.fn(async () => {
      throw new Error('402 payment required');
    });
    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);
    expect(listFacts).not.toHaveBeenCalled();
    expect(allFail.data('continuity')).toBeUndefined();
    expect(useStoryIngestStore.getState().completed).not.toContain('reconcile');
  });

  it('writes an empty continuity section with zero model calls when nothing groups', async () => {
    // Section PRESENCE is what lets the Story tab and phase 10 tell
    // "checked, clean" from "never checked", so a bible with nothing to
    // judge still gets one — and pays for nothing to get it.
    const sections = seedReconcileResume();
    wireFactLog([]);
    const { llm, counts } = scriptedLlm({});

    expect(await useStoryIngestStore.getState().run(runInput({ llm }))).toBe(true);

    expect(counts.judge).toBe(0);
    expect(counts.card).toBe(0);
    expect(llm).not.toHaveBeenCalled();
    expect(sections.data('continuity')).toEqual({ contradictions: [] });
    expect(useStoryIngestStore.getState().completed).toContain('reconcile');
  });
});

// ---------------------------------------------------------------------------
// Incremental re-ingestion (phase 11)
//
// Every case here pins a behaviour that was WRONG in the plan's first
// draft and got caught by the adversarial review. They are regression
// pins first and feature tests second.
// ---------------------------------------------------------------------------

describe('incremental re-ingestion (phase 11)', () => {
  const WALKED = 65; // forces two chunks at WALK_FORCE_SPLIT_MESSAGES=60

  /** A walk reply that establishes a fact, so `appendedFactIds` is
   *  non-empty. Without this the separate empty-set fallback masks any
   *  bug in the coveredWholeExtension guard. */
  function sceneJsonWithFact(title: string, endIdx: number, factText: string) {
    return JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title,
          summary: title.toLowerCase(),
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: endIdx,
          closed: true,
          excluded_local_idxs: [],
          facts: [{ text: factText, category: 'reveal', local_idx: 0 }],
        },
      ],
    });
  }

  function sceneJson(title: string, endIdx: number, closed = true) {
    return JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title,
          summary: title.toLowerCase(),
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: endIdx,
          closed,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
  }

  const VOICE_JSON = JSON.stringify({
    style_summary: '',
    register: 'mixed',
    rhetorical_devices: [],
    tendency: 'reactive',
  });

  const ENTITIES = {
    characters: [{ id: 'char-ivy', canonical_name: 'Ivy', aliases: [] }],
    objects: [],
    factions: [],
  };

  /** A bible whose walk already finished over `WALKED` messages. */
  function completedCheckpoint(over: Record<string, unknown> = {}) {
    return {
      status: 'complete',
      current_pass: null,
      prompt_version: PROMPT_VERSION,
      chunk_index: 2,
      chunk_plan: [
        { start_msg_id: 'm0', end_msg_id: 'm59', est_tokens: 100 },
        { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
      ],
      last_ingested: {
        msg_id: 'm64',
        swipe_idx: 0,
        fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
      },
      open_scene: null,
      lock: null,
      token_usage: { input_tokens: 5, output_tokens: 5 },
      replay_approx: false,
      error: '',
      ...over,
    };
  }

  function wireIncremental(checkpoint: Record<string, unknown>) {
    const sections = wireStatefulSections({
      ingestion: checkpoint,
      entities: ENTITIES,
      meta: {
        schema_version: '1.1',
        bible_id: 'b1',
        created_at: 'x',
        updated_at: 'x',
        source: {
          platform: 'ggbc',
          chat: {
            kind: 'chat',
            ref: { character_avatar: 'Ivy.png', file_name: 'chat1.jsonl' },
            snapshot: { name: 'chat1.jsonl' },
            captured_at: 'x',
          },
        },
        ingest_watermark: {
          message_count: WALKED,
          last_msg: {
            msg_id: 'm64',
            swipe_idx: 0,
            fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
          },
        },
      },
    });
    wireScenesAndFacts();
    wireFactLog();
    manifest.mockResolvedValue({
      project_id: 'p1',
      sections: [],
      scene_count: 2,
      fact_count: 0,
      edit_count: 0,
    });
    return sections;
  }

  it('walks ONLY the new messages and does not rerun cold start', async () => {
    const sections = wireIncremental(completedCheckpoint());
    const responses = [sceneJson('Scene C', 4), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm, hasNewMessages: true })
    );

    expect(ok).toBe(true);
    // Exactly ONE model call: the walk over the 5 new messages. Cold start
    // would add two, and user_voice re-synthesis another — both are
    // skipped on the incremental path. `entities` is asserted directly
    // rather than via character ids, which are deterministic and
    // identical either way.
    expect(llm).toHaveBeenCalledTimes(1);
    expect(putSection.mock.calls.filter((c) => c[1] === 'entities')).toHaveLength(0);
    expect(bulkWriteScenes).toHaveBeenCalledTimes(1);

    const plan = (sections.data('ingestion') as { chunk_plan: unknown[] }).chunk_plan;
    expect(plan).toHaveLength(3); // two pinned + one extension entry
  });

  it('advances the watermark in META, not the checkpoint', async () => {
    const sections = wireIncremental(completedCheckpoint());
    const responses = [sceneJson('Scene C', 4), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm, hasNewMessages: true })
    );

    const meta = sections.data('meta') as {
      ingest_watermark: { message_count: number; last_msg: { msg_id: string } };
    };
    expect(meta.ingest_watermark.message_count).toBe(70);
    expect(meta.ingest_watermark.last_msg.msg_id).toBe('m69');

    // The durable cursor must NOT live in `ingestion`: resetIngestState
    // wipes that whole section, and losing the watermark there would make
    // the next build re-walk — and re-bill — the entire chat.
    const ingestion = sections.data('ingestion') as Record<string, unknown>;
    expect(ingestion.ingest_watermark).toBeUndefined();
  });

  it('starts a NEW scene rather than re-opening a completed walk’s open tail scene', async () => {
    // A completed bible whose chat ended mid-scene: nothing force-closes
    // the final chunk's scene, so open_scene survives completion. Treating
    // that as "resume this scene" would let an incremental run rewrite a
    // title the user set in the phase-10 review UI.
    wireIncremental(completedCheckpoint({ open_scene: 'scene-tail' }));
    const responses = [sceneJson('Scene C', 4), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm, hasNewMessages: true })
    );

    expect(ok).toBe(true);
    // Confirms we really are on the extension path (a fresh rebuild would
    // re-run cold start and re-walk both chunks), so the assertion below
    // is about re-opening rather than about never getting here.
    expect(llm).toHaveBeenCalledTimes(1);
    // The tail scene is never even read, so it cannot be rewritten.
    expect(getScene).not.toHaveBeenCalled();
  });

  it('re-opens the tail scene when the walk is genuinely in flight', async () => {
    // The resume-gap case: current_pass is still 'transcript_walk', so the
    // review UI has been gated shut and nothing can have been reviewed.
    wireIncremental(
      completedCheckpoint({
        status: 'error',
        current_pass: 'transcript_walk',
        chunk_index: 1,
        open_scene: 'scene-tail',
      })
    );
    getScene.mockResolvedValue({
      id: 'scene-tail',
      sequence: 1,
      server_ts: 5,
      updated_at: 'x',
      data: {
        id: 'scene-tail',
        sequence: 1,
        title: 'Tail',
        summary: '',
        detailed_summary: '',
        participants: [],
        continuity_facts_established: [],
        source: {
          message_range: {
            start: { msg_id: 'm60', swipe_idx: 0, fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 } },
            end: { msg_id: 'm64', swipe_idx: 0, fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 } },
          },
          total_messages: 5,
          swipe_resolutions: [],
          excluded_segments: [],
        },
      },
    });
    const responses = [sceneJson('Scene B', 4), sceneJson('Scene C', 4), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm, hasNewMessages: true })
    );

    expect(getScene).toHaveBeenCalledWith('p1', 'scene-tail');
  });

  it('EXTENDS a paused walk’s pinned plan instead of reporting unwalked trailing messages', async () => {
    // Phase 7's resume gap. The plan was pinned over 65 messages; the user
    // kept roleplaying to 70 while the build was paused. Those 5 used to be
    // counted and then abandoned with "rebuild to pick them up".
    const sections = wireIncremental(
      completedCheckpoint({
        status: 'error',
        current_pass: 'transcript_walk',
        chunk_index: 1,
      })
    );
    const responses = [sceneJson('Scene B', 4), sceneJson('Scene C', 4), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm })
    );

    expect(ok).toBe(true);
    const ingestion = sections.data('ingestion') as {
      chunk_plan: unknown[];
      chunk_index: number;
      error: string;
    };
    expect(ingestion.chunk_plan).toHaveLength(3);
    expect(ingestion.chunk_index).toBe(3);
    expect(ingestion.error).not.toMatch(/rebuild to pick them up/i);
  });

  it('does NOT re-prompt the long-walk confirm for a small extension on a huge plan', async () => {
    // The cap is scoped to the extension, so a user adding one message to
    // an already-enormous chat is never asked to re-authorise the chunks
    // they already paid for.
    const bigPlan = Array.from({ length: 250 }, (_, n) => ({
      start_msg_id: `m${n}`,
      end_msg_id: `m${n}`,
      est_tokens: 10,
    }));
    wireIncremental(
      completedCheckpoint({
        chunk_plan: bigPlan,
        chunk_index: 250,
        last_ingested: {
          msg_id: 'm249',
          swipe_idx: 0,
          fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
        },
      })
    );
    const responses = [sceneJson('Scene C', 0), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(
      runInput({
        messages: longMessages(251),
        llm,
        hasNewMessages: true,
        confirmLongWalk: false,
      })
    );

    expect(ok).toBe(true);
    // One call = the single extension chunk. A cumulative cap would have
    // returned needs_confirmation and spent nothing; a full rebuild would
    // have cost far more.
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('walks new messages even when the checkpoint is parked mid-reconcile', async () => {
    // Without the §6 narrowing, `resumableReconcile` skips the walk block
    // entirely: Update would re-judge contradictions, never read the new
    // messages, and still toast "Story built".
    const sections = wireIncremental(
      completedCheckpoint({ status: 'error', current_pass: 'reconcile' })
    );
    const responses = [sceneJson('Scene C', 4), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm, hasNewMessages: true })
    );

    expect(ok).toBe(true);
    expect(bulkWriteScenes).toHaveBeenCalledTimes(1);
    const meta = sections.data('meta') as {
      ingest_watermark: { message_count: number };
    };
    expect(meta.ingest_watermark.message_count).toBe(70);
  });

  it('does NOT re-synthesise user_voice on an incremental run', async () => {
    // writeSection is a full replace, so re-running synthesis would delete
    // sample_passages the user pasted in by hand — destroyed as a side
    // effect of adding two messages to a roleplay (plan §11).
    const sections = wireIncremental(completedCheckpoint());
    sections.inject('user_voice', {
      style_summary: 'terse',
      register: 'pulp',
      rhetorical_devices: [],
      tendency: 'directive',
      sample_passages: [
        { text: 'I wrote this myself.', source: { kind: 'user_annotation' } },
      ],
    });
    const responses = [sceneJson('Scene C', 4), VOICE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm, hasNewMessages: true })
    );

    expect(putSection.mock.calls.filter((c) => c[1] === 'user_voice')).toHaveLength(0);
    const voice = sections.data('user_voice') as {
      sample_passages: { text: string }[];
    };
    expect(voice.sample_passages[0].text).toBe('I wrote this myself.');
  });

  it('refuses an incremental request when the build plan was cleared', async () => {
    // resetIngestState() wipes `ingestion` (and the plan with it) while
    // the watermark in `meta` survives. Falling through here would rerun
    // cold start and re-walk the whole chat, silently, behind a button
    // that promised a cheap update.
    wireIncremental(completedCheckpoint({ chunk_plan: [], chunk_index: 0 }));
    const llm = vi.fn(async () => sceneJson('Scene C', 4));

    const ok = await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm, hasNewMessages: true })
    );

    expect(ok).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(bulkWriteScenes).not.toHaveBeenCalled();
  });

  it('falls back to a FULL reconcile when the walk resumed mid-plan', async () => {
    // A crash-resumed walk appended only some of the new facts; the rest
    // came from the dead process and have never been judged. Restricting
    // reconcile to this process's ids would drop their groups entirely
    // and still report success.
    wireIncremental(
      completedCheckpoint({
        status: 'error',
        current_pass: 'transcript_walk',
        chunk_index: 1,
      })
    );
    // Two contradictory facts the CRASHED run appended, never judged.
    wireFactLog([
      transcriptFact('fact-a', 'Ivy keeps the north wing sealed.'),
      transcriptFact('fact-b', 'Ivy has never sealed the north wing.'),
    ]);
    const responses = [
      sceneJsonWithFact('Scene B', 4, 'The northern gate rusted shut.'),
      sceneJsonWithFact('Scene C', 4, 'The southern gate rusted shut.'),
      VOICE_JSON,
      '{"conflicts": []}',
    ];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(70), llm })
    );

    // The judge must still have seen the pre-crash pair. With a restricted
    // fact set it would only see the two gate facts this run appended, and
    // the unjudged Ivy contradiction would be dropped in silence.
    // Scope to the JUDGE's calls specifically. The walk prompt also
    // carries the recent-facts digest, which contains these same texts,
    // so matching across all calls would pass either way.
    const calls = llm.mock.calls as unknown as [
      { role: string; content: string }[],
      unknown,
    ][];
    const judgePrompts = calls
      .filter(([msgs]) =>
        (msgs ?? []).some(
          (m) => m.role === 'system' && m.content === RECONCILE_SYSTEM
        )
      )
      .map(([msgs]) => JSON.stringify(msgs));

    expect(judgePrompts.length).toBeGreaterThan(0);
    // With a restricted fact set the judge would only see the two gate
    // facts this run appended, and the pre-crash Ivy contradiction —
    // never judged by anyone — would be dropped in silence.
    expect(judgePrompts.some((x) => x.includes('north wing'))).toBe(true);
  });

  it('still skips the walk on a reconcile resume when nothing is new', async () => {
    // The narrowing must not break the phase-8 behaviour it narrows: with
    // no new messages, a parked reconcile still resumes cheaply.
    wireIncremental(completedCheckpoint({ status: 'error', current_pass: 'reconcile' }));
    const llm = vi.fn(async () => '{}');

    const ok = await useStoryIngestStore.getState().run(
      runInput({ messages: longMessages(WALKED), llm })
    );

    expect(ok).toBe(true);
    expect(bulkWriteScenes).not.toHaveBeenCalled();
  });
});

describe('annotate pass (step 3 phase 2)', () => {
  const MREF = (id: string) => ({
    msg_id: id,
    swipe_idx: 0,
    fingerprint: { sha: 'x', hash_alg: 'djb2', send_date: 0 },
  });

  const ENTITIES = {
    characters: [{ id: 'char-ivy', canonical_name: 'Ivy', aliases: [] }],
    objects: [],
    factions: [],
  };

  /** A settled bible: the whole pipeline ran to completion. */
  function settledCheckpoint(over: Record<string, unknown> = {}) {
    return {
      status: 'complete',
      current_pass: null,
      prompt_version: PROMPT_VERSION,
      chunk_index: 2,
      chunk_plan: [
        { start_msg_id: 'm0', end_msg_id: 'm59', est_tokens: 100 },
        { start_msg_id: 'm60', end_msg_id: 'm64', est_tokens: 50 },
      ],
      last_ingested: MREF('m64'),
      open_scene: null,
      lock: null,
      token_usage: { input_tokens: 5, output_tokens: 5 },
      replay_approx: false,
      error: '',
      ...over,
    };
  }

  function sceneData(over: Record<string, unknown> = {}) {
    return {
      id: 'sc1',
      sequence: 0,
      title: 'Arrival',
      summary: 'They arrive.',
      detailed_summary: 'They arrive at the Reach after dark.',
      setting: { location_ref: null, time_ref: null, atmosphere: '' },
      participants: [],
      pov_character: null,
      function: null,
      source: {
        message_range: { start: MREF('m0'), end: MREF('m3') },
        total_messages: 4,
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
      ...over,
    };
  }

  const ANNOTATION = {
    beat: 'rising',
    tension: 6,
    mood: 'wary',
    stakes: 'Whether they are let in.',
    compression_recommendation: 'compress',
    compression_ratio_target: 0.5,
    pacing_notes: 'Hold on the door.',
    dialogue_density: 0.4,
  };
  const ANNOTATE_JSON = JSON.stringify(ANNOTATION);
  const STRUCTURE_JSON = JSON.stringify({
    detected_type: 'episodic',
    detection_confidence: 0.4,
    acts: [],
  });

  /** Full-scene pages plus a putScene that records what landed. */
  function wireScenesFull(rows: { id: string; sequence: number; data: Record<string, unknown> }[]) {
    const stored = new Map(rows.map((r) => [r.id, { ...r, server_ts: 7 }]));
    listScenesFull.mockImplementation(async () => ({
      items: [...stored.values()].map((r) => ({
        id: r.id,
        sequence: r.sequence,
        data: r.data,
        server_ts: r.server_ts,
        updated_at: 'x',
      })),
      next_after_sequence: null,
      next_after_id: null,
      has_more: false,
      truncated_by_bytes: false,
    }));
    putScene.mockImplementation(
      async (_p: string, id: string, data: Record<string, unknown>) => {
        const row = stored.get(id)!;
        row.data = data;
        row.server_ts += 1;
        return { id, sequence: row.sequence, data, server_ts: row.server_ts, updated_at: 'x' };
      }
    );
    return stored;
  }

  function annotateInput(llm: (...a: never[]) => Promise<string>) {
    return { projectId: 'p1', llm, model: 'test-model' } as Parameters<
      ReturnType<typeof useStoryIngestStore.getState>['runAnnotate']
    >[0];
  }

  it('annotates only the scenes that need it, and writes narrative.structure', async () => {
    const sections = wireStatefulSections({ ingestion: settledCheckpoint() });
    const stored = wireScenesFull([
      { id: 'sc1', sequence: 0, data: sceneData() },
      {
        id: 'sc2',
        sequence: 1,
        // Already annotated, and not marked stale — skipped entirely.
        data: sceneData({
          id: 'sc2',
          sequence: 1,
          function: { beat: 'midpoint', tension: 8, mood: '', stakes: '' },
          transformations: {
            compression_recommendation: 'preserve',
            compression_ratio_target: 1,
            pacing_notes: '',
            dialogue_density: 0.5,
          },
        }),
      },
    ]);
    const responses = [ANNOTATE_JSON, STRUCTURE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    const ok = await useStoryIngestStore.getState().runAnnotate(annotateInput(llm));

    expect(ok).toBe(true);
    // One scene call plus one structure call — sc2 is not re-paid for.
    expect(llm).toHaveBeenCalledTimes(2);
    expect(putScene).toHaveBeenCalledTimes(1);
    expect(stored.get('sc1')!.data.function).toEqual({
      beat: 'rising',
      tension: 6,
      mood: 'wary',
      stakes: 'Whether they are let in.',
    });
    expect(sections.data('narrative')!.structure).toMatchObject({
      detected_type: 'episodic',
    });
    // The pipeline's own bookkeeping is untouched: a later Build must
    // still be able to walk incrementally rather than from scratch.
    const ingestion = sections.data('ingestion') as Record<string, unknown>;
    expect(ingestion.chunk_plan).toHaveLength(2);
    expect(ingestion.chunk_index).toBe(2);
    expect(ingestion.status).toBe('complete');
    expect(ingestion.current_pass).toBeNull();
  });

  it('re-annotates a scene the walk marked stale, and clears the marker', async () => {
    wireStatefulSections({ ingestion: settledCheckpoint() });
    const stored = wireScenesFull([
      {
        id: 'sc1',
        sequence: 0,
        data: sceneData({
          function: { beat: 'interlude', tension: 2, mood: '', stakes: '' },
          transformations: {
            compression_recommendation: 'cut',
            compression_ratio_target: 0.2,
            pacing_notes: '',
            dialogue_density: 0.5,
          },
          annotations: {
            user_notes: 'mine',
            author_intent: '',
            flagged_issues: ['annotation_stale', 'user flag'],
            stale_source: false,
          },
        }),
      },
    ]);
    const responses = [ANNOTATE_JSON, STRUCTURE_JSON];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    await useStoryIngestStore.getState().runAnnotate(annotateInput(llm));

    const data = stored.get('sc1')!.data as Record<string, never>;
    expect((data.function as unknown as { beat: string }).beat).toBe('rising');
    // The marker is cleared — re-annotating IS what resolves it — but the
    // user's own flag and notes survive.
    expect(
      (data.annotations as unknown as { flagged_issues: string[] }).flagged_issues
    ).toEqual(['user flag']);
    expect((data.annotations as unknown as { user_notes: string }).user_notes).toBe('mine');
  });

  it('refuses on a checkpoint parked mid-walk rather than overwriting current_pass', async () => {
    // Writing 'annotate' over a parked 'transcript_walk' would destroy the
    // only signal resumableWalk reads, turning a paid half-finished walk
    // into a full rebuild.
    const sections = wireStatefulSections({
      ingestion: settledCheckpoint({ status: 'paused', current_pass: 'transcript_walk' }),
    });
    const llm = vi.fn(async () => ANNOTATE_JSON);

    const ok = await useStoryIngestStore.getState().runAnnotate(annotateInput(llm));

    expect(ok).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(listScenesFull).not.toHaveBeenCalled();
    const ingestion = sections.data('ingestion') as Record<string, unknown>;
    expect(ingestion.current_pass).toBe('transcript_walk');
  });

  it('a stopped annotate parks at current_pass "annotate"', async () => {
    const sections = wireStatefulSections({ ingestion: settledCheckpoint() });
    wireScenesFull([{ id: 'sc1', sequence: 0, data: sceneData() }]);
    const llm = vi.fn(async () => {
      useStoryIngestStore.getState().cancel();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });

    const ok = await useStoryIngestStore.getState().runAnnotate(annotateInput(llm));

    expect(ok).toBe(false);
    const ingestion = sections.data('ingestion') as Record<string, unknown>;
    expect(ingestion.status).toBe('paused');
    expect(ingestion.current_pass).toBe('annotate');
  });

  it('a Build press on a parked annotate does NOT re-run cold start or the walk', async () => {
    // §3.3's pin. Without resumableAnnotate this checkpoint falls to the
    // fresh-build branch: cold start is re-billed, entities/world are
    // full-replaced, and the entire chat is re-walked.
    const sections = wireStatefulSections({
      ingestion: settledCheckpoint({ status: 'paused', current_pass: 'annotate' }),
      entities: ENTITIES,
    });
    wireScenesAndFacts();
    wireFactLog();
    const entitiesTsBefore = sections.ts('entities');
    // Typed parameter, so `mock.calls` carries the system prompt rather
    // than an empty tuple — the assertion below reads it.
    const llm = vi.fn(async (msgs: { content: string }[]) => {
      void msgs;
      return '{}';
    });

    const ok = await useStoryIngestStore
      .getState()
      .run(runInput({ messages: longMessages(65), llm }));

    expect(ok).toBe(true);
    // Cold start's two calls and the walk's per-chunk calls all absent.
    const systems = llm.mock.calls.map((c) => c[0][0].content);
    expect(systems).not.toContain(WALK_SYSTEM);
    expect(systems).not.toContain(USER_VOICE_SYSTEM);
    expect(bulkWriteScenes).not.toHaveBeenCalled();
    // The sections cold start full-replaces are untouched.
    expect(sections.ts('entities')).toBe(entitiesTsBefore);
    expect(sections.data('rendering_hints')).toBeUndefined();
  });

  it('preserves an annotation when a resumed walk EXTENDS the open scene', async () => {
    // §3.9a's pin. The extension is the point: a continuing scene always
    // gets a new end, so a test holding the range fixed would exercise
    // nothing. The annotation survives AND the scene is marked for
    // re-annotation, because its beat was read from less material.
    wireStatefulSections({
      ingestion: settledCheckpoint({
        status: 'error',
        current_pass: 'transcript_walk',
        chunk_index: 1,
        open_scene: 'scene-tail',
      }),
      entities: ENTITIES,
      meta: {
        schema_version: '1.2',
        bible_id: 'b1',
        created_at: 'x',
        updated_at: 'x',
        source: {
          platform: 'ggbc',
          chat: {
            kind: 'chat',
            ref: { character_avatar: 'Ivy.png', file_name: 'chat1.jsonl' },
            snapshot: { name: 'chat1.jsonl' },
            captured_at: 'x',
          },
        },
      },
    });
    wireScenesAndFacts();
    wireFactLog();
    manifest.mockResolvedValue({
      project_id: 'p1',
      sections: [],
      scene_count: 1,
      fact_count: 0,
      edit_count: 0,
    });
    getScene.mockResolvedValue({
      id: 'scene-tail',
      sequence: 0,
      server_ts: 5,
      updated_at: 'x',
      data: sceneData({
        id: 'scene-tail',
        title: 'Tail',
        function: { beat: 'crisis', tension: 9, mood: 'tight', stakes: 'everything' },
        transformations: {
          compression_recommendation: 'preserve',
          compression_ratio_target: 1,
          pacing_notes: 'let it breathe',
          dialogue_density: 0.7,
        },
        source: {
          message_range: { start: MREF('m60'), end: MREF('m64') },
          total_messages: 5,
          swipe_resolutions: [],
          excluded_segments: [],
        },
      }),
    });
    const continuing = JSON.stringify({
      scenes: [
        {
          continues_open_scene: true,
          title: 'Tail',
          summary: 'more',
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
    const responses = [
      continuing,
      JSON.stringify({
        style_summary: '',
        register: 'mixed',
        rhetorical_devices: [],
        tendency: 'reactive',
      }),
    ];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    await useStoryIngestStore
      .getState()
      .run(runInput({ messages: longMessages(65), llm }));

    const written = bulkWriteScenes.mock.calls
      .flatMap((c) => c[1] as { id: string; data: Record<string, unknown> }[])
      .find((s) => s.id === 'scene-tail');
    expect(written).toBeDefined();
    expect(written!.data.function).toEqual({
      beat: 'crisis',
      tension: 9,
      mood: 'tight',
      stakes: 'everything',
    });
    expect(written!.data.transformations).toMatchObject({
      compression_recommendation: 'preserve',
    });
    expect(
      (written!.data.annotations as { flagged_issues: string[] }).flagged_issues
    ).toContain('annotation_stale');
  });

  it('survives one failed call but stops when the model goes away', async () => {
    wireStatefulSections({ ingestion: settledCheckpoint() });
    const stored = wireScenesFull([
      { id: 'sc1', sequence: 0, data: sceneData() },
      { id: 'sc2', sequence: 1, data: sceneData({ id: 'sc2', sequence: 1 }) },
    ]);
    let call = 0;
    const llm = vi.fn(async () => {
      // First scene: one transient failure. Second: annotates fine.
      if (++call === 1) throw new Error('provider 500');
      return ANNOTATE_JSON;
    });

    const ok = await useStoryIngestStore.getState().runAnnotate(annotateInput(llm));

    expect(ok).toBe(true);
    // sc1 was skipped, sc2 landed — one blip must not cost the whole run.
    expect(stored.get('sc1')!.data.function).toBeNull();
    expect(stored.get('sc2')!.data.function).toMatchObject({ beat: 'rising' });
  });

  it('stops rather than billing every remaining scene against a dead provider', async () => {
    const sections = wireStatefulSections({ ingestion: settledCheckpoint() });
    wireScenesFull(
      Array.from({ length: 10 }, (_, i) => ({
        id: `sc${i}`,
        sequence: i,
        data: sceneData({ id: `sc${i}`, sequence: i }),
      }))
    );
    const llm = vi.fn(async () => {
      throw new Error('402 payment required');
    });

    const ok = await useStoryIngestStore.getState().runAnnotate(annotateInput(llm));

    expect(ok).toBe(false);
    // Each scene retries once on an unparseable answer, so the ceiling is
    // per-scene attempts, not per call. Far short of all ten scenes.
    expect(llm.mock.calls.length).toBeLessThan(10);
    const ingestion = sections.data('ingestion') as Record<string, unknown>;
    expect(ingestion.status).toBe('error');
    expect(ingestion.current_pass).toBe('annotate');
  });

  it('restores an annotation on the bulk write’s conflict path', async () => {
    // §3.9a's other half: a re-emitted NON-open scene. The 409 means the
    // row already exists, and the retry used to be a blind re-PUT of a
    // body carrying `function: null`.
    wireStatefulSections({});
    wireFactLog();
    const batches: { id: string; data: Record<string, unknown> }[][] = [];
    let call = 0;
    bulkWriteScenes.mockImplementation(
      async (_p: string, scenes: { id: string; data: Record<string, unknown> }[]) => {
        batches.push(scenes);
        if (++call === 1) {
          throw new FakeBulkConflict(scenes.map((s) => ({ id: s.id, currentTs: 9 })));
        }
        return {
          written: scenes.length,
          scenes: scenes.map((s) => ({
            id: s.id,
            sequence: 0,
            data: s.data,
            server_ts: 20,
            updated_at: 'x',
          })),
        };
      }
    );
    getScene.mockImplementation(async (_p: string, id: string) => ({
      id,
      sequence: 0,
      server_ts: 9,
      updated_at: 'x',
      data: sceneData({
        id,
        function: { beat: 'midpoint', tension: 7, mood: 'm', stakes: 's' },
        transformations: {
          compression_recommendation: 'compress',
          compression_ratio_target: 0.5,
          pacing_notes: '',
          dialogue_density: 0.5,
        },
        source: {
          message_range: { start: MREF('m0'), end: MREF('m1') },
          total_messages: 2,
          swipe_resolutions: [],
          excluded_segments: [],
        },
      }),
    }));
    const walkJson = JSON.stringify({
      scenes: [
        {
          continues_open_scene: false,
          title: 'Scene A',
          summary: 's',
          detailed_summary: '',
          participants: [],
          start_local_idx: 0,
          end_local_idx: 3,
          closed: true,
          excluded_local_idxs: [],
          facts: [],
        },
      ],
    });
    const responses = ['{}', '{}', walkJson, '{}'];
    let i = 0;
    const llm = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]);

    await useStoryIngestStore.getState().run(runInput({ messages: longMessages(4), llm }));

    expect(batches).toHaveLength(2);
    expect(batches[0][0].data.function).toBeNull();
    expect(batches[1][0].data.function).toMatchObject({ beat: 'midpoint' });
    expect(
      (batches[1][0].data.annotations as { flagged_issues: string[] }).flagged_issues
    ).toContain('annotation_stale');
  });

  it('"Rebuild the groundwork" does not reset user-edited rendering hints', async () => {
    // §3.9b's pin. Cold start's write used to be a full replace, reachable
    // with no reset and therefore no archive: a POV, a chapter plan and a
    // set of style anchors vanished with nothing to restore from.
    const sections = wireStatefulSections({
      rendering_hints: {
        novel: {
          pov: 'first',
          pov_character: 'char-ivy',
          tense: 'present',
          chapter_breaks: ['sc1'],
          chapter_titles: [],
          compression_level: 'tight',
          target_word_count: 40000,
          style_anchors: ['spare', 'cold'],
        },
        screenplay: { format: 'fountain', sluglines_inferred: false, page_target: null },
        graphic_novel: {
          pages_per_scene: 1,
          panel_density: 'standard',
          art_style_brief: '',
          character_consistency_refs: [],
        },
        storyboard: { aspect_ratio: '16:9', panels_per_scene: 4 },
      },
    });
    wireFactLog();

    await useStoryIngestStore.getState().run(runInput());

    const hints = sections.data('rendering_hints') as Record<
      string,
      Record<string, unknown>
    >;
    expect(hints.novel.pov).toBe('first');
    expect(hints.novel.style_anchors).toEqual(['spare', 'cold']);
    expect(hints.novel.target_word_count).toBe(40000);
    // `false` is a user CHOICE, not an absence — a `||` fallback would
    // have quietly flipped it back to the default.
    expect(hints.screenplay.sluglines_inferred).toBe(false);
    // Defaults still fill in what the stored section never had.
    expect(hints.storyboard).toBeDefined();
  });
});
