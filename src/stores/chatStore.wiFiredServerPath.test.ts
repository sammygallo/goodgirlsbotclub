/**
 * E2-S5 AC3 — a server-path firing IS recorded under the local entry id.
 *
 * captureWiFired's local-resolvability filter (chatStore.ts) used to exist
 * because the client's local ids and the backend's ids were genuinely
 * disjoint schemes before the native-CRUD cutover (77e689d2, 2026-08-07).
 * That stopped being true the day of the cutover — but the two EXISTING
 * tests the pre-E2-S5 comment cited (serverRetrieval.test.ts's
 * 'srv-entry-1', worldInfoStore.test.ts's 'native-entry-1') use DIFFERENT
 * fixtures and neither proves the two ids come from the SAME backend row.
 * If the backend ever emitted a synthetic id from POST /retrieval/context
 * while GET /lorebooks/{id} kept the primary key, both of those would stay
 * green while this filter silently resumed dropping every server-path
 * firing.
 *
 * This file pins the CLIENT half of that contract: ONE fixture id
 * ('srv-entry-1'/'srv-book-1') seeds BOTH halves — the local store's
 * native-bootstrapped entry (as a real GET /lorebooks fetch would populate
 * it) AND the mocked POST /retrieval/context response `dtoToMatchedEntry`
 * normalizes — then drives a REAL sendMessage() turn (api stubbed at the
 * network edge only, same house style as chatStore.callSites.test.ts) and
 * asserts the firing survives all the way into getWiFiredForChat. What
 * this file does NOT close: a genuine BACKEND id divergence (the server
 * actually returning two different ids for one row) is invisible here by
 * construction — the mock below supplies both ids itself, so they agree
 * unconditionally. Closing THAT needs a ggbc-backend contract test
 * asserting POST /retrieval/context entries[].id equals the
 * lorebook_entries primary key GET /lorebooks/{id} returns — filed as
 * ggbc-backend#83, not covered by this file.
 *
 * The local entry is deliberately given a non-matching key and
 * `constant: false`, so it CANNOT fire via the local keyword scanner on
 * its own — the only way it ends up recorded is the server path actually
 * running. Combined with asserting `getRetrievalContext` was called, this
 * is what keeps the test from passing for the wrong reason (a silent
 * eligibility failure falling back to local scan, e.g. a leftover
 * `constant: true` default, would read as a false pass otherwise).
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

const { useChatStore, getWiFiredForChat } = await import('./chatStore');
const { useCharacterStore } = await import('./characterStore');
const { useChatLoreConfigStore } = await import('./chatLoreConfigStore');
const { usePersonaStore } = await import('./personaStore');
const { useWorldInfoStore, remapLegacyBookId } = await import('./worldInfoStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { api } = await import('../api/client');
const { wiFiredKey } = await import('../utils/wiFired');
const { mkBook, mkEntry, mkChar, resetStores } = await import('./promptGoldens.fixtures');

/** One SSE content frame — same shape chatStore.callSites.test.ts uses to
 *  reach code past `if (!stream) return` (captureWiFired sits there). */
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

beforeEach(() => {
  (globalThis.localStorage as unknown as MemoryStorage).clear();
  vi.restoreAllMocks();
});

