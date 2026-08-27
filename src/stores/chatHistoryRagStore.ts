/**
 * Chat-history RAG settings — the opt-in switch for server-side
 * chat-history recall (Phase 2 of the memory-consolidation plan;
 * docs/memory-consolidation-plan.md).
 *
 * This store used to also own the embedding/query machinery itself
 * (client-side `ensureEmbedded`/`queryTopK` over an in-memory
 * `embeddingsByChat` cache, each new message costing a direct OpenAI call
 * from the browser). That's gone: embedding now happens server-side, as a
 * side effect of `POST /chats/save` (gated on `enabled` below), and
 * recall is a single `POST /retrieval/messages` call — see
 * `resolveRagContext` in chatStore.ts, which is handed the raw-history
 * boundary by its caller rather than deriving one. This
 * store keeps exactly what's still genuinely client-side: the `enabled`
 * flag itself (synced, same as before) and the one-time enable-time
 * backfill trigger for chats that predate this cutover.
 */

import { create } from 'zustand';
import { showToastGlobal } from '../components/ui/Toast';
import { api } from '../api/client';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';

interface ChatHistoryRagState {
  /** Master switch — when off, no embedding jobs get enqueued server-side
   *  and /retrieval/messages always returns no chunks. */
  enabled: boolean;

  setEnabled: (on: boolean) => void;
  /** Fetch from server after login and apply. No-op if no server data yet.
   *  Also the "session start" hook for the enable-time backfill trigger —
   *  see triggerBackfillIfNeeded below. */
  fetchPrefs: () => Promise<void>;
  /** Wipe this store's state + localStorage keys for the current user (logout/switch). */
  resetUser: () => void;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const ENABLED_KEY = 'stm:chat-history-rag-enabled';

// The heavy per-message embeddings/vectors cache this key used to hold is
// gone (see module docstring) — nothing left to purge here going forward,
// but old builds may still have it, so keep clearing it defensively.
const STALE_STORAGE_KEY = 'stm:chat-history-rag';
try { localStorage.removeItem(STALE_STORAGE_KEY); } catch { /* ignore */ }

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

// ---------------------------------------------------------------------------
// Enable-time backfill — state-checked (fires whenever `enabled` is true at
// session start), not transition-only (setEnabled(true) alone would miss
// every user whose flag was already on before this cutover). Session-guarded
// via a module-level flag, same shape as chatStore.ts's `wiPinnedWarnedChats`
// Set for the WI budget toast — this one has no per-chat key since it's a
// once-per-session action, not a once-per-chat one.
// ---------------------------------------------------------------------------

let backfillTriggeredThisSession = false;

async function triggerBackfillIfNeeded(): Promise<void> {
  if (backfillTriggeredThisSession) return;
  backfillTriggeredThisSession = true;
  try {
    const { queued } = await api.ensureMessageEmbeddings();
    if (queued > 0) {
      showToastGlobal(
        `Indexing your past chats for recall — ${queued} chat${queued === 1 ? '' : 's'} queued on your embeddings key. Recall improves as indexing completes.`,
        'info'
      );
    }
  } catch {
    /* best-effort — a failed backfill trigger is never user-facing */
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatHistoryRagStore = create<ChatHistoryRagState>((set, get) => ({
  enabled: loadEnabled(),

  setEnabled: (on) => {
    saveEnabled(on);
    set({ enabled: on });
    try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
    patchServerKey(SERVER_KEY, { enabled: on }, LOCAL_TS_KEY).catch(() => {});
    if (on) void triggerBackfillIfNeeded();
  },

  resetUser: () => {
    set({ enabled: false });
    try { localStorage.removeItem(STALE_STORAGE_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(ENABLED_KEY); } catch { /* ignore */ }
    clearLocalTs(LOCAL_TS_KEY);
    backfillTriggeredThisSession = false;
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as Record<string, unknown> | undefined;
      const serverTs = Number(stored?._ts || 0);
      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        patchServerKey(SERVER_KEY, { enabled: get().enabled }, LOCAL_TS_KEY).catch(() => {});
        return;
      }
      if (stored) {
        const enabled = typeof stored.enabled === 'boolean' ? stored.enabled : get().enabled;
        saveEnabled(enabled);
        try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
        set({ enabled });
      }
    } catch {
      /* non-fatal */
    } finally {
      if (get().enabled) void triggerBackfillIfNeeded();
    }
  },
}));
