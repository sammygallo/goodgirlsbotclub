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
// Pure module — no store imports of its own, so a static import here cannot
// disturb the mock ordering the dynamic imports above exist for.
import { detectDocumentBookOrphans } from '../utils/documentBookOrphans';

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
  function mkBook(over: Partial<WorldInfoBook> = {}): WorldInfoBook {
    return {
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
  }

  /** Puts a book into worldInfoStore's list without touching the registry —
   *  an ordinary world book, or a document that has landed in `books` after
   *  its id was already registered. */
  function landBook(book: WorldInfoBook): WorldInfoBook {
    useWorldInfoStore.setState({
      books: [...useWorldInfoStore.getState().books, book],
    });
    return book;
  }

  /** Registers a document id without the book itself having arrived — the
   *  shape of a document created on another device. */
  function registerDocumentId(id: string): void {
    const ids = useDataBankStore.getState().lorebookIds;
    if (ids.includes(id)) return;
    useDataBankStore.setState({ lorebookIds: [...ids, id] });
  }

  /** Seeds a document book into both stores WITHOUT activating it — the
   *  state every account created before this fix is in. Book first,
   *  registry second: landing a book now re-runs the repair (that is the
   *  cold-cache retry), so registering the id first would activate it before
   *  the test has said `backfillDocumentBookActivation()` out loud. */
  function seedInactiveDocument(over: Partial<WorldInfoBook> = {}): WorldInfoBook {
    const book = landBook(mkBook(over));
    registerDocumentId(book.id);
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

  it('leaves a deliberate deactivation alone for the rest of the session', () => {
    const doc = seedInactiveDocument();
    backfillDocumentBookActivation();
    expect(useWorldInfoStore.getState().activeBookIds).toContain(doc.id);

    // The user's own control — the library row's checkbox — which is what
    // records the opt-out. setBookActive (the repair's own call) does not.
    useWorldInfoStore.getState().toggleBookActive(doc.id);
    backfillDocumentBookActivation();

    expect(useWorldInfoStore.getState().activeBookIds).not.toContain(doc.id);
  });

  // The property the old version of this test claimed and never checked: it
  // called the function twice inside ONE module instance, where a
  // module-level `let` trivially holds. The guard resets on every page load,
  // so only a reload proves anything.
  it('leaves a deliberate deactivation alone across a page load', async () => {
    const doc = seedInactiveDocument();
    backfillDocumentBookActivation();
    expect(useWorldInfoStore.getState().activeBookIds).toContain(doc.id);

    useWorldInfoStore.getState().toggleBookActive(doc.id);
    expect(useWorldInfoStore.getState().activeBookIds).not.toContain(doc.id);

    // A page load: brand-new module instances (every module-level flag back
    // to its initial value), same localStorage. Only something PERSISTED can
    // survive this — which is the point of the opt-out record.
    vi.resetModules();
    const freshDataBank = await import('./dataBankStore');
    const freshWorldInfo = await import('./worldInfoStore');
    freshWorldInfo.useWorldInfoStore.getState().initForUser('');
    expect(freshDataBank.useDataBankStore.getState().lorebookIds).toContain(doc.id);

    freshDataBank.backfillDocumentBookActivation();

    expect(
      freshWorldInfo.useWorldInfoStore.getState().activeBookIds
    ).not.toContain(doc.id);
  });

  it('still repairs the OTHER documents when one has been opted out of', () => {
    const optedOut = seedInactiveDocument({ name: 'Noisy Doc' });
    backfillDocumentBookActivation();
    useWorldInfoStore.getState().toggleBookActive(optedOut.id);

    const fresh = seedInactiveDocument({ name: 'Field Notes' });
    backfillDocumentBookActivation();

    expect(useWorldInfoStore.getState().activeBookIds).toContain(fresh.id);
    expect(useWorldInfoStore.getState().activeBookIds).not.toContain(optedOut.id);
  });

  it('does not arm its once-guard while a registered document is unresolvable', () => {
    // The race the old test was named for and never ran. worldInfoStore
    // hydrates `books` synchronously from a localStorage cache, so the list
    // is NON-empty long before the server view lands — and a cache written
    // before this document was added on another device does not contain it.
    // "Some books are loaded" is not "this book is loaded".
    landBook(mkBook({ id: 'stale-world-book', name: 'Cached World Book' }));
    registerDocumentId('doc-from-other-device');
    backfillDocumentBookActivation();

    // worldInfoStore's fetch now lands the document.
    landBook(mkBook({ id: 'doc-from-other-device' }));
    backfillDocumentBookActivation();

    expect(useWorldInfoStore.getState().activeBookIds).toContain(
      'doc-from-other-device'
    );
  });

  it('repairs on a cold cache, once the book list arrives on its own', () => {
    // The login ordering finding #7 describes: dataBankStore.fetchPrefs wins
    // the race, so the repair's only reachable call site runs against
    // books=[]. Nothing calls it again — so the retry has to come from the
    // book list itself landing, with no second call from any caller.
    registerDocumentId('doc-cold');
    backfillDocumentBookActivation();
    expect(useWorldInfoStore.getState().activeBookIds).toEqual([]);

    landBook(mkBook({ id: 'doc-cold' }));

    expect(useWorldInfoStore.getState().activeBookIds).toContain('doc-cold');
  });

  it('never records an opt-out for a book that is not a document', () => {
    const world = landBook(mkBook({ id: 'plain-world-book' }));
    useWorldInfoStore.getState().setBookActive(world.id, true);
    useWorldInfoStore.getState().toggleBookActive(world.id);
    expect(useDataBankStore.getState().deactivatedDocumentIds).toEqual([]);
  });

  it('clears the opt-out when the user switches the document back on', () => {
    const doc = seedInactiveDocument();
    backfillDocumentBookActivation();
    useWorldInfoStore.getState().toggleBookActive(doc.id);
    expect(useDataBankStore.getState().deactivatedDocumentIds).toEqual([doc.id]);

    useWorldInfoStore.getState().toggleBookActive(doc.id);
    expect(useDataBankStore.getState().deactivatedDocumentIds).toEqual([]);
  });
});

