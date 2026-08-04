import { describe, it, expect, vi, beforeEach } from 'vitest';

// Both stores pull serverSettings at module load (and, through their
// circular import, again) — neutralize before importing, per the
// worldInfoStore.test.ts / chatLoreConfigStore.test.ts pattern.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
}));

// chatLoreConfigStore <-> worldInfoStore is a require cycle; import
// chatLoreConfigStore first, matching chatLoreConfigStore.test.ts's order.
const { useChatLoreConfigStore } = await import('./chatLoreConfigStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { resolveEffectiveBooks, hashContent } = await import(
  '../utils/worldInfoComposition'
);

import type { WorldInfoEntry } from './worldInfoStore';
import type { EntryOverlay } from '../utils/worldInfoComposition';

// ---------------------------------------------------------------------------
// This test runtime's global `localStorage` is an inert `{}` (Node's Web
// Storage implementation needs `--localstorage-file` to actually work), so
// every store call would silently no-op behind its own try/catch. Install a
// working in-memory Storage for the duration of this file, fresh before
// every test — mirrors chatLoreConfigStore.test.ts exactly.
// ---------------------------------------------------------------------------

class MemoryStorage {
  private store = new Map<string, string>();
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

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  useChatLoreConfigStore.getState().resetUser();
  useWorldInfoStore.getState().resetUser();
});

const CHAT_FILE = 'fork-flow.jsonl';

// Fixed timestamps for overlay fixtures — never Date.now() inside a test
// body, matching chatLoreConfigStore.test.ts's mkOverlay convention (fixed
// dummy numbers for caller-supplied fields; only store-internal `updatedAt`
// stamps produced by mutateConfig are checked against a real Date.now()
// window, and this file never asserts on those).
const FORK_TS = 1000;
const REVISE_TS = 2000;

/**
 * Simplified equivalent of chatStore.ts's buildConversationContext union
 * (wiState.activeBookIds ∪ character-embedded/linked book ids ∪
 * persona-linked book ids) for this test's single-book/single-character
 * scenario: there are no character- or persona-linked books to fold in, so
 * the union degenerates to just the globally-active ids.
 */
function computeInheritedBookIds(): string[] {
  const wiState = useWorldInfoStore.getState();
  const charBookIds: string[] = [];
  const personaBookIds: string[] = [];
  return Array.from(
    new Set([...wiState.activeBookIds, ...charBookIds, ...personaBookIds])
  );
}

function getLibraryEntry(bookId: string, entryId: string): WorldInfoEntry {
  const book = useWorldInfoStore.getState().books.find((b) => b.id === bookId);
  const entry = book?.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error('entry not found in store state');
  return entry;
}

/**
 * Step 1: a real book + real entry (with initial content and keys) plus an
 * unrelated second book, both made globally active via activeBookIds.
 */
function createLibrary() {
  const wi = useWorldInfoStore.getState();
  const book = wi.createBook('Main Lorebook');
  const entry = wi.createEntry(book.id, {
    content: 'original content',
    keys: ['dragon'],
  })!;
  const unrelatedBook = wi.createBook('Unrelated Lorebook');
  useWorldInfoStore.getState().createEntry(unrelatedBook.id, {
    content: 'unrelated content',
    keys: ['owl'],
  });
  useWorldInfoStore.getState().setBookActive(book.id, true);
  useWorldInfoStore.getState().setBookActive(unrelatedBook.id, true);
  return { book, entry, unrelatedBook };
}

/** Steps 1-4: library + fork + a base edit, reaching the "drift" state that
 * the rebase/keep-mine sub-cases both branch from. */
function setupForkedAndEdited() {
  const { book, entry, unrelatedBook } = createLibrary();
  const originalContent = entry.content;

  useChatLoreConfigStore.getState().upsertOverlay(CHAT_FILE, {
    baseEntryId: entry.id,
    baseBookId: book.id,
    patch: { content: 'forked content' },
    baseContentHash: hashContent(originalContent),
    createdBy: 'test-user',
    createdAt: FORK_TS,
    updatedAt: FORK_TS,
  });

  useWorldInfoStore
    .getState()
    .updateEntry(book.id, entry.id, { content: 'updated base content' });

  return { book, entry, unrelatedBook, originalContent };
}

