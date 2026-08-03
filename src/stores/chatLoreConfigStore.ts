import { create } from 'zustand';
import {
  getSettingsBlob,
  makeLocalTsKey,
  patchServerKey,
  markSectionDirty,
  recordServerTs,
  shouldReuploadSection,
} from '../utils/serverSettings';
import type { ChatLoreConfig, EntryOverlay } from '../utils/worldInfoComposition';
import { useWorldInfoStore } from './worldInfoStore';
import type { WorldInfoEntry, EntrySource } from './worldInfoStore';

// ---------------------------------------------------------------------------
// Lorebook v2 — per-chat lore config store
// ---------------------------------------------------------------------------
//
// INVARIANT: an ABSENT entry in `configs` for a given chatFile means "no
// config, pure v1 inheritance" — that chat sees exactly the global
// active books, nothing more, nothing overridden. This is the zero-overhead
// default state that the overwhelming majority of chats will be in forever:
// no per-chat storage, no composition work (resolveEffectiveBooks' STEP A
// fast path), nothing to sync. A config only starts existing here the
// moment a chat is actually customized (see updateConfig's "promotion" of a
// legacy chatLinkedBookIds entry, or a brand-new overlay/exclusion/local
// entry). Never write a config just to represent "nothing to see here" —
// getEffectiveConfig synthesizes that ephemeral view on the fly instead.

// ---- Storage keys -----------------------------------------------------------

const CONFIGS_KEY = 'chat_lore_configs_v1';
const SERVER_KEY = 'stm_chat_lore_configs';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

// Module-level handle tracking, mirroring worldInfoStore.ts's own
// _currentHandle / scopedKey pattern exactly so this store's localStorage
// keys are scoped per logged-in user the same way.
let _currentHandle: string | null = null;

function scopedKey(base: string, handle?: string | null): string {
  const h = handle !== undefined ? handle : _currentHandle;
  return h ? `${base}_${h}` : base;
}

// ---- Entry backfill (mirrors worldInfoStore.ts's normalizeStoredBooks) -----
//
// localEntries are WorldInfoEntry[] just like book entries, so a config
// blob written before `source`/`revisions` existed (or by a future/older
// client) needs the same defensive backfill worldInfoStore.ts applies to
// every entry it loads, or downstream code that assumes those fields exist
// will crash.

const ENTRY_SOURCES: readonly EntrySource[] = [
  'manual',
  'auto_memory',
  'import',
  'generated',
  'fork',
];

function isValidEntrySource(value: unknown): value is EntrySource {
  return (
    typeof value === 'string' &&
    (ENTRY_SOURCES as readonly string[]).includes(value)
  );
}

function normalizeLocalEntries(entries: unknown): WorldInfoEntry[] {
  if (!Array.isArray(entries)) return [];
  return (entries as WorldInfoEntry[]).map((e) => ({
    ...e,
    source: isValidEntrySource(e.source)
      ? e.source
      : e.comment === 'Auto-extracted'
        ? 'auto_memory'
        : 'manual',
    revisions: Array.isArray(e.revisions) ? e.revisions.slice(-10) : [],
  }));
}

/**
 * Defensive per-config normalization applied to anything loaded from
 * localStorage or the server sync blob — never trust stored shape.
 */
function normalizeStoredConfigs(
  raw: Record<string, unknown>
): Record<string, ChatLoreConfig> {
  const out: Record<string, ChatLoreConfig> = {};
  for (const [chatFile, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue; // skips a stray `_ts`
    const cfg = value as Partial<ChatLoreConfig>;
    out[chatFile] = {
      chatFile,
      linkedBookIds: Array.isArray(cfg.linkedBookIds)
        ? cfg.linkedBookIds.filter((id): id is string => typeof id === 'string')
        : [],
      excludedEntryIds:
        cfg.excludedEntryIds && typeof cfg.excludedEntryIds === 'object'
          ? cfg.excludedEntryIds
          : {},
      overlays:
        cfg.overlays && typeof cfg.overlays === 'object' ? cfg.overlays : {},
      localEntries: normalizeLocalEntries(cfg.localEntries),
      updatedAt: typeof cfg.updatedAt === 'number' ? cfg.updatedAt : 0,
    };
  }
  return out;
}

function parseConfigs(raw: string): Record<string, ChatLoreConfig> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') return {};
  return normalizeStoredConfigs(parsed);
}

