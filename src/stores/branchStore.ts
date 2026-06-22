/** Phase 8.6: Chat Branching & Checkpoints
 *
 * A "branch" (checkpoint) is a named snapshot of the conversation up to a
 * specific message. Branches are stored in localStorage keyed by chat file.
 * Loading a branch replaces the in-memory message array without touching disk.
 *
 * A3.1b: branches now sync across devices via /sync/section/stm_branches.
 * localStorage stays as a synchronous cache for instant cold loads; the
 * server is the source of truth once fetchPrefs runs.
 */
import { create } from 'zustand';
import type { ChatMessage } from './chatStore';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';

export interface Branch {
  id: string;
  name: string;
  chatFile: string;
  createdAt: number;
  /** ID of the message this checkpoint was captured after. */
  checkpointMessageId: string;
  /** Number of messages included in the snapshot. */
  messageCount: number;
  /** Full message snapshot at the time of creation. */
  messages: ChatMessage[];
}

const BRANCHES_KEY = 'sillytavern_branches';
const SERVER_KEY = 'stm_branches';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

function loadAllFromStorage(): Record<string, Branch[]> {
  try {
    const stored = localStorage.getItem(BRANCHES_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, Branch[]>;
  } catch {
    return {};
  }
}

function writeLocalStorageOnly(data: Record<string, Branch[]>): void {
  try {
    localStorage.setItem(BRANCHES_KEY, JSON.stringify(data));
  } catch {
    // ignore quota
  }
}

// ---------------------------------------------------------------------------
// Cross-device sync (debounced, post-fetchPrefs only)
// ---------------------------------------------------------------------------

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(data: Record<string, Branch[]>): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      { all: data } as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
}

function saveAllToStorage(data: Record<string, Branch[]>): void {
  writeLocalStorageOnly(data);
  schedulePersist(data);
}

interface BranchState {
  /** Branches for the currently open chat file. */
  branches: Branch[];
  /** Which branch is currently loaded (null = "main" / original file). */
  activeBranchId: string | null;

  /** Call when the active chat file changes to swap in the right branches. */
  loadBranchesForChat(chatFile: string): void;
  /** Snapshot messages up to (and including) messageId under a user-given name. */
  createBranch(params: {
    chatFile: string;
    messageId: string;
    name: string;
    messages: ChatMessage[];
  }): void;
  deleteBranch(id: string, chatFile: string): void;
  renameBranch(id: string, chatFile: string, name: string): void;
  setActiveBranch(id: string | null): void;

  /**
   * Pull /sync/section/stm_branches and reconcile with localStorage.
   * First call per user with no server record seeds the server with whatever
   * is currently in localStorage so pre-A3 checkpoints survive the cutover.
   */
  fetchPrefs(): Promise<void>;
  /** Wipe this store's state + localStorage keys for the current user (logout/switch). */
  resetUser(): void;
}

export const useBranchStore = create<BranchState>((set, get) => ({
  branches: [],
  activeBranchId: null,

  loadBranchesForChat(chatFile) {
    const all = loadAllFromStorage();
    set({ branches: all[chatFile] ?? [], activeBranchId: null });
  },

  createBranch({ chatFile, messageId, name, messages }) {
    const idx = messages.findIndex((m) => m.id === messageId);
    const snapshot = idx >= 0 ? messages.slice(0, idx + 1) : [...messages];

    const branch: Branch = {
      id: `branch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || `Checkpoint ${new Date().toLocaleTimeString()}`,
      chatFile,
      createdAt: Date.now(),
      checkpointMessageId: messageId,
      messageCount: snapshot.length,
      messages: snapshot,
    };

    const all = loadAllFromStorage();
    all[chatFile] = [branch, ...(all[chatFile] ?? [])];
    saveAllToStorage(all);
    set({ branches: all[chatFile] });
  },

  deleteBranch(id, chatFile) {
    const all = loadAllFromStorage();
    all[chatFile] = (all[chatFile] ?? []).filter((b) => b.id !== id);
    saveAllToStorage(all);
    set({
      branches: all[chatFile],
      activeBranchId: get().activeBranchId === id ? null : get().activeBranchId,
    });
  },

  renameBranch(id, chatFile, name) {
    const all = loadAllFromStorage();
    all[chatFile] = (all[chatFile] ?? []).map((b) =>
      b.id === id ? { ...b, name: name.trim() || b.name } : b
    );
    saveAllToStorage(all);
    set({ branches: all[chatFile] });
  },

  setActiveBranch(id) {
    set({ activeBranchId: id });
  },

  resetUser: () => {
    set({ branches: [], activeBranchId: null });
    try { localStorage.removeItem(BRANCHES_KEY); } catch { /* ignore */ }
    clearLocalTs(LOCAL_TS_KEY);
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | { all?: Record<string, Branch[]>; _ts?: number }
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (!stored || !stored.all) {
        // First-ever sync for this user — seed the server with localStorage.
        _persistEnabled = true;
        const local = loadAllFromStorage();
        if (Object.keys(local).length > 0) {
          patchServerKey(
            SERVER_KEY,
            { all: local } as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
        return;
      }

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        // Local has unconfirmed mutations — push them.
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          { all: loadAllFromStorage() } as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      // Server has newer (or equal) state — apply and cache.
      _persistEnabled = false;
      writeLocalStorageOnly(stored.all);
      // We don't know which chat is currently open, so any visible branches
      // will refresh next time loadBranchesForChat is called by the chat view.
      // Clear the in-memory list so stale entries aren't shown.
      set({ branches: [], activeBranchId: null });
      try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
      _persistEnabled = true;
    } catch {
      // Network failure — keep local state. Future mutations will mark
      // LOCAL_TS_KEY dirty, so a later fetchPrefs detects the local-newer case.
      _persistEnabled = true;
    }
  },
}));
