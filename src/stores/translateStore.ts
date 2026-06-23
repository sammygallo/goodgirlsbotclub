import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { translateText, type TranslateProvider } from '../api/translateApi';
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

// Cross-device sync of the translation provider + target language via the
// `stm_translate` section. The response cache / pending / visible sets stay
// local (session-only).
const SERVER_KEY = 'stm_translate';

function localTsKey(): string {
  return _currentHandle ? `stm:translate-local-ts_${_currentHandle}` : 'stm:translate-local-ts';
}

async function patchServer(patch: Record<string, unknown>): Promise<void> {
  const settings = await getSettingsBlob();
  const section = (settings[SERVER_KEY] as Record<string, unknown>) || {};
  Object.assign(section, patch);
  await patchServerKey(SERVER_KEY, section, localTsKey());
}

interface TranslateState {
  // Persisted settings
  provider: TranslateProvider;
  targetLang: string;

  // Session state (not persisted)
  cache: Map<string, string>;   // messageId → translated text
  pending: Set<string>;         // messageIds currently being fetched
  visible: Set<string>;         // messageIds with translation panel open

  setProvider: (p: TranslateProvider) => void;
  setTargetLang: (l: string) => void;
  /** Toggle the translation panel for a message. Fetches from API if not cached. */
  toggleTranslation: (messageId: string, text: string) => Promise<void>;
  /** Seed provider + target language from the server after login. */
  fetchPrefs: () => Promise<void>;
  initForUser: (handle: string) => void;
  resetUser: () => void;
}

export const useTranslateStore = create<TranslateState>()(
  persist(
    (set, get) => ({
      provider: 'google',
      targetLang: 'en',
      cache: new Map(),
      pending: new Set(),
      visible: new Set(),

      setProvider: (p) => {
        // Changing provider invalidates all cached translations
        set({ provider: p, cache: new Map(), visible: new Set() });
        markSectionDirty(localTsKey());
        patchServer({ provider: p }).catch(() => {});
      },

      setTargetLang: (l) => {
        // Changing target language invalidates all cached translations
        set({ targetLang: l, cache: new Map(), visible: new Set() });
        markSectionDirty(localTsKey());
        patchServer({ targetLang: l }).catch(() => {});
      },

      toggleTranslation: async (messageId, text) => {
        const { visible, cache, pending, provider, targetLang } = get();

        // --- Hide ---
        if (visible.has(messageId)) {
          const next = new Set(visible);
          next.delete(messageId);
          set({ visible: next });
          return;
        }

        // Debounce: ignore if already fetching
        if (pending.has(messageId)) return;

        // --- Show from cache ---
        if (cache.has(messageId)) {
          const next = new Set(visible);
          next.add(messageId);
          set({ visible: next });
          return;
        }

        // --- Fetch then show ---
        // Add to visible immediately so the panel mounts with a loading state
        const nextPending = new Set(pending);
        nextPending.add(messageId);
        const nextVisible = new Set(visible);
        nextVisible.add(messageId);
        set({ pending: nextPending, visible: nextVisible });

        try {
          const translated = await translateText(text, targetLang, provider);
          const s = get();
          const newCache = new Map(s.cache);
          newCache.set(messageId, translated);
          const newPending = new Set(s.pending);
          newPending.delete(messageId);
          set({ cache: newCache, pending: newPending });
        } catch (err) {
          console.error('Translation failed:', err);
          const s = get();
          const newPending = new Set(s.pending);
          newPending.delete(messageId);
          const newVisible = new Set(s.visible);
          newVisible.delete(messageId);
          set({ pending: newPending, visible: newVisible });
        }
      },

      fetchPrefs: async () => {
        try {
          const settings = await getSettingsBlob();
          const section = settings[SERVER_KEY] as Record<string, unknown> | undefined;
          const serverTs = Number(section?._ts || 0);
          if (shouldReuploadSection(localTsKey(), serverTs)) {
            const s = get();
            patchServer({ provider: s.provider, targetLang: s.targetLang }).catch(() => {});
            return;
          }
          if (!section) return;
          const cur = get();
          const provider = (section.provider as TranslateProvider) ?? cur.provider;
          const targetLang = typeof section.targetLang === 'string' ? section.targetLang : cur.targetLang;
          try { recordServerTs(localTsKey(), serverTs); } catch { /* ignore */ }
          set({ provider, targetLang });
        } catch { /* non-fatal — localStorage values remain active */ }
      },

      initForUser: (handle) => {
        _currentHandle = handle;
        useTranslateStore.persist.rehydrate();
      },
      resetUser: () => {
        _currentHandle = null;
        set({ provider: 'google', targetLang: 'en', cache: new Map(), pending: new Set(), visible: new Set() });
      },
    }),
    {
      name: 'st-mobile-translate',
      storage: createJSONStorage(() => scopedLocalStorage),
      partialize: (state) => ({
        provider: state.provider,
        targetLang: state.targetLang,
      }),
    }
  )
);
