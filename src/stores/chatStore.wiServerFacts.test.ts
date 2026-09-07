/**
 * Server-path facts on the token breakdown (E2-S4 PR1).
 *
 * `PromptBreakdown.wi.server` is stamped by `recordServerActivation`
 * (promptBreakdown.ts) at the three solo call sites that actually attempt
 * POST /retrieval/context — sendMessage, impersonate, editMessageAndRegenerate
 * — and MUST stay `undefined` everywhere else: the two solo sites that never
 * call `tryServerRetrieval` at all (swipeRight/regenerateMessage,
 * continueMessage), group (which never imports serverRetrieval.ts at all —
 * see that module's own header), and any of the three server-path sites on a
 * turn where the server call itself failed or the chat was ineligible.
 *
 * Drives REAL store actions with `api` stubbed at the network edge only —
 * same house style as chatStore.wiFiredServerPath.test.ts and
 * chatStore.callSites.test.ts. Every assertion here reads
 * `useGenerationStore.getState().lastPromptBreakdown` — the object the
 * STORE holds — never a local variable a call site happened to close over,
 * which is what makes this suite catch a `recordServerActivation` call that
 * mutates the wrong object (or nothing at all) rather than merely one that
 * runs in the wrong order relative to `setLastPromptBreakdown` (object
 * mutation makes pure reordering of those two adjacent statements
 * unobservable here — see the "ordering" test below for the honest version
 * of that claim).
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
const { api } = await import('../api/client');
const { mkBook, mkEntry, mkChar, mkMsg, resetStores } = await import('./promptGoldens.fixtures');

import type { GroupChatInfo } from './chatStore';

/** One SSE content frame — same shape chatStore.callSites.test.ts /
 *  chatStore.wiFiredServerPath.test.ts use to reach code past
 *  `if (!stream) return`. */
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

const CHAR = mkChar({ name: 'Ivy', avatar: 'ivy-server-facts.png' });

/**
 * Eligibility-passing world-info state — one active world book, nothing
 * persona/character/chat-scoped to disqualify it (isChatEligibleForServerRetrieval,
 * serverRetrieval.ts). Same shape chatStore.wiFiredServerPath.test.ts uses.
 */
function arrangeEligibleChat(chatFile: string): void {
  resetStores();
  useWorldInfoStore.setState({
    books: [
      mkBook('sf-book-1', [
        mkEntry('sf-entry-1', { constant: true, content: 'Server-facts lore.' }),
      ]),
    ],
    activeBookIds: ['sf-book-1'],
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

/** Stub everything sendMessage/impersonate/editMessageAndRegenerate touch
 *  besides the retrieval read itself, so only `getRetrievalContext`'s mock
 *  varies per test. */
function stubCommonEdges(): void {
  vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
  vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [], reason: null });
  vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('A reply.'));
  vi.spyOn(api, 'importLorebooksFromBlob').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
  vi.spyOn(api, 'importFromDatabank').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
  vi.spyOn(api, 'commitRetrievalContext').mockResolvedValue(undefined);
}

const ENTRY_DTO = {
  id: 'sf-entry-1',
  lorebook_id: 'sf-book-1',
  server_ts: 1,
  content: 'Server-facts lore.',
  comment: '',
  enabled: true,
  constant: true,
};

