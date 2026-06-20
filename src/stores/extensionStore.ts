import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getSettingsBlob, patchServerKey } from '../utils/serverSettings';

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

// ---------------------------------------------------------------------------
// Server sync (mirrors displayPreferencesStore)
//
// Which extensions are enabled now follows the user across devices via the
// `stm_extensions` settings section. localStorage stays the instant-render
// cache; every mutation patches the server in the background. The per-handle
// local-ts key lets fetchPrefs detect a failed patch and re-upload rather than
// clobber newer local state with a stale server copy.
// ---------------------------------------------------------------------------

const SERVER_KEY = 'stm_extensions';

function localTsKey(): string {
  return _currentHandle
    ? `stm:extensions-local-ts_${_currentHandle}`
    : 'stm:extensions-local-ts';
}

function markLocalDirty(): void {
  try { localStorage.setItem(localTsKey(), String(Date.now())); } catch { /* ignore */ }
}

async function patchServer(patch: Record<string, unknown>): Promise<void> {
  const settings = await getSettingsBlob();
  const section = (settings[SERVER_KEY] as Record<string, unknown>) || {};
  Object.assign(section, patch);
  await patchServerKey(SERVER_KEY, section, localTsKey());
}

interface ExtensionState {
  /** Per-extension enabled state. Keys are extension IDs (e.g. 'tts', 'summarize'). */
  enabled: Record<string, boolean>;
  setEnabled: (id: string, on: boolean) => void;
  /** Pull enabled state from the server after login and reconcile with local. */
  fetchPrefs: () => Promise<void>;
  initForUser: (handle: string) => void;
  resetUser: () => void;
}

export const useExtensionStore = create<ExtensionState>()(
  persist(
    (set, get) => ({
      enabled: {},
      setEnabled: (id, on) => {
        set((s) => ({ enabled: { ...s.enabled, [id]: on } }));
        markLocalDirty();
        patchServer({ enabled: get().enabled }).catch(() => {});
      },
      fetchPrefs: async () => {
        try {
          const settings = await getSettingsBlob();
          const section = settings[SERVER_KEY] as Record<string, unknown> | undefined;
          const localTs = Number(localStorage.getItem(localTsKey()) || 0);
          const serverTs = Number(section?._ts || 0);

          if (localTs > serverTs) {
            // Local has mutations that never confirmed to the server — re-upload.
            patchServer({ enabled: get().enabled }).catch(() => {});
            return;
          }

          if (!section) return; // No server state and no newer local — keep local.

          const enabled = (section.enabled as Record<string, boolean>) ?? get().enabled;
          try { localStorage.setItem(localTsKey(), String(serverTs)); } catch { /* ignore */ }
          set({ enabled });
        } catch { /* non-fatal — localStorage values remain active */ }
      },
      initForUser: (handle) => {
        _currentHandle = handle;
        useExtensionStore.persist.rehydrate();
      },
      resetUser: () => {
        _currentHandle = null;
        set({ enabled: {} });
      },
    }),
    {
      name: 'st-mobile-extensions',
      storage: createJSONStorage(() => scopedLocalStorage),
    }
  )
);
