import { describe, it, expect } from 'vitest';

import {
  resolveEffectiveBooks,
  chatLocalBookId,
  CHAT_LOCAL_BOOK_NAME,
} from './worldInfoComposition';
import type { ChatLoreConfig, EntryOverlay } from './worldInfoComposition';

import { DEFAULT_ENTRY, scanMessagesForEntries } from '../stores/worldInfoStore';
import type {
  WorldInfoBook,
  WorldInfoEntry,
  WorldInfoScanOptions,
} from '../stores/worldInfoStore';

// ---------------------------------------------------------------------------
// Fixture helpers — same style/conventions as
// src/stores/chatStore.groupWorldInfo.test.ts and worldInfoStore.test.ts,
// extended with the book fields (scope/ownerHandle/visibility) and entry
// fields (source/revisions) those files' fixtures leave to the interface's
// structural laxity but that the v2 composition layer actually reads/writes.
// ---------------------------------------------------------------------------

let idCounter = 0;

function mkEntry(over: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  idCounter += 1;
  return {
    ...DEFAULT_ENTRY,
    id: `e${idCounter}`,
    content: 'lore content',
    keys: [],
    keysSecondary: [],
    relatedIds: [],
    source: 'manual',
    revisions: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function mkBook(
  entries: WorldInfoEntry[],
  over: Partial<WorldInfoBook> = {}
): WorldInfoBook {
  idCounter += 1;
  return {
    id: `b${idCounter}`,
    name: 'Test Book',
    entries,
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

function mkOverlay(over: Partial<EntryOverlay> = {}): EntryOverlay {
  return {
    baseEntryId: 'unset',
    baseBookId: 'unset',
    patch: {},
    baseContentHash: '',
    createdBy: 'tester',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function opts(over: Partial<WorldInfoScanOptions> = {}): WorldInfoScanOptions {
  return {
    scanDepth: 4,
    maxRecursionSteps: 2,
    tokenBudget: 0,
    profile: 'generic',
    ...over,
  };
}

const msgs = (...contents: string[]) => contents.map((content) => ({ content }));

// ---------------------------------------------------------------------------

describe('resolveEffectiveBooks — v1 identity', () => {
  it('returns the exact same references when no chatConfig is passed', () => {
    const entry = mkEntry({ keys: ['dragon'] });
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];

    const result = resolveEffectiveBooks(books, activeIds);

    expect(result.effectiveBooks).toBe(books);
    expect(result.effectiveActiveIds).toBe(activeIds);
    expect(result.provenance.size).toBe(0);
  });
});

describe('resolveEffectiveBooks — vacuous config', () => {
  it('returns the exact same references for a config that adds nothing meaningful', () => {
    const entry = mkEntry({ keys: ['dragon'] });
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];
    const chatConfig = mkConfig({});

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    expect(result.effectiveBooks).toBe(books);
    expect(result.effectiveActiveIds).toBe(activeIds);
    expect(result.provenance.size).toBe(0);
  });
});

describe('resolveEffectiveBooks — linked-only fast path', () => {
  it('appends linked book ids after the original active ids, without a synthetic book', () => {
    const entry = mkEntry({ keys: ['dragon'] });
    const book = mkBook([entry]);
    const linkedBook = mkBook([mkEntry()]);
    const books = [book, linkedBook];
    const activeIds = [book.id];
    const chatConfig = mkConfig({ linkedBookIds: [linkedBook.id] });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    expect(result.effectiveBooks).toBe(books);
    expect(result.effectiveActiveIds).toEqual([book.id, linkedBook.id]);
    // The original ids all still precede the newly-linked one.
    const bookIdx = result.effectiveActiveIds.indexOf(book.id);
    const linkedIdx = result.effectiveActiveIds.indexOf(linkedBook.id);
    expect(bookIdx).toBeLessThan(linkedIdx);
    expect(
      result.effectiveBooks.some((b) => b.name === CHAT_LOCAL_BOOK_NAME)
    ).toBe(false);
  });
});

describe('resolveEffectiveBooks — book-level exclusion', () => {
  it('excludes every entry of a book while keeping the book itself present', () => {
    const e1 = mkEntry({ keys: ['a'] });
    const e2 = mkEntry({ keys: ['b'] });
    const e3 = mkEntry({ keys: ['c'] });
    const book = mkBook([e1, e2, e3]);
    const books = [book];
    const activeIds = [book.id];
    const chatConfig = mkConfig({
      excludedEntryIds: { [book.id]: [e1.id, e2.id, e3.id] },
    });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const effectiveBook = result.effectiveBooks.find((b) => b.id === book.id);
    expect(effectiveBook).toBeDefined();
    expect(effectiveBook!.entries).toEqual([]);
    for (const e of [e1, e2, e3]) {
      expect(result.provenance.get(e.id)).toBe('excluded');
    }
  });
});

describe('resolveEffectiveBooks — entry-level exclusion', () => {
  it('drops only the excluded entry, keeps the rest tagged inherited, and leaves untouched books alone', () => {
    const e1 = mkEntry({ keys: ['a'] });
    const e2 = mkEntry({ keys: ['b'] });
    const e3 = mkEntry({ keys: ['c'] });
    const book = mkBook([e1, e2, e3]);
    const untouched = mkBook([mkEntry()]);
    const books = [book, untouched];
    const activeIds = [book.id, untouched.id];
    const chatConfig = mkConfig({
      excludedEntryIds: { [book.id]: [e2.id] },
    });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const effectiveBook = result.effectiveBooks.find((b) => b.id === book.id)!;
    expect(effectiveBook.entries.map((e) => e.id)).toEqual([e1.id, e3.id]);
    expect(result.provenance.get(e1.id)).toBe('inherited');
    expect(result.provenance.get(e3.id)).toBe('inherited');
    expect(result.provenance.get(e2.id)).toBe('excluded');

    const effectiveUntouched = result.effectiveBooks.find(
      (b) => b.id === untouched.id
    );
    expect(effectiveUntouched).toBe(untouched);
  });
});

describe('resolveEffectiveBooks — overlay basics', () => {
  it('applies the patch content but forces id/createdAt back to the base entry', () => {
    const entry = mkEntry({
      keys: ['a'],
      content: 'original',
      createdAt: 111,
    });
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];
    const overlay = mkOverlay({
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: {
        content: 'overridden',
        // Mischievous fields — must be ignored/forced back.
        id: 'not-the-real-id',
        createdAt: 999999,
      },
    });
    const chatConfig = mkConfig({ overlays: { [entry.id]: overlay } });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const effectiveBook = result.effectiveBooks.find((b) => b.id === book.id)!;
    const effectiveEntry = effectiveBook.entries.find((e) => e.id === entry.id)!;

    expect(effectiveEntry.content).toBe('overridden');
    expect(effectiveEntry.keys).toEqual(['a']);
    expect(effectiveEntry.id).toBe(entry.id);
    expect(effectiveEntry.createdAt).toBe(entry.createdAt);
    expect(result.provenance.get(entry.id)).toBe('overridden');
  });
});

describe('resolveEffectiveBooks — overlay on an excluded entry', () => {
  it('exclusion wins: the entry stays absent and is tagged excluded, not overridden', () => {
    const entry = mkEntry({ keys: ['a'], content: 'original' });
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];
    const overlay = mkOverlay({
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: { content: 'overridden' },
    });
    const chatConfig = mkConfig({
      excludedEntryIds: { [book.id]: [entry.id] },
      overlays: { [entry.id]: overlay },
    });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const effectiveBook = result.effectiveBooks.find((b) => b.id === book.id)!;
    expect(effectiveBook.entries.find((e) => e.id === entry.id)).toBeUndefined();
    expect(result.provenance.get(entry.id)).toBe('excluded');
  });
});

describe('resolveEffectiveBooks — persona-book overlay', () => {
  it('overlays an entry inside any active book (e.g. a persona-owned book) the same way', () => {
    const entry = mkEntry({ keys: ['a'], content: 'original' });
    const personaBook = mkBook([entry], { ownerHandle: 'persona-owner' });
    const books = [personaBook];
    const activeIds = [personaBook.id];
    const overlay = mkOverlay({
      baseEntryId: entry.id,
      baseBookId: personaBook.id,
      patch: { content: 'overridden' },
    });
    const chatConfig = mkConfig({ overlays: { [entry.id]: overlay } });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const effectiveBook = result.effectiveBooks.find((b) => b.id === personaBook.id)!;
    expect(effectiveBook.id).toBe(personaBook.id);
    const effectiveEntry = effectiveBook.entries.find((e) => e.id === entry.id)!;
    expect(effectiveEntry.content).toBe('overridden');
    expect(result.provenance.get(entry.id)).toBe('overridden');
  });
});

describe('resolveEffectiveBooks — local entries', () => {
  it('appends a synthetic "this chat" book last, containing the local entry', () => {
    const entry = mkEntry();
    const localEntry = mkEntry({ content: 'local fact' });
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];
    const chatConfig = mkConfig({ localEntries: [localEntry] });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const expectedId = chatLocalBookId(chatConfig.chatFile);
    const syntheticBook = result.effectiveBooks.find((b) => b.id === expectedId);
    expect(syntheticBook).toBeDefined();
    expect(syntheticBook!.name).toBe(CHAT_LOCAL_BOOK_NAME);
    expect(result.effectiveActiveIds[result.effectiveActiveIds.length - 1]).toBe(
      expectedId
    );
    expect(syntheticBook!.entries.some((e) => e.id === localEntry.id)).toBe(true);
    expect(result.provenance.get(localEntry.id)).toBe('local');
  });
});

describe('resolveEffectiveBooks — orphaned overlay promotion', () => {
  it('promotes an overlay with a non-empty patch.content whose base entry no longer exists anywhere', () => {
    const entry = mkEntry();
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];
    const orphanId = 'orphan-entry-id';
    const overlay = mkOverlay({
      baseEntryId: orphanId,
      baseBookId: book.id,
      patch: { content: 'promoted fact' },
    });
    const chatConfig = mkConfig({ overlays: { [orphanId]: overlay } });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const syntheticBook = result.effectiveBooks.find(
      (b) => b.id === chatLocalBookId(chatConfig.chatFile)
    )!;
    const promoted = syntheticBook.entries.find((e) => e.id === orphanId);
    expect(promoted).toBeDefined();
    expect(promoted!.source).toBe('fork');
    expect(promoted!.revisions).toEqual([]);
    expect(promoted!.content).toBe('promoted fact');
    expect(result.provenance.get(orphanId)).toBe('local');
  });

  it('does not synthesize anything when the orphaned overlay patch has no content', () => {
    const entry = mkEntry();
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];
    const orphanId = 'orphan-entry-id-2';
    const overlay = mkOverlay({
      baseEntryId: orphanId,
      baseBookId: book.id,
      patch: {}, // no content field at all
    });
    const chatConfig = mkConfig({ overlays: { [orphanId]: overlay } });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const syntheticBook = result.effectiveBooks.find(
      (b) => b.id === chatLocalBookId(chatConfig.chatFile)
    )!;
    expect(syntheticBook.entries.find((e) => e.id === orphanId)).toBeUndefined();
    expect(result.provenance.has(orphanId)).toBe(false);
  });
});

