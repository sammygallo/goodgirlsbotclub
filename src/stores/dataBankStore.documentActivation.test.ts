import { describe, it, expect, vi, beforeEach } from 'vitest';

// E4-S0 / #450 F1+F2 — a document has to be ACTIVE to do anything, and an
// inactive world book is worse than inert: it trips
// isChatEligibleForServerRetrieval's "every world book must be active"
// precondition and turns server-side retrieval off for every solo chat on the
// account. So these tests drive the real stores end to end (addDocument ->
// worldInfoStore -> eligibility) rather than asserting on activeBookIds alone.

// This vitest project runs with `environment: 'node'`, where the global
// `localStorage` exists as an inert object with no working methods — see the
// same note in serverRetrieval.test.ts. Stub a real in-memory one before
// anything below is imported.
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

vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  showToastGlobal: vi.fn(),
}));

// worldInfoStore's mutators fire native /lorebooks calls in the background —
// mock the CRUD surface so nothing depends on a real fetch(), per
// worldInfoStore.test.ts's importOriginal pattern.
const createLorebook = vi.fn();
const createLorebookEntry = vi.fn();
const deleteLorebook = vi.fn();
const importFromDatabank = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      createLorebook: (...args: unknown[]) => createLorebook(...args),
      createLorebookEntry: (...args: unknown[]) => createLorebookEntry(...args),
      deleteLorebook: (...args: unknown[]) => deleteLorebook(...args),
      importFromDatabank: (...args: unknown[]) => importFromDatabank(...args),
    },
  };
});

