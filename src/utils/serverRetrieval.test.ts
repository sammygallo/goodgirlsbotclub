import { describe, it, expect, vi, beforeEach } from 'vitest';

// This vitest project runs with `environment: 'node'`, where the global
// `localStorage` (Node's own, gated behind a CLI flag this repo's test
// script doesn't pass — see the `--localstorage-file` warning it prints
// otherwise) exists as an inert object with no working methods. The several
// stores this module pulls in (worldInfoStore's loadWiTimers/saveWiTimers
// especially) guard every access in try/catch and degrade to a silent
// no-op against a broken localStorage — safe for the app, but useless for
// a test that needs to deterministically seed/read persisted state. Stub
// in a real in-memory implementation before anything below is imported.
const memoryStorage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
})();
vi.stubGlobal('localStorage', memoryStorage);

// serverRetrieval.ts (through worldInfoStore/personaStore/characterStore/
// chatLoreConfigStore) pulls serverSettings at module load — neutralize
// before importing, per worldInfoStore.test.ts's pattern.
vi.mock('./serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

// Only the four retrieval/import wire calls need to be deterministic here.
// Everything else in api/client stays real, per worldInfoStore.test.ts's
// importOriginal pattern.
const importLorebooksFromBlob = vi.fn();
const importWiTimers = vi.fn();
const getRetrievalContext = vi.fn();
const commitRetrievalContext = vi.fn();

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      importLorebooksFromBlob: (...args: unknown[]) => importLorebooksFromBlob(...args),
      importWiTimers: (...args: unknown[]) => importWiTimers(...args),
      getRetrievalContext: (...args: unknown[]) => getRetrievalContext(...args),
      commitRetrievalContext: (...args: unknown[]) => commitRetrievalContext(...args),
    },
  };
});

const {
  isChatEligibleForServerRetrieval,
  tryServerRetrieval,
  commitServerRetrieval,
} = await import('./serverRetrieval');
const { useWorldInfoStore, saveWiTimers } = await import('../stores/worldInfoStore');
const { useCharacterStore } = await import('../stores/characterStore');
const { useChatLoreConfigStore } = await import('../stores/chatLoreConfigStore');
const { usePersonaStore } = await import('../stores/personaStore');

import type { WorldInfoBook } from '../stores/worldInfoStore';

const AVATAR = 'seraphina.png';
const CHAT_FILE = 'baseline-chat.jsonl';

