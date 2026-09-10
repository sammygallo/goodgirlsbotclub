/**
 * Integration tests for `insightsApi.ts` — everything that needs a real
 * `chatStore`/`generationStore` turn (pure-function tests for the two
 * projectors live in `src/utils/insights/wiInsights.test.ts`).
 *
 * Drives REAL store actions with `api` stubbed at the network edge only —
 * same house style as `chatStore.wiServerFacts.test.ts` and
 * `chatStore.wiFiredServerPath.test.ts`. Every test names the mutation it
 * kills, per the story brief.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));
vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}
globalThis.localStorage = new MemoryStorage() as unknown as Storage;

const { useChatStore, DEFAULT_GROUP_CARD_MODE } = await import('./chatStore');
const { useGenerationStore } = await import('./generationStore');
const { useCharacterStore } = await import('./characterStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { usePersonaStore } = await import('./personaStore');
const { api } = await import('../api/client');
const { mkBook, mkEntry, mkChar, mkMsg, resetStores } = await import('./promptGoldens.fixtures');
const { createPromptBreakdown } = await import('../utils/promptBreakdown');
const { wiFiredKey } = await import('../utils/wiFired');
const { getTurnWiInsight, getTelemetryCoverage, getEntryFiringAggregate } = await import('./insightsApi');
const { OBSERVED_FALSE_REASONS } = await import('../utils/insights/types');

import type { GroupChatInfo } from './chatStore';
import type { ObservedFalseReason } from '../utils/insights/types';

function sseOnce(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      );
      controller.close();
    },
  });
}

const CHAR = mkChar({ name: 'Ivy', avatar: 'ivy-insights.png' });

function arrangeEligibleChat(chatFile: string): void {
  resetStores();
  useWorldInfoStore.setState({
    books: [mkBook('ins-book-1', [mkEntry('ins-entry-1', { constant: true, content: 'Insights lore.' })])],
    activeBookIds: ['ins-book-1'],
    sharedBooksStatus: 'loaded',
  });
  useCharacterStore.setState({ selectedCharacter: CHAR });
  useChatHistoryRagStore.setState({ enabled: true });
  useChatStore.setState({
    messages: [],
    currentChatFile: chatFile,
    isSending: false,
    isStreaming: false,
    error: null,
    abortController: null,
  });
}

function stubCommonEdges(): void {
  vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
  vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [], reason: null });
  vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('A reply.'));
  vi.spyOn(api, 'importLorebooksFromBlob').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
  vi.spyOn(api, 'importFromDatabank').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
  vi.spyOn(api, 'commitRetrievalContext').mockResolvedValue(undefined);
}

const ENTRY_DTO = {
  id: 'ins-entry-1',
  lorebook_id: 'ins-book-1',
  server_ts: 1,
  content: 'Insights lore.',
  comment: '',
  enabled: true,
  constant: true,
};

/** Forces a chat ineligible for server retrieval via a persona-linked book
 *  (serverRetrieval.ts's condition 1) — the simplest reliable "never even
 *  tries the network" trigger, same as chatStore.wiServerFacts.test.ts. */
function makeChatIneligible(): void {
  usePersonaStore.setState({
    personas: [
      {
        id: 'p1',
        name: 'Wren',
        description: 'irrelevant',
        descriptionPosition: 'before_char',
        descriptionDepth: 4,
        descriptionRole: 'system',
        linkedBookIds: ['ins-book-1'],
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    activePersonaId: 'p1',
  });
}

beforeEach(() => {
  (globalThis.localStorage as unknown as MemoryStorage).clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// I2 — server eviction, four wire shapes, via a real sendMessage turn
// ---------------------------------------------------------------------------

describe('getTurnWiInsight — server eviction wire shapes (I2)', () => {
  it('absent evictedEntryIds -> backend-does-not-report-eviction', async () => {
    const CHAT_FILE = 'insights-evict-absent.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['ins-entry-1'],
      // evictedEntryIds deliberately absent.
    });

    await useChatStore.getState().sendMessage('Tell me something.', CHAR);

    const insight = getTurnWiInsight();
    expect(insight.observed).toBe(true);
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.engine).toBe('server');
    expect(insight.value.evicted).toEqual({ observed: false, why: 'backend-does-not-report-eviction' });
  });

  it('evictedEntryIds: [] -> observed, value [] (a real positive fact)', async () => {
    const CHAT_FILE = 'insights-evict-empty.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['ins-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().sendMessage('Tell me something else.', CHAR);

    const insight = getTurnWiInsight();
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.evicted).toEqual({ observed: true, value: [] });
  });

  it("evictedEntryIds: ['e1'] -> observed, one id-only evicted entry (MANDATORY: kills `evicted = breakdown.wi.droppedEntries`)", async () => {
    // `wi.droppedEntries` is always [] on a server turn (the client scan
    // never ran) — a projector that read eviction off it instead of
    // `wi.server.evictedEntryIds` would report `[]` here instead of the
    // one real evicted id the backend actually sent.
    const CHAT_FILE = 'insights-evict-real.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['ins-entry-1'],
      evictedEntryIds: ['ins-entry-2'],
    });

    await useChatStore.getState().sendMessage('Something evicted?', CHAR);

    const insight = getTurnWiInsight();
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.evicted.observed).toBe(true);
    if (!insight.value.evicted.observed) throw new Error('unreachable');
    expect(insight.value.evicted.value).toEqual([
      {
        entryId: 'ins-entry-2',
        bookId: { observed: false, why: 'server-reports-id-only' },
        tokens: { observed: false, why: 'server-reports-id-only' },
      },
    ]);
  });

  it('evictedEntryIds: [null, null] (garbage) -> backend-does-not-report-eviction, same as absent', async () => {
    const CHAT_FILE = 'insights-evict-garbage.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['ins-entry-1'],
      evictedEntryIds: [null, null],
    } as never);

    await useChatStore.getState().sendMessage('Garbage eviction?', CHAR);

    const insight = getTurnWiInsight();
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.evicted).toEqual({ observed: false, why: 'backend-does-not-report-eviction' });
  });
});

// ---------------------------------------------------------------------------
// CONF4 — getTurnWiInsight's PromptBreakdown -> source mapping. Every field
// below gets its own distinct value in the fixture, so a mapping bug that
// reads the wrong PromptBreakdown field (or drops one) surfaces as a wrong
// value here rather than being absorbed by two fields sharing one number.
// ---------------------------------------------------------------------------

