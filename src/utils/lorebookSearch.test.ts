import { describe, it, expect } from 'vitest';

import {
  buildEntrySearchIndex,
  searchEntries,
  MIN_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
  SNIPPET_RADIUS,
} from './lorebookSearch';

import { DEFAULT_ENTRY } from '../stores/worldInfoStore';
import type { WorldInfoBook, WorldInfoEntry } from '../stores/worldInfoStore';

// ---------------------------------------------------------------------------
// Fixture helpers — same style/conventions as
// src/stores/chatStore.groupWorldInfo.test.ts and
// src/utils/resolveEffectiveBooks.test.ts.
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

// ---------------------------------------------------------------------------

describe('searchEntries — case-insensitive matching per field', () => {
  it('matches on comment regardless of case', () => {
    const entry = mkEntry({ comment: 'DRAGON info', keys: [], content: 'unrelated' });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'dragon');

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.id).toBe(entry.id);
    expect(hits[0].matchedField).toBe('comment');
  });

  it('matches on primary keys regardless of case', () => {
    const entry = mkEntry({ comment: 'no match here', keys: ['DRAGON'], content: 'nothing' });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'dragon');

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.id).toBe(entry.id);
    expect(hits[0].matchedField).toBe('keys');
  });

  it('matches on secondary keys regardless of case', () => {
    const entry = mkEntry({
      comment: 'no match',
      keys: [],
      keysSecondary: ['DRAGON'],
      content: 'nothing',
    });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'dragon');

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.id).toBe(entry.id);
    expect(hits[0].matchedField).toBe('keys');
  });

  it('matches on content regardless of case', () => {
    const entry = mkEntry({ comment: 'no match', keys: [], content: 'a DRAGON appears' });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'dragon');

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.id).toBe(entry.id);
    expect(hits[0].matchedField).toBe('content');
  });

  it('reports "keys" (not "content") when both keys and content match', () => {
    const entry = mkEntry({
      comment: 'plain text',
      keys: ['zzzmatch'],
      content: 'zzzmatch appears in content too',
    });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'zzzmatch');

    expect(hits).toHaveLength(1);
    expect(hits[0].matchedField).toBe('keys');
  });

  it('reports "comment" (highest priority) when comment, keys, and content all match', () => {
    const entry = mkEntry({
      comment: 'hasmatchword',
      keys: ['hasmatchword'],
      content: 'hasmatchword',
    });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'hasmatchword');

    expect(hits).toHaveLength(1);
    expect(hits[0].matchedField).toBe('comment');
  });
});

describe('searchEntries — query length guards', () => {
  it('returns [] for a query shorter than MIN_SEARCH_QUERY_LENGTH', () => {
    const entry = mkEntry({ comment: 'a', content: 'ab' });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const shortQuery = 'a'.repeat(MIN_SEARCH_QUERY_LENGTH - 1);
    expect(searchEntries(index, shortQuery)).toEqual([]);
  });

  it('returns [] for a whitespace-only query', () => {
    const entry = mkEntry({ comment: 'something', content: 'something' });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    expect(searchEntries(index, '     ')).toEqual([]);
  });

  it('finds a real match at exactly MIN_SEARCH_QUERY_LENGTH characters', () => {
    // Build a query of exactly the minimum length and make sure it's a
    // genuine substring of the comment.
    const query = 'ab'.repeat(Math.ceil(MIN_SEARCH_QUERY_LENGTH / 2)).slice(
      0,
      MIN_SEARCH_QUERY_LENGTH
    );
    expect(query.length).toBe(MIN_SEARCH_QUERY_LENGTH);

    const entry = mkEntry({ comment: `prefix-${query}-suffix`, content: 'unrelated' });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, query);

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.id).toBe(entry.id);
  });
});

describe('searchEntries — result cap', () => {
  it('caps results at MAX_SEARCH_RESULTS by default when more entries match', () => {
    const entries = Array.from({ length: MAX_SEARCH_RESULTS + 10 }, (_, i) =>
      mkEntry({ comment: 'no match', keys: [], content: `capmatch entry number ${i}` })
    );
    const index = buildEntrySearchIndex([mkBook(entries)]);

    const hits = searchEntries(index, 'capmatch');

    expect(hits).toHaveLength(MAX_SEARCH_RESULTS);
  });

  it('respects an explicit smaller limit argument', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      mkEntry({ comment: 'no match', keys: [], content: `limitmatch entry ${i}` })
    );
    const index = buildEntrySearchIndex([mkBook(entries)]);

    const hits = searchEntries(index, 'limitmatch', 2);

    expect(hits).toHaveLength(2);
  });
});

describe('searchEntries — ordering: comment, then keys, then content', () => {
  it('sorts all comment-matches before all keys-matches before all content-matches', () => {
    const contentEntry = mkEntry({
      comment: 'no match',
      keys: ['nope'],
      content: 'contains orderword right here',
    });
    const keysEntry = mkEntry({
      comment: 'no match',
      keys: ['orderword'],
      content: 'nothing relevant',
    });
    const commentEntry = mkEntry({
      comment: 'has orderword inside',
      keys: ['nope'],
      content: 'nothing relevant',
    });

    // Deliberately inserted in the *opposite* of the expected output order,
    // so a passing test proves real sorting, not incidental index order.
    const book = mkBook([contentEntry, keysEntry, commentEntry]);
    const index = buildEntrySearchIndex([book]);

    const hits = searchEntries(index, 'orderword');

    expect(hits.map((h) => h.entry.id)).toEqual([
      commentEntry.id,
      keysEntry.id,
      contentEntry.id,
    ]);
    expect(hits.map((h) => h.matchedField)).toEqual(['comment', 'keys', 'content']);
  });
});