// E4-S0 / #450 F3. The document/embedded-book distinction has to survive
// the user editing the document, because the app's own copy tells them to:
// "Add keywords to a chunk in the lorebook editor if it has to fire
// everywhere." A content heuristic cannot survive that; identity can.
describe('document identity vs. the card lorebook', () => {
  const CARD_JSON = JSON.stringify({
    name: 'From Card',
    entries: [{ keys: ['ivy'], content: 'card lore', enabled: true }],
  });

  it('protects a character-scoped document that has an ordinary entry added', () => {
    const docId = useDataBankStore
      .getState()
      .addDocument('Ivy Dossier', 'chunk one text', 'character', AVATAR);
    // Exactly what AddDocumentModal's copy advises.
    useWorldInfoStore.getState().createEntry(docId, {
      keys: ['rain'],
      content: 'Ivy hates rain',
    });
    expect(bookById(docId)!.entries.some((e) => !e.semanticOnly)).toBe(true);

    const imported = useWorldInfoStore
      .getState()
      .importBookJson(CARD_JSON, 'From Card', AVATAR);

    expect(imported!.id).not.toBe(docId);
    expect(bookById(docId)).toBeDefined();
    expect(bookById(docId)!.entries.length).toBe(2);
    expect(deleteLorebook).not.toHaveBeenCalledWith(docId);
  });

  it('protects the same document from a character-card re-import', () => {
    const docId = useDataBankStore
      .getState()
      .addDocument('Ivy Dossier', 'chunk one text', 'character', AVATAR);
    useWorldInfoStore.getState().createEntry(docId, {
      keys: ['rain'],
      content: 'Ivy hates rain',
    });

    const upserted = useWorldInfoStore.getState().upsertCharacterBook(
      AVATAR,
      { name: 'From Card', entries: [{ keys: ['ivy'], content: 'card lore' }] } as never,
      'From Card'
    );

    expect(upserted.id).not.toBe(docId);
    expect(bookById(docId)!.entries.length).toBe(2);
    expect(bookById(docId)!.name).toBe('Ivy Dossier');
  });
});