describe('getTurnWiInsight — PromptBreakdown -> source field mapping (CONF4)', () => {
  it('a client-scanned turn maps all 12 client-path fields from their own PromptBreakdown field, not a neighboring one', () => {
    resetStores();
    const breakdown = createPromptBreakdown('group', 'claude');
    breakdown.chatFile = 'conf4-client.jsonl';
    breakdown.publishedAt = 424242;
    breakdown.wi.emittedTokens = 501;
    breakdown.wi.rawTokens = 502;
    breakdown.wi.budget = 601;
    breakdown.wi.pinnedTokens = 602;
    breakdown.wi.pinnedOverBudget = true;
    breakdown.wi.entries = [
      {
        entryId: 'conf4-common-entry',
        bookId: 'conf4-common-book',
        emittedTokens: 10,
        emittedChars: 20,
        rawTokens: 5,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    breakdown.wi.trimmedFromHistoryEntries = [
      {
        entryId: 'conf4-trimmed-entry',
        bookId: 'conf4-trimmed-book',
        emittedTokens: 11,
        emittedChars: 21,
        rawTokens: 6,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    breakdown.wi.droppedEntries = [
      {
        entryId: 'conf4-dropped-entry',
        bookId: 'conf4-dropped-book',
        emittedTokens: null,
        emittedChars: null,
        rawTokens: 7,
        placement: null,
        wrapper: null,
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

    const insight = getTurnWiInsight();
    expect(insight.observed).toBe(true);
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.engine).toBe('client');
    expect(insight.value.mode).toBe('group');
    expect(insight.value.chatFile).toBe('conf4-client.jsonl');
    expect(insight.value.publishedAt).toBe(424242);
    expect(insight.value.profile).toBe('claude');
    expect(insight.value.emittedTotal).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'claude', tokens: 501 },
    });
    expect(insight.value.rawTotal).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'claude', tokens: 502 },
    });
    expect(insight.value.entries.map((e) => e.entryId)).toEqual(['conf4-common-entry']);
    expect(insight.value.trimmedFromHistoryEntries.map((e) => e.entryId)).toEqual(['conf4-trimmed-entry']);
    expect(insight.value.budget).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'claude', tokens: 601 },
    });
    expect(insight.value.pinnedTokens).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'claude', tokens: 602 },
    });
    expect(insight.value.pinnedOverBudget).toEqual({ observed: true, value: true });
    expect(insight.value.evicted.observed).toBe(true);
    if (!insight.value.evicted.observed) throw new Error('unreachable');
    expect(insight.value.evicted.value.map((e) => e.entryId)).toEqual(['conf4-dropped-entry']);
  });

  it('a server-scanned turn maps the shared 8 fields plus `server` from breakdown.wi.server, not a neighboring field', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'claude');
    breakdown.chatFile = 'conf4-server.jsonl';
    breakdown.publishedAt = 434343;
    breakdown.wi.activationSource = 'server';
    breakdown.wi.emittedTokens = 511;
    breakdown.wi.rawTokens = 512;
    breakdown.wi.entries = [
      {
        entryId: 'conf4-server-common-entry',
        bookId: 'conf4-server-common-book',
        emittedTokens: 12,
        emittedChars: 22,
        rawTokens: 8,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    breakdown.wi.trimmedFromHistoryEntries = [
      {
        entryId: 'conf4-server-trimmed-entry',
        bookId: 'conf4-server-trimmed-book',
        emittedTokens: 13,
        emittedChars: 23,
        rawTokens: 9,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    breakdown.wi.server = {
      budgetRequested: 999,
      budgetEstimator: 'generic',
      evictedEntryIds: [],
      activatedEntryIds: [],
    };
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

    const insight = getTurnWiInsight();
    expect(insight.observed).toBe(true);
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.engine).toBe('server');
    expect(insight.value.mode).toBe('solo');
    expect(insight.value.chatFile).toBe('conf4-server.jsonl');
    expect(insight.value.publishedAt).toBe(434343);
    expect(insight.value.profile).toBe('claude');
    expect(insight.value.emittedTotal).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'claude', tokens: 511 },
    });
    expect(insight.value.rawTotal).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'claude', tokens: 512 },
    });
    expect(insight.value.entries.map((e) => e.entryId)).toEqual(['conf4-server-common-entry']);
    expect(insight.value.trimmedFromHistoryEntries.map((e) => e.entryId)).toEqual([
      'conf4-server-trimmed-entry',
    ]);
    // budgetRequested 999 could only have come from breakdown.wi.server —
    // no other field on this fixture carries that number.
    expect(insight.value.budget).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'generic', tokens: 999 },
    });
  });
});

// ---------------------------------------------------------------------------
// I5 — empty chat list refuses, paired with a non-empty case
// ---------------------------------------------------------------------------

describe('getTelemetryCoverage — empty chat list (I5)', () => {
  it('an empty in-memory chat list refuses chat-list-not-loaded, never reports 0', () => {
    resetStores();
    useChatStore.setState({ chatFiles: [], messages: [], currentChatFile: null });
    const coverage = getTelemetryCoverage();
    expect(coverage.chatsInScope).toEqual({ observed: false, why: 'chat-list-not-loaded' });
    expect(coverage.chatsWithTelemetry).toEqual({ observed: false, why: 'chat-list-not-loaded' });
  });

  it('a non-empty in-memory chat list reports a real chatsInScope count — the pair that proves the refusal is real, not vacuous', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [{ fileName: 'a.jsonl', messageCount: 0, lastMessage: '' }],
      messages: [],
      currentChatFile: null,
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.chatsInScope).toEqual({ observed: true, value: 1 });
  });

  it('a caller-supplied empty list is a deliberate zero, not a refusal', () => {
    resetStores();
    const coverage = getTelemetryCoverage({ chatFiles: [] });
    expect(coverage.scope).toBe('caller-supplied');
    expect(coverage.chatsInScope).toEqual({ observed: true, value: 0 });
  });
});

// ---------------------------------------------------------------------------
// I4 — coverage numerator: three seeded chats
// ---------------------------------------------------------------------------

