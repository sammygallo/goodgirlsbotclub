import type { WorldInfoBook } from '../stores/worldInfoStore';

// ---------------------------------------------------------------------------
// E4-S0 — orphaned Data Bank document detection (pure utility)
// ---------------------------------------------------------------------------
//
// Pure module: no React, no zustand/store imports, no side effects (the
// WorldInfoBook import is type-only and erased at compile time). Every
// store's real shape is read by the caller and passed in as plain data —
// same contract as bookAttachments.ts.
//
// DETECTION ONLY. Nothing here deletes, reassigns or otherwise repairs an
// orphan, and the surface that renders these findings must not either. An
// orphaned document is the user's own uploaded text with no way back to it;
// the one thing worse than it being invisible is it being tidied away.
//
// Deliberately NOT folded into worldInfoStore's auditBookHealth: that takes
// `(book, profile)` and cannot see the document registry, the character list,
// or an id with no book behind it at all — which is precisely the population
// an orphan lives in. Widening its signature to reach them would make a
// per-book entry-quality audit depend on three unrelated stores.

/**
 * Which way a document went missing.
 *
 * - `unresolved-registration`: the id is in dataBankStore's registry and no
 *   book with that id exists. Either the book was deleted in the library
 *   (deleteBook does not prune the registry) or it exists only on another
 *   device and this account's fetch has not seen it. Nothing is lost here —
 *   it is a leftover record — but it is also the shape the activation repair
 *   has to skip, so it is worth saying out loud rather than guessing at.
 * - `owner-gone`: the book exists, is character-scoped, and names an
 *   `ownerCharacterAvatar` that is not in the character list. This one is
 *   real stranded data: the text is still there, but a character-scoped book
 *   reaches the scan ONLY through getActiveBookIdsForCharacter(avatar), and
 *   no such character remains to pass that avatar in. It is out of every
 *   scan, global and per-character alike, permanently.
 *   `deleteCharacterBooks` keeps new deletions from landing here; it does
 *   nothing for a character deleted before it shipped.
 */
export type DocumentOrphanKind = 'unresolved-registration' | 'owner-gone';

/** One orphaned document, in whichever of the two senses applies. */
export interface DocumentOrphan {
  kind: DocumentOrphanKind;
  /** The registered lorebook id — the only field present for both kinds. */
  documentId: string;
  /** The book's name, or null when there is no book to read it from. */
  bookName: string | null;
  /** The avatar filename that no longer resolves; null for the other kind. */
  ownerCharacterAvatar: string | null;
}

export interface DetectDocumentOrphansInput {
  /** dataBankStore's `lorebookIds` — the document registry. */
  documentIds: string[];
  /** worldInfoStore's `books` (the caller's own books, never shared ones). */
  books: WorldInfoBook[];
  /** characterStore's `characters`, reduced to avatar filenames. */
  characterAvatars: string[];
  /**
   * True only when a SUCCESSFUL native /lorebooks fetch has been applied to
   * `books` this session — worldInfoStore's
   * canConfidentlyDropUnresolvedLegacyIds(), the same predicate that gates
   * "not found anywhere" being trusted as "confidently gone" over there.
   *
   * Without it every cold start reports every document as orphaned: `books`
   * hydrates synchronously from a localStorage cache that can predate a
   * document added on another device, so a non-empty book list happily
   * coexists with a registered id that does not resolve yet. That is the
   * same load-order race backfillDocumentBookActivation converges around by
   * retrying — but a report cannot retry its way out of having already told
   * the user their documents are gone.
   */
  booksSettled: boolean;
  /**
   * True only once characterStore's fetchCharacters has succeeded this
   * session (`charactersLoaded`). `characters.length > 0` is NOT a
   * substitute: the store starts at `[]` with `isLoading: false`, so before
   * the first fetch "no characters" and "not asked yet" are the same value,
   * and every character-scoped document would read as owner-gone for the
   * whole window before the list lands.
   */
  charactersSettled: boolean;
}

/**
 * Find every registered document that has been orphaned, in either sense.
 *
 * Returns `[]` — not a partial answer — for whichever sense is not yet
 * decidable, so a report built on this stays silent during hydration rather
 * than crying wolf. The two readiness gates are independent: a settled book
 * list still reports unresolved registrations while the character list is
 * in flight, and vice versa.
 *
 * Registry order is preserved, and a duplicate id is reported once.
 */
export function detectDocumentBookOrphans(
  input: DetectDocumentOrphansInput
): DocumentOrphan[] {
  const {
    documentIds,
    books,
    characterAvatars,
    booksSettled,
    charactersSettled,
  } = input;
  if (documentIds.length === 0) return [];

  const bookById = new Map<string, WorldInfoBook>();
  for (const book of books) bookById.set(book.id, book);
  const knownAvatars = new Set(characterAvatars);

  const orphans: DocumentOrphan[] = [];
  const seen = new Set<string>();
  for (const id of documentIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    const book = bookById.get(id);
    if (!book) {
      if (!booksSettled) continue;
      orphans.push({
        kind: 'unresolved-registration',
        documentId: id,
        bookName: null,
        ownerCharacterAvatar: null,
      });
      continue;
    }

    // `ownerCharacterAvatar`, never the derived `scope` field — worldInfoStore
    // calls scope "never authoritative" and recomputes it from this one at
    // every write site.
    const owner = book.ownerCharacterAvatar;
    if (owner === null) continue; // a global document has no owner to lose
    if (!charactersSettled) continue;
    if (knownAvatars.has(owner)) continue;
    orphans.push({
      kind: 'owner-gone',
      documentId: id,
      bookName: book.name,
      ownerCharacterAvatar: owner,
    });
  }
  return orphans;
}