beforeEach(() => {
  (globalThis.localStorage as unknown as MemoryStorage).clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Absent vs. empty — the AC4 kill test
// ---------------------------------------------------------------------------

describe('server activation facts — absent vs empty evictedEntryIds (AC4)', () => {
  it('a response WITHOUT evictedEntryIds leaves wi.server.evictedEntryIds undefined', async () => {
    const CHAT_FILE = 'server-facts-absent.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      // evictedEntryIds deliberately absent — a pre-E4-S0 backend response.
    });

    await useChatStore.getState().sendMessage('Tell me something.', CHAR);

    expect(
      getRetrievalContext,
      'the server-path read never happened — eligibility must have failed'
    ).toHaveBeenCalledTimes(1);
    // Read off the STORE, not a local — see the file header.
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown?.wi.server, 'wi.server was never stamped at all').toBeDefined();
    expect(
      breakdown!.wi.server!.evictedEntryIds,
      'an absent evictedEntryIds key must surface as undefined, not []'
    ).toBeUndefined();
    expect(breakdown!.wi.server!.activatedEntryIds).toEqual(['sf-entry-1']);
    expect(breakdown!.wi.server!.budgetEstimator).toBe('generic');
    expect(breakdown!.wi.activationSource).toBe('server');
  });

  it('a response WITH evictedEntryIds: [] leaves wi.server.evictedEntryIds as []', async () => {
    const CHAT_FILE = 'server-facts-empty.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().sendMessage('Tell me something else.', CHAR);

    expect(getRetrievalContext).toHaveBeenCalledTimes(1);
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(
      breakdown?.wi.server?.evictedEntryIds,
      'the backend reported an empty eviction list and it collapsed away — absent and [] must not collapse into one another'
    ).toEqual([]);
    expect(breakdown!.wi.server!.evictedEntryIds).not.toBeUndefined();
  });

  it('a non-empty eviction list survives onto wi.server.evictedEntryIds untouched', async () => {
    // KILLS: deriving eviction as `activatedEntryIds − entries` (dead since
    // E4-S0 — that difference is now always empty by construction, per
    // RetrievalContextDTO's own doc comment) instead of forwarding the
    // backend's own `evictedEntryIds` verbatim. `sf-entry-2` here is an id
    // that never appears in `entries`/`activatedEntryIds` at all — the kind
    // of evicted STICKY CARRY-OVER a derivation from those two arrays could
    // never produce, so a passing test here rules out that whole class.
    const CHAT_FILE = 'server-facts-real-eviction.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: ['sf-entry-2'],
    });

    await useChatStore.getState().sendMessage('Something evicted?', CHAR);

    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown!.wi.server!.evictedEntryIds).toEqual(['sf-entry-2']);
  });
});

// ---------------------------------------------------------------------------
// The ordering requirement, and what it actually catches
// ---------------------------------------------------------------------------

describe('server activation facts — stamped on the object the store holds', () => {
  it('wi.server is populated on generationStore.lastPromptBreakdown, not merely computed', async () => {
    // The two tests above already read exclusively through
    // `useGenerationStore.getState().lastPromptBreakdown` rather than any
    // value a call site returned or a test-local variable captured — that is
    // what makes them fail an implementation that computes the right facts
    // but never wires them onto the object `setLastPromptBreakdown` actually
    // stored (a fresh/disconnected breakdown, or a `recordServerActivation`
    // that returns a new object instead of mutating `out` in place, matching
    // `recordCallSiteTurn`/`recordAttachments`'s established shape). This
    // test restates that as its own assertion so the requirement has a name.
    const CHAT_FILE = 'server-facts-ordering.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().sendMessage('Ordering check.', CHAR);

    const stored = useGenerationStore.getState().lastPromptBreakdown;
    expect(stored, 'the store never received a breakdown for this turn').not.toBeNull();
    expect(
      stored!.wi.server,
      "wi.server is undefined on the object generationStore actually holds — recordServerActivation's write never reached it"
    ).toBeDefined();
    expect(stored!.wi.server!.budgetRequested).toBe(useWorldInfoStore.getState().tokenBudget);
  });
});

// ---------------------------------------------------------------------------
// budgetRequested — captured at request time, never read live later
// (FIX ROUND 1, B4)
//
// The "ordering" test above compares `budgetRequested` against
// `useWorldInfoStore.getState().tokenBudget` read LIVE at assertion time —
// which is also what the whole rest of the test's arrangement never
// changes, so it cannot tell "captured at request time" apart from
// "re-read at stamp time." Both `ServerRetrievalResult.budgetRequested`'s
// and `ServerActivationFacts.budgetRequested`'s own doc comments say the
// value must NOT be read live later — this is the dedicated test for that
// invariant. Mutation-verified: changing serverRetrieval.ts's
// `budgetRequested: tokenBudget` to `budgetRequested:
// useWorldInfoStore.getState().tokenBudget` (the exact staleness the doc
// comment forbids) left the "ordering" test above green.
// ---------------------------------------------------------------------------