describe('getTelemetryCoverage — numerator (I4)', () => {
  it('(A) in chatFiles, never opened; (B) in chatFiles, opened with an empty header; (C) in wiFiredByFile but NOT chatFiles', async () => {
    resetStores();
    const CHAT_A = 'i4-a-never-opened.jsonl';
    const CHAT_B = 'i4-b-opened-empty.jsonl';
    const CHAT_C = 'i4-c-not-in-scope.jsonl';

    // B: loaded with a header carrying NO wi_fired key at all -> hydrates
    // to `{}` (getWiFiredForChat(B) !== undefined must be TRUE — kills
    // `Object.keys(map ?? {}).length > 0`, which would read `{}` as
    // "no telemetry").
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({ header: {}, messages: [], server_ts: 1 });
    await useChatStore.getState().loadChat('avatar.png', CHAT_B);

    // C: loaded too (populating the module-private wiFiredByFile map), but
    // deliberately excluded from `chatFiles` below — kills
    // `wiFiredByFile.size` as a numerator, which would count C.
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({
      header: { wi_fired: { [wiFiredKey('cbook', 'centry')]: { first_turn: 0, last_turn: 0, count: 1 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_C);

    useChatStore.setState({
      chatFiles: [
        { fileName: CHAT_A, messageCount: 0, lastMessage: '' },
        { fileName: CHAT_B, messageCount: 0, lastMessage: '' },
      ],
      currentChatFile: null,
    });

    const coverage = getTelemetryCoverage();
    expect(coverage.chatsInScope).toEqual({ observed: true, value: 2 });
    // Only B has telemetry — A was never opened, and C is out of scope
    // even though it's in wiFiredByFile.
    expect(coverage.chatsWithTelemetry).toEqual({ observed: true, value: 1 });
  });
});

// ---------------------------------------------------------------------------
// I6 — partial coverage -> atLeast, paired with a complete case -> exact
// (reuses the legacy-remap setup from chatStore.wiFiredLegacyRemap.test.ts)
// ---------------------------------------------------------------------------

describe('getEntryFiringAggregate — generations completeness (I6)', () => {
  const LEGACY_BOOK = 'wibook_1777000000000_aaaaaa';
  const LEGACY_ENTRY = 'wi_1777000000001_bbbbbb';

  it('a chat with an unresolved legacy wi_fired key -> generations is the atLeast arm', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const CHAT_FILE = 'i6-partial.jsonl';
    const legacyKey = wiFiredKey(LEGACY_BOOK, LEGACY_ENTRY);
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [legacyKey]: { first_turn: 0, last_turn: 2, count: 4 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
    useChatStore.setState({ chatFiles: [{ fileName: CHAT_FILE, messageCount: 0, lastMessage: '' }] });

    const [agg] = getEntryFiringAggregate([{ bookId: LEGACY_BOOK, entryId: LEGACY_ENTRY }], {
      chatFiles: [CHAT_FILE],
    });
    expect(agg.generations).toEqual({
      observed: true,
      complete: false,
      atLeast: 4,
      why: 'telemetry-coverage-partial',
    });
  });

  it('a chat with an ordinary native-shaped key -> generations is the exact arm', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const CHAT_FILE = 'i6-complete.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { 'native-book:native-entry': { first_turn: 0, last_turn: 1, count: 3 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
    useChatStore.setState({ chatFiles: [{ fileName: CHAT_FILE, messageCount: 0, lastMessage: '' }] });

    const [agg] = getEntryFiringAggregate([{ bookId: 'native-book', entryId: 'native-entry' }], {
      chatFiles: [CHAT_FILE],
    });
    expect(agg.generations).toEqual({ observed: true, complete: true, exact: 3 });
  });

  it('an un-hydrated chat, alone in scope -> generations is atLeast with chat-not-hydrated', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const NEVER_OPENED = 'i6-never-opened.jsonl';
    useChatStore.setState({ chatFiles: [{ fileName: NEVER_OPENED, messageCount: 0, lastMessage: '' }] });

    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'any-entry' }], {
      chatFiles: [NEVER_OPENED],
    });
    expect(agg.generations).toEqual({ observed: true, complete: false, atLeast: 0, why: 'chat-not-hydrated' });
  });

  it('BOTH an un-hydrated chat AND a partially-covered chat in scope at once -> chat-not-hydrated wins (C10 — the priority the docstring actually claims)', async () => {
    // The old version of this test put ONLY a never-opened chat in scope,
    // so it could never tell "chat-not-hydrated is checked" apart from
    // "chat-not-hydrated takes PRIORITY OVER telemetry-coverage-partial" —
    // swapping computeFiringCount's two `if` blocks stayed green under it.
    // This fixture puts both gaps in scope simultaneously, so only the
    // correctly-prioritized implementation passes.
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const legacyBook = 'wibook_1777000000010_eeeeee';
    const legacyEntry = 'wi_1777000000011_ffffff';
    const PARTIAL_CHAT = 'i6-priority-partial.jsonl';
    const NEVER_OPENED = 'i6-priority-never-opened.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [wiFiredKey(legacyBook, legacyEntry)]: { first_turn: 0, last_turn: 2, count: 4 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', PARTIAL_CHAT);
    useChatStore.setState({
      chatFiles: [
        { fileName: PARTIAL_CHAT, messageCount: 0, lastMessage: '' },
        { fileName: NEVER_OPENED, messageCount: 0, lastMessage: '' },
      ],
    });

    const [agg] = getEntryFiringAggregate([{ bookId: legacyBook, entryId: legacyEntry }], {
      chatFiles: [PARTIAL_CHAT, NEVER_OPENED],
    });
    expect(agg.generations).toEqual({ observed: true, complete: false, atLeast: 4, why: 'chat-not-hydrated' });
  });

  it('accumulates counts across multiple fully-hydrated, non-partial chats — kills reporting only one chat\'s count (C10)', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const BOOK = 'accum-book';
    const ENTRY = 'accum-entry';
    const CHAT_1 = 'i6-accum-1.jsonl';
    const CHAT_2 = 'i6-accum-2.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({
      header: { wi_fired: { [wiFiredKey(BOOK, ENTRY)]: { first_turn: 0, last_turn: 0, count: 3 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_1);
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({
      header: { wi_fired: { [wiFiredKey(BOOK, ENTRY)]: { first_turn: 0, last_turn: 0, count: 5 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_2);
    useChatStore.setState({
      chatFiles: [
        { fileName: CHAT_1, messageCount: 0, lastMessage: '' },
        { fileName: CHAT_2, messageCount: 0, lastMessage: '' },
      ],
    });

    const [agg] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }], {
      chatFiles: [CHAT_1, CHAT_2],
    });
    // 3 + 5 = 8 — a mutation that reports only the last (5) or first (3)
    // file's count, instead of summing across scope, fails this.
    expect(agg.generations).toEqual({ observed: true, complete: true, exact: 8 });
  });

  it('a caller-supplied scope naming the same file twice is deduped before counting — the sum does not double, and stays the exact arm (CONF3)', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const BOOK = 'dup-book';
    const ENTRY = 'dup-entry';
    const CHAT_FILE = 'i6-duplicate.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [wiFiredKey(BOOK, ENTRY)]: { first_turn: 0, last_turn: 0, count: 3 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
    useChatStore.setState({ chatFiles: [{ fileName: CHAT_FILE, messageCount: 0, lastMessage: '' }] });

    const [agg] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }], {
      chatFiles: [CHAT_FILE, CHAT_FILE],
    });
    // A count of 6 would mean the duplicate file inflated the sum. Once the
    // scope is a set, the one real chat it names is still fully covered, so
    // the count stays the exact arm, not a downgraded atLeast.
    expect(agg.generations).toEqual({ observed: true, complete: true, exact: 3 });
  });
});