const { useDataBankStore, backfillDocumentBookActivation } = await import('./dataBankStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { useCharacterStore } = await import('./characterStore');
const { useChatLoreConfigStore } = await import('./chatLoreConfigStore');
const { usePersonaStore } = await import('./personaStore');
const { isChatEligibleForServerRetrieval } = await import('../utils/serverRetrieval');

import type { WorldInfoBook } from './worldInfoStore';

const AVATAR = 'seraphina.png';
const OTHER_AVATAR = 'marcus.png';
const CHAT_FILE = 'baseline-chat.jsonl';

/** The clean state under which isChatEligibleForServerRetrieval is true. */
function resetEligibleState() {
  useWorldInfoStore.setState({
    books: [],
    sharedBooks: [],
    activeBookIds: [],
    chatLinkedBookIds: {},
    sharedBooksStatus: 'loaded',
  });
  useCharacterStore.setState({ linkedBookIdsByAvatar: {}, characters: [] });
  useChatLoreConfigStore.setState({ configs: {} });
  usePersonaStore.setState({
    personas: [],
    activePersonaId: null,
    locks: { byChat: {}, byCharacter: {} },
  } as never);
  useDataBankStore.getState().resetUser();
}

beforeEach(() => {
  memoryStorage.clear();
  createLorebook.mockReset();
  createLorebook.mockImplementation(async (payload: Record<string, unknown>) => ({
    ownerHandle: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...payload,
    server_ts: 1,
  }));
  createLorebookEntry.mockReset();
  createLorebookEntry.mockImplementation(
    async (bookId: string, payload: Record<string, unknown>) => ({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...payload,
      lorebook_id: bookId,
      server_ts: 1,
    })
  );
  deleteLorebook.mockReset();
  deleteLorebook.mockResolvedValue(undefined);
  importFromDatabank.mockReset();
  importFromDatabank.mockResolvedValue({ imported: [] });
  resetEligibleState();
});

function bookById(id: string): WorldInfoBook | undefined {
  return useWorldInfoStore.getState().books.find((b) => b.id === id);
}

describe('addDocument — activation', () => {
  it('activates a global document so it is actually scannable', () => {
    const id = useDataBankStore.getState().addDocument('Field Notes', 'some text', 'global');
    expect(bookById(id)!.scope).toBe('world');
    expect(useWorldInfoStore.getState().activeBookIds).toContain(id);
  });

  it('leaves server retrieval switched on for the whole account', () => {
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
    useDataBankStore.getState().addDocument('Field Notes', 'some text', 'global');
    // The regression this pins: an inactive world book made EVERY solo chat
    // ineligible, demoting all of the user's other lore to the keyword scan.
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
    expect(isChatEligibleForServerRetrieval(OTHER_AVATAR, CHAT_FILE)).toBe(true);
  });

  it('keeps a character-scoped document out of activeBookIds and linkedBookIdsByAvatar', () => {
    const id = useDataBankStore
      .getState()
      .addDocument('Ivy Dossier', 'some text', 'character', AVATAR);
    expect(bookById(id)!.scope).toBe('character');
    // Both registries would disqualify chats if the document landed in them:
    // activeBookIds via condition 5 (foreign character-scoped book),
    // linkedBookIdsByAvatar via condition 2 (any manual link at all).
    expect(useWorldInfoStore.getState().activeBookIds).not.toContain(id);
    expect(useCharacterStore.getState().linkedBookIdsByAvatar).toEqual({});
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
    expect(isChatEligibleForServerRetrieval(OTHER_AVATAR, CHAT_FILE)).toBe(true);
  });

  it('still puts a character-scoped document in that character\'s scan scope', () => {
    const id = useDataBankStore
      .getState()
      .addDocument('Ivy Dossier', 'some text', 'character', AVATAR);
    // getActiveBookIdsForCharacter is the only path that reaches an owned
    // book, and it used to union the embedded book alone.
    expect(
      useCharacterStore.getState().getActiveBookIdsForCharacter(AVATAR)
    ).toContain(id);
    expect(
      useCharacterStore.getState().getActiveBookIdsForCharacter(OTHER_AVATAR)
    ).not.toContain(id);
  });
});

describe('backfillDocumentBookActivation', () => {
  /** Seeds a document book directly into both stores WITHOUT activating it —
   *  the state every account created before this fix is in. */
  function seedInactiveDocument(over: Partial<WorldInfoBook> = {}): WorldInfoBook {
    const book: WorldInfoBook = {
      id: `doc-${Math.random().toString(36).slice(2)}`,
      name: 'Legacy Doc',
      entries: [],
      ownerCharacterAvatar: null,
      scope: 'world',
      ownerHandle: '',
      visibility: 'private',
      createdAt: 0,
      updatedAt: 0,
      ...over,
    };
    useWorldInfoStore.setState({ books: [...useWorldInfoStore.getState().books, book] });
    useDataBankStore.setState({
      lorebookIds: [...useDataBankStore.getState().lorebookIds, book.id],
    });
    return book;
  }

  it('activates a global document that was created before the fix', () => {
    const doc = seedInactiveDocument();
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(false);

    backfillDocumentBookActivation();

    expect(useWorldInfoStore.getState().activeBookIds).toContain(doc.id);
    expect(isChatEligibleForServerRetrieval(AVATAR, CHAT_FILE)).toBe(true);
  });

  it('never activates a character-scoped document', () => {
    const doc = seedInactiveDocument({
      scope: 'character',
      ownerCharacterAvatar: AVATAR,
    });

    backfillDocumentBookActivation();

    expect(useWorldInfoStore.getState().activeBookIds).not.toContain(doc.id);
  });

  it('runs at most once, so a deliberate deactivation afterwards sticks', () => {
    const doc = seedInactiveDocument();
    backfillDocumentBookActivation();
    expect(useWorldInfoStore.getState().activeBookIds).toContain(doc.id);

    useWorldInfoStore.getState().setBookActive(doc.id, false);
    backfillDocumentBookActivation();

    expect(useWorldInfoStore.getState().activeBookIds).not.toContain(doc.id);
  });

  it('does not arm its once-guard before both stores have loaded', () => {
    // Registry populated, book list still empty (fetchPrefs order is not
    // guaranteed) — the pass must be a no-op that still runs later.
    useDataBankStore.setState({ lorebookIds: ['not-loaded-yet'] });
    backfillDocumentBookActivation();

    const doc = seedInactiveDocument();
    backfillDocumentBookActivation();
    expect(useWorldInfoStore.getState().activeBookIds).toContain(doc.id);
  });
});