describe('server-path firing survives captureWiFired (AC3)', () => {
  const CHAT_FILE = 'server-path-canary.jsonl';
  const CHAR = mkChar({ name: 'Ivy', avatar: 'ivy-server-path.png' });

  it('records a POST /retrieval/context match under the SAME id the local store resolves it by', async () => {
    resetStores();
    // isChatEligibleForServerRetrieval's preconditions (serverRetrieval.ts):
    // sharedBooksStatus loaded, one world book, toggled active, no
    // persona/character/chat-level customization — resetStores() already
    // supplies the last three empty.
    useWorldInfoStore.setState({
      books: [
        mkBook('srv-book-1', [
          mkEntry('srv-entry-1', {
            // Deliberately non-matching + non-constant: the LOCAL scanner
            // must never activate this entry on its own. See file header.
            constant: false,
            keys: ['keyword-the-local-scanner-will-never-see'],
            content: 'A line only the server-path match should surface.',
          }),
        ]),
      ],
      activeBookIds: ['srv-book-1'],
      sharedBooksStatus: 'loaded',
    });
    useCharacterStore.setState({ selectedCharacter: CHAR });
    useChatHistoryRagStore.setState({ enabled: true });
    useChatStore.setState({
      messages: [],
      currentChatFile: CHAT_FILE,
      isSending: false,
      isStreaming: false,
      error: null,
      abortController: null,
    });

    const save = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [], reason: null });
    const generate = vi.spyOn(api, 'generateMessage').mockResolvedValue(sseOnce('A reply.'));
    vi.spyOn(api, 'importLorebooksFromBlob').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
    vi.spyOn(api, 'importFromDatabank').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
    const getRetrievalContext = vi.spyOn(api, 'getRetrievalContext').mockResolvedValue({
      // SAME id as the local bootstrap above — the "same row" this test
      // exists to pin. id / lorebook_id are the only fields whose absence
      // makes dtoToMatchedEntry return NULL (serverRetrieval.ts); every
      // other field it reads has some safe fallback, so this sparse
      // fixture is valid. Deliberately NOT restating which fields are
      // allowlisted vs coerced vs cast — that partition has now been
      // written wrongly three times in this story's review rounds (it is
      // at least six mechanisms across ~30 fields, including strArr(), a
      // bare typeof-ternary to null for scanDepth, and an UNVALIDATED
      // cast for revisions). Read dtoToMatchedEntry for the per-field
      // contract; do not trust a summary of it here. What matters is only
      // that those fallbacks happen to be the values this test wants
      // (enabled: true, position: 'before_char'), not that the fields go
      // unread.
      // server_ts is here only because RetrievalContextEntryDTO's TYPE
      // requires it (tsc -b, which — unlike plain vitest — typechecks this
      // file, catches its absence).
      entries: [
        {
          id: 'srv-entry-1',
          lorebook_id: 'srv-book-1',
          server_ts: 1,
          content: 'A line only the server-path match should surface.',
          comment: '',
          enabled: true,
        },
      ],
      turnNo: 0,
      activatedEntryIds: ['srv-entry-1'],
    });
    const commitRetrievalContext = vi.spyOn(api, 'commitRetrievalContext').mockResolvedValue(undefined);

    await useChatStore.getState().sendMessage('Tell me a story about the archive.', CHAR);

    // Proves the SERVER path actually ran — without this, an eligibility
    // mistake would silently fall back to the (here, deliberately inert)
    // local scanner and the assertion below would fail for the right
    // reason instead of passing for the wrong one.
    expect(getRetrievalContext, 'the server-path read never happened — eligibility must have failed').toHaveBeenCalledTimes(
      1
    );
    expect(generate, 'the turn never dispatched a generation').toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().error, 'the turn errored before reaching captureWiFired').toBeNull();

    const fired = getWiFiredForChat(CHAT_FILE);
    expect(fired, 'no WI fired-state was recorded for this turn').toBeDefined();
    expect(
      fired?.[wiFiredKey('srv-book-1', 'srv-entry-1')],
      'the server-matched entry was not recorded under the local store\'s own id for that row'
    ).toMatchObject({ count: 1 });

    // Confirmed-successful generation is also commitServerRetrieval's own
    // gate (serverRetrieval.ts) — a real turn reaches it.
    expect(commitRetrievalContext).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalled();
  });
});

// Legacy-shaped ids for the AC4 fixture below — a fix-round finding (E2-S5)
// caught an earlier version of this block never driving a real
// fetchPrefs/buildLegacyIdRemap, so getWiFiredForChat's remapped view and
// wiFiredByFile's raw view were byte-identical and the persistence
// assertion could not distinguish buildChatPayload reading the wrong one.
// Same literal shape as wiFired.test.ts's own LEGACY_BOOK/LEGACY_ENTRY.
const LEGACY_BOOK = 'wibook_1777000000000_aaaaaa';
const LEGACY_ENTRY = 'wi_1777000000001_bbbbbb';

// DTO shapes for the mocked native-fetch responses fetchPrefs's
// buildLegacyIdRemap leg consumes — same fixture shape as
// chatStore.wiFiredLegacyRemap.test.ts's own mkEntryDto/mkBookDto, kept
// local to this file since each wi_fired suite owns its own api mocks.
function mkEntryDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dto-entry',
    lorebook_id: 'dto-book',
    server_ts: 1,
    keys: [],
    content: '',
    comment: '',
    enabled: true,
    constant: false,
    caseSensitive: false,
    position: 'before_char',
    depth: 4,
    order: 100,
    keysSecondary: [],
    selective: false,
    selectiveLogic: 'AND_ANY',
    scanDepth: null,
    probability: 100,
    useProbability: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    preventRecursion: false,
    excludeRecursion: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    critical: false,
    category: '',
    relatedIds: [],
    source: 'manual',
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function mkBookDto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dto-book',
    ownerHandle: 'alice',
    server_ts: 1,
    name: 'DTO Book',
    ownerCharacterAvatar: null,
    autoExtracted: false,
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/**
 * Drives a real worldInfoStore.fetchPrefs() so remapLegacyBookId(LEGACY_BOOK)
 * resolves for real — same harness shape (and the same 'Shared Lore' /
 * comment:'c' / content:'text' / keys:['a'] signature fixture) as
 * chatStore.wiFiredLegacyRemap.test.ts's own seedMigratedBook(), duplicated
 * per that file's "each suite owns its own api mocks" convention.
 */