// ---------------------------------------------------------------------------
// I7 — live-slot identity: null / mismatch / match, plus a group round
// ---------------------------------------------------------------------------

describe('getTurnWiInsight — live-slot identity (I7)', () => {
  it('null slot refuses breakdown-slot-empty', () => {
    resetStores();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
    expect(getTurnWiInsight()).toEqual({ observed: false, why: 'breakdown-slot-empty' });
  });

  it('a chatFile mismatch refuses breakdown-slot-describes-another-turn, and a match observes', async () => {
    const CHAT_FILE = 'i7-match.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    makeChatIneligible(); // keep this a plain client-scanned turn
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['ins-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().sendMessage('Hello.', CHAR);

    expect(getTurnWiInsight({ forChatFile: 'some-other-chat.jsonl' })).toEqual({
      observed: false,
      why: 'breakdown-slot-describes-another-turn',
    });
    const matched = getTurnWiInsight({ forChatFile: CHAT_FILE });
    expect(matched.observed).toBe(true);
  });

  it('a group round with two speakers: the slot holds only the LAST-published speaker, never a merge of both', async () => {
    resetStores();
    const CHAT_FILE = 'i7-group.jsonl';
    const CHAR_B = mkChar({ name: 'Marcus', avatar: 'marcus-insights.png' });
    const groupChat: GroupChatInfo = {
      fileName: CHAT_FILE,
      characterNames: [CHAR.name, CHAR_B.name],
      characterAvatars: [CHAR.avatar, CHAR_B.avatar],
      lastMessage: '',
      createdAt: 0,
      activationStrategy: 'manual',
      mutedAvatars: [],
      pooledExcludeRecent: 0,
      autoModeEnabled: false,
      autoModeDelayMs: 0,
      scenarioOverride: '',
      talkativenessOverrides: {},
      cardMode: DEFAULT_GROUP_CARD_MODE,
    };
    useWorldInfoStore.setState({
      books: [mkBook('grp-book-1', [mkEntry('grp-entry-1', { constant: true, content: 'Group lore.' })])],
      activeBookIds: ['grp-book-1'],
      sharedBooksStatus: 'loaded',
    });
    useChatHistoryRagStore.setState({ enabled: true });
    useChatStore.setState({
      messages: [mkMsg('g1', 'Hello, everyone.')],
      currentChatFile: CHAT_FILE,
      groupChats: [groupChat],
      isSending: false,
      isStreaming: false,
      error: null,
      abortController: null,
    });
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [],
      turnNo: 0,
      activatedEntryIds: [],
    });

    await useChatStore.getState().forceGroupMemberTalk(CHAR, [CHAR, CHAR_B]);
    const firstStamp = useGenerationStore.getState().lastPromptBreakdown?.publishedAt;
    const firstEntries = getTurnWiInsight();
    expect(firstEntries.observed).toBe(true);

    await useChatStore.getState().forceGroupMemberTalk(CHAR_B, [CHAR, CHAR_B]);
    const secondStamp = useGenerationStore.getState().lastPromptBreakdown?.publishedAt;
    const secondInsight = getTurnWiInsight();

    expect(secondStamp, 'a second group turn must publish a NEW stamp, not reuse the first').not.toBe(
      firstStamp
    );
    expect(secondInsight.observed).toBe(true);
    if (!secondInsight.observed) throw new Error('unreachable');
    // Never merged: the one constant entry should appear once, not
    // accumulated across the two speaker passes.
    expect(secondInsight.value.entries.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// I14 — engine derivation, three cases
// ---------------------------------------------------------------------------

describe('getTurnWiInsight — engine derivation (I14)', () => {
  it('group -> engine "client" (group never calls the server at all)', async () => {
    resetStores();
    const CHAT_FILE = 'i14-group.jsonl';
    const CHAR_B = mkChar({ name: 'Marcus', avatar: 'marcus-i14.png' });
    const groupChat: GroupChatInfo = {
      fileName: CHAT_FILE,
      characterNames: [CHAR.name, CHAR_B.name],
      characterAvatars: [CHAR.avatar, CHAR_B.avatar],
      lastMessage: '',
      createdAt: 0,
      activationStrategy: 'manual',
      mutedAvatars: [],
      pooledExcludeRecent: 0,
      autoModeEnabled: false,
      autoModeDelayMs: 0,
      scenarioOverride: '',
      talkativenessOverrides: {},
      cardMode: DEFAULT_GROUP_CARD_MODE,
    };
    useChatHistoryRagStore.setState({ enabled: true });
    useChatStore.setState({
      messages: [mkMsg('g1', 'Hi all.')],
      currentChatFile: CHAT_FILE,
      groupChats: [groupChat],
      isSending: false,
      isStreaming: false,
      error: null,
      abortController: null,
    });
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext');

    await useChatStore.getState().forceGroupMemberTalk(CHAR, [CHAR, CHAR_B]);

    expect(getRetrievalContext).not.toHaveBeenCalled();
    const insight = getTurnWiInsight();
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.engine).toBe('client');
  });

  it('solo, ineligible (tryServerRetrieval returns null) -> engine "client"', async () => {
    const CHAT_FILE = 'i14-ineligible.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    makeChatIneligible();
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext');

    await useChatStore.getState().sendMessage('Anyone home?', CHAR);

    expect(getRetrievalContext).not.toHaveBeenCalled();
    const insight = getTurnWiInsight();
    if (!insight.observed) throw new Error('unreachable');
    expect(insight.value.engine).toBe('client');
  });

  it('hand-built activationSource "server" with wi.server undefined -> engine "server", and the zeroed scan report is never read as real (HIGHEST-PRIORITY kill: `engine = wi.server ? "server" : "client"`)', () => {
    // This exact combination is unreachable through real store actions —
    // production always sets activationSource and wi.server together
    // (chatStore.ts's `serverMatchedEntries !== undefined` test drives
    // both). It IS the state AC4 exists to defend against: a turn that
    // says "the server ran this" while carrying the untouched, zeroed
    // wiScanReport defaults (chatStore.ts:1361-1371) for budget/
    // pinnedTokens/droppedEntries — exactly as a real server-path turn's
    // breakdown looks before `recordServerActivation` (or a mutation that
    // drops it) stamps `wi.server`.
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.chatFile = 'i14-handbuilt.jsonl';
    breakdown.wi.activationSource = 'server';
    // wi.server left undefined — deliberately not stamped.
    // wi.budget / wi.pinnedTokens / wi.droppedEntries stay at their real
    // zeroed defaults from createPromptBreakdown, matching production.
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

    const insight = getTurnWiInsight();
    expect(insight.observed).toBe(true);
    if (!insight.observed) throw new Error('unreachable');
    // The mutation `engine = wi.server ? 'server' : 'client'` would report
    // 'client' here, AND would then read the zeroed scan defaults as real
    // observed figures (pinnedTokens: value 0, budget: value 0, evicted:
    // value []) instead of every one of these refusing.
    expect(insight.value.engine).toBe('server');
    expect(insight.value.pinnedTokens).toEqual({ observed: false, why: 'server-path-no-scan-report' });
    expect(insight.value.pinnedOverBudget).toEqual({ observed: false, why: 'server-path-no-scan-report' });
    expect(insight.value.budget).toEqual({ observed: false, why: 'server-facts-missing' });
    expect(insight.value.evicted).toEqual({ observed: false, why: 'server-facts-missing' });
  });
});

// ---------------------------------------------------------------------------
// I15 — coverage accompanies every aggregate (walker + non-vacuity)
// ---------------------------------------------------------------------------

describe('getEntryFiringAggregate — coverage accompanies every result (I15)', () => {
  it('every returned aggregate carries a well-formed TelemetryCoverage', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [
        { fileName: 'i15-a.jsonl', messageCount: 0, lastMessage: '' },
        { fileName: 'i15-b.jsonl', messageCount: 0, lastMessage: '' },
      ],
      currentChatFile: null,
    });

    const results = getEntryFiringAggregate([
      { bookId: 'book-a', entryId: 'entry-a' },
      { bookId: 'book-b', entryId: 'entry-b' },
      { bookId: 'book-c', entryId: 'entry-c' },
    ]);

    // Non-vacuity: an empty `keys` array (or a walker that never actually
    // inspects `.coverage`) must not be how this test passes.
    expect(results.length).toBe(3);
    for (const agg of results) {
      expect(agg.coverage, JSON.stringify(agg)).toBeDefined();
      expect(agg.coverage.scope).toBe('in-memory-chat-list');
      expect(agg.coverage.chatsInScope.observed).toBe(true);
      expect(agg.coverage.turns).toBeDefined();
      expect(agg.coverage.turns.turnsWithTelemetry).toEqual({
        observed: false,
        why: 'turn-telemetry-not-persisted',
      });
      expect(agg.coverage.recency).toEqual({ observed: false, why: 'chat-recency-not-recorded' });
    }
    // Every result shares the SAME coverage object contents — one
    // denominator computation per call, not per key.
    expect(results[0].coverage).toEqual(results[1].coverage);
    expect(results[1].coverage).toEqual(results[2].coverage);
  });
});

