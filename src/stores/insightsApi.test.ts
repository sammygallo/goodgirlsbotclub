/**
 * Integration tests for `insightsApi.ts` — pure-function tests for the two
 * projectors live in `src/utils/insights/wiInsights.test.ts`.
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
 *  (serverRetrieval.ts's condition 1). */
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

describe('getTurnWiInsight — PromptBreakdown -> source field mapping (CONF4)', () => {
  it('a client-scanned turn maps all 12 client-path fields from their own PromptBreakdown field, not a neighboring one', () => {
    resetStores();
    const breakdown = createPromptBreakdown('group', 'gemini');
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
    expect(insight.value.profile).toBe('gemini');
    expect(insight.value.emittedTotal).toEqual({
      observed: true,
      value: { basis: 'emitted', estimator: 'gemini', tokens: 501 },
    });
    expect(insight.value.rawTotal).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'gemini', tokens: 502 },
    });
    expect(insight.value.entries.map((e) => e.entryId)).toEqual(['conf4-common-entry']);
    expect(insight.value.trimmedFromHistoryEntries.map((e) => e.entryId)).toEqual(['conf4-trimmed-entry']);
    expect(insight.value.budget).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'gemini', tokens: 601 },
    });
    expect(insight.value.pinnedTokens).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'gemini', tokens: 602 },
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
    expect(insight.value.budget).toEqual({
      observed: true,
      value: { basis: 'raw', estimator: 'generic', tokens: 999 },
    });
  });
});

