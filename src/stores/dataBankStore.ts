/**
 * Phase 8.5 — Data Bank / RAG
 *
 * Paste/upload text (plain text or .md/.txt), chunk it, and create a native
 * Lorebook (one book per document, one semantic-only LorebookEntry per
 * chunk — see worldInfoStore.ts's `semanticOnly` field). Retrieval is no
 * longer this store's concern: once entries exist server-side, the
 * background embedding worker embeds them and the native hybrid
 * (keyword+semantic+FTS) activation engine (`/retrieval/context`) picks
 * them up the same way it does any other lorebook entry — no separate
 * client-side query/injection path.
 *
 * This store now owns two things only:
 *  1. `addDocument` — a thin, Data-Bank-flavored front end over
 *     `worldInfoStore.ts`'s native `createBookWithEntries`, so paste/upload
 *     stays a one-call action instead of the caller hand-assembling
 *     chunks + entries itself. (Deletion needs no counterpart: documents
 *     are ordinary lorebooks, deleted in the library via `deleteBook` like
 *     any other book.)
 *  2. A small index (`stm_data_bank_index` — a NEW server section,
 *     deliberately NOT the legacy `stm_data_bank` blob, see the module
 *     docstring on `fetchPrefs` below) of which of the user's lorebook ids
 *     came from a Data Bank upload. (It once backed the retired
 *     DataBankPage's filtered "your documents" view; documents now live in
 *     the World Info library like any other lorebook, added via
 *     AddDocumentModal.)
 *
 * The legacy `stm_data_bank` blob (old documents + client-computed
 * embedding vectors) is migrated once, automatically, via
 * `ensureDataBankImported` below, and is never written to again — new
 * uploads go straight to native Lorebooks.
 *
 * Persistence: localStorage under `stm:data-bank-index`.
 */

import { create } from 'zustand';
import { chunkText } from '../utils/chunker';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';
import { api, settingsApi, SECRET_KEYS, type SecretsResponse } from '../api/client';
import { useSettingsStore } from './settingsStore';
import { useWorldInfoStore, type WorldInfoEntry } from './worldInfoStore';
import {
  setDocumentBookIds,
  onUserBookActivation,
  onBooksChanged,
} from './documentBookRegistry';

// ---------------------------------------------------------------------------
// Embeddings-key gate. The backend resolves a fallback chain server-side —
// OpenAI (dedicated embeddings secret, falling back to the general chat
// key), then Google, then Cohere, whichever the user has (see
// app/providers/embeddings_dispatch.py) — so this gate must check every
// secret in that chain, not just OpenAI's, or a user with only a Gemini or
// Cohere key would see an incorrect "not configured" warning throughout the
// UI even though embeddings actually work for them.
// ---------------------------------------------------------------------------

/** True if the embeddings pipeline will find a usable key server-side for ANY
 *  provider in the fallback chain (OpenAI, Google, Cohere) — set either as
 *  the user's personal secret or (when sharing is on) an owner-managed
 *  global one. Mirrors the personal-OR-global check the provider keys use
 *  in MyKeysPage/AISettingsPage. */
export function embeddingsConfigured(
  secrets: SecretsResponse,
  globalSecrets?: SecretsResponse,
  globalSharingEnabled?: boolean,
): boolean {
  const nonEmpty = (store: SecretsResponse | undefined, k: string) =>
    !!store && Array.isArray(store[k]) && (store[k] as unknown[]).length > 0;
  const has = (k: string) =>
    nonEmpty(secrets, k) || (!!globalSharingEnabled && nonEmpty(globalSecrets, k));
  return (
    has(SECRET_KEYS.OPENAI_EMBEDDINGS) ||
    has(SECRET_KEYS.OPENAI) ||
    has(SECRET_KEYS.GOOGLE) ||
    has(SECRET_KEYS.COHERE)
  );
}

/** Narrow variant of {@link embeddingsConfigured}: true only when one of the
 *  two OPENAI secrets is set. The dedicated key CARD needs this — its input
 *  field stores an OpenAI key specifically, so its "•••• configured" state
 *  must not light up for a Google/Cohere-only user whose embeddings work
 *  through the fallback chain but whose OpenAI field is genuinely empty. */