// ---------------------------------------------------------------------------
// I16 — turn coverage: the counts must differ, or messages.length passes
// ---------------------------------------------------------------------------

describe('getTelemetryCoverage — turn coverage (I16)', () => {
  it('an open, in-scope chat refuses aiTurnsInScope unconditionally (transcript-identity-unprovable), even with a rich transcript in memory — #530', () => {
    // Round 2: this used to assert a real count (7 AI turns out of 17
    // messages) — the PM has since ruled that transcript identity can
    // never be confirmed from existing chatStore state (Critical 2), so
    // this now refuses regardless of how populated `messages` is.
    resetStores();
    const CHAT_FILE = 'i16-open.jsonl';
    const messages = [
      ...Array.from({ length: 9 }, (_, i) => mkMsg(`u${i}`, 'hi', { isUser: true, isSystem: false })),
      ...Array.from({ length: 7 }, (_, i) => mkMsg(`a${i}`, 'hello', { isUser: false, isSystem: false })),
      mkMsg('s0', 'system note', { isUser: false, isSystem: true }),
    ];
    useChatStore.setState({
      chatFiles: [{ fileName: CHAT_FILE, messageCount: messages.length, lastMessage: '' }],
      currentChatFile: CHAT_FILE,
      messages,
    });

    expect(messages.length).toBe(17); // sanity: the fixture really has 17 messages total.
    const coverage = getTelemetryCoverage();
    expect(coverage.turns.aiTurnsInScope).toEqual({ observed: false, why: 'transcript-identity-unprovable' });
  });

  it('no open chat in scope -> aiTurnsInScope refuses transcript-not-in-memory', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [{ fileName: 'i16-unopened.jsonl', messageCount: 0, lastMessage: '' }],
      currentChatFile: null,
      messages: [],
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.turns.aiTurnsInScope).toEqual({ observed: false, why: 'transcript-not-in-memory' });
  });

  it('an open chat file that is NOT in scope still refuses aiTurnsInScope — kills dropping the scope-membership check (`currentChatFile !== null` alone) (C9)', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [{ fileName: 'in-scope.jsonl', messageCount: 0, lastMessage: '' }],
      currentChatFile: 'not-in-scope.jsonl',
      messages: [mkMsg('a1', 'hello', { isUser: false, isSystem: false })],
      isLoading: false,
      error: null,
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.turns.aiTurnsInScope).toEqual({ observed: false, why: 'transcript-not-in-memory' });
  });

  it('chatsWithUncountedTurns is every file in scope, unconditionally — aiTurnsInScope never counts the open chat any more (#530) (C9)', () => {
    // Round 2: used to be "total minus the open one" (value 2 here) — now
    // nothing is ever counted, so it's every file in scope (value 3).
    resetStores();
    useChatStore.setState({
      chatFiles: [
        { fileName: 'i16-a.jsonl', messageCount: 0, lastMessage: '' },
        { fileName: 'i16-b.jsonl', messageCount: 0, lastMessage: '' },
        { fileName: 'i16-c.jsonl', messageCount: 0, lastMessage: '' },
      ],
      currentChatFile: 'i16-a.jsonl',
      messages: [],
      isLoading: false,
      error: null,
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.turns.chatsWithUncountedTurns).toEqual({ observed: true, value: 3 });
  });
});

// ---------------------------------------------------------------------------
// Round 2, Critical 2 — aiTurnsInScope is an UNCONDITIONAL refusal.
// Transcript identity is unprovable from existing chatStore state:
// `loadChat`/`loadGroupChat` move `currentChatFile` without `messages` in
// the same atomic set, and neither
// stamps a per-file confirmation a reader could check — true whether or not
// a load is in flight or one errored, not only during one (the old
// `isLoading || error !== null` predicate under-refused on at least three
// reachable paths). PM ruling: fail closed always; the store-side fix is
// out of this API's scope (issue #530, filed).
// ---------------------------------------------------------------------------