let idCounter = 0;
function mkBook(over: Partial<WorldInfoBook> = {}): WorldInfoBook {
  idCounter += 1;
  return {
    id: `book${idCounter}`,
    name: `Book ${idCounter}`,
    entries: [],
    ownerCharacterAvatar: null,
    scope: 'world',
    ownerHandle: '',
    visibility: 'private',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** A clean, minimal state under which isChatEligibleForServerRetrieval is
 *  true — every eligibility test starts here and violates exactly one
 *  condition. */
function resetEligibleState() {
  useWorldInfoStore.setState({
    books: [],
    sharedBooks: [],
    activeBookIds: [],
    chatLinkedBookIds: {},
    sharedBooksStatus: 'loaded',
    scanDepth: 4,
    maxRecursionSteps: 2,
    tokenBudget: 512,
  });
  useCharacterStore.setState({ linkedBookIdsByAvatar: {}, characters: [] });
  useChatLoreConfigStore.setState({ configs: {} });
  usePersonaStore.setState({
    personas: [],
    activePersonaId: null,
    locks: { byChat: {}, byCharacter: {} },
  } as never);
}

beforeEach(() => {
  memoryStorage.clear();
  importLorebooksFromBlob.mockReset();
  importWiTimers.mockReset();
  getRetrievalContext.mockReset();
  commitRetrievalContext.mockReset();
  resetEligibleState();
});

describe('isChatEligibleForServerRetrieval', () => {
  it('is true for a chat with no lore customization at all', () => {
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
  });

  it('is false without a character avatar or chat file', () => {
    expect(isChatEligibleForServerRetrieval(undefined, CHAT_FILE)).toBe(false);
    expect(isChatEligibleForServerRetrieval(AVATAR, null)).toBe(false);
    expect(isChatEligibleForServerRetrieval(AVATAR, undefined)).toBe(false);
  });

  it('is false while shared books have not finished loading', () => {
    useWorldInfoStore.setState({ sharedBooksStatus: 'idle' });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);

    useWorldInfoStore.setState({ sharedBooksStatus: 'loading' });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);

    useWorldInfoStore.setState({ sharedBooksStatus: 'error' });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);
  });

  it('is false when the active persona links any books', () => {
    usePersonaStore.setState({
      personas: [
        {
          id: 'p1',
          name: 'Ash',
          description: 'A wandering smith.',
          linkedBookIds: ['book-x'],
        },
      ],
      activePersonaId: 'p1',
    } as never);
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);
  });

  it('is false when the character has a manually-linked book', () => {
    useCharacterStore.setState({ linkedBookIdsByAvatar: { [AVATAR]: ['book-x'] } });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);
  });

  it.each([
    ['linkedBookIds', { linkedBookIds: ['book-x'], excludedEntryIds: {}, overlays: {}, localEntries: [] }],
    ['excludedEntryIds', { linkedBookIds: [], excludedEntryIds: { b1: ['e1'] }, overlays: {}, localEntries: [] }],
    ['overlays', { linkedBookIds: [], excludedEntryIds: {}, overlays: { e1: {} }, localEntries: [] }],
    ['localEntries', { linkedBookIds: [], excludedEntryIds: {}, overlays: {}, localEntries: [{ id: 'e1' }] }],
  ])('is false when the chat has v2 %s customization', (_label, patch) => {
    useChatLoreConfigStore.setState({
      configs: {
        [CHAT_FILE]: {
          chatFile: CHAT_FILE,
          updatedAt: 0,
          ...(patch as object),
        },
      },
    } as never);
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);
  });

  it('is false when a world book exists but is not toggled active', () => {
    const worldBook = mkBook({ scope: 'world' });
    useWorldInfoStore.setState({ books: [worldBook], activeBookIds: [] });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);
  });

  it('is true when every world book is toggled active', () => {
    const worldBook = mkBook({ scope: 'world' });
    useWorldInfoStore.setState({ books: [worldBook], activeBookIds: [worldBook.id] });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
  });

  it("is false when activeBookIds contains another character's book", () => {
    const otherBook = mkBook({ scope: 'character', ownerCharacterAvatar: 'marcus.png' });
    useWorldInfoStore.setState({ books: [otherBook], activeBookIds: [otherBook.id] });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);
  });

  it("is true when activeBookIds contains this same character's own book", () => {
    const ownBook = mkBook({ scope: 'character', ownerCharacterAvatar: AVATAR });
    useWorldInfoStore.setState({ books: [ownBook], activeBookIds: [ownBook.id] });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
  });

  it('is false when an active world book was sourced from a group peer (wiState.sharedBooks), not the caller\'s own books', () => {
    // GET /worldinfo/shared can surface a peer's book via a blob-fallback
    // path the server's POST /retrieval/context scope query has no
    // equivalent for (see the doc comment on condition 4b) — the client
    // can't tell whether this specific peer has migrated, so any active
    // shared-origin book must make the chat ineligible.
    const sharedBook = mkBook({ scope: 'world' });
    useWorldInfoStore.setState({ books: [], sharedBooks: [sharedBook], activeBookIds: [sharedBook.id] });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);
  });

  it('is true when an active book id collides between own and shared books — getComposableBooks resolves the collision in favor of the own book', () => {
    const ownBook = mkBook({ scope: 'world' });
    const collidingSharedBook = mkBook({ scope: 'world' });
    collidingSharedBook.id = ownBook.id;
    useWorldInfoStore.setState({
      books: [ownBook],
      sharedBooks: [collidingSharedBook],
      activeBookIds: [ownBook.id],
    });
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
  });
});

describe('tryServerRetrieval — eligibility gate', () => {
  it('resolves to null without any network call when ineligible', async () => {
    useWorldInfoStore.setState({ sharedBooksStatus: 'idle' });
    const result = await tryServerRetrieval(AVATAR, CHAT_FILE);
    expect(result).toBeNull();
    expect(importLorebooksFromBlob).not.toHaveBeenCalled();
    expect(importWiTimers).not.toHaveBeenCalled();
    expect(getRetrievalContext).not.toHaveBeenCalled();
  });
});

