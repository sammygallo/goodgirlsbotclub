/**
 * Chat-history RAG — embeddings over the user's own past chat turns.
 *
 * Companion to dataBankStore: same embeddings API + cosine search, but the
 * source is the live chat instead of user-uploaded docs. The point is to
 * recall specific past moments by semantic relevance instead of paying to
 * keep them in raw history every turn.
 *
 * Lifecycle:
 *   - The chat generation path calls `ensureEmbedded(chatFile, messages)`
 *     before building context. Any messages that don't yet have an embedding
 *     are embedded one-by-one and persisted.
 *   - At query time, `queryTopK(chatFile, query, k)` returns the top-K most
 *     relevant past messages by cosine similarity.
 *   - `clearChat(chatFile)` wipes a chat's stored embeddings (e.g. after a
 *     "Start new chat" reset).
 *
 * Cost: each new message costs one OpenAI embedding call. Opt-in only.
 * Storage: ~6 KB per message vector. 1 000 messages ≈ 6 MB localStorage.
 */

import { create } from 'zustand';
import { useDataBankStore } from './dataBankStore';
import { cosineSimilarity, getEmbedding } from '../utils/embeddings';
import { getSettingsBlob, makeLocalTsKey, patchServerKey } from '../utils/serverSettings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessageEmbedding {
  /** Stable id — `${chatFile}#${index}` so re-embedding the same slot is idempotent. */
  id: string;
  /** Original message text (the slice we embedded). */
  text: string;
  /** Speaker label, kept for the retrieval-context preamble. */
  speaker: 'user' | 'assistant';
  embedding: number[];
}

interface ChatHistoryRagState {
  /** Master switch — when off, no embedding calls and no retrieval. */
  enabled: boolean;
  /** Per-message embeddings keyed by chat file name. */
  embeddingsByChat: Record<string, ChatMessageEmbedding[]>;
  /** Whether an embedding pass is currently running for a given chat. */
  embeddingChats: Set<string>;

  setEnabled: (on: boolean) => void;
  /** Fetch from server after login and apply. No-op if no server data yet. */
  fetchPrefs: () => Promise<void>;

  /**
   * Make sure every non-system message in `messages` has an embedding stored
   * for `chatFile`. New messages are embedded sequentially using the Data
   * Bank's OpenAI key. If no key is set, this is a no-op.
   */
  ensureEmbedded: (
    chatFile: string,
    messages: { content: string; isUser: boolean; isSystem: boolean }[]
  ) => Promise<void>;

  /**
   * Return the top-K past messages most relevant to `query`. Results carry
   * the speaker label so callers can render a useful preamble.
   */
  queryTopK: (
    chatFile: string,
    query: string,
    k?: number
  ) => Promise<Array<{ text: string; speaker: 'user' | 'assistant'; score: number }>>;