describe('getTelemetryCoverage — transcript identity is unprovable (#530)', () => {
  it('the open chat refuses transcript-identity-unprovable even when isLoading is false and error is null — kills aiTurnsInScope ever reporting a count again', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [{ fileName: 'c3-settled.jsonl', messageCount: 0, lastMessage: '' }],
      currentChatFile: 'c3-settled.jsonl',
      messages: [mkMsg('a1', 'hello', { isUser: false, isSystem: false })],
      isLoading: false,
      error: null,
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.turns.aiTurnsInScope).toEqual({ observed: false, why: 'transcript-identity-unprovable' });
  });

  it('a load in flight and a load that errored refuse the IDENTICAL way — isLoading/error no longer change the result', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [{ fileName: 'c3-in-flight.jsonl', messageCount: 0, lastMessage: '' }],
      currentChatFile: 'c3-in-flight.jsonl',
      messages: [],
      isLoading: true,
      error: null,
    });
    expect(getTelemetryCoverage().turns.aiTurnsInScope).toEqual({
      observed: false,
      why: 'transcript-identity-unprovable',
    });

    useChatStore.setState({ isLoading: false, error: 'Failed to load chat' });
    expect(getTelemetryCoverage().turns.aiTurnsInScope).toEqual({
      observed: false,
      why: 'transcript-identity-unprovable',
    });
    useChatStore.setState({ error: null }); // don't leak into later tests
  });

  it('a chat in scope but NOT the open one still refuses transcript-not-in-memory, not transcript-identity-unprovable — the two codes stay distinct, never collapsed into one', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [{ fileName: 'c3-not-open.jsonl', messageCount: 0, lastMessage: '' }],
      currentChatFile: null,
      messages: [],
      isLoading: false,
      error: null,
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.turns.aiTurnsInScope).toEqual({ observed: false, why: 'transcript-not-in-memory' });
  });
});

// ---------------------------------------------------------------------------
// I17 — sampledTurns is the literal 1
// ---------------------------------------------------------------------------