// These tests share serverRetrieval.ts's module-level, session-scoped
// success guards (contentImportSucceeded / timerImportSucceededChats),
// which are never reset once set to true — so ORDER MATTERS: the
// content-import-failure case must run before any test that lets content
// import succeed, and every test below uses its own chat file so the
// per-chat timer-import guard never collides across tests.
describe('tryServerRetrieval — network path', () => {
  it('resolves to null when the content import fails, and never attempts the timer import or read', async () => {
    importLorebooksFromBlob.mockRejectedValue(new Error('network down'));
    const result = await tryServerRetrieval(AVATAR, 'chat-content-fail.jsonl');
    expect(result).toBeNull();
    expect(importWiTimers).not.toHaveBeenCalled();
    expect(getRetrievalContext).not.toHaveBeenCalled();
  });

  it('resolves to null when the timer import fails, after content import succeeds', async () => {
    importLorebooksFromBlob.mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
    const chatFile = 'chat-timer-fail.jsonl';
    saveWiTimers(chatFile, new Set(['e1']), 1); // seed local timers so the import is attempted
    importWiTimers.mockRejectedValue(new Error('network down'));
    const result = await tryServerRetrieval(AVATAR, chatFile);
    expect(result).toBeNull();
    expect(getRetrievalContext).not.toHaveBeenCalled();
  });

  it('resolves to null when the retrieval read itself fails', async () => {
    getRetrievalContext.mockRejectedValue(new Error('network down'));
    const result = await tryServerRetrieval(AVATAR, 'chat-read-fail.jsonl');
    expect(result).toBeNull();
  });

  it('resolves to null on a malformed response shape', async () => {
    getRetrievalContext.mockResolvedValue({ entries: 'not-an-array', turnNo: 1, activatedEntryIds: [] });
    const result = await tryServerRetrieval(AVATAR, 'chat-malformed.jsonl');
    expect(result).toBeNull();
  });

  it('normalizes a successful response into MatchedEntry[], defaulting invalid enum fields and dropping entries without an id', async () => {
    getRetrievalContext.mockResolvedValue({
      entries: [
        {
          id: 'srv-entry-1',
          lorebook_id: 'srv-book-1',
          keys: ['k'],
          content: 'c',
          comment: '',
          enabled: true,
          position: 'not-a-real-position',
          selectiveLogic: 'not-a-real-logic',
          source: 'not-a-real-source',
        },
        { id: '', lorebook_id: 'srv-book-1' }, // missing id -> dropped
        { id: 'srv-entry-2' }, // missing lorebook_id -> dropped
      ],
      turnNo: 7,
      activatedEntryIds: ['srv-entry-1', 42], // non-string filtered out
    });

    const result = await tryServerRetrieval(AVATAR, 'chat-success.jsonl');

    expect(result).not.toBeNull();
    expect(result!.turnNo).toBe(7);
    expect(result!.activatedEntryIds).toEqual(['srv-entry-1']);
    expect(result!.matchedEntries).toHaveLength(1);
    const [matched] = result!.matchedEntries;
    expect(matched.entry.id).toBe('srv-entry-1');
    expect(matched.bookId).toBe('srv-book-1');
    // Every unrecognized enum value falls back to its documented default
    // rather than propagating a value buildConversationContext's
    // wiByPosition indexing can't handle.
    expect(matched.entry.position).toBe('before_char');
    expect(matched.entry.selectiveLogic).toBe('AND_ANY');
    expect(matched.entry.source).toBe('manual');
  });

  it('re-checks eligibility right before the read and bails without reading if a world book was toggled off mid-flight', async () => {
    const worldBook = mkBook({ scope: 'world' });
    useWorldInfoStore.setState({ books: [worldBook], activeBookIds: [worldBook.id] });
    const chatFile = 'chat-toggle-midflight.jsonl';
    // Force a real timer-import network call (an empty local timer blob
    // short-circuits without one) so there's an awaited leg whose
    // implementation can simulate the user's toggle happening mid-flight.
    saveWiTimers(chatFile, new Set(['e1']), 1);
    importLorebooksFromBlob.mockResolvedValue({ imported: [], skipped: [], entry_count: 0 });
    importWiTimers.mockImplementation(async () => {
      // Simulate the user toggling the world book off client-side while
      // this import call is in flight.
      useWorldInfoStore.setState({ activeBookIds: [] });
      return undefined;
    });

    const result = await tryServerRetrieval(AVATAR, chatFile);

    expect(result).toBeNull();
    expect(getRetrievalContext).not.toHaveBeenCalled();
  });
});

describe('commitServerRetrieval', () => {
  it('never throws even when the underlying commit call rejects', () => {
    commitRetrievalContext.mockRejectedValue(new Error('network down'));
    expect(() => commitServerRetrieval(AVATAR, 'chat-commit-fail.jsonl', 1, ['e1'])).not.toThrow();
  });
});