describe('server activation facts — budgetRequested is captured at request time, not read live', () => {
  it('a WI budget change mid-flight does not leak into the recorded budgetRequested', async () => {
    const CHAT_FILE = 'server-facts-budget-staleness.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    const SENT_BUDGET = 4096;
    useWorldInfoStore.setState({ tokenBudget: SENT_BUDGET });
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockImplementation(
      async () => {
        // Simulate the user changing the WI budget slider WHILE this
        // request is in flight — the realistic window tryServerRetrieval's
        // own eligibility-recheck comment describes.
        useWorldInfoStore.setState({ tokenBudget: SENT_BUDGET + 777 });
        return {
          entries: [ENTRY_DTO],
          turnNo: 0,
          activatedEntryIds: ['sf-entry-1'],
          evictedEntryIds: [],
        };
      }
    );

    await useChatStore.getState().sendMessage('Budget staleness check.', CHAR);

    expect(getRetrievalContext).toHaveBeenCalledTimes(1);
    // The call itself must have been made with the PRE-mutation budget —
    // the request already left before the store changed.
    expect(getRetrievalContext.mock.calls[0][2]).toBe(SENT_BUDGET);
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(
      breakdown!.wi.server!.budgetRequested,
      'budgetRequested drifted to the LIVE (post-mutation) store value instead of staying pinned to what was actually requested'
    ).toBe(SENT_BUDGET);
    expect(breakdown!.wi.server!.budgetRequested).not.toBe(SENT_BUDGET + 777);
    // Sanity: the store really did change, so a pass here isn't just
    // because nothing moved.
    expect(useWorldInfoStore.getState().tokenBudget).toBe(SENT_BUDGET + 777);
  });
});

// ---------------------------------------------------------------------------
// impersonate / editMessageAndRegenerate (FIX ROUND 1, B2)
//
// Every test above drives `sendMessage` only, even though this file's own
// header names all three solo server-path call sites. Mutation-verified by
// the round-1 review: deleting either site's `if (serverRetrieval) {
// recordServerActivation(...) }` block outright, or stamping onto a fresh
// disconnected `createPromptBreakdown('solo')` instead of the real
// `breakdown`, left the whole suite green. The tests below give both sites
// the identical real-store treatment `sendMessage` gets above, and add the
// ineligible/null-path case (the guard-removal mutation) each site shares
// with `sendMessage`'s own copy under "absent on every client-scanned turn".
// ---------------------------------------------------------------------------

type ServerSite = {
  name: 'impersonate' | 'editMessageAndRegenerate';
  /** Extra store setup this site needs beyond arrangeEligibleChat (a real
   *  message to edit, for editMessageAndRegenerate). */
  arrange: () => void;
  run: () => Promise<void>;
};

const SERVER_SITES: ServerSite[] = [
  {
    name: 'impersonate',
    arrange: () => {
      // impersonate builds from whatever messages already exist; none
      // required beyond arrangeEligibleChat's empty list.
    },
    run: async () => {
      await useChatStore.getState().impersonate(CHAR);
    },
  },
  {
    name: 'editMessageAndRegenerate',
    arrange: () => {
      useChatStore.setState({ messages: [mkMsg('ef1', 'Edit target.')] });
    },
    run: async () => {
      const target = useChatStore.getState().messages[0];
      await useChatStore.getState().editMessageAndRegenerate(target.id, 'Edited content.', CHAR);
    },
  },
];

