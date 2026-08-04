import { create } from 'zustand';
import {
  getSettingsBlob,
  makeLocalTsKey,
  patchServerKey,
  markSectionDirty,
  recordServerTs,
  shouldReuploadSection,
} from '../utils/serverSettings';
import { useWorldInfoStore } from './worldInfoStore';
import type { RevisionAction } from './worldInfoStore';
import { useChatLoreConfigStore } from './chatLoreConfigStore';
import { hashContent } from '../utils/worldInfoComposition';
import { useAuthStore } from './authStore';

// ---------------------------------------------------------------------------
// Lorebook v2 — Auto Memory conflict store (Phase 4)
// ---------------------------------------------------------------------------
//
// Holds pending "the auto-memory extractor found lore that conflicts with an
// existing entry" records until the user resolves each one. Modeled
// structurally on chatLoreConfigStore.ts: same scoped-localStorage-key
// pattern, same debounced server sync, same initForUser/resetUser/fetchPrefs
// three-branch lifecycle.

// ---- Types ------------------------------------------------------------------

export type ConflictDetector = 'llm' | 'lint';

export interface ConflictRecord {
  id: string;
  chatFile: string;
  bookId: string;
  existingEntryId: string;
  /** Full text of the existing entry AT DETECTION TIME. */
  existingContentSnapshot: string;
  proposedContent: string;
  proposedKeys: string[];
  detectedBy: ConflictDetector;
  createdAt: number;
}

export type ConflictResolutionKind =
  | 'keep'
  | 'replace'
  | 'fork_chat'
  | 'fork_group'
  | 'add_new'
  | 'dismiss';

export type ConflictScope =
  | { kind: 'chat'; chatFile: string }
  | { kind: 'book'; bookId: string };

// ---- Storage keys -------------------------------------------------------------

const RECORDS_KEY = 'lore_conflicts_v1';
const SERVER_KEY = 'stm_lore_conflicts';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

/** Maximum number of pending records retained; oldest is evicted past this. */
const MAX_RECORDS = 100;

// Module-level handle tracking, mirroring chatLoreConfigStore.ts's own
// _currentHandle / scopedKey pattern exactly so this store's localStorage
// keys are scoped per logged-in user the same way.
let _currentHandle: string | null = null;

function scopedKey(base: string, handle?: string | null): string {
  const h = handle !== undefined ? handle : _currentHandle;
  return h ? `${base}_${h}` : base;
}

// ---- Defensive parsing --------------------------------------------------------

const CONFLICT_DETECTORS: readonly ConflictDetector[] = ['llm', 'lint'];

function isValidDetector(value: unknown): value is ConflictDetector {
  return (
    typeof value === 'string' &&
    (CONFLICT_DETECTORS as readonly string[]).includes(value)
  );
}

/**
 * Defensive per-record normalization applied to anything loaded from
 * localStorage or the server sync blob — never trust stored shape. Drops
 * (silently) any entry that doesn't look like a real ConflictRecord rather
 * than throwing, so a malformed or foreign blob never crashes this store.
 */
function normalizeStoredRecords(
  raw: Record<string, unknown>
): Record<string, ConflictRecord> {
  const out: Record<string, ConflictRecord> = {};
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== 'object') continue; // skips a stray `_ts`
    const r = value as Partial<ConflictRecord>;
    if (typeof r.id !== 'string') continue;
    if (typeof r.chatFile !== 'string') continue;
    if (typeof r.bookId !== 'string') continue;
    if (typeof r.existingEntryId !== 'string') continue;
    if (typeof r.existingContentSnapshot !== 'string') continue;
    if (typeof r.proposedContent !== 'string') continue;
    if (!isValidDetector(r.detectedBy)) continue;
    const proposedKeys = Array.isArray(r.proposedKeys)
      ? r.proposedKeys.filter((k): k is string => typeof k === 'string')
      : [];
    const createdAt =
      typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
        ? r.createdAt
        : 0;
    out[r.id] = {
      id: r.id,
      chatFile: r.chatFile,
      bookId: r.bookId,
      existingEntryId: r.existingEntryId,
      existingContentSnapshot: r.existingContentSnapshot,
      proposedContent: r.proposedContent,
      proposedKeys,
      detectedBy: r.detectedBy,
      createdAt,
    };
  }
  return out;
}