describe('searchEntries — content snippet windows', () => {
  it('omits the leading ellipsis when the match starts at the very beginning of content', () => {
    const content = 'startmarker' + 'x'.repeat(70);
    const entry = mkEntry({ comment: 'no match', keys: [], content });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'startmarker');

    expect(hits).toHaveLength(1);
    const expected = 'startmarker' + 'x'.repeat(SNIPPET_RADIUS) + '…';
    expect(hits[0].snippet).toBe(expected);
    expect(hits[0].snippet.startsWith('…')).toBe(false);
    expect(hits[0].snippet.endsWith('…')).toBe(true);
  });

  it('includes both ellipses when the match is in the middle with room on both sides', () => {
    const content = 'a'.repeat(60) + 'midmarker' + 'b'.repeat(60);
    const entry = mkEntry({ comment: 'no match', keys: [], content });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'midmarker');

    expect(hits).toHaveLength(1);
    const expected =
      '…' + 'a'.repeat(SNIPPET_RADIUS) + 'midmarker' + 'b'.repeat(SNIPPET_RADIUS) + '…';
    expect(hits[0].snippet).toBe(expected);
  });

  it('omits the trailing ellipsis when the match ends at the very end of content', () => {
    const content = 'y'.repeat(70) + 'endmarker';
    const entry = mkEntry({ comment: 'no match', keys: [], content });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'endmarker');

    expect(hits).toHaveLength(1);
    const expected = '…' + 'y'.repeat(SNIPPET_RADIUS) + 'endmarker';
    expect(hits[0].snippet).toBe(expected);
    expect(hits[0].snippet.startsWith('…')).toBe(true);
    expect(hits[0].snippet.endsWith('…')).toBe(false);
  });
});

describe('searchEntries — regex-form keys are matched as literal text', () => {
  it('finds a query that is a substring of a "/pattern/flags" key, as plain text', () => {
    const entry = mkEntry({
      comment: 'no match',
      keys: ['/^Bob$/i'],
      content: 'nothing relevant',
    });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    // "bob" is a plain substring of "/^Bob$/i" once lowercased — it must be
    // found via string.includes(), not by compiling the key as a RegExp.
    const hits = searchEntries(index, 'bob');

    expect(hits).toHaveLength(1);
    expect(hits[0].matchedField).toBe('keys');
    expect(hits[0].snippet).toBe('/^Bob$/i');
  });
});

describe('searchEntries — empty content and disabled entries', () => {
  it('finds an entry with empty content via a matching comment', () => {
    const entry = mkEntry({ comment: 'lonelycomment', content: '', keys: [] });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'lonelycomment');

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.id).toBe(entry.id);
    expect(hits[0].matchedField).toBe('comment');
  });

  it('finds a disabled entry — search does not filter by enabled state', () => {
    const entry = mkEntry({
      comment: 'nothing',
      keys: [],
      content: 'disabledcontent is here',
      enabled: false,
    });
    const index = buildEntrySearchIndex([mkBook([entry])]);

    const hits = searchEntries(index, 'disabledcontent');

    expect(hits).toHaveLength(1);
    expect(hits[0].entry.id).toBe(entry.id);
    expect(hits[0].entry.enabled).toBe(false);
  });
});

describe('buildEntrySearchIndex — scope and autoExtracted carry through from the book', () => {
  it('tags hits with the correct scope/autoExtracted for character vs. auto-extracted books', () => {
    const characterEntry = mkEntry({
      comment: 'no match',
      keys: [],
      content: 'chartoken lore text',
    });
    const characterBook = mkBook([characterEntry], {
      name: 'Character Book',
      scope: 'character',
      ownerCharacterAvatar: 'avatar.png',
    });

    const autoEntry = mkEntry({
      comment: 'no match',
      keys: [],
      content: 'autotoken lore text',
    });
    const autoBook = mkBook([autoEntry], {
      name: 'Auto Book',
      autoExtracted: true,
    });

    const index = buildEntrySearchIndex([characterBook, autoBook]);

    const charHits = searchEntries(index, 'chartoken');
    expect(charHits).toHaveLength(1);
    expect(charHits[0].bookId).toBe(characterBook.id);
    expect(charHits[0].bookName).toBe('Character Book');
    expect(charHits[0].scope).toBe('character');
    expect(charHits[0].autoExtracted).toBe(false);

    const autoHits = searchEntries(index, 'autotoken');
    expect(autoHits).toHaveLength(1);
    expect(autoHits[0].bookId).toBe(autoBook.id);
    expect(autoHits[0].bookName).toBe('Auto Book');
    expect(autoHits[0].scope).toBe('world');
    expect(autoHits[0].autoExtracted).toBe(true);
  });
});

describe('searchEntries — determinism', () => {
  it('returns deep-equal results for identical index/query called twice', () => {
    const entryA = mkEntry({ comment: 'detcomment', keys: [], content: 'unrelated' });
    const entryB = mkEntry({ comment: 'no match', keys: ['detkey'], content: 'unrelated' });
    const entryC = mkEntry({ comment: 'no match', keys: [], content: 'has detcontent here' });
    const index = buildEntrySearchIndex([mkBook([entryA, entryB, entryC])]);

    const result1 = searchEntries(index, 'det');
    const result2 = searchEntries(index, 'det');

    expect(result1).toEqual(result2);
  });
});
