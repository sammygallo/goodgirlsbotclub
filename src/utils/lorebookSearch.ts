import type { BookScope, WorldInfoBook, WorldInfoEntry } from '../stores/worldInfoStore';

// ---------------------------------------------------------------------------
// Lorebook v2 — global entry search (Phase 3)
// ---------------------------------------------------------------------------
//
// Pure module: no React, no zustand/store imports, no side effects. Builds a
// flat, pre-lowercased search index over every entry in every world-info
// book so the Library can run a fast "find an entry across all my books"
// search without re-scanning raw (mixed-case) entry data on every keystroke.
//
// Synthetic per-chat local books (see CHAT_LOCAL_BOOK_PREFIX /
// isChatLocalBookId in worldInfoComposition.ts) are a non-issue for this
// module and deliberately get no special-case filtering here: they only
// ever exist transiently inside resolveEffectiveBooks's *return value* for
// a single composition/scan call, never inside the persisted store. This
// index is meant to be built directly from useWorldInfoStore's `books`
// array (the Library's source of truth), which never contains one, so
// there is nothing for buildEntrySearchIndex to exclude.

/** Minimum characters a query must have before it is searched at all. */
export const MIN_SEARCH_QUERY_LENGTH = 2;

/** Hard cap on the number of hits returned, regardless of how many match. */
export const MAX_SEARCH_RESULTS = 50;

/** Characters of context kept on each side of a content match in a snippet. */
export const SNIPPET_RADIUS = 40; // characters either side of the match

/**
 * One indexed entry. Not exported: it only ever escapes this module as the
 * (opaque, caller-shouldn't-touch-directly) contents of an EntrySearchIndex.
 * `entry` is a reference into the original book, never a copy, so hits stay
 * cheap and always reflect the live entry object.
 */
interface EntrySearchRecord {
  bookId: string;
  bookName: string;
  scope: BookScope;
  autoExtracted: boolean;
  entry: WorldInfoEntry;
  commentLower: string;
  /** Primary keys AND secondary keys, lowercased, in that order. */
  keysLower: string[];
  contentLower: string;
}

export interface EntrySearchIndex {
  records: EntrySearchRecord[];
}

export interface EntrySearchHit {
  bookId: string;
  bookName: string;
  scope: BookScope;
  autoExtracted: boolean;
  entry: WorldInfoEntry;
  matchedField: 'comment' | 'keys' | 'content';
  snippet: string;
}

/**
 * Builds one EntrySearchRecord per entry across every book, INCLUDING
 * disabled entries and entries with empty content. Unlike
 * scanMessagesForEntries (which only cares about what could actually fire
 * in a chat, and skips disabled/empty entries for that reason), the Library
 * manages every entry regardless of activation state, so this index has to
 * be able to find all of them too.
 *
 * `entry.comment` / `entry.keys` / `entry.keysSecondary` / `entry.content`
 * are typed as always-present (string / string[]) on WorldInfoEntry, and
 * DEFAULT_ENTRY fills them with '' / [] / [] / '' for anything created
 * through this app. But normalizeStoredBooks's lazy-backfill pass (see
 * worldInfoStore.ts) only backfills fields added *after* initial release
 * (sticky, cooldown, delay, critical, category, relatedIds, source,
 * revisions) — it does not touch these foundational fields — so a
 * sufficiently old localStorage blob could in principle still be missing
 * one. The `?? ''` / `?? []` fallbacks below are cheap insurance against
 * that, not a sign these are expected to be undefined in normal operation.
 *
 * Lowercasing happens once per entry, here. This function is meant to be
 * called once per `books` array change (e.g. from a `useMemo` keyed on the
 * books reference) — it must NOT be invoked on every keystroke; keeping
 * searchEntries's per-keystroke cost to a plain substring scan over
 * already-lowercased strings is the whole point of splitting index-build
 * from search.
 */