function parseRecords(raw: string): Record<string, ConflictRecord> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') return {};
  return normalizeStoredRecords(parsed);
}

function loadRecords(handle?: string | null): Record<string, ConflictRecord> {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const raw = localStorage.getItem(scopedKey(RECORDS_KEY, h));
    if (!raw) return {};
    return parseRecords(raw);
  } catch {
    return {};
  }
}

function saveRecords(records: Record<string, ConflictRecord>) {
  try {
    localStorage.setItem(scopedKey(RECORDS_KEY), JSON.stringify(records));
  } catch {
    // ignore quota/security errors
  }
}

// ---- Small local helpers --------------------------------------------------

function norm80(s: string): string {
  return s.trim().toLowerCase().slice(0, 80);
}

/**
 * Case-insensitive union: a's entries first (original order), then any of
 * b's entries not already present.
 */
function unionKeys(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of a) {
    const lower = k.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(k);
    }
  }
  for (const k of b) {
    const lower = k.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(k);
    }
  }
  return out;
}

// ---- Store ------------------------------------------------------------------

interface LoreConflictState {
  /** ONLY ever holds pending conflicts, keyed by id. */
  records: Record<string, ConflictRecord>;
  error: string | null;

  /**
   * Registers a newly-detected conflict. Deduped against an existing pending
   * record for the same bookId + existingEntryId whose proposedContent
   * normalizes (trim/lowercase/first-80-chars) to the same value — if found,
   * that existing record is returned unchanged instead of creating a
   * duplicate. Caps total pending records at 100, evicting the oldest
   * (by createdAt) before adding when already at the cap.
   */
  addConflict: (input: Omit<ConflictRecord, 'id' | 'createdAt'>) => ConflictRecord;

  /** Merges patch onto an existing record. No-op if id doesn't exist. */
  updateProposed: (
    id: string,
    patch: { proposedContent?: string; proposedKeys?: string[] }
  ) => void;

  /**
   * Plain getState()-style helper — NOT a React selector. Components should
   * subscribe to the whole `records` map and useMemo-filter themselves.
   */
  pendingForChat: (chatFile: string) => ConflictRecord[];

  /** Same discipline as pendingForChat — not a React selector. */
  pendingForBook: (bookId: string) => ConflictRecord[];

  /**
   * Resolves a single conflict against the live world-info entry. See the
   * per-kind behavior documented at each branch inline. Leaves the record
   * pending (does not delete it) when the live entry has vanished and the
   * chosen kind needs it — that's the orphan case surfaced to the UI as
   * `error`.
   */
  resolveConflict: (id: string, kind: ConflictResolutionKind) => void;

  /**
   * Bulk-resolves every pending conflict in scope with the same kind.
   * Records whose live entry no longer exists are left pending (orphans
   * are never force-resolved in bulk).
   */
  resolveAll: (scope: ConflictScope, kind: 'keep' | 'replace') => void;

  /** Called when a world-info book is deleted — drops every record for it. */
  pruneBook: (bookId: string) => void;

  clearError: () => void;

  // Lifecycle: mirrors chatLoreConfigStore.ts's initForUser/resetUser exactly.
  initForUser: (handle: string) => void;
  resetUser: () => void;

  /** Mirrors chatLoreConfigStore.ts's fetchPrefs three-branch sync logic exactly. */
  fetchPrefs: () => Promise<void>;
}