function loadConfigs(handle?: string | null): Record<string, ChatLoreConfig> {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const raw = localStorage.getItem(scopedKey(CONFIGS_KEY, h));
    if (!raw) return {};
    return parseConfigs(raw);
  } catch {
    return {};
  }
}

function saveConfigs(configs: Record<string, ChatLoreConfig>) {
  try {
    localStorage.setItem(scopedKey(CONFIGS_KEY), JSON.stringify(configs));
  } catch {
    // ignore quota/security errors
  }
}

// ---- Legacy per-chat linked-book map ---------------------------------------
//
// Pre-v2, "link extra books to a chat" lived entirely in worldInfoStore's
// chatLinkedBookIds map (chatFile -> bookId[]). v2 configs supersede it, but
// existing chats that only ever used the old feature must keep working
// exactly as before until (and unless) they're promoted to a real config.

function legacyLinkedBookIds(chatFile: string): string[] {
  return useWorldInfoStore.getState().chatLinkedBookIds[chatFile] || [];
}

// ---- Store ------------------------------------------------------------------

interface ChatLoreConfigState {
  /** ONLY ever holds persisted configs — never synthesized/ephemeral ones. */
  configs: Record<string, ChatLoreConfig>;
  error: string | null;

  /** Persisted config only, or undefined. Never synthesizes anything. */
  getConfig: (chatFile: string) => ChatLoreConfig | undefined;

  /**
   * Persisted config if present; otherwise an ephemeral config synthesized
   * from the legacy chatLinkedBookIds map (never written back to `configs`).
   * undefined when neither exists.
   */
  getEffectiveConfig: (chatFile: string) => ChatLoreConfig | undefined;

  /**
   * Upsert-and-persist. Seeds linkedBookIds from the legacy map on first
   * write for a chat (the "promotion" moment), merges excludedEntryIds/
   * overlays key-by-key (patch wins per top-level key), replaces
   * localEntries/linkedBookIds wholesale when present in the patch, and
   * always stamps a fresh updatedAt.
   */
  updateConfig: (
    chatFile: string,
    patch: Partial<Omit<ChatLoreConfig, 'chatFile' | 'updatedAt'>>
  ) => void;

  deleteConfig: (chatFile: string) => void;

  /** Called when a world-info book is deleted — scrubs every reference to it. */
  pruneBook: (bookId: string) => void;

  clearError: () => void;

  // Lifecycle: mirrors worldInfoStore.ts's initForUser/resetUser exactly.
  initForUser: (handle: string) => void;
  resetUser: () => void;

  /** Mirrors worldInfoStore.ts's fetchPrefs three-branch sync logic exactly. */
  fetchPrefs: () => Promise<void>;
}

