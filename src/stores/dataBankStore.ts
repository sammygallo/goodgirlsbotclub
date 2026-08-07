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
 *  1. `addDocument`/`deleteDocument` — a thin, Data-Bank-flavored front end
 *     over `worldInfoStore.ts`'s native CRUD (`createBookWithEntries`/
 *     `deleteBook`), so paste/upload stays a one-call action instead of the
 *     caller hand-assembling chunks + entries itself.
 *  2. A small index (`stm_data_bank_index` — a NEW server section,
 *     deliberately NOT the legacy `stm_data_bank` blob, see the module
 *     docstring on `fetchPrefs` below) of which of the user's lorebook ids
 *     came from a Data Bank upload, purely so `DataBankPage.tsx` can show a
 *     filtered "your documents" view instead of the user's whole library.
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

// ---------------------------------------------------------------------------
// Embeddings-key gate — unchanged by the native-Lorebook cutover. The SAME
// secret (api_key_openai_embeddings, falling back to api_key_openai) is what
// the server-side background embedding worker uses to embed newly-created
// entries (app/workers/embeddings.py) — this store just surfaces whether
// one is configured so DataBankPage can warn "documents won't be searchable
// until you add a key," same message, different (now server-side) consumer.
// ---------------------------------------------------------------------------

/** True if the embeddings proxy will find a usable key server-side: a dedicated
 *  embeddings secret or the chat OpenAI key it falls back to — set either as the
 *  user's personal secret or (when sharing is on) an owner-managed global one.
 *  Mirrors the personal-OR-global check the provider keys use in MyKeysPage. */
export function embeddingsConfigured(
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

  /** Deletes the underlying lorebook (via worldInfoStore.deleteBook) and
   *  drops it from this store's index. */
  deleteDocument: (id: string) => void;

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
}

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(lorebookIds: string[]): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      { lorebookIds } as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 500);
}

function loadFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedShape;
      return Array.isArray(parsed.lorebookIds) ? parsed.lorebookIds : [];
    }
  } catch { /* ignore */ }
  return [];
}

function writeCache(lorebookIds: string[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ lorebookIds } satisfies PersistedShape),
    );
  } catch { /* ignore */ }
}

function saveIndex(lorebookIds: string[]): void {
  writeCache(lorebookIds);
  schedulePersist(lorebookIds);
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
  lorebookIds: loadFromStorage(),

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

    const lorebookIds = [...get().lorebookIds, book.id];
    saveIndex(lorebookIds);
    set({ lorebookIds });
    return book.id;
  },

  deleteDocument: (id) => {
    useWorldInfoStore.getState().deleteBook(id);
    const lorebookIds = get().lorebookIds.filter((bookId) => bookId !== id);
    saveIndex(lorebookIds);
    set({ lorebookIds });
  },

  resetUser: () => {
    set({ lorebookIds: [] });
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
        const lorebookIds = get().lorebookIds;
        if (lorebookIds.length > 0) {
          patchServerKey(
            SERVER_KEY,
            { lorebookIds } as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
      } else if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          { lorebookIds: get().lorebookIds } as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
      } else {
        _persistEnabled = false;
        const lorebookIds = Array.isArray(stored.lorebookIds) ? stored.lorebookIds : [];
        writeCache(lorebookIds);
        try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
        set({ lorebookIds });
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
 * would silently vanish from the Data Bank page forever.
 */
export async function ensureDataBankImportedAndIndexed(): Promise<void> {
  const migrated = await ensureDataBankImported();
  if (migrated.length === 0) return;
  const migratedIds = migrated.map((b) => b.lorebook_id);
  const current = useDataBankStore.getState().lorebookIds;
  const lorebookIds = Array.from(new Set([...current, ...migratedIds]));
  saveIndex(lorebookIds);
  useDataBankStore.setState({ lorebookIds });
  // Refresh worldInfoStore's book list so the just-migrated books show up
  // without waiting for the next login. Best-effort: if this fails, the
  // books still exist server-side (the migration endpoint already
  // committed them) and will surface on the next successful native-books
  // fetch regardless.
  useWorldInfoStore
    .getState()
    .fetchPrefs()
    .catch(() => {});
}