describe('resolveEffectiveBooks — provenance completeness', () => {
  it('tags every id exactly once across a mixed inherited/excluded/overridden/local scenario', () => {
    const inheritedEntry = mkEntry({ keys: ['keep'] });
    const excludedEntry = mkEntry({ keys: ['drop'] });
    const overriddenEntry = mkEntry({ keys: ['over'], content: 'base' });
    const book = mkBook([inheritedEntry, excludedEntry, overriddenEntry]);
    const localEntry = mkEntry({ content: 'local' });
    const books = [book];
    const activeIds = [book.id];

    const overlay = mkOverlay({
      baseEntryId: overriddenEntry.id,
      baseBookId: book.id,
      patch: { content: 'patched' },
    });

    const chatConfig = mkConfig({
      excludedEntryIds: { [book.id]: [excludedEntry.id] },
      overlays: { [overriddenEntry.id]: overlay },
      localEntries: [localEntry],
    });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    expect(result.provenance.get(inheritedEntry.id)).toBe('inherited');
    expect(result.provenance.get(excludedEntry.id)).toBe('excluded');
    expect(result.provenance.get(overriddenEntry.id)).toBe('overridden');
    expect(result.provenance.get(localEntry.id)).toBe('local');

    // Every id present has exactly one tag (Map semantics already guarantee
    // this, but assert explicitly that nothing is missing or duplicated).
    const allIds = [
      inheritedEntry.id,
      excludedEntry.id,
      overriddenEntry.id,
      localEntry.id,
    ];
    const tags = allIds.map((id) => result.provenance.get(id));
    expect(tags.every((t): t is NonNullable<typeof t> => t !== undefined)).toBe(
      true
    );
    expect(new Set(allIds).size).toBe(allIds.length);

    // Excluded id is absent from the actual output but still tagged.
    const effectiveBook = result.effectiveBooks.find((b) => b.id === book.id)!;
    expect(
      effectiveBook.entries.some((e) => e.id === excludedEntry.id)
    ).toBe(false);
  });
});