export const useChatLoreConfigStore = create<ChatLoreConfigState>((set, get) => ({
  // Start empty; populated by initForUser once the authenticated user is known.
  configs: {},
  error: null,

  getConfig: (chatFile) => {
    return get().configs[chatFile];
  },

  getEffectiveConfig: (chatFile) => {
    const existing = get().configs[chatFile];
    if (existing) return existing;
    const legacy = legacyLinkedBookIds(chatFile);
    if (legacy.length === 0) return undefined;
    return {
      chatFile,
      linkedBookIds: [...legacy],
      excludedEntryIds: {},
      overlays: {},
      localEntries: [],
      updatedAt: 0,
    };
  },

  updateConfig: (chatFile, patch) => {
    const now = Date.now();
    const cur = get().configs;
    const existing = cur[chatFile];
    // First real write for this chat: seed from the legacy map (promotion).
    // The legacy map itself is left untouched — just no longer consulted for
    // this chatFile once a real config exists.
    const base: ChatLoreConfig =
      existing ?? {
        chatFile,
        linkedBookIds: [...legacyLinkedBookIds(chatFile)],
        excludedEntryIds: {},
        overlays: {},
        localEntries: [],
        updatedAt: 0,
      };

    const mergedExcludedEntryIds: Record<string, string[]> = {
      ...base.excludedEntryIds,
      ...(patch.excludedEntryIds ?? {}),
    };
    const mergedOverlays: Record<string, EntryOverlay> = {
      ...base.overlays,
      ...(patch.overlays ?? {}),
    };

    const next: ChatLoreConfig = {
      ...base,
      ...patch,
      chatFile,
      excludedEntryIds: mergedExcludedEntryIds,
      overlays: mergedOverlays,
      linkedBookIds:
        patch.linkedBookIds !== undefined
          ? patch.linkedBookIds
          : base.linkedBookIds,
      localEntries:
        patch.localEntries !== undefined
          ? patch.localEntries
          : base.localEntries,
      updatedAt: now,
    };

    const nextConfigs = { ...cur, [chatFile]: next };
    saveConfigs(nextConfigs);
    set({ configs: nextConfigs });
  },

  deleteConfig: (chatFile) => {
    const cur = get().configs;
    if (!(chatFile in cur)) return;
    const next = { ...cur };
    delete next[chatFile];
    saveConfigs(next);
    set({ configs: next });
  },

  pruneBook: (bookId) => {
    const cur = get().configs;
    const next: Record<string, ChatLoreConfig> = {};
    let anyChanged = false;

    for (const [chatFile, cfg] of Object.entries(cur)) {
      let mutated = false;

      const linkedBookIds = cfg.linkedBookIds.includes(bookId)
        ? cfg.linkedBookIds.filter((id) => id !== bookId)
        : cfg.linkedBookIds;
      if (linkedBookIds !== cfg.linkedBookIds) mutated = true;

      let excludedEntryIds = cfg.excludedEntryIds;
      if (bookId in excludedEntryIds) {
        excludedEntryIds = { ...excludedEntryIds };
        delete excludedEntryIds[bookId];
        mutated = true;
      }

      let overlays = cfg.overlays;
      const hasOverlayForBook = Object.values(cfg.overlays).some(
        (o) => o.baseBookId === bookId
      );
      if (hasOverlayForBook) {
        const filtered: Record<string, EntryOverlay> = {};
        for (const [entryId, overlay] of Object.entries(cfg.overlays)) {
          if (overlay.baseBookId !== bookId) filtered[entryId] = overlay;
        }
        overlays = filtered;
        mutated = true;
      }

      if (!mutated) {
        next[chatFile] = cfg;
        continue;
      }
      anyChanged = true;

      const isNowEmpty =
        linkedBookIds.length === 0 &&
        Object.keys(excludedEntryIds).length === 0 &&
        Object.keys(overlays).length === 0 &&
        cfg.localEntries.length === 0;

      if (isNowEmpty) continue; // drop entirely rather than leaving a vacuous config

      next[chatFile] = {
        ...cfg,
        linkedBookIds,
        excludedEntryIds,
        overlays,
        updatedAt: Date.now(),
      };
    }

    if (!anyChanged) return;
    saveConfigs(next);
    set({ configs: next });
  },

  clearError: () => set({ error: null }),

  initForUser: (handle) => {
    _currentHandle = handle;
    // Hydrate from localStorage first so the UI has something to show before
    // fetchPrefs returns. fetchPrefs will overlay the server state if newer.
    _persistEnabled = false;
    set({
      configs: loadConfigs(handle),
      error: null,
    });
  },

  resetUser: () => {
    _persistEnabled = false;
    _currentHandle = null;
    set({
      configs: {},
      error: null,
    });
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | (Record<string, unknown> & { _ts?: number })
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (!stored) {
        // First-ever sync for this user — seed the server with the
        // localStorage state we just loaded in initForUser.
        _persistEnabled = true;
        const s = get();
        const hasAnything = Object.keys(s.configs).length > 0;
        if (hasAnything) {
          patchServerKey(
            SERVER_KEY,
            s.configs as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
        return;
      }

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        // Local has unconfirmed mutations — push them and keep local state.
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          get().configs as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      // Server has newer (or equal) state — apply it. Normalize first: the
      // blob may have been written by an older/future client missing fields
      // (or lacking them entirely), and localEntries in particular is
      // dereferenced throughout the scanner/UI.
      _persistEnabled = false;
      const handle = _currentHandle;
      const configs = normalizeStoredConfigs(stored);
      set({ configs });
      // Cache to localStorage so the next cold load is instant.
      if (handle) {
        try {
          localStorage.setItem(scopedKey(CONFIGS_KEY, handle), JSON.stringify(configs));
        } catch { /* ignore */ }
      }
      try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
      _persistEnabled = true;
    } catch {
      // Network failure — keep local state. Next mutation marks the section
      // dirty, so a future fetchPrefs will detect the local-newer case.
      _persistEnabled = true;
    }
  },
}));

// ---------------------------------------------------------------------------
// Subscribe-based autosave (debounced) — set up after the store exists so
// useChatLoreConfigStore is in scope. Mirrors worldInfoStore.ts's own
// subscribe-based autosave exactly.
// ---------------------------------------------------------------------------

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _persistEnabled = false;

useChatLoreConfigStore.subscribe((state) => {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      state.configs as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
});
