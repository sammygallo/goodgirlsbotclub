import type {
  WorldInfoEntry,
  WorldInfoBook,
} from '../stores/worldInfoStore';
import { DEFAULT_ENTRY } from '../stores/worldInfoStore';

// ---------------------------------------------------------------------------
// Lorebook v2 — pure composition layer
// ---------------------------------------------------------------------------
//
// This module sits strictly BEFORE scanMessagesForEntries in the pipeline.
// It takes the raw global books/activeBookIds plus an optional per-chat
// customization record (ChatLoreConfig) and produces the "effective" book
// list the scanner should run over. The scanner itself is never modified and
// is never made aware of overlays, exclusions, or per-chat local entries —
// see the v2 composition contract note above scanMessagesForEntries in
// worldInfoStore.ts. All per-chat customization is resolved here, once,
// before scanning.

// ---- Types -----------------------------------------------------------------

/**
 * A per-chat "fork" of a single base entry. The base entry (identified by
 * baseEntryId/baseBookId) is left completely untouched in the library; the
 * overlay's patch is merged on top of it only when computing this chat's
 * effective books.
 */
export interface EntryOverlay {
  baseEntryId: string;
  baseBookId: string;
  /**
   * May include any entry field except id/createdAt — those are always
   * forced back to the base entry's values when the overlay is applied
   * (or, for orphan promotion, to the overlay's own recorded values).
   */
  patch: Partial<WorldInfoEntry>;
  /** Fingerprint of the base entry's content at fork time (see hashContent). */
  baseContentHash: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface ChatLoreConfig {
  chatFile: string;
  linkedBookIds: string[];
  /** bookId -> array of excluded entry ids. */
  excludedEntryIds: Record<string, string[]>;
  /** entryId -> overlay. */
  overlays: Record<string, EntryOverlay>;
  /** Chat-only entries — the "alternate universe" additions. */
  localEntries: WorldInfoEntry[];
  updatedAt: number;
}

export type EntryProvenance = 'inherited' | 'overridden' | 'local' | 'excluded';

export interface EffectiveBooksResult {
  effectiveBooks: WorldInfoBook[];
  effectiveActiveIds: string[];
  provenance: Map<string, EntryProvenance>;
}

// ---- Content fingerprint -----------------------------------------------------

/**
 * FNV-1a 32-bit hash, returned as a hex string. Only used as a cheap
 * fingerprint to detect "the base entry changed since this overlay forked
 * it" — does not need to be cryptographically strong.
 */
export function hashContent(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// ---- Synthetic "this chat" local book ---------------------------------------

export const CHAT_LOCAL_BOOK_NAME = '⚡ This chat';
export const CHAT_LOCAL_BOOK_PREFIX = 'wibook_chatlocal__';

export function chatLocalBookId(chatFile: string): string {
  return CHAT_LOCAL_BOOK_PREFIX + chatFile;
}

export function isChatLocalBookId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(CHAT_LOCAL_BOOK_PREFIX);
}

// ---- Internal helpers --------------------------------------------------------

/** Unique values, preserving first-occurrence order. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * A fresh, empty provenance map for the v1-identity and linked-only fast
 * paths. Deliberately NOT a shared singleton: Object.freeze on a Map instance
 * does not actually block .set()/.delete() (those operate on internal slots,
 * not own properties), so a single reused instance would let one caller's
 * mutation silently corrupt every other fast-path chat's "empty" provenance.
 * A fresh Map per call is the only way to make "callers must not mutate this"
 * actually true rather than just documented.
 */
function emptyProvenance(): Map<string, EntryProvenance> {
  return new Map();
}

function hasAnyExcluded(excludedEntryIds: Record<string, string[]> | undefined): boolean {
  if (!excludedEntryIds) return false;
  return Object.values(excludedEntryIds).some((arr) => Array.isArray(arr) && arr.length > 0);
}

function hasAnyOverlays(overlays: Record<string, EntryOverlay> | undefined): boolean {
  if (!overlays) return false;
  return Object.keys(overlays).length > 0;
}

// ---- Core resolver -----------------------------------------------------------

/**
 * Resolves the "effective" set of active books for a chat, folding in
 * per-chat exclusions, entry overlays (forks), and chat-local entries on top
 * of the raw global books/activeBookIds.
 *
 * Why ids are always preserved: downstream code keys per-entry timed-effect
 * state (sticky/cooldown/delay via wiTimers) and per-book ownership/persona
 * attribution off of entry.id / book.id. This resolver never mints a new id
 * for an entry or book that already exists elsewhere — an overridden entry
 * keeps its base id, and even a "promoted orphan" (step 4 below) is forced
 * back onto its original baseEntryId — so all of that keyed state keeps
 * working completely unchanged across composition. The one genuinely new id
 * introduced is the synthetic per-chat local book, and it's derived
 * deterministically from chatFile (chatLocalBookId), not randomly generated.
 *
 * The scanner (scanMessagesForEntries) is intentionally never modified or
 * made aware of overlays/exclusions/local entries — composition always runs
 * strictly before it, so the scanner just sees a plain WorldInfoBook[] /
 * string[] as before.
 *
 * PURITY CONTRACT: no store access, no I/O, no Date.now(), no Math.random().
 * Deterministic — same inputs always produce the same outputs (including by
 * reference, where noted). This is what lets a test suite assert (via toBe)
 * that v1 behavior is completely unchanged when there is no meaningful
 * per-chat customization.
 */
export function resolveEffectiveBooks(
  books: WorldInfoBook[],
  activeBookIds: string[],
  chatConfig?: ChatLoreConfig
): EffectiveBooksResult {
  const hasLinked = !!chatConfig && chatConfig.linkedBookIds.length > 0;
  const hasExcluded = !!chatConfig && hasAnyExcluded(chatConfig.excludedEntryIds);
  const hasOverlays = !!chatConfig && hasAnyOverlays(chatConfig.overlays);
  const hasLocal = !!chatConfig && chatConfig.localEntries.length > 0;

  // STEP A — v1 identity fast path. No chatConfig, or a chatConfig that adds
  // nothing meaningful: return the exact same references passed in.
  if (!chatConfig || (!hasLinked && !hasExcluded && !hasOverlays && !hasLocal)) {
    return {
      effectiveBooks: books,
      effectiveActiveIds: activeBookIds,
      provenance: emptyProvenance(),
    };
  }

  // STEP B — linked-only fast path: extra manually-linked books, nothing
  // else. Must match today's pre-existing "chat-linked books" behavior
  // bit-for-bit.
  if (hasLinked && !hasExcluded && !hasOverlays && !hasLocal) {
    return {
      effectiveBooks: books,
      effectiveActiveIds: dedupe([...activeBookIds, ...chatConfig.linkedBookIds]),
      provenance: emptyProvenance(),
    };
  }

  // STEP C — full composition path.
  const provenance = new Map<string, EntryProvenance>();

  // 1. Effective active ids: activeBookIds + linked, deduped, dropping any
  //    id that no longer corresponds to a real book (book deleted since the
  //    chat linked it).
  const booksById = new Map<string, WorldInfoBook>();
  for (const b of books) booksById.set(b.id, b);

  const dedupedActive = dedupe([...activeBookIds, ...chatConfig.linkedBookIds]);
  const baseEffectiveActiveIds = dedupedActive.filter((id) => booksById.has(id));

  // 2 + 3. For each active book, drop excluded entries and apply overlays to
  // survivors, in a single pass. Books untouched by either pass through by
  // reference; only touched books/entry-arrays get shallow-copied.
  const excludedEntryIds = chatConfig.excludedEntryIds;
  const overlays = chatConfig.overlays;

  const effectiveBooksStepped: WorldInfoBook[] = baseEffectiveActiveIds.map((id) => {
    const book = booksById.get(id) as WorldInfoBook;
    const excludedIds = excludedEntryIds[id];
    const excludedSet =
      excludedIds && excludedIds.length > 0 ? new Set(excludedIds) : null;

    let changed = false;
    const newEntries: WorldInfoEntry[] = [];
    for (const entry of book.entries) {
      if (excludedSet && excludedSet.has(entry.id)) {
        provenance.set(entry.id, 'excluded');
        changed = true;
        continue;
      }
      const overlay = overlays[entry.id];
      if (overlay) {
        const merged: WorldInfoEntry = {
          ...entry,
          ...overlay.patch,
          id: entry.id,
          createdAt: entry.createdAt,
        };
        newEntries.push(merged);
        provenance.set(entry.id, 'overridden');
        changed = true;
      } else {
        newEntries.push(entry);
        provenance.set(entry.id, 'inherited');
      }
    }

    if (!changed) return book;
    return { ...book, entries: newEntries };
  });

  // 4. Orphan handling: overlays whose base entry no longer exists ANYWHERE
  // across the full original books array (deleted from the library, not
  // merely excluded from this chat) get promoted into synthetic local
  // entries when they carry non-empty content; otherwise dropped silently.
  const allEntryIds = new Set<string>();
  for (const b of books) {
    for (const e of b.entries) allEntryIds.add(e.id);
  }

  const promotedEntries: WorldInfoEntry[] = [];
  for (const overlay of Object.values(overlays)) {
    if (allEntryIds.has(overlay.baseEntryId)) continue; // not orphaned
    const content = overlay.patch.content;
    if (typeof content !== 'string' || content.trim().length === 0) continue; // nothing to promote
    const synthesized: WorldInfoEntry = {
      ...DEFAULT_ENTRY,
      ...overlay.patch,
      id: overlay.baseEntryId,
      source: 'fork',
      revisions: [],
      createdAt: overlay.createdAt,
      updatedAt: overlay.updatedAt,
    };
    promotedEntries.push(synthesized);
    provenance.set(synthesized.id, 'local');
  }

  // 5. Synthetic per-chat local book: local entries + promoted orphans,
  // always appended last, in both effectiveBooks and effectiveActiveIds.
  const localBookEntries = [...chatConfig.localEntries, ...promotedEntries];
  for (const e of localBookEntries) provenance.set(e.id, 'local');

  const syntheticBook: WorldInfoBook = {
    id: chatLocalBookId(chatConfig.chatFile),
    name: CHAT_LOCAL_BOOK_NAME,
    entries: localBookEntries,
    ownerCharacterAvatar: null,
    scope: 'world',
    ownerHandle: '',
    visibility: 'private',
    createdAt: chatConfig.updatedAt,
    updatedAt: chatConfig.updatedAt,
  };

  return {
    effectiveBooks: [...effectiveBooksStepped, syntheticBook],
    effectiveActiveIds: [...baseEffectiveActiveIds, syntheticBook.id],
    provenance,
  };
}