describe('resolveEffectiveBooks — determinism', () => {
  it('returns deep-equal results for identical inputs called twice', () => {
    const entry = mkEntry({ keys: ['a'], content: 'base' });
    const localEntry = mkEntry({ content: 'local' });
    const book = mkBook([entry]);
    const books = [book];
    const activeIds = [book.id];
    const overlay = mkOverlay({
      baseEntryId: entry.id,
      baseBookId: book.id,
      patch: { content: 'overridden' },
    });
    const chatConfig = mkConfig({
      overlays: { [entry.id]: overlay },
      localEntries: [localEntry],
    });

    const result1 = resolveEffectiveBooks(books, activeIds, chatConfig);
    const result2 = resolveEffectiveBooks(books, activeIds, chatConfig);

    expect(result1.effectiveBooks).toEqual(result2.effectiveBooks);
    expect(result1.effectiveActiveIds).toEqual(result2.effectiveActiveIds);
    expect(result1.provenance).toEqual(result2.provenance);
  });
});

describe('resolveEffectiveBooks — scanner integration smoke test', () => {
  it('feeds an effective-books result into scanMessagesForEntries: overlay changes matching, exclusion always suppresses, local constant always fires', () => {
    // Overlay changes an entry's keys, which changes whether it fires.
    const keyChangedEntry = mkEntry({ keys: ['original-key'], content: 'Key-changed lore.' });
    // Excluded entry would match on keys but must never fire.
    const excludedEntry = mkEntry({ keys: ['dragon'], content: 'Excluded lore.' });
    const book = mkBook([keyChangedEntry, excludedEntry]);
    const books = [book];
    const activeIds = [book.id];

    const overlay = mkOverlay({
      baseEntryId: keyChangedEntry.id,
      baseBookId: book.id,
      patch: { keys: ['new-key'] },
    });

    // Local entry, always-fires via constant: true.
    const localConstantEntry = mkEntry({ constant: true, content: 'Local constant lore.' });

    const chatConfig = mkConfig({
      excludedEntryIds: { [book.id]: [excludedEntry.id] },
      overlays: { [keyChangedEntry.id]: overlay },
      localEntries: [localConstantEntry],
    });

    const result = resolveEffectiveBooks(books, activeIds, chatConfig);

    const messages = msgs('a dragon appears', 'looking for the new-key thing');

    const matches = scanMessagesForEntries(
      result.effectiveBooks,
      result.effectiveActiveIds,
      messages,
      opts()
    );
    const matchedIds = matches.map((m) => m.entry.id);

    // Excluded entry never fires, even though "dragon" is in the messages.
    expect(matchedIds).not.toContain(excludedEntry.id);
    // Old key ("original-key") no longer matches anything in the messages;
    // the overlay's new key ("new-key") does, so the overlaid entry fires.
    expect(matchedIds).toContain(keyChangedEntry.id);
    // Local constant entry always fires.
    expect(matchedIds).toContain(localConstantEntry.id);
  });
});