// ---------------------------------------------------------------------------
// Main coherent flow: steps 1-4.
// ---------------------------------------------------------------------------

describe('lorebook v2 fork — real store integration flow', () => {
  it('creates a real book/entry, resolves v1-identity, forks it, and detects base drift', () => {
    const { book, entry, unrelatedBook } = createLibrary();
    const originalContent = entry.content;

    // --- Step 2: resolve with NO chatConfig yet ---
    let inheritedIds = computeInheritedBookIds();
    let books = useWorldInfoStore.getState().books;
    let result = resolveEffectiveBooks(books, inheritedIds);

    const baseBookEffective = result.effectiveBooks.find((b) => b.id === book.id)!;
    const baseEntryEffective = baseBookEffective.entries.find((e) => e.id === entry.id)!;
    expect(baseEntryEffective.content).toBe(originalContent);
    // v1 identity fast path: exact same references passed straight through.
    expect(result.effectiveBooks).toBe(books);
    expect(result.effectiveActiveIds).toBe(inheritedIds);
    expect(result.provenance.size).toBe(0);

    // --- Step 3: fork the entry via an overlay ---
    const booksBeforeOverlay = useWorldInfoStore.getState().books;
    const unrelatedBeforeOverlay = booksBeforeOverlay.find((b) => b.id === unrelatedBook.id)!;

    useChatLoreConfigStore.getState().upsertOverlay(CHAT_FILE, {
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: { content: 'forked content' },
      baseContentHash: hashContent(originalContent),
      createdBy: 'test-user',
      createdAt: FORK_TS,
      updatedAt: FORK_TS,
    });

    const effectiveConfig = useChatLoreConfigStore.getState().getEffectiveConfig(CHAT_FILE);
    expect(effectiveConfig).toBeDefined();

    books = useWorldInfoStore.getState().books;
    inheritedIds = computeInheritedBookIds();
    result = resolveEffectiveBooks(books, inheritedIds, effectiveConfig);

    const forkedBook = result.effectiveBooks.find((b) => b.id === book.id)!;
    const forkedEntry = forkedBook.entries.find((e) => e.id === entry.id)!;
    expect(forkedEntry.content).toBe('forked content');
    expect(forkedEntry.id).toBe(entry.id);
    expect(result.provenance.get(entry.id)).toBe('overridden');

    // The base library entry (and the whole books array) must be completely
    // untouched by the overlay — upsertOverlay only ever writes to
    // useChatLoreConfigStore, never to useWorldInfoStore.
    expect(useWorldInfoStore.getState().books).toBe(booksBeforeOverlay);
    expect(useWorldInfoStore.getState().books).toEqual(booksBeforeOverlay);
    const untouchedEntry = getLibraryEntry(book.id, entry.id);
    expect(untouchedEntry.content).toBe(originalContent);

    // An unrelated active book, untouched by any overlay/exclusion, passes
    // through effectiveBooks by reference — the documented copy-discipline.
    const unrelatedEffective = result.effectiveBooks.find((b) => b.id === unrelatedBook.id)!;
    expect(unrelatedEffective).toBe(unrelatedBeforeOverlay);

    // --- Step 4: base edit — drift becomes detectable ---
    useWorldInfoStore
      .getState()
      .updateEntry(book.id, entry.id, { content: 'updated base content' });
    const updatedEntry = getLibraryEntry(book.id, entry.id);
    expect(updatedEntry.content).toBe('updated base content');

    const overlayAfterEdit = useChatLoreConfigStore
      .getState()
      .getConfig(CHAT_FILE)!.overlays[entry.id];
    const newHash = hashContent(updatedEntry.content);
    expect(newHash).not.toBe(overlayAfterEdit.baseContentHash);
    // Sanity: the stored hash is still the fork-time hash of the original.
    expect(overlayAfterEdit.baseContentHash).toBe(hashContent(originalContent));
  });
});

