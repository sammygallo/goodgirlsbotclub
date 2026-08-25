/**
 * The little that worldInfoStore and dataBankStore have to know about each
 * other: which lorebooks are Data Bank documents, and the two signals that
 * keep that fact and the user's own choices flowing between them.
 *
 * A LEAF module — it imports nothing, and that is the whole point. The two
 * stores sit on opposite ends of a module-init cycle (worldInfoStore ->
 * loreConflictStore -> authStore -> dataBankStore -> worldInfoStore), so
 * either one reaching across it at module scope reads a half-evaluated
 * module and throws a TDZ ReferenceError before the app renders a pixel —
 * the same class of crash components/works/ingestSources.ts's header
 * documents. A leaf is guaranteed fully evaluated before any importer's body
 * runs, so both stores can register with it from module scope safely.
 *
 * Nothing here is persisted. dataBankStore owns the durable copies (its
 * synced `stm_data_bank_index` section); this module is the in-memory mirror
 * plus a pair of callback slots.
 */

// ---------------------------------------------------------------------------
// Document identity
// ---------------------------------------------------------------------------

const _documentBookIds = new Set<string>();

/**
 * Mirror the Data Bank registry. Called by dataBankStore on every registry
 * change; idempotent, so calling it with the same ids repeatedly is free.
 */
export function setDocumentBookIds(ids: Iterable<string>): void {
  _documentBookIds.clear();
  for (const id of ids) _documentBookIds.add(id);
}

/**
 * True when this book id is a known Data Bank document.
 *
 * The signal worldInfoStore's document check is built on, because it is
 * DURABLE: written when the document is created, persisted locally and
 * synced server-side, and unaffected by anything the user later does to the
 * book's entries. A content heuristic in its place ("every entry is
 * semantic-only") flips the moment one ordinary entry is added — which the
 * Data Bank's own UI copy tells users to do.
 */
export function isRegisteredDocumentBook(bookId: string): boolean {
  return _documentBookIds.has(bookId);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

type UserBookActivationListener = (bookId: string, active: boolean) => void;
let _userActivationListener: UserBookActivationListener | null = null;

/**
 * Register for "the USER flipped a book's active switch" — worldInfoStore's
 * `toggleBookActive`, and nothing else. Its programmatic sibling
 * `setBookActive` deliberately stays silent, and that separation is what
 * lets dataBankStore's activation repair tell a deliberate "off" from the
 * never-activated state it exists to fix. Without it the repair can only
 * guess, and it guessed wrong on every page load.
 */
export function onUserBookActivation(
  listener: UserBookActivationListener | null
): void {
  _userActivationListener = listener;
}

export function notifyUserBookActivation(bookId: string, active: boolean): void {
  try {
    _userActivationListener?.(bookId, active);
  } catch (err) {
    console.warn('[documentBookRegistry] activation listener threw', err);
  }
}

type BooksChangedListener = () => void;
let _booksChangedListener: BooksChangedListener | null = null;

/**
 * Register for "worldInfoStore's book list was replaced". The activation
 * repair needs it: its earliest call runs at login against a book list that
 * may still be empty or a stale local cache, and this is what tells it to
 * try again once the real list lands.
 */
export function onBooksChanged(listener: BooksChangedListener | null): void {
  _booksChangedListener = listener;
}

export function notifyBooksChanged(): void {
  try {
    _booksChangedListener?.();
  } catch (err) {
    console.warn('[documentBookRegistry] books-changed listener threw', err);
  }
}

/** Test seam: drop every registration and mirrored id. */
export function resetDocumentBookRegistry(): void {
  _documentBookIds.clear();
  _userActivationListener = null;
  _booksChangedListener = null;
}