describe.each(SERVER_SITES)('server activation facts — $name stamps wi.server too', (site) => {
  it('absent evictedEntryIds leaves wi.server.evictedEntryIds undefined', async () => {
    const CHAT_FILE = `server-facts-${site.name}-absent.jsonl`;
    arrangeEligibleChat(CHAT_FILE);
    site.arrange();
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      // evictedEntryIds deliberately absent.
    });

    await site.run();

    expect(
      getRetrievalContext,
      `${site.name} never attempted the server-path read`
    ).toHaveBeenCalledTimes(1);
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown?.wi.server, `${site.name} never stamped wi.server at all`).toBeDefined();
    expect(
      breakdown!.wi.server!.evictedEntryIds,
      'an absent key must surface as undefined, not []'
    ).toBeUndefined();
    expect(breakdown!.wi.server!.activatedEntryIds).toEqual(['sf-entry-1']);
    expect(breakdown!.wi.activationSource).toBe('server');
  });

  it('evictedEntryIds: [] survives onto wi.server.evictedEntryIds as [], not undefined', async () => {
    const CHAT_FILE = `server-facts-${site.name}-empty.jsonl`;
    arrangeEligibleChat(CHAT_FILE);
    site.arrange();
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await site.run();

    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown?.wi.server?.evictedEntryIds).toEqual([]);
    expect(breakdown!.wi.server!.evictedEntryIds).not.toBeUndefined();
  });

  it('a non-empty eviction list survives onto wi.server.evictedEntryIds untouched', async () => {
    const CHAT_FILE = `server-facts-${site.name}-real-eviction.jsonl`;
    arrangeEligibleChat(CHAT_FILE);
    site.arrange();
    stubCommonEdges();
    vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: ['sf-entry-2'],
    });

    await site.run();

    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown!.wi.server!.evictedEntryIds).toEqual(['sf-entry-2']);
  });

  it('a null tryServerRetrieval result (ineligible) leaves wi.server undefined — KILLS dropping the `if (serverRetrieval)` guard', async () => {
    const CHAT_FILE = `server-facts-${site.name}-ineligible.jsonl`;
    arrangeEligibleChat(CHAT_FILE);
    site.arrange();
    const { usePersonaStore } = await import('./personaStore');
    usePersonaStore.setState({
      personas: [
        {
          id: 'p1',
          name: 'Wren',
          description: 'irrelevant',
          descriptionPosition: 'before_char',
          descriptionDepth: 4,
          descriptionRole: 'system',
          linkedBookIds: ['sf-book-1'],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      activePersonaId: 'p1',
    });
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await site.run();

    expect(
      getRetrievalContext,
      `${site.name} called the server-retrieval endpoint on an ineligible chat`
    ).not.toHaveBeenCalled();
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(
      breakdown!.wi.server,
      `wi.server was stamped even though tryServerRetrieval returned null at ${site.name}`
    ).toBeUndefined();
    expect(breakdown!.wi.activationSource).toBe('client');
  });
});

// ---------------------------------------------------------------------------
// Client path — wi.server stays undefined
// ---------------------------------------------------------------------------