  clearChat: (chatFile: string) => void;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'stm:chat-history-rag';
const ENABLED_KEY = 'stm:chat-history-rag-enabled';

interface PersistedShape {
  embeddingsByChat: Record<string, ChatMessageEmbedding[]>;
}

function loadFromStorage(): Record<string, ChatMessageEmbedding[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedShape;
      return parsed.embeddingsByChat ?? {};
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveToStorage(embeddingsByChat: Record<string, ChatMessageEmbedding[]>) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ embeddingsByChat } satisfies PersistedShape)
    );
  } catch {
    /* ignore */
  }
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveEnabled(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

const SERVER_KEY = 'stm_rag_settings';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

// Cap how many short trailing messages we skip embedding — those are likely
// already in the raw history window. Anything older needs embeddings to be
// retrievable after compaction.
const TAIL_SKIP = 4;

// Don't bother embedding messages shorter than this — too little signal for
// cosine similarity to do anything useful, and they're cheap to keep raw.
const MIN_CHARS = 40;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatHistoryRagStore = create<ChatHistoryRagState>((set, get) => ({
  enabled: loadEnabled(),
  embeddingsByChat: loadFromStorage(),
  embeddingChats: new Set(),

  setEnabled: (on) => {
    saveEnabled(on);
    set({ enabled: on });
    try { localStorage.setItem(LOCAL_TS_KEY, String(Date.now())); } catch { /* ignore */ }
    patchServerKey(SERVER_KEY, { enabled: on }, LOCAL_TS_KEY).catch(() => {});
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as Record<string, unknown> | undefined;
      const localTs = Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
      const serverTs = Number(stored?._ts || 0);
      if (localTs > serverTs) {
        patchServerKey(SERVER_KEY, { enabled: get().enabled }, LOCAL_TS_KEY).catch(() => {});
        return;
      }
      if (!stored) return;
      const enabled = typeof stored.enabled === 'boolean' ? stored.enabled : get().enabled;
      saveEnabled(enabled);
      try { localStorage.setItem(LOCAL_TS_KEY, String(serverTs)); } catch { /* ignore */ }
      set({ enabled });
    } catch { /* non-fatal */ }
  },

  ensureEmbedded: async (chatFile, messages) => {
    const state = get();
    if (!state.enabled) return;
    if (state.embeddingChats.has(chatFile)) return; // already embedding this chat

    const apiKey = useDataBankStore.getState().embeddingsApiKey;
    if (!apiKey) return;

    const existing = state.embeddingsByChat[chatFile] ?? [];
    const existingIds = new Set(existing.map((e) => e.id));

    // Build the candidate list: every non-system message, capped to leave
    // the live tail alone (no need to embed what's already in raw history).
    const nonSystem = messages.filter((m) => !m.isSystem);
    const sliceEnd = Math.max(0, nonSystem.length - TAIL_SKIP);
    const toCheck = nonSystem.slice(0, sliceEnd);

    const todo: { id: string; text: string; speaker: 'user' | 'assistant' }[] = [];
    for (let i = 0; i < toCheck.length; i++) {
      const msg = toCheck[i];
      const text = msg.content.trim();
      if (text.length < MIN_CHARS) continue;
      const id = `${chatFile}#${i}`;
      if (existingIds.has(id)) continue;
      todo.push({ id, text, speaker: msg.isUser ? 'user' : 'assistant' });
    }
    if (todo.length === 0) return;

    set((s) => ({ embeddingChats: new Set([...s.embeddingChats, chatFile]) }));
    try {
      const fresh: ChatMessageEmbedding[] = [];
      for (const item of todo) {
        try {
          const embedding = await getEmbedding(item.text, apiKey);
          fresh.push({ ...item, embedding });
        } catch {
          // Skip individual failures — partial coverage is still useful.
        }
      }
      if (fresh.length > 0) {
        const next = {
          ...get().embeddingsByChat,
          [chatFile]: [...existing, ...fresh],
        };
        saveToStorage(next);
        set({ embeddingsByChat: next });
      }
    } finally {
      set((s) => {
        const remaining = new Set(s.embeddingChats);
        remaining.delete(chatFile);
        return { embeddingChats: remaining };
      });
    }
  },

  queryTopK: async (chatFile, query, k = 3) => {
    const state = get();
    if (!state.enabled) return [];
    const apiKey = useDataBankStore.getState().embeddingsApiKey;
    if (!apiKey) return [];

    const stored = state.embeddingsByChat[chatFile] ?? [];
    if (stored.length === 0) return [];

    try {
      const queryEmbedding = await getEmbedding(query, apiKey);
      return stored
        .map((m) => ({
          text: m.text,
          speaker: m.speaker,
          score: cosineSimilarity(queryEmbedding, m.embedding),
        }))
        .filter((m) => m.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    } catch {
      return [];
    }
  },

  clearChat: (chatFile) => {
    const next = { ...get().embeddingsByChat };
    delete next[chatFile];
    saveToStorage(next);
    set({ embeddingsByChat: next });
  },
}));