// ---------------------------------------------------------------------------
// Step 5: rebase simulation.
// ---------------------------------------------------------------------------

describe('rebase simulation (step 5)', () => {
  it('stops shadowing content once content is trimmed from the patch, exposing the current base content', () => {
    const { book, entry } = setupForkedAndEdited();
    const oldOverlay: EntryOverlay = useChatLoreConfigStore
      .getState()
      .getConfig(CHAT_FILE)!.overlays[entry.id];
    const currentBaseEntry = getLibraryEntry(book.id, entry.id);
    expect(currentBaseEntry.content).toBe('updated base content');

    const trimmedPatch: Partial<WorldInfoEntry> = { ...oldOverlay.patch };
    delete trimmedPatch.content;

    useChatLoreConfigStore.getState().upsertOverlay(CHAT_FILE, {
      ...oldOverlay,
      patch: trimmedPatch,
      baseContentHash: hashContent(currentBaseEntry.content),
      updatedAt: REVISE_TS,
    });

    const effectiveConfig = useChatLoreConfigStore.getState().getEffectiveConfig(CHAT_FILE);
    const inheritedIds = computeInheritedBookIds();
    const result = resolveEffectiveBooks(
      useWorldInfoStore.getState().books,
      inheritedIds,
      effectiveConfig
    );
    const effectiveEntry = result.effectiveBooks
      .find((b) => b.id === book.id)!
      .entries.find((e) => e.id === entry.id)!;

    expect(effectiveEntry.content).toBe(currentBaseEntry.content);
    expect(effectiveEntry.content).toBe('updated base content');
  });
});

// ---------------------------------------------------------------------------
// Step 6: "keep mine" simulation.
// ---------------------------------------------------------------------------

describe('keep mine simulation (step 6)', () => {
  it('keeps the content override after refreshing baseContentHash, and drift is resolved', () => {
    const { book, entry } = setupForkedAndEdited();
    const oldOverlay: EntryOverlay = useChatLoreConfigStore
      .getState()
      .getConfig(CHAT_FILE)!.overlays[entry.id];
    const currentBaseEntry = getLibraryEntry(book.id, entry.id);

    useChatLoreConfigStore.getState().upsertOverlay(CHAT_FILE, {
      ...oldOverlay,
      // Same content-overriding patch as before...
      patch: { ...oldOverlay.patch },
      // ...but the fingerprint is refreshed to match the current base.
      baseContentHash: hashContent(currentBaseEntry.content),
      updatedAt: REVISE_TS,
    });

    const effectiveConfig = useChatLoreConfigStore.getState().getEffectiveConfig(CHAT_FILE);
    const inheritedIds = computeInheritedBookIds();
    const result = resolveEffectiveBooks(
      useWorldInfoStore.getState().books,
      inheritedIds,
      effectiveConfig
    );
    const effectiveEntry = result.effectiveBooks
      .find((b) => b.id === book.id)!
      .entries.find((e) => e.id === entry.id)!;

    // The override persists...
    expect(effectiveEntry.content).toBe('forked content');

    // ...and the drift signal is now clear: hashing current base content
    // matches the overlay's refreshed baseContentHash.
    const refreshedOverlay = useChatLoreConfigStore
      .getState()
      .getConfig(CHAT_FILE)!.overlays[entry.id];
    expect(hashContent(currentBaseEntry.content)).toBe(refreshedOverlay.baseContentHash);
  });
});

// ---------------------------------------------------------------------------
// Step 7: revision cap + restore-appends-not-rewinds, on the REAL library
// entry (not an overlay).
// ---------------------------------------------------------------------------