// E4-S0 — a delete has to take the registry record with it. `lorebookIds` is
// persisted AND synced, so a record left behind outlives the book on every
// device the account touches: the registry only grows, and every leftover
// reads as an orphaned document to detectDocumentBookOrphans — which would
// turn the orphan report into a list of things the user deleted on purpose,
// i.e. a report nobody reads.
describe('deleting a book prunes the document registry', () => {
  const DOC_STORAGE_KEY = 'stm:data-bank-index';

  function addGlobalDocument(name: string): string {
    return useDataBankStore.getState().addDocument(name, 'some text', 'global');
  }

  function registry(): string[] {
    return useDataBankStore.getState().lorebookIds;
  }

  /** The persisted half — what a page load on this device would restore. */
  function persistedIndex(): { lorebookIds: string[]; deactivatedDocumentIds: string[] } {
    return JSON.parse(memoryStorage.getItem(DOC_STORAGE_KEY) ?? '{}');
  }

  /** Let the fire-and-forget DELETE (and its rejection handler) settle. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it('drops the deleted document and leaves the others registered', () => {
    const kept = addGlobalDocument('Field Notes');
    const doomed = addGlobalDocument('Old Draft');
    expect(registry()).toEqual([kept, doomed]);

    useWorldInfoStore.getState().deleteBook(doomed);

    expect(registry()).toEqual([kept]);
  });

  it('writes the prune through to the persisted index', () => {
    // Pins the prune to saveIndex + the snapshot helper rather than a bare
    // setState: state-only would leave the cache (and the synced section it
    // shares a write with) still holding the deleted id, so the record would
    // come back on the next page load — and the opt-out slice, written in
    // the same snapshot, must survive the trip untouched.
    const kept = addGlobalDocument('Field Notes');
    const doomed = addGlobalDocument('Old Draft');
    useWorldInfoStore.getState().toggleBookActive(kept);
    expect(persistedIndex().deactivatedDocumentIds).toEqual([kept]);

    useWorldInfoStore.getState().deleteBook(doomed);

    expect(persistedIndex().lorebookIds).toEqual([kept]);
    expect(persistedIndex().deactivatedDocumentIds).toEqual([kept]);
  });

  it("forgets the deleted document's own opt-out", () => {
    // An opt-out is an answer to "should the repair activate this?", and
    // there is nothing left to activate — keeping it is the same unbounded
    // leak one field over.
    const doc = addGlobalDocument('Noisy Doc');
    useWorldInfoStore.getState().toggleBookActive(doc);
    expect(useDataBankStore.getState().deactivatedDocumentIds).toEqual([doc]);

    useWorldInfoStore.getState().deleteBook(doc);

    expect(useDataBankStore.getState().deactivatedDocumentIds).toEqual([]);
  });

  it('prunes every document a character deletion takes at once', () => {
    const dossier = useDataBankStore
      .getState()
      .addDocument('Ivy Dossier', 'chunk one', 'character', AVATAR);
    const notes = useDataBankStore
      .getState()
      .addDocument('Ivy Notes', 'chunk two', 'character', AVATAR);
    const global = addGlobalDocument('Field Notes');
    const otherChar = useDataBankStore
      .getState()
      .addDocument('Marcus Dossier', 'chunk three', 'character', OTHER_AVATAR);
    expect(registry()).toEqual([dossier, notes, global, otherChar]);

    useWorldInfoStore.getState().deleteCharacterBooks(AVATAR);

    // Both of the deleted character's documents, and only those.
    expect(registry()).toEqual([global, otherChar]);
  });

  it('leaves an ordinary lorebook delete alone', () => {
    const doc = addGlobalDocument('Field Notes');
    const plain = useWorldInfoStore.getState().createBook('Hand-written Book');

    useWorldInfoStore.getState().deleteBook(plain.id);

    expect(registry()).toEqual([doc]);
  });

  it('puts the record back when the server delete fails', async () => {
    // deleteBook is optimistic-local-then-confirm-server and rolls the local
    // removal back on an error, so the registry has to roll back with it —
    // otherwise a failed delete leaves the book alive and its document
    // identity gone, which is the state that lets a character-scoped
    // document be overwritten by the card's embedded lorebook.
    const doc = addGlobalDocument('Field Notes');
    useWorldInfoStore.getState().toggleBookActive(doc);
    deleteLorebook.mockRejectedValueOnce(new Error('offline'));

    useWorldInfoStore.getState().deleteBook(doc);
    expect(registry()).toEqual([]);
    await flush();

    expect(useWorldInfoStore.getState().books.map((b) => b.id)).toContain(doc);
    expect(registry()).toEqual([doc]);
    expect(useDataBankStore.getState().deactivatedDocumentIds).toEqual([doc]);
    expect(persistedIndex().lorebookIds).toEqual([doc]);
    expect(useWorldInfoStore.getState().error).toBeTruthy();
  });

  it('keeps a document added while the failed delete was in flight', async () => {
    // The undo is id-scoped against current state, not a saved copy of the
    // whole array — same rule worldInfoStore's own rollback follows, and for
    // the same reason: a wholesale restore would erase this one.
    const doomed = addGlobalDocument('Old Draft');
    deleteLorebook.mockRejectedValueOnce(new Error('offline'));
    useWorldInfoStore.getState().deleteBook(doomed);

    const added = addGlobalDocument('Added Mid-flight');
    await flush();

    expect(registry()).toContain(added);
    expect(registry()).toContain(doomed);
    expect(registry()).toHaveLength(2);
  });

  it('no longer reports a deleted document as an orphan', () => {
    // The whole point of the prune. Without it every document the user has
    // ever deleted shows up in the AC4 report as an unresolved registration,
    // forever, on every device — so the report's ordinary content becomes
    // things the user meant to delete, and the one real finding in it is
    // indistinguishable from the noise.
    const doc = addGlobalDocument('Old Draft');
    useWorldInfoStore.getState().deleteBook(doc);

    const orphans = detectDocumentBookOrphans({
      documentIds: registry(),
      books: useWorldInfoStore.getState().books,
      characterAvatars: [AVATAR],
      // Both fetches settled: the report is at its most talkative here, so
      // silence is the detector's verdict rather than a readiness gate's.
      booksSettled: true,
      charactersSettled: true,
    });

    expect(orphans).toEqual([]);
  });

  it('still reports a genuinely unresolved registration', () => {
    // The other half of the pair above: the prune must quiet the deletions
    // WITHOUT quieting the sense itself. A document registered on another
    // device that this account's fetch has not seen is still reported.
    const doc = addGlobalDocument('Field Notes');
    useWorldInfoStore.getState().deleteBook(doc);
    useDataBankStore.setState({ lorebookIds: [...registry(), 'doc-elsewhere'] });

    const orphans = detectDocumentBookOrphans({
      documentIds: registry(),
      books: useWorldInfoStore.getState().books,
      characterAvatars: [AVATAR],
      booksSettled: true,
      charactersSettled: true,
    });

    expect(orphans.map((o) => o.bookId)).toEqual(['doc-elsewhere']);
  });
});
