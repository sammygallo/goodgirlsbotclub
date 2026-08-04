import { describe, it, expect } from 'vitest';

import {
  computeBookAttachments,
  filterBooksByScope,
} from './bookAttachments';
import type {
  BookAttachments,
  ComputeBookAttachmentsInput,
} from './bookAttachments';
import type { WorldInfoBook } from '../stores/worldInfoStore';
import type { ChatLoreConfig } from './worldInfoComposition';

// ---------------------------------------------------------------------------
// Fixture helpers — same style/conventions as resolveEffectiveBooks.test.ts /
// worldInfoStore.test.ts's mkBook/mkConfig fixtures.
// ---------------------------------------------------------------------------

let idCounter = 0;

function mkBook(over: Partial<WorldInfoBook> = {}): WorldInfoBook {
  idCounter += 1;
  return {
    id: `b${idCounter}`,
    name: 'Test Book',
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

function mkConfig(over: Partial<ChatLoreConfig> = {}): ChatLoreConfig {
  return {
    chatFile: 'test.jsonl',
    linkedBookIds: [],
    excludedEntryIds: {},
    overlays: {},
    localEntries: [],
    updatedAt: 0,
    ...over,
  };
}

/** Base input with every field present but empty — spread overrides on top. */
function mkInput(
  over: Partial<ComputeBookAttachmentsInput> = {}
): ComputeBookAttachmentsInput {
  return {
    books: [],
    activeBookIds: [],
    linkedBookIdsByAvatar: {},
    personas: [],
    chatConfigs: {},
    legacyChatLinkedBookIds: {},
    ...over,
  };
}

function getEntry(
  result: Map<string, BookAttachments>,
  bookId: string
): BookAttachments {
  const entry = result.get(bookId);
  if (!entry) throw new Error(`expected an entry for book ${bookId}, found none`);
  return entry;
}

// ---------------------------------------------------------------------------

describe('computeBookAttachments — owner attribution', () => {
  it('reports a character-owned book\'s owner avatar as ownerAvatar', () => {
    const book = mkBook({ ownerCharacterAvatar: 'char-a.png' });
    const result = computeBookAttachments(mkInput({ books: [book] }));
    expect(getEntry(result, book.id).ownerAvatar).toBe('char-a.png');
  });

  it('reports ownerAvatar: null for a world book', () => {
    const book = mkBook({ ownerCharacterAvatar: null });
    const result = computeBookAttachments(mkInput({ books: [book] }));
    expect(getEntry(result, book.id).ownerAvatar).toBeNull();
  });
});

describe('computeBookAttachments — character links vs. ownership', () => {
  it('lists a non-owning character that links a book in linkedByCharacterAvatars', () => {
    const book = mkBook({ ownerCharacterAvatar: 'owner.png' });
    const result = computeBookAttachments(
      mkInput({
        books: [book],
        linkedBookIdsByAvatar: { 'linker.png': [book.id] },
      })
    );
    const entry = getEntry(result, book.id);
    expect(entry.linkedByCharacterAvatars).toEqual(['linker.png']);
    // The owner is a separate concern (ownerAvatar) and must not leak into
    // the linked array just by virtue of owning the book.
    expect(entry.linkedByCharacterAvatars).not.toContain('owner.png');
  });

  it('does not duplicate the owner into linkedByCharacterAvatars when the owner also self-links via the character-links map', () => {
    // The real type shape *does* allow this edge case: linkedBookIdsByAvatar
    // is keyed by avatar -> extra book ids with no constraint preventing the
    // owning character's own avatar from appearing there too (e.g. stale/
    // redundant data). computeBookAttachments doesn't special-case ownership
    // when walking that map — it just dedupes by avatar, same as any other
    // entrant — so the owner ends up appearing at most once in the array,
    // exactly like every other character would.
    const book = mkBook({ ownerCharacterAvatar: 'owner.png' });
    const result = computeBookAttachments(
      mkInput({
        books: [book],
        linkedBookIdsByAvatar: {
          'owner.png': [book.id], // owner redundantly self-links
          'linker.png': [book.id],
        },
      })
    );
    const entry = getEntry(result, book.id);
    expect(entry.ownerAvatar).toBe('owner.png');
    // owner.png appears exactly once (not duplicated), alongside linker.png.
    expect(entry.linkedByCharacterAvatars).toEqual(['owner.png', 'linker.png']);
    expect(
      entry.linkedByCharacterAvatars.filter((a) => a === 'owner.png').length
    ).toBe(1);
  });
});

describe('computeBookAttachments — chat references (config vs. legacy map)', () => {
  it('includes a chat that references a book only via a persisted ChatLoreConfig', () => {
    const book = mkBook();
    const cfg = mkConfig({ chatFile: 'chat-a.jsonl', linkedBookIds: [book.id] });
    const result = computeBookAttachments(
      mkInput({
        books: [book],
        chatConfigs: { 'chat-a.jsonl': cfg },
      })
    );
    expect(getEntry(result, book.id).chatFiles).toEqual(['chat-a.jsonl']);
  });

  it('includes a chat that references a book only via the legacy chatLinkedBookIds map (not yet promoted)', () => {
    const book = mkBook();
    const result = computeBookAttachments(
      mkInput({
        books: [book],
        legacyChatLinkedBookIds: { 'chat-b.jsonl': [book.id] },
      })
    );
    expect(getEntry(result, book.id).chatFiles).toEqual(['chat-b.jsonl']);
  });

  it('PRECEDENCE: a persisted config for a chat wins entirely over that chat\'s legacy map entry, even when they point at different books', () => {
    // Simulates stale pre-promotion legacy data: chat-c was promoted (has a
    // real persisted ChatLoreConfig linking book A) but its old legacy
    // chatLinkedBookIds entry — pointing at a *different* book B — was never
    // cleaned up. Per chatLoreConfigStore.ts's getEffectiveConfig, once a
    // persisted config exists for a chatFile, the legacy map is never
    // consulted for that chatFile again. bookAttachments.ts must replicate
    // that exactly: book A should see chat-c, book B must NOT.
    const bookA = mkBook();
    const bookB = mkBook();
    const cfg = mkConfig({ chatFile: 'chat-c.jsonl', linkedBookIds: [bookA.id] });

    const result = computeBookAttachments(
      mkInput({
        books: [bookA, bookB],
        chatConfigs: { 'chat-c.jsonl': cfg },
        legacyChatLinkedBookIds: { 'chat-c.jsonl': [bookB.id] },
      })
    );

    expect(getEntry(result, bookA.id).chatFiles).toContain('chat-c.jsonl');
    expect(getEntry(result, bookB.id).chatFiles).not.toContain('chat-c.jsonl');
    expect(getEntry(result, bookB.id).chatFiles).toEqual([]);
  });
});

describe('computeBookAttachments — globallyActive', () => {
  it('is true iff the book id is in activeBookIds', () => {
    const activeBook = mkBook();
    const inactiveBook = mkBook();
    const result = computeBookAttachments(
      mkInput({
        books: [activeBook, inactiveBook],
        activeBookIds: [activeBook.id],
      })
    );
    expect(getEntry(result, activeBook.id).globallyActive).toBe(true);
    expect(getEntry(result, inactiveBook.id).globallyActive).toBe(false);
  });
});

describe('computeBookAttachments — persona links', () => {
  it('populates linkedByPersonas with the correct {id, name} pair', () => {
    const book = mkBook();
    const result = computeBookAttachments(
      mkInput({
        books: [book],
        personas: [{ id: 'p1', name: 'Persona One', linkedBookIds: [book.id] }],
      })
    );
    expect(getEntry(result, book.id).linkedByPersonas).toEqual([
      { id: 'p1', name: 'Persona One' },
    ]);
  });

  it('produces multiple entries when multiple personas link the same book, without incorrect dedup', () => {
    const book = mkBook();
    const result = computeBookAttachments(
      mkInput({
        books: [book],
        personas: [
          { id: 'p1', name: 'Persona One', linkedBookIds: [book.id] },
          { id: 'p2', name: 'Persona Two', linkedBookIds: [book.id] },
        ],
      })
    );
    expect(getEntry(result, book.id).linkedByPersonas).toEqual([
      { id: 'p1', name: 'Persona One' },
      { id: 'p2', name: 'Persona Two' },
    ]);
  });
});

describe('computeBookAttachments — dangling references', () => {
  it('silently ignores every kind of dangling reference without crashing, and leaves other real books correctly computed', () => {
    const realBook = mkBook();
    const danglingId = 'does-not-exist';

    const cfg = mkConfig({ chatFile: 'chat-dangling.jsonl', linkedBookIds: [danglingId] });

    const input = mkInput({
      books: [realBook],
      activeBookIds: [realBook.id], // keep real book's own attachments verifiable
      chatConfigs: { 'chat-dangling.jsonl': cfg },
      legacyChatLinkedBookIds: { 'chat-legacy-dangling.jsonl': [danglingId] },
      linkedBookIdsByAvatar: { 'char-dangling.png': [danglingId] },
      personas: [{ id: 'p-dangling', name: 'Dangling Persona', linkedBookIds: [danglingId] }],
    });

    expect(() => computeBookAttachments(input)).not.toThrow();

    const result = computeBookAttachments(input);

    // No phantom entry for the dangling id.
    expect(result.has(danglingId)).toBe(false);

    // The real book's own attachments are unaffected by the dangling data.
    const entry = getEntry(result, realBook.id);
    expect(entry.globallyActive).toBe(true);
    expect(entry.chatFiles).toEqual([]);
    expect(entry.linkedByCharacterAvatars).toEqual([]);
    expect(entry.linkedByPersonas).toEqual([]);
  });
});

describe('computeBookAttachments — untouched book', () => {
  it('yields a fully-empty BookAttachments record for a book referenced by nothing', () => {
    const book = mkBook({ ownerCharacterAvatar: 'solo.png' });
    const result = computeBookAttachments(mkInput({ books: [book] }));
    expect(result.has(book.id)).toBe(true);
    expect(getEntry(result, book.id)).toEqual({
      ownerAvatar: 'solo.png',
      linkedByCharacterAvatars: [],
      linkedByPersonas: [],
      chatFiles: [],
      globallyActive: false,
    });
  });
});

describe('filterBooksByScope — character-owned books are no longer hidden (regression proof)', () => {
  it("'all' and 'character' return a character-owned, non-autoExtracted book — proving the old \"hide character-owned books\" filter is gone", () => {
    const book = mkBook({ ownerCharacterAvatar: 'char.png', autoExtracted: false });
    const books = [book];

    expect(filterBooksByScope(books, 'all')).toContain(book);
    expect(filterBooksByScope(books, 'character')).toContain(book);
    expect(filterBooksByScope(books, 'world')).not.toContain(book);
    expect(filterBooksByScope(books, 'auto_memory')).not.toContain(book);
  });

  it("an autoExtracted character-owned book matches 'all', 'character', AND 'auto_memory' simultaneously — deliberate multi-membership, not a bug", () => {
    const book = mkBook({ ownerCharacterAvatar: 'char.png', autoExtracted: true });
    const books = [book];

    expect(filterBooksByScope(books, 'all')).toContain(book);
    expect(filterBooksByScope(books, 'character')).toContain(book);
    expect(filterBooksByScope(books, 'auto_memory')).toContain(book);
    expect(filterBooksByScope(books, 'world')).not.toContain(book);
  });

  it("a plain world book is returned by 'all' and 'world' only", () => {
    const book = mkBook({ ownerCharacterAvatar: null, autoExtracted: false });
    const books = [book];

    expect(filterBooksByScope(books, 'all')).toContain(book);
    expect(filterBooksByScope(books, 'world')).toContain(book);
    expect(filterBooksByScope(books, 'character')).not.toContain(book);
    expect(filterBooksByScope(books, 'auto_memory')).not.toContain(book);
  });
});