describe('entry revision cap + restore append (step 7)', () => {
  it('never exceeds the 10-revision cap, and a "restore" appends a new edit rather than rewinding history', () => {
    const book = useWorldInfoStore.getState().createBook('Revision Book');
    const entry = useWorldInfoStore.getState().createEntry(book.id, {
      content: 'v0',
      keys: [],
    })!;

    const getEntry = () => getLibraryEntry(book.id, entry.id);

    // The initial 'create' revision.
    expect(getEntry().revisions.length).toBe(1);
    expect(getEntry().revisions[0].action).toBe('create');

    for (let i = 1; i <= 11; i++) {
      useWorldInfoStore.getState().updateEntry(book.id, entry.id, { content: `v${i}` });
      expect(getEntry().revisions.length).toBeLessThanOrEqual(10);
    }

    const revisionsBeforeRestore = getEntry().revisions;
    expect(revisionsBeforeRestore.length).toBe(10);
    const contentBeforeRestore = getEntry().content;
    expect(contentBeforeRestore).toBe('v11');
    const restoreTarget = revisionsBeforeRestore[0].prevContent;

    // "Restore" = a normal updateEntry call setting content back to an old
    // revision's prevContent — nothing here is special-cased by the store.
    useWorldInfoStore.getState().updateEntry(book.id, entry.id, { content: restoreTarget });

    const afterRestore = getEntry();
    expect(afterRestore.content).toBe(restoreTarget);
    // Cap still holds.
    expect(afterRestore.revisions.length).toBe(10);

    // Appended, not rewound: the 9 oldest surviving revisions keep their
    // original relative order (just shifted down by the cap dropping the
    // very oldest), and the new record lands at the end.
    expect(afterRestore.revisions.slice(0, 9)).toEqual(revisionsBeforeRestore.slice(1));
    const lastRevision = afterRestore.revisions[9];
    expect(lastRevision.action).toBe('edit');
    expect(lastRevision.prevContent).toBe(contentBeforeRestore);
  });
});

// ---------------------------------------------------------------------------
// Step 8: exclusion + fork interaction.
// ---------------------------------------------------------------------------

describe('exclusion + fork interaction (step 8)', () => {
  it('hides a forked entry when excluded without destroying the overlay, and un-excluding brings the fork back', () => {
    const { book, entry } = createLibrary();
    const originalContent = entry.content;

    useChatLoreConfigStore.getState().upsertOverlay(CHAT_FILE, {
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: { content: 'forked content' },
      baseContentHash: hashContent(originalContent),
      createdBy: 'test-user',
      createdAt: FORK_TS,
      updatedAt: FORK_TS,
    });

    const inheritedIds = computeInheritedBookIds();
    const books = useWorldInfoStore.getState().books;

    // Exclude the forked entry for this chat.
    useChatLoreConfigStore.getState().setEntryExcluded(CHAT_FILE, book.id, entry.id, true);
    let effectiveConfig = useChatLoreConfigStore.getState().getEffectiveConfig(CHAT_FILE);
    let result = resolveEffectiveBooks(books, inheritedIds, effectiveConfig);
    let mainBookEffective = result.effectiveBooks.find((b) => b.id === book.id)!;

    expect(mainBookEffective.entries.find((e) => e.id === entry.id)).toBeUndefined();
    expect(result.provenance.get(entry.id)).toBe('excluded');

    // The fork itself survives exclusion — hidden, not destroyed.
    expect(
      useChatLoreConfigStore.getState().getConfig(CHAT_FILE)!.overlays[entry.id]
    ).toBeDefined();

    // Re-include: the forked content reappears.
    useChatLoreConfigStore.getState().setEntryExcluded(CHAT_FILE, book.id, entry.id, false);
    effectiveConfig = useChatLoreConfigStore.getState().getEffectiveConfig(CHAT_FILE);
    result = resolveEffectiveBooks(books, inheritedIds, effectiveConfig);
    mainBookEffective = result.effectiveBooks.find((b) => b.id === book.id)!;
    const reincluded = mainBookEffective.entries.find((e) => e.id === entry.id);

    expect(reincluded).toBeDefined();
    expect(reincluded!.content).toBe('forked content');
  });
});
