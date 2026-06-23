/**
 * Phase 8.5 — Data Bank / RAG
 *
 * Stores documents (plain text or .md/.txt uploads), chunks them, and
 * optionally embeds the chunks via OpenAI's text-embedding-3-small model.
 *
 * At generation time the last user message is embedded and the most relevant
 * chunks from in-scope documents are injected into the system prompt.
 *
 * Scope:
 *   'global'    — available in every chat
 *   'character' — only available when `characterAvatar` matches
 *
 * Persistence: localStorage under `stm:data-bank`.
 * Embeddings are included in the persisted blob (they're ~6 KB/chunk).
 */

import { create } from 'zustand';
import { chunkText } from '../utils/chunker';
import { getEmbedding, findTopK } from '../utils/embeddings';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';
import { settingsApi, SECRET_KEYS, type SecretsResponse } from '../api/client';
import { useSettingsStore } from './settingsStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentChunk {
  id: string;
  text: string;
  /** Empty array until the document has been embedded. */
  embedding: number[];
}

export interface DataBankDocument {
  id: string;
  name: string;
  scope: 'global' | 'character';
  /** Set when scope === 'character'. */
  characterAvatar?: string;
  /** Raw source text (kept for re-chunking / display). */
  content: string;
  chunks: DocumentChunk[];
  /** True once all chunks have embeddings. */
  isEmbedded: boolean;
  createdAt: number;
}

interface DataBankState {
  documents: DataBankDocument[];
  /** IDs of documents currently being embedded (transient, not persisted). */
  embeddingIds: Set<string>;

  /**
   * Store the OpenAI embeddings key as a server-side secret
   * (`api_key_openai_embeddings`). The key is never persisted in the browser;
   * the backend embeddings proxy resolves it. Refreshes settingsStore secrets.
   */
  setEmbeddingsApiKey: (key: string) => Promise<void>;

  /** Add a document and chunk it. Returns the new document's id. */
  addDocument: (
    name: string,
    content: string,
    scope: 'global' | 'character',
    characterAvatar?: string
  ) => string;

  deleteDocument: (id: string) => void;

  /**
   * Embed all chunks of a document via the backend embeddings proxy.
   * Throws if no embeddings key is configured server-side.
   */
  embedDocument: (id: string) => Promise<void>;

  /**
   * Find the top-K most relevant chunks for `query` across all in-scope
   * documents (global + those matching `characterAvatar`).
   *
   * Returns an array of {text, docName} objects sorted by relevance, or [] if
   * no embedded documents are in scope, no embeddings key is configured, or the
   * proxy call fails. Each result carries its parent document's name so callers
   * can attribute the source when injecting into a prompt.
   */
  queryRelevantChunks: (
    query: string,
    characterAvatar?: string,
    topK?: number
  ) => Promise<Array<{ text: string; docName: string }>>;

  /** A3.1d — pull /sync/section/stm_data_bank and reconcile. */
  fetchPrefs: () => Promise<void>;
  /** Wipe this store's state + localStorage keys for the current user (logout/switch). */
  resetUser: () => void;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'stm:data-bank';
const SERVER_KEY = 'stm_data_bank';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

/** Legacy localStorage key the embeddings secret used to live under (now moved
 *  server-side). Kept only so resetUser can purge leftovers on upgrade. */
const LEGACY_EMBED_KEY_STORAGE = 'stm:data-bank-embed-key';

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

interface PersistedShape {
  documents: DataBankDocument[];
}

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(documents: DataBankDocument[]): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      { documents } as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 500);
}

function loadFromStorage(): DataBankDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedShape;
      return parsed.documents ?? [];
    }
  } catch { /* ignore */ }
  return [];
}