describe('server activation facts — absent on every client-scanned turn', () => {
  it('swipeRight never calls the server and never stamps wi.server, even on an eligible chat', async () => {
    // KILLS: a `recordServerActivation` call added unconditionally to a
    // shared helper both two-pass sites reach, rather than gated to the
    // three sites that actually call tryServerRetrieval. Eligibility is
    // deliberately satisfied here (arrangeEligibleChat) so a false pass
    // can't hide behind "this chat could never have qualified anyway."
    const CHAT_FILE = 'server-facts-swipe.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    useChatStore.setState({
      messages: [
        mkMsg('sw1', 'Hi.'),
        mkMsg('sw2', 'Hello.', { isUser: false, name: 'Ivy' }),
      ],
    });
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().swipeRight('sw2', CHAR);

    expect(
      getRetrievalContext,
      'swipeRight called the server-retrieval endpoint — it must never attempt this'
    ).not.toHaveBeenCalled();
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown, 'swipeRight never published a breakdown for this turn').not.toBeNull();
    expect(
      breakdown!.wi.server,
      'wi.server was stamped on a turn that never called the server'
    ).toBeUndefined();
    expect(breakdown!.wi.activationSource).toBe('client');
  });

  it('continueMessage never calls the server and never stamps wi.server', async () => {
    const CHAT_FILE = 'server-facts-continue.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    useChatStore.setState({
      messages: [
        mkMsg('cm1', 'Hi.'),
        mkMsg('cm2', 'Hello', { isUser: false, name: 'Ivy' }),
      ],
    });
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().continueMessage(CHAR);

    expect(
      getRetrievalContext,
      'continueMessage called the server-retrieval endpoint — it must never attempt this'
    ).not.toHaveBeenCalled();
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown!.wi.server).toBeUndefined();
  });

  it('a null tryServerRetrieval result (ineligible / failed call) leaves wi.server undefined at the send site', async () => {
    // KILLS: calling recordServerActivation unconditionally, ignoring
    // tryServerRetrieval's null return — that would fabricate server facts
    // for a turn the client engine actually scanned. Ineligibility is forced
    // here by a persona-linked book (isChatEligibleForServerRetrieval's
    // condition 1, serverRetrieval.ts), the simplest reliable "never even
    // tries the network" trigger.
    const CHAT_FILE = 'server-facts-ineligible.jsonl';
    arrangeEligibleChat(CHAT_FILE);
    const { usePersonaStore } = await import('./personaStore');
    usePersonaStore.setState({
      personas: [
        {
          id: 'p1',
          name: 'Wren',
          description: 'irrelevant',
          descriptionPosition: 'before_char',
          descriptionDepth: 4,
          descriptionRole: 'system',
          linkedBookIds: ['sf-book-1'],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      activePersonaId: 'p1',
    });
    stubCommonEdges();
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().sendMessage('Anyone home?', CHAR);

    expect(
      getRetrievalContext,
      'the ineligible chat still called the server — the eligibility precondition did not hold for this test'
    ).not.toHaveBeenCalled();
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown!.wi.server, 'wi.server was stamped even though tryServerRetrieval returned null').toBeUndefined();
    expect(breakdown!.wi.activationSource).toBe('client');
  });

  it('group never calls the server and never stamps wi.server — buildGroupConversationContext has no code path to', async () => {
    // `utils/serverRetrieval.ts`'s own module header: "Group chat
    // (buildGroupConversationContext) is untouched by design and must never
    // import from this module." Driven through a real store action
    // (forceGroupMemberTalk -> generateGroupTurn) rather than asserted from
    // reading the source, for the same reason every other test in this file
    // drives a real action: a source-level check proves the import is
    // absent, not that the RUNTIME breakdown this file actually reaches
    // stays unstamped.
    resetStores();
    const CHAT_FILE = 'server-facts-group.jsonl';
    const CHAR_B = mkChar({ name: 'Marcus', avatar: 'marcus-server-facts.png' });
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
      books: [
        mkBook('sf-book-1', [
          mkEntry('sf-entry-1', { constant: true, content: 'Server-facts lore.' }),
        ]),
      ],
      activeBookIds: ['sf-book-1'],
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
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      entries: [ENTRY_DTO],
      turnNo: 0,
      activatedEntryIds: ['sf-entry-1'],
      evictedEntryIds: [],
    });

    await useChatStore.getState().forceGroupMemberTalk(CHAR, [CHAR, CHAR_B]);

    expect(
      getRetrievalContext,
      'group called the server-retrieval endpoint — it must never do this'
    ).not.toHaveBeenCalled();
    const breakdown = useGenerationStore.getState().lastPromptBreakdown;
    expect(breakdown, 'group never published a breakdown for this turn').not.toBeNull();
    expect(breakdown!.mode).toBe('group');
    expect(breakdown!.wi.server).toBeUndefined();
    expect(breakdown!.wi.activationSource).toBe('client');
  });
});
