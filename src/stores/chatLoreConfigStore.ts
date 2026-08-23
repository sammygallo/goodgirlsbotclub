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
import {
  useWorldInfoStore,
  DEFAULT_ENTRY,
  legacyIdRemapReady,
  resolveLegacyBookId,
  resolveLegacyEntryId,
  remapLegacyBookId,
  remapLegacyEntryId,
} from './worldInfoStore';
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

/**
 * Shared "promotion" seed: the persisted config if one already exists,
 * otherwise a fresh ChatLoreConfig synthesized from the legacy
 * chatLinkedBookIds map. Used by both updateConfig and mutateConfig so the
 * seeding rule only ever lives in one place.
 */
function seedBaseConfig(
  chatFile: string,
  existing: ChatLoreConfig | undefined
): ChatLoreConfig {
  return (
    existing ?? {
      chatFile,
      linkedBookIds: [...legacyLinkedBookIds(chatFile)],
      excludedEntryIds: {},
      overlays: {},
      localEntries: [],
      updatedAt: 0,
    }
  );
}

/**
 * Internal mutation helper — every method that needs to add/remove/replace
 * something inside a chat's ChatLoreConfig (as opposed to updateConfig's
 * public "patch merge" API, which can only add/overwrite keys) goes through
 * here. Centralizes: seeding/promotion, the updatedAt stamp, dropping empty
 * excludedEntryIds arrays, and the "nothing left, so remove the config"
 * vacuous-drop rule (mirrors pruneBook's isNowEmpty check).
 *
 * Not part of the public store interface — callers reach it only through
 * the named actions below.
 */