function saveToStorage(documents: DataBankDocument[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ documents } satisfies PersistedShape));
  } catch { /* ignore */ }
  schedulePersist(documents);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDataBankStore = create<DataBankState>((set, get) => ({
  documents: loadFromStorage(),
  embeddingIds: new Set(),

  setEmbeddingsApiKey: async (key) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    await settingsApi.writeSecret(SECRET_KEYS.OPENAI_EMBEDDINGS, trimmed, 'OpenAI Embeddings');
    await useSettingsStore.getState().fetchSecrets();
  },

  addDocument: (name, content, scope, characterAvatar) => {
    const id = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const rawChunks = chunkText(content);
    const chunks: DocumentChunk[] = rawChunks.map((text, i) => ({
      id: `${id}_chunk_${i}`,
      text,
      embedding: [],
    }));
    const doc: DataBankDocument = {
      id,
      name: name.trim() || 'Untitled',
      scope,
      characterAvatar: scope === 'character' ? characterAvatar : undefined,
      content,
      chunks,
      isEmbedded: false,
      createdAt: Date.now(),
    };
    const documents = [...get().documents, doc];
    saveToStorage(documents);
    set({ documents });
    return id;
  },

  deleteDocument: (id) => {
    const documents = get().documents.filter((d) => d.id !== id);
    saveToStorage(documents);
    set({ documents });
  },

  embedDocument: async (id) => {
    if (!hasEmbeddingsKey()) throw new Error('No embeddings API key configured. Set one in Data Bank settings.');

    const doc = get().documents.find((d) => d.id === id);
    if (!doc) return;

    set((s) => ({ embeddingIds: new Set([...s.embeddingIds, id]) }));

    try {
      const chunks = await Promise.all(
        doc.chunks.map(async (chunk) => {
          // Skip chunks that already have embeddings
          if (chunk.embedding.length > 0) return chunk;
          const embedding = await getEmbedding(chunk.text);
          return { ...chunk, embedding };
        })
      );

      const updatedDoc: DataBankDocument = { ...doc, chunks, isEmbedded: true };
      const documents = get().documents.map((d) => (d.id === id ? updatedDoc : d));
      saveToStorage(documents);
      set({ documents });
    } finally {
      set((s) => {
        const next = new Set(s.embeddingIds);
        next.delete(id);
        return { embeddingIds: next };
      });
    }
  },

  queryRelevantChunks: async (query, characterAvatar, topK = 3) => {
    if (!hasEmbeddingsKey()) return [];

    const { documents } = get();

    // Collect all chunks from in-scope, embedded documents
    const inScope = documents.filter(
      (d) =>
        d.isEmbedded &&
        (d.scope === 'global' ||
          (d.scope === 'character' && d.characterAvatar === characterAvatar))
    );

    if (inScope.length === 0) return [];

    // Attach docName from the parent document at flatten time so retrieval
    // results can be attributed back to their source for provenance.
    const allChunks = inScope.flatMap((d) =>
      d.chunks.map((c) => ({ ...c, docName: d.name }))
    );
    if (allChunks.length === 0) return [];

    try {
      const queryEmbedding = await getEmbedding(query);
      const results = findTopK(queryEmbedding, allChunks, topK);
      // Only return chunks with at least weak relevance (score > 0.3)
      return results
        .filter((r) => r.score > 0.3)
        .map((r) => ({ text: r.text, docName: r.docName }));
    } catch {
      // Fail silently so generation still proceeds without RAG
      return [];
    }
  },

  resetUser: () => {
    set({ documents: [], embeddingIds: new Set() });
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    // Legacy: older builds stored the embeddings key in localStorage; purge it.
    try { localStorage.removeItem(LEGACY_EMBED_KEY_STORAGE); } catch { /* ignore */ }
    clearLocalTs(LOCAL_TS_KEY);
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | { documents?: DataBankDocument[]; _ts?: number }
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (!stored) {
        _persistEnabled = true;
        const documents = get().documents;
        if (documents.length > 0) {
          patchServerKey(
            SERVER_KEY,
            { documents } as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
        return;
      }

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          { documents: get().documents } as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      _persistEnabled = false;
      const documents = Array.isArray(stored.documents) ? stored.documents : [];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ documents }));
        recordServerTs(LOCAL_TS_KEY, serverTs);
      } catch { /* ignore */ }
      // Imported documents have no embeddings yet — caller will re-embed when
      // RAG is next used. Same as the in-memory shape after a fresh load.
      set({ documents, embeddingIds: new Set() });
      _persistEnabled = true;
    } catch {
      _persistEnabled = true;
    }
  },
}));