export function openaiEmbeddingsKeyConfigured(
  secrets: SecretsResponse,
  globalSecrets?: SecretsResponse,
  globalSharingEnabled?: boolean,
): boolean {
  const nonEmpty = (store: SecretsResponse | undefined, k: string) =>
    !!store && Array.isArray(store[k]) && (store[k] as unknown[]).length > 0;
  const has = (k: string) =>
    nonEmpty(secrets, k) || (!!globalSharingEnabled && nonEmpty(globalSecrets, k));
  return has(SECRET_KEYS.OPENAI_EMBEDDINGS) || has(SECRET_KEYS.OPENAI);
}

/** Non-reactive gate for store actions. Components should select the secrets
 *  slices from settingsStore and call embeddingsConfigured() so they re-render. */
export function hasEmbeddingsKey(): boolean {
  const s = useSettingsStore.getState();
  return embeddingsConfigured(s.secrets, s.globalSecrets, s.globalSharingEnabled);
}

// ---------------------------------------------------------------------------
// Data Bank document index
// ---------------------------------------------------------------------------

interface DataBankState {
  /** Lorebook ids created via addDocument (or the legacy-blob migration) —
   *  purely a display filter, never source of truth for the books/entries
   *  themselves (that's worldInfoStore.ts, same as any other lorebook). */
  lorebookIds: string[];

  /**
   * Document book ids the user has explicitly switched OFF in the library.
   *
   * The activation repair below has no other way to tell the state it
   * exists to fix ("this document was never activated") from a deliberate
   * choice ("I turned this one off"): both read as "in the registry, not in
   * activeBookIds". Recording the choice — durably, and synced alongside
   * the registry so it holds on every device — is what stops the repair
   * from reverting it on the next page load, forever.
   *
   * Written only from the user-facing toggle (see the
   * onUserBookActivation listener at the bottom of this module), never from
   * the repair's own setBookActive calls.
   */
  deactivatedDocumentIds: string[];

  /**
   * Store the OpenAI embeddings key as a server-side secret
   * (`api_key_openai_embeddings`). The key is never persisted in the browser;
   * the backend embeddings proxy resolves it. Refreshes settingsStore secrets.
   */
  setEmbeddingsApiKey: (key: string) => Promise<void>;

  /**
   * Chunk `content` and create one native Lorebook (semanticOnly entries,
   * one per chunk) via worldInfoStore's createBookWithEntries. Synchronous
   * optimistic write + fire-and-forget background sync, matching every
   * worldInfoStore book-creation action — NOT a new async contract.
   * Returns the new book's id.
   */
  addDocument: (
    name: string,
    content: string,
    scope: 'global' | 'character',
    characterAvatar?: string
  ) => string;

  /** A3.1d — pull /sync/section/stm_data_bank_index and reconcile; also
   *  runs the one-time legacy-blob migration (see module docstring). */
  fetchPrefs: () => Promise<void>;
  /** Wipe this store's state + localStorage keys for the current user (logout/switch). */
  resetUser: () => void;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'stm:data-bank-index';
// Deliberately a NEW section name, not the legacy `stm_data_bank` blob.
// worldInfoStore.fetchPrefs() and this store's fetchPrefs() fire
// independently/unordered from authStore.ts (checkAuth/login/register all
// fire-and-forget every store's fetchPrefs in one block) — if this store
// reused `stm_data_bank` for the new (much smaller) index shape, its own
// "no stored data yet -> seed the server" branch could overwrite the
// ORIGINAL blob before the independently-timed migration call below has
// read it. Leaving the legacy blob at its own untouched section name (never
// written here again) makes that race impossible, and mirrors how
// import_lorebooks_from_blob already leaves stm_worldinfo untouched after
// migrating it.
const SERVER_KEY = 'stm_data_bank_index';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

/** Legacy localStorage key the embeddings secret used to live under (now moved
 *  server-side). Kept only so resetUser can purge leftovers on upgrade. */
const LEGACY_EMBED_KEY_STORAGE = 'stm:data-bank-embed-key';
/** Pre-cutover localStorage cache key (full documents + stripped embeddings).
 *  Purged on resetUser; never read by this version of the store. */
const LEGACY_DOCUMENTS_STORAGE_KEY = 'stm:data-bank';

interface PersistedShape {
  lorebookIds: string[];
  /** Optional: absent in every blob written before the opt-out existed. */
  deactivatedDocumentIds?: string[];
}

/** The whole persisted slice, in one value — the two fields are written
 *  together so an opt-out can never be dropped by a registry-only save. */
type IndexSnapshot = Required<PersistedShape>;

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(snapshot: IndexSnapshot): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      snapshot as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 500);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

