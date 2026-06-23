import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getSettingsBlob, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';

let _currentHandle: string | null = null;

const scopedLocalStorage = {
  getItem: (name: string) => {
    const key = _currentHandle ? `${name}_${_currentHandle}` : name;
    return localStorage.getItem(key);
  },
  setItem: (name: string, value: string) => {
    const key = _currentHandle ? `${name}_${_currentHandle}` : name;
    localStorage.setItem(key, value);
  },
  removeItem: (name: string) => {
    const key = _currentHandle ? `${name}_${_currentHandle}` : name;
    localStorage.removeItem(key);
  },
};

// Cross-device sync of the authored quick-reply sets via `stm_quick_replies`.
// `activeSetId` is a local UI selection and intentionally not synced. Because
// there are many mutators, a single subscription pushes whenever `sets` changes
// rather than threading a call through every action. Pushes are gated by
// _syncEnabled so the initial rehydrate, the fetchPrefs apply, and logout's
// resetUser() can't echo back to the server.
const SERVER_KEY = 'stm_quick_replies';

function localTsKey(): string {
  return _currentHandle ? `stm:quick-replies-local-ts_${_currentHandle}` : 'stm:quick-replies-local-ts';
}

let _syncEnabled = false;
let _syncTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePush(sets: QuickReplySet[]): void {
  if (!_syncEnabled) return;
  markSectionDirty(localTsKey());
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    patchServerKey(SERVER_KEY, { sets }, localTsKey()).catch(() => {});
  }, 500);
}

export interface QuickReplyEntry {
  id: string;
  label: string;
  message: string;
}

export interface QuickReplySet {
  id: string;
  name: string;
  entries: QuickReplyEntry[];
}

interface QuickReplyState {
  sets: QuickReplySet[];
  activeSetId: string | null;

  setActiveSet: (id: string | null) => void;

  createSet: (name: string) => string;
  renameSet: (id: string, name: string) => void;
  deleteSet: (id: string) => void;

  addEntry: (setId: string, label: string, message: string) => void;
  updateEntry: (setId: string, entryId: string, label: string, message: string) => void;
  deleteEntry: (setId: string, entryId: string) => void;
  moveEntryUp: (setId: string, entryId: string) => void;
  moveEntryDown: (setId: string, entryId: string) => void;
  /** Seed quick-reply sets from the server after login. */
  fetchPrefs: () => Promise<void>;
  initForUser: (handle: string) => void;
  resetUser: () => void;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const useQuickReplyStore = create<QuickReplyState>()(
  persist(
    (set, get) => ({
      sets: [],
      activeSetId: null,

      setActiveSet: (id) => set({ activeSetId: id }),

      createSet: (name) => {
        const id = uid();
        set((s) => ({ sets: [...s.sets, { id, name: name.trim() || 'New Set', entries: [] }] }));
        return id;
      },

      renameSet: (id, name) =>
        set((s) => ({
          sets: s.sets.map((qs) =>
            qs.id === id ? { ...qs, name: name.trim() || qs.name } : qs
          ),
        })),

      deleteSet: (id) =>
        set((s) => ({
          sets: s.sets.filter((qs) => qs.id !== id),
          activeSetId: s.activeSetId === id ? null : s.activeSetId,
        })),

      addEntry: (setId, label, message) =>
        set((s) => ({
          sets: s.sets.map((qs) =>
            qs.id === setId
              ? {
                  ...qs,
                  entries: [
                    ...qs.entries,
                    { id: uid(), label: label.trim(), message },
                  ],
                }
              : qs
          ),
        })),

      updateEntry: (setId, entryId, label, message) =>
        set((s) => ({
          sets: s.sets.map((qs) =>
            qs.id === setId
              ? {
                  ...qs,
                  entries: qs.entries.map((e) =>
                    e.id === entryId ? { ...e, label: label.trim(), message } : e
                  ),
                }
              : qs
          ),
        })),

      deleteEntry: (setId, entryId) =>
        set((s) => ({
          sets: s.sets.map((qs) =>
            qs.id === setId
              ? { ...qs, entries: qs.entries.filter((e) => e.id !== entryId) }
              : qs
          ),
        })),

      moveEntryUp: (setId, entryId) =>
        set((s) => ({
          sets: s.sets.map((qs) => {
            if (qs.id !== setId) return qs;
            const idx = qs.entries.findIndex((e) => e.id === entryId);
            if (idx <= 0) return qs;
            const entries = [...qs.entries];
            [entries[idx - 1], entries[idx]] = [entries[idx], entries[idx - 1]];
            return { ...qs, entries };
          }),
        })),

      moveEntryDown: (setId, entryId) =>
        set((s) => ({
          sets: s.sets.map((qs) => {
            if (qs.id !== setId) return qs;
            const idx = qs.entries.findIndex((e) => e.id === entryId);
            if (idx < 0 || idx >= qs.entries.length - 1) return qs;
            const entries = [...qs.entries];
            [entries[idx], entries[idx + 1]] = [entries[idx + 1], entries[idx]];
            return { ...qs, entries };
          }),
        })),
      fetchPrefs: async () => {
        _syncEnabled = false;
        try {
          const settings = await getSettingsBlob();
          const section = settings[SERVER_KEY] as { sets?: QuickReplySet[]; _ts?: number } | undefined;
          const serverTs = Number(section?._ts || 0);
          if (shouldReuploadSection(localTsKey(), serverTs)) {
            patchServerKey(SERVER_KEY, { sets: get().sets }, localTsKey()).catch(() => {});
            return;
          }
          if (section && Array.isArray(section.sets)) {
            set({ sets: section.sets });
            try { recordServerTs(localTsKey(), serverTs); } catch { /* ignore */ }
          }
        } catch { /* non-fatal — localStorage values remain active */ } finally {
          _syncEnabled = true;
        }
      },

      initForUser: (handle) => {
        _currentHandle = handle;
        useQuickReplyStore.persist.rehydrate();
      },
      resetUser: () => {
        // Disable sync first so clearing in-memory state on logout never pushes
        // an empty set up to the server.
        _syncEnabled = false;
        if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
        _currentHandle = null;
        set({ sets: [], activeSetId: null });
      },
    }),
    {
      name: 'quick-reply-store',
      storage: createJSONStorage(() => scopedLocalStorage),
    }
  )
);

// Push authored sets to the server whenever they change (gated by _syncEnabled).
useQuickReplyStore.subscribe((state, prev) => {
  if (state.sets !== prev.sets) schedulePush(state.sets);
});