async function seedMigratedBook(): Promise<void> {
  useWorldInfoStore.setState({
    books: [
      mkBook(LEGACY_BOOK, [mkEntry(LEGACY_ENTRY, { comment: 'c', content: 'text', keys: ['a'] })], {
        name: 'Shared Lore',
      }),
    ],
  });
  vi.spyOn(api, 'listLorebooks').mockResolvedValue([mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' })] as never);
  vi.spyOn(api, 'getLorebook').mockResolvedValue({
    ...mkBookDto({ id: 'uuid-book-1', name: 'Shared Lore' }),
    entries: [
      mkEntryDto({ id: 'uuid-entry-1', lorebook_id: 'uuid-book-1', comment: 'c', content: 'text', keys: ['a'] }),
    ],
  } as never);
  vi.spyOn(api, 'listSharedWorldInfoBooks').mockResolvedValue([] as never);
  vi.spyOn(api, 'importLorebooksFromBlob').mockResolvedValue({ imported: [], skipped: [], entry_count: 0 } as never);

  await useWorldInfoStore.getState().fetchPrefs();
  expect(remapLegacyBookId(LEGACY_BOOK)).toBe('uuid-book-1');
}

describe('buildChatPayload persistence is unaffected by the read-time remap (AC4)', () => {
  const CHAT_FILE = 'persist-unaffected.jsonl';
  const CHAR = mkChar({ name: 'Ivy', avatar: 'ivy-persist.png' });
  const LEGACY_KEY = wiFiredKey(LEGACY_BOOK, LEGACY_ENTRY);

  it('saves the RAW (un-remapped) wi_fired map — getWiFiredForChat\'s remap is read-time only', async () => {
    resetStores();
    useWorldInfoStore.getState().resetUser();

    // Drive a REAL fetchPrefs first, so the two views this test compares
    // actually differ. Without this, getWiFiredForChat's remapped view and
    // wiFiredByFile's raw view are byte-identical and the assertion below
    // cannot tell buildChatPayload apart from a mutation that reads the
    // wrong one (see the header comment history on this block).
    await seedMigratedBook();

    // loadChat hydrates wiFiredByFile straight from a synthetic header —
    // lighter than driving a full generation just to seed a pre-existing
    // legacy key.
    vi.spyOn(api, 'getChatWithHeader').mockResolvedValue({
      header: { wi_fired: { [LEGACY_KEY]: { first_turn: 0, last_turn: 2, count: 4 } } },
      messages: [],
      server_ts: 1,
    });
    await useChatStore.getState().loadChat(CHAR.avatar, CHAT_FILE);

    // getWiFiredForChat's read-time view now genuinely DIFFERS from
    // wiFiredByFile's raw one — the remap is live, so this is the state in
    // which the two views could actually be mistaken for each other.
    expect(getWiFiredForChat(CHAT_FILE)).toEqual({
      [wiFiredKey('uuid-book-1', 'uuid-entry-1')]: { first_turn: 0, last_turn: 2, count: 4 },
    });

    useCharacterStore.setState({ selectedCharacter: CHAR });
    useChatLoreConfigStore.setState({ configs: {} });
    usePersonaStore.setState({ personas: [], activePersonaId: null, locks: { byCharacter: {}, byChat: {} } });
    useChatHistoryRagStore.setState({ enabled: false });

    const save = vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 2 });
    vi.spyOn(api, 'getRetrievalMessages').mockResolvedValue({ chunks: [], reason: null });
    vi.spyOn(api, 'generateMessage').mockResolvedValue(null); // no stream needed — only the pre-generation save matters here

    await useChatStore.getState().sendMessage('hello', CHAR);

    expect(save, 'sendMessage never saved the chat').toHaveBeenCalled();
    // chatData is saveChat's 3rd positional arg; chatData[0] is the header
    // buildChatPayload assembles from wiFiredByFile directly (chatStore.ts)
    // — NOT from getWiFiredForChat's remapped view. See that read site's
    // own comment for why that must stay true (AC4).
    const [, , chatData] = save.mock.calls[0] as [string, string, Array<Record<string, unknown>>];
    const persistedFired = chatData[0].wi_fired as Record<string, unknown> | undefined;
    expect(
      persistedFired?.[LEGACY_KEY],
      'the persisted header must still carry the RAW legacy key — captureWiFired/buildChatPayload must not change what gets persisted (AC4)'
    ).toEqual({ first_turn: 0, last_turn: 2, count: 4 });
    expect(
      persistedFired?.[wiFiredKey('uuid-book-1', 'uuid-entry-1')],
      'the persisted header must NOT carry the remapped native key — that would be the exact silent migration AC4 forbids'
    ).toBeUndefined();
  });
});