export const useLoreConflictStore = create<LoreConflictState>((set, get) => ({
  // Start empty; populated by initForUser once the authenticated user is known.
  records: {},
  error: null,

  addConflict: (input) => {
    const cur = get().records;
    const targetNorm = norm80(input.proposedContent);
    const dup = Object.values(cur).find(
      (r) =>
        r.bookId === input.bookId &&
        r.existingEntryId === input.existingEntryId &&
        norm80(r.proposedContent) === targetNorm
    );
    if (dup) return dup;

    let records = cur;
    if (Object.keys(records).length >= MAX_RECORDS) {
      let oldestId: string | null = null;
      let oldestTs = Infinity;
      for (const r of Object.values(records)) {
        if (r.createdAt < oldestTs) {
          oldestTs = r.createdAt;
          oldestId = r.id;
        }
      }
      if (oldestId) {
        const trimmed = { ...records };
        delete trimmed[oldestId];
        records = trimmed;
      }
    }

    const now = Date.now();
    const record: ConflictRecord = {
      ...input,
      id: `wic_${now}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
    };
    const next = { ...records, [record.id]: record };
    saveRecords(next);
    set({ records: next });
    return record;
  },

  updateProposed: (id, patch) => {
    const cur = get().records;
    const existing = cur[id];
    if (!existing) return;
    const next = { ...cur, [id]: { ...existing, ...patch } };
    saveRecords(next);
    set({ records: next });
  },

  pendingForChat: (chatFile) => {
    return Object.values(get().records).filter((r) => r.chatFile === chatFile);
  },

  pendingForBook: (bookId) => {
    return Object.values(get().records).filter((r) => r.bookId === bookId);
  },

  resolveConflict: (id, kind) => {
    const record = get().records[id];
    if (!record) return;

    const world = useWorldInfoStore.getState();
    const book = world.books.find((b) => b.id === record.bookId);

    if (!book) {
      // Nothing left to resolve against.
      const next = { ...get().records };
      delete next[id];
      saveRecords(next);
      set({ records: next });
      return;
    }

    const liveEntry = book.entries.find((e) => e.id === record.existingEntryId);

    if (!liveEntry && kind !== 'add_new' && kind !== 'dismiss') {
      // Leave the record pending so the UI can show an orphan card.
      set({ error: 'The conflicting entry no longer exists' });
      return;
    }

    const handle = useAuthStore.getState().currentUser?.handle ?? '';

    switch (kind) {
      case 'keep': {
        // Content doesn't change, but recordRevision: 'always' forces a
        // revision to record the decision.
        world.updateEntry(
          record.bookId,
          record.existingEntryId,
          {},
          {
            action: 'conflict_keep' as RevisionAction,
            recordRevision: 'always',
            sourceChatFile: record.chatFile,
          }
        );
        break;
      }
      case 'replace': {
        const newKeys = unionKeys(liveEntry!.keys, record.proposedKeys);
        world.updateEntry(
          record.bookId,
          record.existingEntryId,
          { content: record.proposedContent, keys: newKeys },
          {
            action: 'conflict_replace' as RevisionAction,
            sourceChatFile: record.chatFile,
          }
        );
        break;
      }
      case 'fork_chat': {
        const now = Date.now();
        // upsertOverlay replaces the whole overlay object (chatLoreConfigStore.ts
        // does a plain overlays[baseEntryId] = overlay, not a merge). If this
        // entry already has an overlay in this chat — a manual fork made via
        // ForkEntryEditor, or an earlier conflict resolution — building a
        // brand-new overlay from scratch here would silently wipe out every
        // other patched field (comment, group, critical, etc.), the user's own
        // note, and the original createdAt. Read the existing overlay first and
        // merge on top of it instead of replacing it wholesale.
        const existingOverlay = useChatLoreConfigStore
          .getState()
          .getEffectiveConfig(record.chatFile)?.overlays[liveEntry!.id];
        useChatLoreConfigStore.getState().upsertOverlay(record.chatFile, {
          baseEntryId: liveEntry!.id,
          baseBookId: record.bookId,
          patch: {
            ...existingOverlay?.patch,
            content: record.proposedContent,
            keys: unionKeys(
              existingOverlay?.patch.keys ?? liveEntry!.keys,
              record.proposedKeys
            ),
          },
          baseContentHash: hashContent(liveEntry!.content),
          createdBy: existingOverlay?.createdBy ?? handle,
          createdAt: existingOverlay?.createdAt ?? now,
          updatedAt: now,
          note: existingOverlay?.note ?? 'Auto Memory conflict resolution',
        });
        // The base entry's own content didn't change (the fork lives in the
        // chat's overlay), but it still gets an audit revision.
        world.updateEntry(
          record.bookId,
          record.existingEntryId,
          {},
          {
            action: 'conflict_fork' as RevisionAction,
            recordRevision: 'always',
            sourceChatFile: record.chatFile,
          }
        );
        break;
      }
      case 'fork_group': {
        const existingGroup = liveEntry!.group.trim();
        const group =
          existingGroup.length > 0
            ? existingGroup
            : `memory-${record.existingEntryId.slice(-6)}`;
        // recordRevision 'always' because a group-only change would not
        // otherwise trigger updateEntry's content-changed revision rule, but
        // this decision must still be recorded.
        world.updateEntry(
          record.bookId,
          record.existingEntryId,
          { group },
          {
            action: 'conflict_fork' as RevisionAction,
            recordRevision: 'always',
            sourceChatFile: record.chatFile,
          }
        );
        // Sibling entry that now competes with the original via the shared group.
        world.createEntry(
          record.bookId,
          {
            keys: record.proposedKeys,
            content: record.proposedContent,
            comment: 'Auto-extracted',
            category: 'continuity_note',
            source: 'auto_memory',
            group,
          },
          { sourceChatFile: record.chatFile }
        );
        break;
      }
      case 'add_new': {
        world.createEntry(
          record.bookId,
          {
            keys: record.proposedKeys,
            content: record.proposedContent,
            comment: 'Auto-extracted',
            category: 'continuity_note',
            source: 'auto_memory',
          },
          { sourceChatFile: record.chatFile }
        );
        break;
      }
      case 'dismiss':
        // No side effects on any entry.
        break;
    }

    const next = { ...get().records };
    delete next[id];
    saveRecords(next);
    set({ records: next });
  },

  resolveAll: (scope, kind) => {
    const list =
      scope.kind === 'chat'
        ? get().pendingForChat(scope.chatFile)
        : get().pendingForBook(scope.bookId);

    const world = useWorldInfoStore.getState();
    for (const record of list) {
      const book = world.books.find((b) => b.id === record.bookId);
      const liveExists =
        !!book && book.entries.some((e) => e.id === record.existingEntryId);
      if (!liveExists) continue; // orphan — leave pending, don't force-resolve
      get().resolveConflict(record.id, kind);
    }
  },

  pruneBook: (bookId) => {
    const cur = get().records;
    const next: Record<string, ConflictRecord> = {};
    let changed = false;
    for (const [key, r] of Object.entries(cur)) {
      if (r.bookId === bookId) {
        changed = true;
        continue;
      }
      next[key] = r;
    }
    if (!changed) return;
    saveRecords(next);
    set({ records: next });
  },

  clearError: () => set({ error: null }),

  initForUser: (handle) => {
    _currentHandle = handle;
    // Hydrate from localStorage first so the UI has something to show before
    // fetchPrefs returns. fetchPrefs will overlay the server state if newer.
    _persistEnabled = false;
    set({
      records: loadRecords(handle),
      error: null,
    });
  },

  resetUser: () => {
    _persistEnabled = false;
    _currentHandle = null;
    set({
      records: {},
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
        const hasAnything = Object.keys(s.records).length > 0;
        if (hasAnything) {
          patchServerKey(
            SERVER_KEY,
            s.records as unknown as Record<string, unknown>,
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
          get().records as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      // Server has newer (or equal) state — apply it. Normalize first: the
      // blob may have been written by an older/future client missing fields
      // (or lacking them entirely).
      _persistEnabled = false;
      const handle = _currentHandle;
      const records = normalizeStoredRecords(stored);
      set({ records });
      // Cache to localStorage so the next cold load is instant.
      if (handle) {
        try {
          localStorage.setItem(scopedKey(RECORDS_KEY, handle), JSON.stringify(records));
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
// useLoreConflictStore is in scope. Mirrors chatLoreConfigStore.ts's own
// subscribe-based autosave exactly.
// ---------------------------------------------------------------------------

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _persistEnabled = false;

useLoreConflictStore.subscribe((state) => {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      state.records as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
});