describe('getTelemetryCoverage — empty chat list (I5)', () => {
  it('an empty in-memory chat list never yields a false observed 0 anywhere in computeCoverage\'s shape (round 10, job 2)', () => {
    resetStores();
    useChatStore.setState({ chatFiles: [], messages: [], currentChatFile: null });
    const coverage = getTelemetryCoverage();
    expect(coverage).toEqual({
      scope: 'in-memory-chat-list',
      chatsInScope: { observed: false, why: 'chat-list-not-loaded' },
      chatsWithTelemetry: { observed: false, why: 'chat-list-not-loaded' },
      turns: {
        aiTurnsInScope: { observed: false, why: 'chat-list-not-loaded' },
        turnsWithTelemetry: { observed: false, why: 'turn-telemetry-not-persisted' },
        chatsWithUncountedTurns: { observed: false, why: 'chat-list-not-loaded' },
      },
      recency: { observed: false, why: 'chat-recency-not-recorded' },
    });
  });

  it('a non-empty in-memory chat list reports a real chatsInScope count', () => {
    resetStores();
    useChatStore.setState({
      chatFiles: [{ fileName: 'a.jsonl', messageCount: 0, lastMessage: '' }],
      messages: [],
      currentChatFile: null,
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.chatsInScope).toEqual({ observed: true, value: 1 });
  });

  it('a caller-supplied empty list is a deliberate zero, not a refusal — and, deliberately, NOT the unverified ChatCountFigure arm either (round 11 carve-out): summing over zero chats can never be inflated or deflated by a name collision, so nothing here is unverified', () => {
    resetStores();
    const coverage = getTelemetryCoverage({ chatFiles: [] });
    expect(coverage.scope).toBe('caller-supplied');
    expect(coverage.chatsInScope).toEqual({ observed: true, value: 0 });
    expect(coverage.chatsWithTelemetry).toEqual({ observed: true, value: 0 });
    expect(coverage.turns.chatsWithUncountedTurns).toEqual({ observed: true, value: 0 });
  });
});

describe('getTelemetryCoverage — numerator (I4)', () => {
  it('(A) in chatFiles, never opened; (B) in chatFiles, opened with an empty header; (C) in wiFiredByFile but NOT chatFiles', async () => {
    resetStores();
    const CHAT_A = 'i4-a-never-opened.jsonl';
    const CHAT_B = 'i4-b-opened-empty.jsonl';
    const CHAT_C = 'i4-c-not-in-scope.jsonl';

    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({ header: {}, messages: [], server_ts: 1 });
    await useChatStore.getState().loadChat('avatar.png', CHAT_B);

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
    expect(coverage.chatsWithTelemetry).toEqual({
      observed: true,
      verified: false,
      count: 1,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('chatsWithTelemetry is a real count, not a hardcoded 1 — two opened chats, one never opened (round 10, job 2)', async () => {
    resetStores();
    const CHAT_A = 'i4-real-count-a.jsonl';
    const CHAT_B = 'i4-real-count-b.jsonl';
    const CHAT_C = 'i4-real-count-c-never-opened.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({ header: {}, messages: [], server_ts: 1 });
    await useChatStore.getState().loadChat('avatar.png', CHAT_A);
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({ header: {}, messages: [], server_ts: 1 });
    await useChatStore.getState().loadChat('avatar.png', CHAT_B);
    useChatStore.setState({
      chatFiles: [
        { fileName: CHAT_A, messageCount: 0, lastMessage: '' },
        { fileName: CHAT_B, messageCount: 0, lastMessage: '' },
        { fileName: CHAT_C, messageCount: 0, lastMessage: '' },
      ],
      currentChatFile: null,
    });
    const coverage = getTelemetryCoverage();
    expect(coverage.chatsInScope).toEqual({ observed: true, value: 3 });
    expect(coverage.chatsWithTelemetry).toEqual({
      observed: true,
      verified: false,
      count: 2,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });
});

describe('getEntryFiringAggregate — generations (I6)', () => {
  const LEGACY_BOOK = 'wibook_1777000000000_aaaaaa';
  const LEGACY_ENTRY = 'wi_1777000000001_bbbbbb';

  it('a chat with an unresolved legacy wi_fired key -> generations carries telemetry-coverage-partial ahead of the mandatory collision reason', async () => {
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
      verified: false,
      count: 4,
      reasons: ['telemetry-coverage-partial', 'chat-file-names-not-verified-distinct'],
    });
  });

  it('a chat with an ordinary native-shaped key, in-memory scope -> generations is STILL unverified (round 11: wiFiredByFile has no per-character partition, so the in-memory scope does not exempt it the way it exempts chatsInScope)', async () => {
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

    const [agg] = getEntryFiringAggregate([{ bookId: 'native-book', entryId: 'native-entry' }]);
    expect(agg.coverage.scope).toBe('in-memory-chat-list');
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 3,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('a hydrated, non-partial, in-memory chat with no recorded firing for the queried key -> generations count: 0, still wrapped unverified (round 10, job 2 / round 11)', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const CHAT_FILE = 'i6-zero.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: {} },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
    useChatStore.setState({ chatFiles: [{ fileName: CHAT_FILE, messageCount: 0, lastMessage: '' }] });

    const [agg] = getEntryFiringAggregate([{ bookId: 'never-fired-book', entryId: 'never-fired-entry' }]);
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 0,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('an empty in-memory chat list -> generations is the Unobservable arm, carrying the SAME why as coverage.chatsInScope (round 10, job 2)', () => {
    resetStores();
    useChatStore.setState({ chatFiles: [], messages: [], currentChatFile: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'any-entry' }]);
    expect(agg.generations).toEqual({ observed: false, why: 'chat-list-not-loaded' });
  });

  it('an empty CALLER-SUPPLIED chat list -> generations is a real Observed<number> 0 (round 12 carve-out): summing zero chats can never collide, the same reasoning `chatsInScope`/`chatsWithTelemetry`/`chatsWithUncountedTurns` already got', () => {
    resetStores();
    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'any-entry' }], { chatFiles: [] });
    expect(agg.coverage.scope).toBe('caller-supplied');
    expect(agg.generations).toEqual({ observed: true, value: 0 });
  });

  it('two distinct keys queried in one call each get their OWN bookId/entryId/generations — no swap, no shared hardcoded key (round 10, job 2)', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const CHAT_FILE = 'i6-two-keys.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: {
        wi_fired: {
          [wiFiredKey('book-alpha', 'entry-alpha')]: { first_turn: 0, last_turn: 0, count: 4 },
          [wiFiredKey('book-beta', 'entry-beta')]: { first_turn: 0, last_turn: 0, count: 9 },
        },
      },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
    useChatStore.setState({ chatFiles: [{ fileName: CHAT_FILE, messageCount: 0, lastMessage: '' }] });

    const [aggA, aggB] = getEntryFiringAggregate([
      { bookId: 'book-alpha', entryId: 'entry-alpha' },
      { bookId: 'book-beta', entryId: 'entry-beta' },
    ]);
    expect(aggA.bookId).toBe('book-alpha');
    expect(aggA.entryId).toBe('entry-alpha');
    expect(aggA.generations).toEqual({
      observed: true,
      verified: false,
      count: 4,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
    expect(aggB.bookId).toBe('book-beta');
    expect(aggB.entryId).toBe('entry-beta');
    expect(aggB.generations).toEqual({
      observed: true,
      verified: false,
      count: 9,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('an un-hydrated chat, alone in scope -> generations carries chat-not-hydrated ahead of the mandatory collision reason', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const NEVER_OPENED = 'i6-never-opened.jsonl';
    useChatStore.setState({ chatFiles: [{ fileName: NEVER_OPENED, messageCount: 0, lastMessage: '' }] });

    const [agg] = getEntryFiringAggregate([{ bookId: 'any-book', entryId: 'any-entry' }], {
      chatFiles: [NEVER_OPENED],
    });
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 0,
      reasons: ['chat-not-hydrated', 'chat-file-names-not-verified-distinct'],
    });
  });

  it('BOTH an un-hydrated chat AND a partially-covered chat in scope at once -> chat-not-hydrated wins (C10 — the priority the docstring actually claims)', async () => {
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
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 4,
      reasons: ['chat-not-hydrated', 'chat-file-names-not-verified-distinct'],
    });
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

    // In-memory scope (no `chatFiles` opt).
    const [agg] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }]);
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 8,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('a caller-supplied scope naming the same file twice is deduped before counting — the sum does not double, and the coverage denominator does not double either (CONF3)', async () => {
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
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 3,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
    expect(agg.coverage.chatsInScope).toEqual({
      observed: true,
      verified: false,
      count: 1,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
    expect(agg.coverage.turns.chatsWithUncountedTurns).toEqual({
      observed: true,
      verified: false,
      count: 1,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });
});

describe('getTelemetryCoverage — chatsWithTelemetry, caller-supplied scope', () => {
  it('a non-empty caller-supplied scope with one hydrated chat and one never-opened chat -> the unverified arm, count 1 — not a hardcoded clean Observed<number>', async () => {
    resetStores();
    const HYDRATED = 'conf5-hydrated.jsonl';
    const NEVER_OPENED = 'conf5-never-opened.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: {
        wi_fired: { [wiFiredKey('conf5-book', 'conf5-entry')]: { first_turn: 0, last_turn: 0, count: 4 } },
      },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', HYDRATED);

    const coverage = getTelemetryCoverage({ chatFiles: [HYDRATED, NEVER_OPENED] });
    expect(coverage.scope).toBe('caller-supplied');
    expect(coverage.chatsWithTelemetry).toEqual({
      observed: true,
      verified: false,
      count: 1,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('a non-empty caller-supplied scope where nothing is hydrated -> still the unverified arm at count 0 — distinct from the deliberate-empty-LIST carve-out (`chatFiles: []`), which this is not', () => {
    resetStores();
    const coverage = getTelemetryCoverage({
      chatFiles: ['conf5-unopened-a.jsonl', 'conf5-unopened-b.jsonl'],
    });
    expect(coverage.scope).toBe('caller-supplied');
    expect(coverage.chatsWithTelemetry).toEqual({
      observed: true,
      verified: false,
      count: 0,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });
});

describe('getEntryFiringAggregate — round 11: generations is scope-independent, chatsInScope is not', () => {
  it('in-memory scope, fully hydrated and non-partial -> generations is STILL the unverified arm (this is what round 10 job 1 got wrong: wiFiredByFile has no per-character partition, so hydration in ANY scope cannot certify the count)', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const BOOK = 'r11-book';
    const ENTRY = 'r11-entry';
    const CHAT_FILE = 'r11-in-memory.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [wiFiredKey(BOOK, ENTRY)]: { first_turn: 0, last_turn: 0, count: 2 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
    useChatStore.setState({ chatFiles: [{ fileName: CHAT_FILE, messageCount: 0, lastMessage: '' }] });

    // No `chatFiles` opt -> in-memory scope.
    const [agg] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }]);
    expect(agg.coverage.scope).toBe('in-memory-chat-list');
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 2,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('caller-supplied scope, identically hydrated and non-partial -> generations reports the IDENTICAL shape as the in-memory case above (same hydration, same count, only the scope differs — and it no longer matters to this figure)', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const BOOK = 'r11-book-2';
    const ENTRY = 'r11-entry-2';
    const CHAT_FILE = 'r11-caller-supplied.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [wiFiredKey(BOOK, ENTRY)]: { first_turn: 0, last_turn: 0, count: 2 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);

    const [agg] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }], { chatFiles: [CHAT_FILE] });
    expect(agg.coverage.scope).toBe('caller-supplied');
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 2,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('the SAME two fixtures above still tell in-memory and caller-supplied apart through chatsInScope — it, unlike generations, never touches wiFiredByFile', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const CHAT_FILE = 'r11-chatsinscope-split.jsonl';
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({ header: {}, messages: [], server_ts: 1 });
    await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
    useChatStore.setState({ chatFiles: [{ fileName: CHAT_FILE, messageCount: 0, lastMessage: '' }] });

    const inMemory = getTelemetryCoverage();
    expect(inMemory.scope).toBe('in-memory-chat-list');
    expect(inMemory.chatsInScope).toEqual({ observed: true, value: 1 });

    const callerSupplied = getTelemetryCoverage({ chatFiles: [CHAT_FILE] });
    expect(callerSupplied.scope).toBe('caller-supplied');
    expect(callerSupplied.chatsInScope).toEqual({
      observed: true,
      verified: false,
      count: 1,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('the collision state itself: two characters share a chat file name; character B\'s real telemetry is read back under character A\'s in-memory scope, unflagged as foreign — the state TelemetryDerivedCount exists to mark, constructed through the real loadChat API, not hand-built', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const SHARED_NAME = 'r11-collision-shared.jsonl';
    const BOOK = 'r11-collision-book';
    const ENTRY = 'r11-collision-entry';

    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({
      header: { wi_fired: { [wiFiredKey(BOOK, ENTRY)]: { first_turn: 0, last_turn: 0, count: 7 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('character-b-avatar.png', SHARED_NAME);

    useChatStore.setState({
      chatFiles: [{ fileName: SHARED_NAME, messageCount: 0, lastMessage: '' }],
      currentChatFile: null,
    });

    const [agg] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }]);
    expect(agg.coverage.scope).toBe('in-memory-chat-list');
    expect(agg.generations).toEqual({
      observed: true,
      verified: false,
      count: 7,
      reasons: ['chat-file-names-not-verified-distinct'],
    });
  });

  it('deflation via deleteChat: a real, previously-recorded count reads back as chat-not-hydrated once an UNRELATED character deletes their own same-named chat, because wiFiredByFile is keyed and deleted by bare name only', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();
    const SHARED_NAME = 'r11-deflation-shared.jsonl';
    const BOOK = 'r11-deflation-book';
    const ENTRY = 'r11-deflation-entry';

    vi.spyOn(api, 'getChatWithHeader').mockResolvedValueOnce({
      header: { wi_fired: { [wiFiredKey(BOOK, ENTRY)]: { first_turn: 0, last_turn: 0, count: 5 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat('avatar.png', SHARED_NAME);
    useChatStore.setState({ chatFiles: [{ fileName: SHARED_NAME, messageCount: 0, lastMessage: '' }] });

    const [before] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }]);
    expect(before.generations).toEqual({
      observed: true,
      verified: false,
      count: 5,
      reasons: ['chat-file-names-not-verified-distinct'],
    });

    vi.spyOn(api, 'deleteChat').mockResolvedValueOnce(undefined);
    vi.spyOn(api, 'getChats').mockResolvedValueOnce([]);
    await useChatStore.getState().deleteChat('some-other-avatar.png', SHARED_NAME);

    const [after] = getEntryFiringAggregate([{ bookId: BOOK, entryId: ENTRY }], { chatFiles: [SHARED_NAME] });
    expect(after.generations).toEqual({
      observed: true,
      verified: false,
      count: 0,
      reasons: ['chat-not-hydrated', 'chat-file-names-not-verified-distinct'],
    });
  });
});

describe('getTurnWiInsight — live-slot identity (I7)', () => {
  it('null slot refuses breakdown-slot-empty', () => {
    resetStores();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
    expect(getTurnWiInsight()).toEqual({ observed: false, why: 'breakdown-slot-empty' });
  });

  it('a null slot with forChatFile supplied still refuses breakdown-slot-empty, never reading opts.forChatFile against a null breakdown', () => {
    resetStores();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
    expect(getTurnWiInsight({ forChatFile: 'irrelevant.jsonl' })).toEqual({
      observed: false,
      why: 'breakdown-slot-empty',
    });
  });

  it('a chatFile mismatch refuses breakdown-slot-describes-another-turn, and a NAME MATCH refuses too — chat-file-names-not-verified-distinct, since a bare name can never prove the slot describes the requested chat', async () => {
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
    expect(getTurnWiInsight({ forChatFile: CHAT_FILE })).toEqual({
      observed: false,
      why: 'chat-file-names-not-verified-distinct',
    });
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
    expect(secondInsight.value.entries.length).toBe(1);
  });
});

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
    expect(insight.value.engine).toBe('server');
    expect(insight.value.pinnedTokens).toEqual({ observed: false, why: 'server-path-no-scan-report' });
    expect(insight.value.pinnedOverBudget).toEqual({ observed: false, why: 'server-path-no-scan-report' });
    expect(insight.value.budget).toEqual({ observed: false, why: 'server-facts-missing' });
    expect(insight.value.evicted).toEqual({ observed: false, why: 'server-facts-missing' });
  });
});

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
    expect(results[0].coverage).toEqual(results[1].coverage);
    expect(results[1].coverage).toEqual(results[2].coverage);
  });
});

describe('getTelemetryCoverage — turn coverage (I16)', () => {
  it('an open, in-scope chat refuses aiTurnsInScope unconditionally (transcript-identity-unprovable), even with a rich transcript in memory — #530', () => {
    resetStores();
    const CHAT_FILE = 'i16-open.jsonl';
    // 9 user, 7 AI, 1 system.
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

    expect(messages.length).toBe(17);
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
    useChatStore.setState({ error: null });
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
      value: {
        sampledTurns: 1,
        tokens: { basis: 'emitted', estimator: 'gpt', tokens: 42 },
        turn: { chatFile: breakdown.chatFile, publishedAt: breakdown.publishedAt },
      },
    });
  });

  it('no live breakdown -> refuses no-observed-turn', () => {
    resetStores();
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'any', entryId: 'any' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'no-observed-turn' });
  });

  it('a live breakdown absent from entries/trimmedFromHistoryEntries/droppedEntries -> refuses entry-not-accounted-for-this-turn, NOT entry-never-rendered (C1)', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'missing-book', entryId: 'missing-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('present ONLY in trimmedFromHistoryEntries -> refuses entry-trimmed-from-history, even though it carries a REAL emitted cost (C1/C11)', () => {
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

  it('an entry in trimmedFromHistoryEntries sharing only the queried entryId (different bookId) does not refuse entry-trimmed-from-history — kills matchesKey -> entryId-only at the trimmedFromHistoryEntries call site', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.trimmedFromHistoryEntries = [
      {
        entryId: 'wanted-entry',
        bookId: 'decoy-book',
        emittedTokens: 9,
        emittedChars: 20,
        rawTokens: 6,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'wanted-book', entryId: 'wanted-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('an entry in trimmedFromHistoryEntries sharing only the queried bookId (different entryId) does not refuse entry-trimmed-from-history — kills matchesKey -> bookId-only at the trimmedFromHistoryEntries call site', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.trimmedFromHistoryEntries = [
      {
        entryId: 'decoy-entry',
        bookId: 'wanted-book',
        emittedTokens: 9,
        emittedChars: 20,
        rawTokens: 6,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'wanted-book', entryId: 'wanted-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
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

  it('an entry in droppedEntries sharing only the queried entryId (different bookId) does not refuse entry-never-rendered — kills matchesKey -> entryId-only at the droppedEntries call site', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.droppedEntries = [
      {
        entryId: 'wanted-entry',
        bookId: 'decoy-book',
        emittedTokens: null,
        emittedChars: null,
        rawTokens: 4,
        placement: null,
        wrapper: null,
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'wanted-book', entryId: 'wanted-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('an entry in droppedEntries sharing only the queried bookId (different entryId) does not refuse entry-never-rendered — kills matchesKey -> bookId-only at the droppedEntries call site', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.droppedEntries = [
      {
        entryId: 'decoy-entry',
        bookId: 'wanted-book',
        emittedTokens: null,
        emittedChars: null,
        rawTokens: 4,
        placement: null,
        wrapper: null,
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'wanted-book', entryId: 'wanted-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('round 12: the sample names the chat file and publish time of the live turn it came from, and a fixture where that turn belongs to a chat OUTSIDE the queried scope shows the consumer can tell — computeEmittedSample reads lastPromptBreakdown directly and never checks it against `opts.chatFiles`', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.chatFile = 'chat-B.jsonl';
    breakdown.publishedAt = 555555;
    breakdown.wi.entries = [
      {
        entryId: 'cross-scope-entry',
        bookId: 'cross-scope-book',
        emittedTokens: 21,
        emittedChars: 50,
        rawTokens: 15,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

    // Scope is chat-A only; the live turn's own chatFile is chat-B.
    const [agg] = getEntryFiringAggregate([{ bookId: 'cross-scope-book', entryId: 'cross-scope-entry' }], {
      chatFiles: ['chat-A.jsonl'],
    });
    expect(agg.emittedSample).toEqual({
      observed: true,
      value: {
        sampledTurns: 1,
        tokens: { basis: 'emitted', estimator: 'gpt', tokens: 21 },
        turn: { chatFile: 'chat-B.jsonl', publishedAt: 555555 },
      },
    });
  });

  it('two entries sharing a bookId but differing entryId — the sample matches the exact entryId queried, not the other entry under the same book (CONF3)', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.entries = [
      {
        entryId: 'other-entry',
        bookId: 'shared-book',
        emittedTokens: 999,
        emittedChars: 999,
        rawTokens: 999,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
      {
        entryId: 'wanted-entry',
        bookId: 'shared-book',
        emittedTokens: 7,
        emittedChars: 20,
        rawTokens: 5,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

    const [agg] = getEntryFiringAggregate([{ bookId: 'shared-book', entryId: 'wanted-entry' }]);
    expect(agg.emittedSample).toEqual({
      observed: true,
      value: {
        sampledTurns: 1,
        tokens: { basis: 'emitted', estimator: 'gpt', tokens: 7 },
        turn: { chatFile: breakdown.chatFile, publishedAt: breakdown.publishedAt },
      },
    });
  });

  it('two entries sharing an entryId but differing bookId — the sample matches the exact bookId queried, not the other entry under the same entryId (CONF3)', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.entries = [
      {
        entryId: 'shared-entry',
        bookId: 'other-book',
        emittedTokens: 999,
        emittedChars: 999,
        rawTokens: 999,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
      {
        entryId: 'shared-entry',
        bookId: 'wanted-book',
        emittedTokens: 11,
        emittedChars: 30,
        rawTokens: 8,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });

    const [agg] = getEntryFiringAggregate([{ bookId: 'wanted-book', entryId: 'shared-entry' }]);
    expect(agg.emittedSample).toEqual({
      observed: true,
      value: {
        sampledTurns: 1,
        tokens: { basis: 'emitted', estimator: 'gpt', tokens: 11 },
        turn: { chatFile: breakdown.chatFile, publishedAt: breakdown.publishedAt },
      },
    });
  });

  it('the wanted entry placed FIRST in wi.entries, with an unrelated entry LAST, still returns the wanted entry — kills `.find(matchesKey)` degenerating into always the last element', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.entries = [
      {
        entryId: 'wanted-entry',
        bookId: 'wanted-book',
        emittedTokens: 13,
        emittedChars: 30,
        rawTokens: 9,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
      {
        entryId: 'unrelated-entry',
        bookId: 'unrelated-book',
        emittedTokens: 999,
        emittedChars: 999,
        rawTokens: 999,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'wanted-book', entryId: 'wanted-entry' }]);
    expect(agg.emittedSample).toEqual({
      observed: true,
      value: {
        sampledTurns: 1,
        tokens: { basis: 'emitted', estimator: 'gpt', tokens: 13 },
        turn: { chatFile: breakdown.chatFile, publishedAt: breakdown.publishedAt },
      },
    });
  });
});

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
      value: {
        sampledTurns: 1,
        tokens: { basis: 'emitted', estimator: 'gpt', tokens: 55 },
        turn: { chatFile: breakdown.chatFile, publishedAt: breakdown.publishedAt },
      },
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

  it('a server turn where the queried entry is BOTH in trimmedFromHistoryEntries and in evictedEntryIds refuses entry-trimmed-from-history, not entry-evicted-but-bookid-unverified — pins the trimmed check running before the server classifier', () => {
    resetStores();
    const breakdown = createPromptBreakdown('solo', 'gpt');
    breakdown.wi.activationSource = 'server';
    breakdown.wi.trimmedFromHistoryEntries = [
      {
        entryId: 'contested-entry',
        bookId: 'contested-book',
        emittedTokens: 25,
        emittedChars: 60,
        rawTokens: 18,
        placement: { stage: 'A', sectionId: 'wi_before_char' },
        wrapper: 'none',
        pinned: false,
      },
    ];
    breakdown.wi.server = {
      budgetRequested: 10,
      budgetEstimator: 'generic',
      evictedEntryIds: ['contested-entry'],
      activatedEntryIds: [],
    };
    useGenerationStore.setState({ lastPromptBreakdown: breakdown, lastPromptBreakdownTag: null });
    const [agg] = getEntryFiringAggregate([{ bookId: 'contested-book', entryId: 'contested-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-trimmed-from-history' });
  });

  it('a populated trimmedFromHistoryEntries that does NOT contain the queried key does not refuse entry-trimmed-from-history — kills `.some(matchesKey)` -> `.length > 0`', () => {
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
    const [agg] = getEntryFiringAggregate([{ bookId: 'unmatched-book', entryId: 'unmatched-entry' }]);
    expect(agg.emittedSample).toEqual({ observed: false, why: 'entry-not-accounted-for-this-turn' });
  });

  it('present in wi.entries itself with a null emittedTokens executes the defensive fallback -> entry-never-rendered (CONF7)', () => {
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

      // chat-file-names-not-verified-distinct
      const matched = getTurnWiInsight({ forChatFile: CHAT_FILE });
      if (!matched.observed) record(matched.why);

      // client-scan-computes-no-activation-reason
      const unfiltered = getTurnWiInsight();
      if (unfiltered.observed && unfiltered.value.engine === 'client') {
        for (const e of unfiltered.value.entries) {
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
        // server-reports-no-activation-reason
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

    // entry-evicted-but-bookid-unverified
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

    // entry-never-rendered
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

      const [droppedAgg] = getEntryFiringAggregate([{ bookId: 'i18-dropped-book', entryId: 'i18-dropped' }]);
      if (!droppedAgg.emittedSample.observed) record(droppedAgg.emittedSample.why);

      const insight = getTurnWiInsight();
      if (insight.observed && insight.value.engine === 'client' && insight.value.evicted.observed) {
        for (const e of insight.value.evicted.value) {
          if (!e.wrapper.observed) record(e.wrapper.why);
          if (!e.placement.observed) record(e.placement.why);
          if (!e.emittedTokens.observed) record(e.emittedTokens.why);
        }
      }
    }

    // entry-not-accounted-for-this-turn
    {
      const [missAgg] = getEntryFiringAggregate([{ bookId: 'nope', entryId: 'nope' }]);
      if (!missAgg.emittedSample.observed) record(missAgg.emittedSample.why);
    }

    // entry-trimmed-from-history
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

    // no-observed-turn
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
      if (partialAgg.generations.observed && 'reasons' in partialAgg.generations) {
        for (const r of partialAgg.generations.reasons) record(r);
      }
      const [unhydratedAgg] = getEntryFiringAggregate([{ bookId: 'z', entryId: 'z' }], {
        chatFiles: [NEVER_OPENED],
      });
      if (unhydratedAgg.generations.observed && 'reasons' in unhydratedAgg.generations) {
        for (const r of unhydratedAgg.generations.reasons) record(r);
      }
    }

    // chat-file-names-not-verified-distinct
    {
      resetStores();
      useWorldInfoStore.getState().resetUser();
      const CHAT_FILE = 'i18-caller-supplied.jsonl';
      vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
        header: {
          wi_fired: { [wiFiredKey('i18-book', 'i18-entry')]: { first_turn: 0, last_turn: 0, count: 1 } },
        },
        messages: [],
        server_ts: 1,
      });
      await useChatStore.getState().loadChat('avatar.png', CHAT_FILE);
      const [callerSuppliedAgg] = getEntryFiringAggregate([{ bookId: 'i18-book', entryId: 'i18-entry' }], {
        chatFiles: [CHAT_FILE],
      });
      if (callerSuppliedAgg.generations.observed && 'reasons' in callerSuppliedAgg.generations) {
        for (const r of callerSuppliedAgg.generations.reasons) record(r);
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

    // transcript-identity-unprovable
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