describe('getEntryFiringAggregate — emittedSample (I17)', () => {
  it('sampledTurns is 1, and the sample is the live turn\'s own emittedTokens', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.entries = [
      {
        entryId: 'sample-entry',
        bookId: 'sample-book',
        emittedTokens: 42,
        emittedChars: 100,
        rawTokens: 30,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

    const [agg] = getEntryFiringAggregate([{ bookId: 'sample-book', entryId: 'sample-entry' }]);
    expect(agg.emittedSample).toEqual({
      observed: true,
      value: { sampledTurns: 1, tokens: { basis: 'emitted', estimator: 'gpt', tokens: 42 } },
    });
  });

  it('no live breakdown -> refuses no-observed-turn', () => {
    resetStores();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'any', entryId: 'any' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'no-observed-turn' });
  });

  it('a live breakdown absent from entries/trimmedFromHistoryEntries/droppedEntries -> refuses entry-not-accounted-for-this-turn, NOT entry-never-rendered (C1)', () => {
    // Not accounted for anywhere this turn — distinct from `entry-never-
    // rendered` (C1's other two cases below), which means it WAS
    // evaluated. (Round 2: renamed from `entry-not-activated-this-turn` —
    // this API cannot actually prove non-candidacy, only absence from the
    // accounted records; see that code's own comment, types.ts.)
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'missing-book', entryId: 'missing-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('present ONLY in trimmedFromHistoryEntries -> refuses entry-trimmed-from-history, even though it carries a REAL emitted cost (C1/C11)', () => {
    // Mutating the lookup to also search `trimmedFromHistoryEntries` for a
    // sample (instead of refusing) would report this entry's real cost as
    // if it reached the model — it didn't; the history trim cut it first.
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.trimmedFromHistoryEntries = [
      {
        entryId: 'e-trimmed',
        bookId: 'b-trimmed',
        emittedTokens: 17,
        emittedChars: 40,
        rawTokens: 12,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'b-trimmed', entryId: 'e-trimmed' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-trimmed-from-history' });
  });

  it('present ONLY in droppedEntries with a null emittedTokens -> refuses entry-never-rendered (evaluated, evicted before rendering) (C1)', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.droppedEntries = [
      {
        entryId: 'e-dropped',
        bookId: 'b-dropped',
        emittedTokens: null,
        emittedChars: null,
        rawTokens: 5,
        placement: null,
        wrapper: null,
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'b-dropped', entryId: 'e-dropped' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-never-rendered' });
  });
});

// ---------------------------------------------------------------------------
// Round 2, Critical 1 — computeEmittedSample's server arm. A measured
// emission in `wi.entries` outranks any absence claim on BOTH engines
// (checked first, before any engine split); past that, absence means
// something different per engine, and the server arm's classifier is typed
// `Unobservable` so it is a type error for it to ever manufacture a value.
// ---------------------------------------------------------------------------

describe('getEntryFiringAggregate — emittedSample, server-arm classifier (Critical 1)', () => {
  it('server engine with the queried entry present in wi.entries carrying a real emittedTokens -> observed sample, not server-facts-missing or any other server-arm refusal — kills hoisting the activationSource === "server" check above the wi.entries lookup', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    breakdown.wi.entries = [
      {
        entryId: 'server-rendered-entry',
        bookId: 'server-rendered-book',
        emittedTokens: 55,
        emittedChars: 130,
        rawTokens: 40,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([
      { bookId: 'server-rendered-book', entryId: 'server-rendered-entry' },
    ]);
    expect(agg.emittedSample).toEqual({
      observed: true,
      value: { sampledTurns: 1, tokens: { basis: 'emitted', estimator: 'gpt', tokens: 55 } },
    });
  });

  it('server engine, wi.server undefined -> server-facts-missing', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    // wi.server left undefined.
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'any-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'server-facts-missing' });
  });

  it('server engine, evictedEntryIds undefined -> backend-does-not-report-eviction', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    breakdown.wi.server = { budgetRequested: 10, budgetEstimator: 'generic', activatedEntryIds: [] };
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'any-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'backend-does-not-report-eviction' });
  });

  it('server engine, evictedEntryIds contains the queried id -> entry-evicted-but-bookid-unverified, regardless of bookId', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    breakdown.wi.server = {
      budgetRequested: 10,
      budgetEstimator: 'generic',
      evictedEntryIds: ['target-entry'],
      activatedEntryIds: [],
    };
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    // bookId is deliberately irrelevant to the caller's key here — the
    // backend's evictedEntryIds list carries no book pairing to check it
    // against.
    const [agg] = getEntryFiringAggregate([{ bookId: 'irrelevant-book', entryId: 'target-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-evicted-but-bookid-unverified' });
  });

  it('server engine, evictedEntryIds present but lacking the id -> entry-not-accounted-for-this-turn', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    breakdown.wi.server = {
      budgetRequested: 10,
      budgetEstimator: 'generic',
      evictedEntryIds: ['some-other-id'],
      activatedEntryIds: [],
    };
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'target-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('engine must be read off activationSource, never wi.server truthiness — a hand-built server turn with wi.server undefined still refuses server-facts-missing (I14, restated for computeEmittedSample)', () => {
    // Unreachable through real store actions (see I14's own comment on
    // getTurnWiInsight, above) — the state AC4 exists to defend against. A
    // mutant reading `wi.server`'s truthiness instead of `activationSource`
    // would see a falsy `wi.server` and route this through the CLIENT arm
    // instead, which — since `droppedEntries` here is empty — would report
    // `entry-not-accounted-for-this-turn` rather than the correct
    // `server-facts-missing`.
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    // wi.server left undefined; wi.droppedEntries stays at its real
    // zeroed default ([]) from createPromptBreakdown, matching production.
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'any-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'server-facts-missing' });
  });

  it('the server arm never consults droppedEntries, even when one is (unreachably) populated with a matching entry', () => {
    // `wi.droppedEntries` is structurally `[]` on every real server turn
    // (chatStore.ts's `serverMatchedEntries !== undefined` short-circuit)
    // — hand-built here only to prove the
    // server arm never reads it. A mutant that consulted it anyway would
    // find the matching entry and report `entry-never-rendered` instead of
    // the correct `entry-not-accounted-for-this-turn`.
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    breakdown.wi.server = {
      budgetRequested: 10,
      budgetEstimator: 'generic',
      evictedEntryIds: [],
      activatedEntryIds: [],
    };
    breakdown.wi.droppedEntries = [
      {
        entryId: 'planted-in-dropped',
        bookId: 'planted-book',
        emittedTokens: null,
        emittedChars: null,
        rawTokens: 3,
        placement: null,
        wrapper: null,
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'planted-book', entryId: 'planted-in-dropped' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('a populated trimmedFromHistoryEntries that does NOT contain the queried key does not refuse entry-trimmed-from-history — kills `.some(matchesKey)` -> `.length > 0` (CONF5)', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.trimmedFromHistoryEntries = [
      {
        entryId: 'other-trimmed',
        bookId: 'other-book',
        emittedTokens: 9,
        emittedChars: 20,
        rawTokens: 6,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    // A `.length > 0` mutant would report entry-trimmed-from-history here
    // (the array is non-empty) even though the queried key isn't in it.
    const [agg] = getEntryFiringAggregate([{ bookId: 'unmatched-book', entryId: 'unmatched-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('present in wi.entries itself with a null emittedTokens executes the defensive fallback -> entry-never-rendered (CONF7)', () => {
    // Production only ever puts entries that reached `wrapWiContent` (and
    // so carry a real cost) into `wi.entries` — but the TYPE does not
    // forbid a null one, so this branch exists and must actually run
    // somewhere, rather than being a claim no fixture ever checks.
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.entries = [
      {
        entryId: 'e-null-cost',
        bookId: 'b-null-cost',
        emittedTokens: null,
        emittedChars: null,
        rawTokens: 5,
        placement: null,
        wrapper: null,
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'b-null-cost', entryId: 'e-null-cost' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-never-rendered' });
  });
});

// ---------------------------------------------------------------------------
// I18 — every declared `why` code is actually produced somewhere (set
// equality against OBSERVED_FALSE_REASONS)
// ---------------------------------------------------------------------------

describe('every declared ObservedFalseReason is produced (I18)', () => {
  it('a purpose-built battery of scenarios hits every declared reason, and nothing else', async () => {
    const produced = new Set<ObservedFalseReason>();
    const record = (why: ObservedFalseReason | undefined) => {
      if (why) produced.add(why);
    };

    // breakdown-slot-empty
    resetStores();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
    const emptySlot = getTurnWiInsight();
    if (!emptySlot.observed) record(emptySlot.why);

    // breakdown-slot-describes-another-turn
    {
      const CHAT_FILE = 'i18-mismatch.jsonl';
      arrangeEligibleChat(CHAT_FILE);
      makeChatIneligible();
      stubCommonEdges();
      vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
        entries: [ENTRY_DTO],
        turnNo: 0,
        activatedEntryIds: ['ins-entry-1'],
        evictedEntryIds: [],
      });
      await useChatStore.getState().sendMessage('hi', CHAR);
      const mismatch = getTurnWiInsight({ forChatFile: 'nope.jsonl' });
      if (!mismatch.observed) record(mismatch.why);

      // client-scan-computes-no-activation-reason (this same client turn)
      const matched = getTurnWiInsight({ forChatFile: CHAT_FILE });
      if (matched.observed && matched.value.engine === 'client') {
        for (const e of matched.value.entries) {
          if (!e.activationReason.observed) record(e.activationReason.why);
        }
      }
    }

    // server-path-no-scan-report, server-facts-missing,
    // backend-does-not-report-eviction, server-reports-id-only
    {
      const CHAT_FILE = 'i18-server.jsonl';
      arrangeEligibleChat(CHAT_FILE);
      stubCommonEdges();
      vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
        entries: [ENTRY_DTO],
        turnNo: 0,
        activatedEntryIds: ['ins-entry-1'],
        evictedEntryIds: ['ins-entry-2'],
      });
      await useChatStore.getState().sendMessage('server turn', CHAR);
      const serverInsight = getTurnWiInsight();
      if (serverInsight.observed && serverInsight.value.engine === 'server') {
        if (!serverInsight.value.pinnedTokens.observed) record(serverInsight.value.pinnedTokens.why);
        if (!serverInsight.value.evicted.observed) record(serverInsight.value.evicted.why);
        else {
          for (const ev of serverInsight.value.evicted.value) {
            if (!ev.bookId.observed) record(ev.bookId.why);
            if (!ev.tokens.observed) record(ev.tokens.why);
          }
        }
        // server-reports-no-activation-reason: ENTRY_DTO's activation was
        // never sent (no `activations` map on this mocked response), so
        // the entry the server DID activate carries no reason.
        for (const e of serverInsight.value.entries) {
          if (!e.activationReason.observed) record(e.activationReason.why);
        }
      }

      const breakdown = createPromptBreakdown('solo', 'gpt');
      breakdown.wi.activationSource = 'server';
      useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
      const missing = getTurnWiInsight();
      if (missing.observed && !missing.value.budget.observed) record(missing.value.budget.why);

      const absentBreakdown = createPromptBreakdown('solo', 'gpt');
      absentBreakdown.wi.activationSource = 'server';
      absentBreakdown.wi.server = { budgetRequested: 10, budgetEstimator: 'generic', activatedEntryIds: [] };
      useGenerationStore.setState({ lastPromptBreakdown: absentBreakdown, lastPromptBreakdownTag: null });
      const absentEviction = getTurnWiInsight();
      if (absentEviction.observed && !absentEviction.value.evicted.observed) {
        record(absentEviction.value.evicted.why);
      }
    }

    // entry-evicted-but-bookid-unverified: computeEmittedSample's
    // server-arm classifier, queried entryId present in evictedEntryIds.
    {
      resetStores();
      const breakdown = createPromptBreakdown('solo', 'gpt');
      breakdown.wi.activationSource = 'server';
      breakdown.wi.server = {
        budgetRequested: 10,
        budgetEstimator: 'generic',
        evictedEntryIds: ['i18-evicted-id'],
        activatedEntryIds: [],
      };
      useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
      const [evictedIdAgg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'i18-evicted-id' }]);
      if (!evictedIdAgg.emittedSample.observed) record(evictedIdAgg.emittedSample.why);
    }

    // entry-never-rendered: a hand-built turn whose only entry sits in
    // droppedEntries with a null emittedTokens — evaluated, then evicted
    // before rendering. (A real sendMessage turn can't exercise this
    // reliably: `arrangeEligibleChat`'s only WI entry is `constant: true`,
    // and a pinned entry can never be budget-evicted — see
    // `WiEntryRecord.pinned`'s own doc comment in promptBreakdown.ts.)
    {
      resetStores();
      const breakdown = createPromptBreakdown('solo', 'gpt');
      breakdown.wi.droppedEntries = [
        {
          entryId: 'i18-dropped',
          bookId: 'i18-dropped-book',
          emittedTokens: null,
          emittedChars: null,
          rawTokens: 4,
          placement: null,
          wrapper: null,
          pinned: false,
        },
      ];
      useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

      // Via computeEmittedSample (insightsApi.ts):
      const [droppedAgg] = getEntryFiringAggregate([{ bookId: 'i18-dropped-book', entryId: 'i18-dropped' }]);
      if (!droppedAgg.emittedSample.observed) record(droppedAgg.emittedSample.why);

      // Via projectEntry's own wrapper/placement/emittedTokens fields
      // (wiInsights.ts), reached through getTurnWiInsight's evicted list:
      const insight = getTurnWiInsight();
      if (insight.observed && insight.value.engine === 'client' && insight.value.evicted.observed) {
        for (const e of insight.value.evicted.value) {
          if (!e.wrapper.observed) record(e.wrapper.why);
          if (!e.placement.observed) record(e.placement.why);
          if (!e.emittedTokens.observed) record(e.emittedTokens.why);
        }
      }
    }

    // entry-not-accounted-for-this-turn: a key absent from every one of
    // this turn's accounted WI records — see that code's own comment
    // (types.ts) for why that is not evidence of non-candidacy.
    {
      const [missAgg] = getEntryFiringAggregate([{ bookId: 'nope', entryId: 'nope' }]);
      if (!missAgg.emittedSample.observed) record(missAgg.emittedSample.why);
    }

    // entry-trimmed-from-history: a hand-built turn whose only entry sits
    // in trimmedFromHistoryEntries with a REAL emitted cost.
    {
      resetStores();
      const breakdown = createPromptBreakdown('solo', 'gpt');
      breakdown.wi.trimmedFromHistoryEntries = [
        {
          entryId: 'i18-trimmed',
          bookId: 'i18-trimmed-book',
          emittedTokens: 9,
          emittedChars: 20,
          rawTokens: 6,
          placement: { stage: 'A', sectionId: 'wi_before_char' },
          wrapper: 'none',
          pinned: false,
        },
      ];
      useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
      const [trimmedAgg] = getEntryFiringAggregate([{ bookId: 'i18-trimmed-book', entryId: 'i18-trimmed' }]);
      if (!trimmedAgg.emittedSample.observed) record(trimmedAgg.emittedSample.why);
    }

    // no-observed-turn (an aggregate with no live breakdown at all)
    {
      resetStores();
      useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
      const [agg] = getEntryFiringAggregate([{ bookId: 'x', entryId: 'y' }]);
      if (!agg.emittedSample.observed) record(agg.emittedSample.why);
    }

    // chat-list-not-loaded
    {
      resetStores();
      useChatStore.setState({ chatFiles: [], messages: [], currentChatFile: null });
      const coverage = getTelemetryCoverage();
      if (!coverage.chatsInScope.observed) record(coverage.chatsInScope.why);
    }

    // chat-not-hydrated, telemetry-coverage-partial
    {
      resetStores();
      useWorldInfoStore.getState().resetUser();
      const LEGACY_BOOK = 'wibook_1777000000002_cccccc';
      const LEGACY_ENTRY = 'wi_1777000000003_dddddd';
      const PARTIAL_CHAT = 'i18-partial.jsonl';
      const NEVER_OPENED = 'i18-never-opened.jsonl';
      vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
        header: { wi_fired: { [wiFiredKey(LEGACY_BOOK, LEGACY_ENTRY)]: { first_turn: 0, last_turn: 0, count: 1 } } },
        messages: [],
        server_ts: 1,
      });
      await useChatStore.getState().loadChat('avatar.png', PARTIAL_CHAT);
      useChatStore.setState({
        chatFiles: [
          { fileName: PARTIAL_CHAT, messageCount: 0, lastMessage: '' },
          { fileName: NEVER_OPENED, messageCount: 0, lastMessage: '' },
        ],
      });
      const [partialAgg] = getEntryFiringAggregate([{ bookId: LEGACY_BOOK, entryId: LEGACY_ENTRY }], {
        chatFiles: [PARTIAL_CHAT],
      });
      if (partialAgg.generations.observed && !partialAgg.generations.complete) {
        record(partialAgg.generations.why);
      }
      const [unhydratedAgg] = getEntryFiringAggregate([{ bookId: 'z', entryId: 'z' }], {
        chatFiles: [NEVER_OPENED],
      });
      if (unhydratedAgg.generations.observed && !unhydratedAgg.generations.complete) {
        record(unhydratedAgg.generations.why);
      }
    }

    // transcript-not-in-memory, turn-telemetry-not-persisted,
    // chat-recency-not-recorded
    {
      resetStores();
      useChatStore.setState({
        chatFiles: [{ fileName: 'i18-turns.jsonl', messageCount: 0, lastMessage: '' }],
        currentChatFile: null,
        messages: [],
      });
      const coverage = getTelemetryCoverage();
      if (!coverage.turns.aiTurnsInScope.observed) record(coverage.turns.aiTurnsInScope.why);
      record(coverage.turns.turnsWithTelemetry.why);
      record(coverage.recency.why);
    }

    // transcript-identity-unprovable: the open chat IS in scope — refuses
    // unconditionally now (#530), regardless of isLoading/error.
    {
      resetStores();
      useChatStore.setState({
        chatFiles: [{ fileName: 'i18-switch.jsonl', messageCount: 0, lastMessage: '' }],
        currentChatFile: 'i18-switch.jsonl',
        messages: [],
      });
      const coverage = getTelemetryCoverage();
      if (!coverage.turns.aiTurnsInScope.observed) record(coverage.turns.aiTurnsInScope.why);
    }

    expect(produced).toEqual(new Set(OBSERVED_FALSE_REASONS));
  });
});