export function buildEntrySearchIndex(books: WorldInfoBook[]): EntrySearchIndex {
  const records: EntrySearchRecord[] = [];
  for (const book of books) {
    const autoExtracted = book.autoExtracted === true;
    for (const entry of book.entries) {
      const keys = entry.keys ?? [];
      const keysSecondary = entry.keysSecondary ?? [];
      records.push({
        bookId: book.id,
        bookName: book.name,
        scope: book.scope,
        autoExtracted,
        entry,
        commentLower: (entry.comment ?? '').toLowerCase(),
        keysLower: [...keys, ...keysSecondary].map((k) => k.toLowerCase()),
        contentLower: (entry.content ?? '').toLowerCase(),
      });
    }
  }
  return { records };
}

/**
 * Windows SNIPPET_RADIUS characters either side of a content match, read
 * from the ORIGINAL-case content (not the lowercased copy) so snippets
 * preserve the author's casing. `matchIndex` is the offset found via the
 * lowercased string, which lines up 1:1 with the original string for the
 * overwhelming common case (toLowerCase() is length-preserving for
 * essentially all lore text this app deals with).
 */
function buildContentSnippet(
  originalContent: string,
  matchIndex: number,
  matchLength: number
): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(originalContent.length, matchIndex + matchLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < originalContent.length ? '…' : '';
  return prefix + originalContent.slice(start, end) + suffix;
}

/**
 * Searches a prebuilt index for `rawQuery`. Returns at most `limit` hits
 * (default MAX_SEARCH_RESULTS), sorted so every comment-match sorts before
 * every keys-match, which sorts before every content-match; within each
 * group, hits keep the index's original record order (stable, since
 * buildEntrySearchIndex iterates books/entries in a fixed order).
 *
 * Each record produces AT MOST ONE hit: fields are checked in priority
 * order (comment, then keys, then content) and the first one that contains
 * `query` wins, even if a later field would also have matched.
 */
export function searchEntries(
  index: EntrySearchIndex,
  rawQuery: string,
  limit: number = MAX_SEARCH_RESULTS
): EntrySearchHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < MIN_SEARCH_QUERY_LENGTH) return [];

  const commentHits: EntrySearchHit[] = [];
  const keysHits: EntrySearchHit[] = [];
  const contentHits: EntrySearchHit[] = [];

  for (const record of index.records) {
    if (record.commentLower.includes(query)) {
      commentHits.push({
        bookId: record.bookId,
        bookName: record.bookName,
        scope: record.scope,
        autoExtracted: record.autoExtracted,
        entry: record.entry,
        matchedField: 'comment',
        snippet: record.entry.comment,
      });
      continue;
    }

    // Keys are matched as plain literal substrings, even when a key is
    // written in /slashes/flags/ regex form (e.g. "/^bob$/i"). This is a
    // deliberate difference from keyMatches() in worldInfoStore.ts (used by
    // the message scanner), which tries to compile such keys as a RegExp:
    // this is a text search over what an author typed into a key field, not
    // a re-run of keyword-activation semantics, so the raw characters are
    // what should match.
    const keysMatchIndex = record.keysLower.findIndex((k) => k.includes(query));
    if (keysMatchIndex !== -1) {
      const originalKeys = [
        ...(record.entry.keys ?? []),
        ...(record.entry.keysSecondary ?? []),
      ];
      keysHits.push({
        bookId: record.bookId,
        bookName: record.bookName,
        scope: record.scope,
        autoExtracted: record.autoExtracted,
        entry: record.entry,
        matchedField: 'keys',
        snippet: originalKeys[keysMatchIndex],
      });
      continue;
    }

    const contentMatchIndex = record.contentLower.indexOf(query);
    if (contentMatchIndex !== -1) {
      const originalContent = record.entry.content ?? '';
      contentHits.push({
        bookId: record.bookId,
        bookName: record.bookName,
        scope: record.scope,
        autoExtracted: record.autoExtracted,
        entry: record.entry,
        matchedField: 'content',
        snippet: buildContentSnippet(originalContent, contentMatchIndex, query.length),
      });
    }
  }

  return [...commentHits, ...keysHits, ...contentHits].slice(0, limit);
}