function loadFromStorage(): IndexSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedShape;
      return {
        lorebookIds: strings(parsed.lorebookIds),
        deactivatedDocumentIds: strings(parsed.deactivatedDocumentIds),
      };
    }
  } catch { /* ignore */ }
  return { lorebookIds: [], deactivatedDocumentIds: [] };
}

function writeCache(snapshot: IndexSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch { /* ignore */ }
}

function saveIndex(snapshot: IndexSnapshot): void {
  writeCache(snapshot);
  schedulePersist(snapshot);
}

/** Current persisted slice as held in state — the base every save builds on,
 *  so one field's write never silently reverts the other's. */
function indexSnapshot(over: Partial<IndexSnapshot> = {}): IndexSnapshot {
  const s = useDataBankStore.getState();
  return {
    lorebookIds: s.lorebookIds,
    deactivatedDocumentIds: s.deactivatedDocumentIds,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// One-time legacy-blob migration bootstrap — same shape/guard idiom as
// worldInfoStore.ts's ensureBlobImported (module-level in-memory flag, reset
// on failure and on resetUser so a second user in the same browser session
// gets their own attempt). Deliberately does NOT touch this store's state
// directly — folding the result into the index is `ensureDataBankImportedAndIndexed`'s
// job (defined after the store below, since it needs `useDataBankStore` in
// scope), which is the single shared entrypoint BOTH this store's own
// fetchPrefs and serverRetrieval.ts's first-turn trigger call — see that
// function's docstring for why routing both callers through it (rather
// than each updating the registry from its own copy of the result) matters.
// ---------------------------------------------------------------------------

let _databankImportAttempted = false;

async function ensureDataBankImported(): Promise<Array<{ name: string; lorebook_id: string }>> {
  if (_databankImportAttempted) return [];
  _databankImportAttempted = true;
  try {
    const result = await api.importFromDatabank();
    return result.imported;
  } catch (err) {
    _databankImportAttempted = false;
    console.warn('[dataBankStore] import-from-databank failed', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDataBankStore = create<DataBankState>((set, get) => ({
  ...loadFromStorage(),

  setEmbeddingsApiKey: async (key) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    await settingsApi.writeSecret(SECRET_KEYS.OPENAI_EMBEDDINGS, trimmed, 'OpenAI Embeddings');
    await useSettingsStore.getState().fetchSecrets();
  },

  addDocument: (name, content, scope, characterAvatar) => {
    const trimmedName = name.trim() || 'Untitled';
    const chunks = chunkText(content);
    const entries: Array<Partial<Omit<WorldInfoEntry, 'id' | 'createdAt' | 'updatedAt'>>> =
      chunks.map((text, i) => ({
        content: text,
        comment: `chunk ${i + 1} of ${trimmedName}`,
        keys: [],
        semanticOnly: true,
        source: 'import',
      }));
    const ownerCharacterAvatar = scope === 'character' ? characterAvatar ?? null : null;
    const book = useWorldInfoStore
      .getState()
      .createBookWithEntries(trimmedName, entries, ownerCharacterAvatar);

    // A global document has to be ACTIVE or it does nothing — and worse than
    // nothing: scanMessagesForEntries skips inactive books, and an inactive
    // world book makes every solo chat on the account ineligible for server
    // retrieval (serverRetrieval.ts condition 4), silently demoting all of
    // the user's OTHER lore to the keyword-only local scan. Adding one
    // document used to turn server retrieval off account-wide, permanently.
    //
    // Character-scoped documents are deliberately NOT activated: activeBookIds
    // is global, and an active character-scoped book owned by someone other
    // than the character generating disqualifies that chat too (condition 5).
    // They reach the scan through characterStore.getActiveBookIdsForCharacter,
    // which unions every book the character owns.
    if (book.scope === 'world') {
      useWorldInfoStore.getState().setBookActive(book.id, true);
    }

    const lorebookIds = [...get().lorebookIds, book.id];
    saveIndex(indexSnapshot({ lorebookIds }));
    set({ lorebookIds });
    return book.id;
  },

  resetUser: () => {
    set({ lorebookIds: [], deactivatedDocumentIds: [] });
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(LEGACY_DOCUMENTS_STORAGE_KEY); } catch { /* ignore */ }
    // Legacy: older builds stored the embeddings key in localStorage; purge it.
    try { localStorage.removeItem(LEGACY_EMBED_KEY_STORAGE); } catch { /* ignore */ }
    clearLocalTs(LOCAL_TS_KEY);
    _databankImportAttempted = false;
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | (PersistedShape & { _ts?: number })
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (!stored) {
        _persistEnabled = true;
        const snapshot = indexSnapshot();
        if (snapshot.lorebookIds.length > 0) {
          patchServerKey(
            SERVER_KEY,
            snapshot as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
      } else if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          indexSnapshot() as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
      } else {
        _persistEnabled = false;
        const snapshot: IndexSnapshot = {
          lorebookIds: strings(stored.lorebookIds),
          deactivatedDocumentIds: strings(stored.deactivatedDocumentIds),
        };
        writeCache(snapshot);
        try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
        set(snapshot);
        _persistEnabled = true;
      }
    } catch {
      _persistEnabled = true;
    }

    try {
      await ensureDataBankImportedAndIndexed();
    } catch {
      // ensureDataBankImported already handles its own retry guard/logging.
    }

    // Repair documents added before global documents were activated on
    // creation — see backfillDocumentBookActivation. This is the earliest
    // call, not the only one: worldInfoStore's books may still be a stale
    // cache (or empty) at this point, and the subscription at the bottom of
    // this module re-runs the repair when they land.
    backfillDocumentBookActivation();
  },
}));

/**
 * Shared entrypoint for the one-time Data Bank -> Lorebook migration.
 * There are TWO independent, unordered triggers for it: this store's own
 * fetchPrefs (above, fired at login) and serverRetrieval.ts's first-turn
 * safety net (fired lazily, only once a chat generation is actually
 * eligible for server-side retrieval). Whichever fires first "wins" the
 * one-shot server-side import (ensureDataBankImported's own guard, plus
 * the backend's idempotent skip-if-already-exists) — routing BOTH
 * triggers through this single function is what guarantees whichever one
 * actually performs the network call is also the one that updates
 * lorebookIds. Without this, a loser-takes-nothing bug is real and
 * permanent: the trigger that loses the race always sees an empty
 * `imported` list (everything already migrated), so if it were the only
 * one updating the registry, the registry could end up NEVER populated
 * for that user — the books would exist and work fine for retrieval, but
 * their Data Bank provenance would be silently lost forever.
 */
export async function ensureDataBankImportedAndIndexed(): Promise<void> {
  const migrated = await ensureDataBankImported();
  if (migrated.length === 0) {
    // Nothing to migrate is the ordinary case for an already-migrated
    // account, and it used to return here — which put the activation repair
    // retry below on the far side of an early return that is ALWAYS taken,
    // i.e. made it dead code for every account that needed it. The repair is
    // cheap and idempotent; run it on every trip through here.
    backfillDocumentBookActivation();
    return;
  }
  const migratedIds = migrated.map((b) => b.lorebook_id);
  const current = useDataBankStore.getState().lorebookIds;
  const lorebookIds = Array.from(new Set([...current, ...migratedIds]));
  saveIndex(indexSnapshot({ lorebookIds }));
  useDataBankStore.setState({ lorebookIds });
  // Refresh worldInfoStore's book list so the just-migrated books show up
  // without waiting for the next login. Best-effort: if this fails, the
  // books still exist server-side (the migration endpoint already
  // committed them) and will surface on the next successful native-books
  // fetch regardless.
  useWorldInfoStore
    .getState()
    .fetchPrefs()
    .then(() => backfillDocumentBookActivation())
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Activation repair for documents added before this fix
// ---------------------------------------------------------------------------

/**
 * Activates every global document book that isn't already active and that
 * the user hasn't deliberately switched off.
 *
 * addDocument never activated the book it created, so on an existing account
 * every global document is sitting inactive. That is not merely "the document
 * doesn't fire": an inactive world book trips
 * isChatEligibleForServerRetrieval's condition 4, which turns server-side
 * retrieval off for EVERY solo chat on the account and demotes all of the
 * user's other lore to the keyword-only local scan. Adding one document was
 * enough to do it, permanently, with nothing in the UI to say so.
 *
 * Global scope only: a character-scoped document must stay out of the global
 * activeBookIds (condition 5 — see addDocument's note), and reaches the scan
 * through getActiveBookIdsForCharacter instead.
 *
 * Deliberately has NO once-per-session guard, which is the opposite of how
 * this started, and the reason is the whole shape of the fix:
 *
 * A guard needs a readiness test, and every cheap one is wrong. "The book
 * list is non-empty" was the one used, and it fails on the ordinary case:
 * both stores' fetchPrefs fire unordered from authStore, and worldInfoStore
 * seeds `books` synchronously from a localStorage cache that can predate a
 * document added on another device. So a non-empty book list happily
 * coexists with an id that does not resolve — the guard armed, the
 * unresolvable id was skipped, and the account-wide retrieval outage this
 * repair exists to end survived the entire session.
 *
 * The honest readiness test is per id, and the honest response to "not
 * resolvable yet" is to try again later. So: repair whatever resolves now,
 * and let the caller (and the book-list subscription at the bottom of this
 * module) call again. Idempotent by construction — every book it would
 * touch is one that is registered, world-scoped, and currently inactive.
 *
 * Re-running is only SAFE because a deliberate deactivation is recorded
 * durably in `deactivatedDocumentIds`. A module flag could never carry that:
 * it resets on every page load, so the repair could not tell "never
 * activated" from "the user turned this off", and it chose wrong every
 * single reload — silently re-activating a document the user had switched
 * off, with no sequence of actions that made it stick.
 */
export function backfillDocumentBookActivation(): void {
  const { lorebookIds: documentIds, deactivatedDocumentIds } =
    useDataBankStore.getState();
  if (documentIds.length === 0) return;
  const wi = useWorldInfoStore.getState();
  const optedOut = new Set(deactivatedDocumentIds);
  for (const id of documentIds) {
    // Unresolvable means "not visible to us yet, or gone" — never "nothing
    // to do". Skipping it here costs one more array scan on the next call.
    const book = wi.books.find((b) => b.id === id);
    if (!book) continue;
    if (book.scope !== 'world') continue;
    if (optedOut.has(id)) continue;
    if (wi.activeBookIds.includes(id)) continue;
    useWorldInfoStore.getState().setBookActive(id, true);
  }
}

// ---------------------------------------------------------------------------
// Cross-store wiring, all of it through documentBookRegistry.ts. Registering
// with a leaf module rather than reaching into worldInfoStore from module
// scope is not style: the two stores close a module-init cycle
// (worldInfoStore -> loreConflictStore -> authStore -> dataBankStore), so a
// direct call here runs against a half-evaluated module and TDZ-crashes the
// app on load. See that module's header.
// ---------------------------------------------------------------------------

/** Keep worldInfoStore's document-identity check backed by the registry, so
 *  a character-scoped document is never mistaken for the card's embedded
 *  lorebook and overwritten — no matter what its entries look like after the
 *  user has edited them (#450 F3). */
setDocumentBookIds(useDataBankStore.getState().lorebookIds);
useDataBankStore.subscribe((state, prev) => {
  if (state.lorebookIds === prev.lorebookIds) return;
  setDocumentBookIds(state.lorebookIds);
});

/** Record the user's own activation choices for document books. Only
 *  toggleBookActive reaches this — the repair's setBookActive deliberately
 *  does not — so "off" here always means the user said off. */
onUserBookActivation((bookId, active) => {
  const { lorebookIds, deactivatedDocumentIds } = useDataBankStore.getState();
  // Non-documents have nothing to opt out of: the repair only ever touches
  // ids in the registry.
  if (!lorebookIds.includes(bookId)) return;
  const alreadyRecorded = deactivatedDocumentIds.includes(bookId);
  let next: string[];
  if (!active && !alreadyRecorded) {
    next = [...deactivatedDocumentIds, bookId];
  } else if (active && alreadyRecorded) {
    next = deactivatedDocumentIds.filter((id) => id !== bookId);
  } else {
    return;
  }
  saveIndex(indexSnapshot({ deactivatedDocumentIds: next }));
  useDataBankStore.setState({ deactivatedDocumentIds: next });
});

/** Retry the repair whenever worldInfoStore's book list changes. This is
 *  what makes the per-id readiness rule above converge: the login-time call
 *  legitimately runs against an empty or stale `books`, and this fires when
 *  the real list lands. Costs one early return for accounts with no
 *  documents, which is most of them. */
onBooksChanged(() => {
  backfillDocumentBookActivation();
});