function mutateConfig(
  chatFile: string,
  fn: (cfg: ChatLoreConfig) => ChatLoreConfig
): void {
  const cur = useChatLoreConfigStore.getState().configs;
  const base = seedBaseConfig(chatFile, cur[chatFile]);
  const result = fn(base);
  if (result === base) return; // fn declined to change anything

  const now = Date.now();
  const stamped: ChatLoreConfig = {
    ...result,
    chatFile,
    updatedAt: now,
  };

  // Normalize: drop any excludedEntryIds key whose array is now empty.
  const normalizedExcludedEntryIds: Record<string, string[]> = {};
  for (const [bookId, ids] of Object.entries(stamped.excludedEntryIds)) {
    if (Array.isArray(ids) && ids.length > 0) {
      normalizedExcludedEntryIds[bookId] = ids;
    }
  }
  const next: ChatLoreConfig = {
    ...stamped,
    excludedEntryIds: normalizedExcludedEntryIds,
  };

  const isVacuous =
    next.linkedBookIds.length === 0 &&
    Object.keys(next.excludedEntryIds).length === 0 &&
    Object.keys(next.overlays).length === 0 &&
    next.localEntries.length === 0;

  const nextConfigs = { ...cur };
  if (isVacuous) {
    delete nextConfigs[chatFile];
  } else {
    nextConfigs[chatFile] = next;
  }

  saveConfigs(nextConfigs);
  useChatLoreConfigStore.setState({ configs: nextConfigs });
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

  /**
   * Excludes (or un-excludes) a single entry from a linked/active book for
   * this chat. Unlike updateConfig, this can actually remove an id — an
   * empty resulting exclusion array is dropped by mutateConfig's normalize
   * step.
   */
  setEntryExcluded: (
    chatFile: string,
    bookId: string,
    entryId: string,
    excluded: boolean
  ) => void;

  /**
   * Bulk version of setEntryExcluded for an entire book. The caller supplies
   * the book's current entry ids (this store never reaches into
   * useWorldInfoStore to enumerate a book's entries itself).
   */
  setBookExcluded: (
    chatFile: string,
    bookId: string,
    allEntryIds: string[],
    excluded: boolean
  ) => void;

  /** Creates or replaces the overlay (fork) for overlay.baseEntryId. */
  upsertOverlay: (chatFile: string, overlay: EntryOverlay) => void;

  /** Deletes the overlay for baseEntryId, if any. No-op if absent. */
  removeOverlay: (chatFile: string, baseEntryId: string) => void;

  /**
   * Creates a new chat-local world-info entry from DEFAULT_ENTRY + data,
   * appends it to localEntries, and returns the created entry (the only
   * method here with a return value other than void — callers need the new
   * id immediately, e.g. to open it in an editor).
   */
  addLocalEntry: (
    chatFile: string,
    data?: Partial<Omit<WorldInfoEntry, 'id' | 'createdAt' | 'updatedAt'>>
  ) => WorldInfoEntry;

  /** Merges data onto an existing local entry by id. No-op if not found. */
  updateLocalEntry: (
    chatFile: string,
    entryId: string,
    data: Partial<Omit<WorldInfoEntry, 'id' | 'createdAt'>>
  ) => void;

  /** Removes a local entry by id. No-op if not found. */
  removeLocalEntry: (chatFile: string, entryId: string) => void;

  /**
   * Clears excludedEntryIds/overlays/localEntries back to empty, but
   * deliberately leaves linkedBookIds untouched — attaching a book is a
   * linking decision, not something "reset" should undo.
   */
  resetCustomizations: (chatFile: string) => void;

  clearError: () => void;

  // Lifecycle: mirrors worldInfoStore.ts's initForUser/resetUser exactly.
  initForUser: (handle: string) => void;
  resetUser: () => void;

  /** Mirrors worldInfoStore.ts's fetchPrefs three-branch sync logic exactly. */
  fetchPrefs: () => Promise<void>;

  /**
   * One-time-per-login remap of every id this store persists that's keyed
   * off a book/entry id minted before worldInfoStore's native-CRUD cutover:
   * every config's linkedBookIds, excludedEntryIds (both the bookId keys and
   * the entryId values), and overlays (both the entryId key and the
   * baseBookId/baseEntryId fields). Uses worldInfoStore's
   * resolveLegacyBookId/resolveLegacyEntryId for linkedBookIds/
   * excludedEntryIds (which DROP a confidently-unresolvable id — see those
   * functions' docs), but overlays only ever apply a confident remap
   * (remapLegacyBookId/remapLegacyEntryId directly) and never drop, so a
   * genuinely orphaned overlay is left exactly as-is for
   * resolveEffectiveBooks' existing promote-to-local-entry handling to pick
   * up, unchanged (see worldInfoComposition.ts).
   *
   * Synchronous and idempotent — a second call once everything is already
   * current is a true no-op (no `set()`, no localStorage write, no server
   * patch). Called automatically from fetchPrefs once legacyIdRemapReady()
   * resolves; exposed on the store so callers (and tests) can invoke it
   * directly without driving the full async fetchPrefs/login flow.
   */
  remapLegacyIds: () => void;
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
    // First real write for this chat: seed from the legacy map (promotion).
    // The legacy map itself is left untouched — just no longer consulted for
    // this chatFile once a real config exists.
    const base: ChatLoreConfig = seedBaseConfig(chatFile, cur[chatFile]);

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

  setEntryExcluded: (chatFile, bookId, entryId, excluded) => {
    mutateConfig(chatFile, (cfg) => {
      const current = cfg.excludedEntryIds[bookId] ?? [];
      const nextIds = excluded
        ? current.includes(entryId)
          ? current
          : [...current, entryId]
        : current.filter((id) => id !== entryId);

      if (nextIds === current) return cfg; // already in the desired state

      return {
        ...cfg,
        excludedEntryIds: { ...cfg.excludedEntryIds, [bookId]: nextIds },
      };
    });
  },

  setBookExcluded: (chatFile, bookId, allEntryIds, excluded) => {
    mutateConfig(chatFile, (cfg) => ({
      ...cfg,
      excludedEntryIds: {
        ...cfg.excludedEntryIds,
        [bookId]: excluded ? [...allEntryIds] : [],
      },
    }));
  },

  upsertOverlay: (chatFile, overlay) => {
    mutateConfig(chatFile, (cfg) => ({
      ...cfg,
      overlays: { ...cfg.overlays, [overlay.baseEntryId]: overlay },
    }));
  },

  removeOverlay: (chatFile, baseEntryId) => {
    mutateConfig(chatFile, (cfg) => {
      if (!(baseEntryId in cfg.overlays)) return cfg;
      const nextOverlays = { ...cfg.overlays };
      delete nextOverlays[baseEntryId];
      return { ...cfg, overlays: nextOverlays };
    });
  },

  addLocalEntry: (chatFile, data) => {
    const now = Date.now();
    const entry: WorldInfoEntry = {
      ...DEFAULT_ENTRY,
      ...data,
      id: `wi_local_${now}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
    };
    mutateConfig(chatFile, (cfg) => ({
      ...cfg,
      localEntries: [...cfg.localEntries, entry],
    }));
    return entry;
  },

  updateLocalEntry: (chatFile, entryId, data) => {
    mutateConfig(chatFile, (cfg) => {
      const idx = cfg.localEntries.findIndex((e) => e.id === entryId);
      if (idx === -1) return cfg;
      const nextEntries = [...cfg.localEntries];
      nextEntries[idx] = {
        ...nextEntries[idx],
        ...data,
        id: nextEntries[idx].id,
        createdAt: nextEntries[idx].createdAt,
        updatedAt: Date.now(),
      };
      return { ...cfg, localEntries: nextEntries };
    });
  },

  removeLocalEntry: (chatFile, entryId) => {
    mutateConfig(chatFile, (cfg) => {
      if (!cfg.localEntries.some((e) => e.id === entryId)) return cfg;
      return {
        ...cfg,
        localEntries: cfg.localEntries.filter((e) => e.id !== entryId),
      };
    });
  },

  resetCustomizations: (chatFile) => {
    mutateConfig(chatFile, (cfg) => ({
      ...cfg,
      excludedEntryIds: {},
      overlays: {},
      localEntries: [],
    }));
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
      } else if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        // Local has unconfirmed mutations — push them and keep local state.
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          get().configs as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
      } else {
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
      }
    } catch {
      // Network failure — keep local state. Next mutation marks the section
      // dirty, so a future fetchPrefs will detect the local-newer case.
      _persistEnabled = true;
    }

    // One-time-per-login legacy-id remap (see remapLegacyIds' own docstring).
    // Fired regardless of which branch above ran — even on a pure
    // network-failure fallthrough, whatever configs are already in local
    // state may still carry pre-cutover ids and deserve a remap attempt.
    // Deliberately NOT awaited: nothing here depends on it completing before
    // fetchPrefs itself resolves (mirrors how fetchPrefs is always called
    // fire-and-forget from authStore.ts), and legacyIdRemapReady() may not
    // resolve until worldInfoStore's OWN fetchPrefs (a separate, concurrent
    // call from authStore) finishes — awaiting it here would make this
    // store's login sequencing depend on another store's, which neither
    // store's fetchPrefs contract promises today.
    legacyIdRemapReady()
      .then(() => get().remapLegacyIds())
      .catch(() => {});
  },

  remapLegacyIds: () => {
    const cur = get().configs;
    let anyChanged = false;
    const nextConfigs: Record<string, ChatLoreConfig> = {};

    for (const [chatFile, cfg] of Object.entries(cur)) {
      let changed = false;

      // 1. linkedBookIds — book ids only. `null` from resolveLegacyBookId
      // means the drop is a verified fact: a native id confidently gone, or
      // a legacy-pattern id whose server-recorded successor was deliberately
      // deleted (R2 of docs/legacy-id-strip-scoping.md). Unadjudicable
      // legacy ids come back UNCHANGED and are kept dangling — harmless to
      // lore behavior (every lore-injection read path filters id lists
      // against real books; count-style badges may over-count, cosmetic).
      const seenLinked = new Set<string>();
      const nextLinkedBookIds: string[] = [];
      for (const id of cfg.linkedBookIds) {
        const resolved = resolveLegacyBookId(id);
        if (resolved === null) {
          console.warn(
            `[chatLoreConfigStore] dropping unresolvable linkedBookIds entry "${id}" for chat "${chatFile}"`
          );
          changed = true;
          continue;
        }
        if (resolved !== id) changed = true;
        if (seenLinked.has(resolved)) {
          changed = true;
          continue;
        }
        seenLinked.add(resolved);
        nextLinkedBookIds.push(resolved);
      }

      // 2. excludedEntryIds — bookId -> entryId[]. Remap the book id key,
      // then each entry id within it. A confidently-unresolvable book or
      // entry is dropped: an exclusion for something that no longer exists
      // has zero effect either way (resolveEffectiveBooks only ever
      // consults exclusions for entries it's actually iterating), so
      // there's nothing to lose by pruning it — unlike overlays below.
      const nextExcludedEntryIds: Record<string, string[]> = {};
      for (const [bookId, entryIds] of Object.entries(cfg.excludedEntryIds)) {
        const resolvedBookId = resolveLegacyBookId(bookId);
        if (resolvedBookId === null) {
          console.warn(
            `[chatLoreConfigStore] dropping unresolvable excludedEntryIds book "${bookId}" for chat "${chatFile}"`
          );
          changed = true;
          continue;
        }
        if (resolvedBookId !== bookId) changed = true;

        const seenEntries = new Set<string>();
        const nextEntryIds: string[] = [];
        for (const entryId of entryIds) {
          const resolvedEntryId = resolveLegacyEntryId(resolvedBookId, entryId);
          if (resolvedEntryId === null) {
            console.warn(
              `[chatLoreConfigStore] dropping unresolvable excludedEntryIds entry "${entryId}" (book "${bookId}") for chat "${chatFile}"`
            );
            changed = true;
            continue;
          }
          if (resolvedEntryId !== entryId) changed = true;
          if (seenEntries.has(resolvedEntryId)) {
            changed = true;
            continue;
          }
          seenEntries.add(resolvedEntryId);
          nextEntryIds.push(resolvedEntryId);
        }

        if (nextEntryIds.length > 0) {
          // Two old book ids remapping onto the same new one is not
          // expected, but merge defensively rather than let the second
          // silently clobber the first.
          nextExcludedEntryIds[resolvedBookId] = nextExcludedEntryIds[resolvedBookId]
            ? Array.from(new Set([...nextExcludedEntryIds[resolvedBookId], ...nextEntryIds]))
            : nextEntryIds;
        } else if (entryIds.length > 0) {
          changed = true; // every entry in this book's list got dropped
        }
      }

      // 3. overlays — entryId -> overlay { baseBookId, baseEntryId, ... }.
      // ONLY a confident remap is ever applied here — never dropped based on
      // "not currently found." An overlay whose base entry can't be matched
      // may be a genuine orphan (the base entry was deleted, not just
      // migrated), and resolveEffectiveBooks already has dedicated
      // promote-to-local-entry handling for exactly that case — but only if
      // the overlay keeps pointing at the SAME base id it always has, so it
      // can still recognize a truly-migrated one that this pass DID map.
      const nextOverlays: Record<string, EntryOverlay> = {};
      for (const [entryKey, overlay] of Object.entries(cfg.overlays)) {
        const mappedBookId = remapLegacyBookId(overlay.baseBookId);
        const mappedEntryId = remapLegacyEntryId(overlay.baseEntryId);
        const nextBookId = mappedBookId ?? overlay.baseBookId;
        const nextEntryId = mappedEntryId ?? overlay.baseEntryId;
        const fieldsChanged =
          nextBookId !== overlay.baseBookId || nextEntryId !== overlay.baseEntryId;
        if (fieldsChanged || entryKey !== nextEntryId) changed = true;
        nextOverlays[nextEntryId] = fieldsChanged
          ? { ...overlay, baseBookId: nextBookId, baseEntryId: nextEntryId }
          : overlay;
      }

      if (!changed) {
        nextConfigs[chatFile] = cfg;
        continue;
      }
      anyChanged = true;

      const nextCfg: ChatLoreConfig = {
        ...cfg,
        linkedBookIds: nextLinkedBookIds,
        excludedEntryIds: nextExcludedEntryIds,
        overlays: nextOverlays,
        updatedAt: Date.now(),
      };

      const isVacuous =
        nextCfg.linkedBookIds.length === 0 &&
        Object.keys(nextCfg.excludedEntryIds).length === 0 &&
        Object.keys(nextCfg.overlays).length === 0 &&
        nextCfg.localEntries.length === 0;

      if (!isVacuous) {
        nextConfigs[chatFile] = nextCfg;
      }
      // else: drop entirely — mirrors mutateConfig's vacuous-drop rule.
    }

    if (!anyChanged) return; // true no-op: no set(), no persistence write
    saveConfigs(nextConfigs);
    set({ configs: nextConfigs });
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
