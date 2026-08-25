import { create } from 'zustand';
import { showToastGlobal } from '../components/ui/Toast';
import { estimateTokens, type TokenizerProfile } from '../utils/tokenizer';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';
import {
  api,
  LorebookConflictError,
  LorebookEntryConflictError,
  type SharedWorldInfoBookDTO,
  type LorebookDTO,
  type LorebookEntryDTO,
  type LorebookWithEntriesDTO,
} from '../api/client';
import { useChatLoreConfigStore } from './chatLoreConfigStore';
import { useLoreConflictStore } from './loreConflictStore';
import {
  isRegisteredDocumentBook,
  notifyUserBookActivation,
  notifyBooksChanged,
} from './documentBookRegistry';
import type {
  CharacterBookV2,
  CharacterBookEntryV2,
} from '../utils/characterCard';

// Where a world info entry is injected relative to the character definitions
// and the rest of the prompt. These map 1:1 onto SillyTavern's position codes
// (0-4) for import/export compatibility.
export type WorldInfoPosition =
  | 'before_char' // Before character description (ST position 0)
  | 'after_char' // After character description (ST position 1)
  | 'before_an' // Before author's note / jailbreak (ST position 2)
  | 'after_an' // After author's note / post-history (ST position 3)
  | 'at_depth'; // Injected at a specific depth in the chat (ST position 4)

// How secondary keys combine with the primary-key match. Mirrors ST's
// selectiveLogic integer codes: 0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL.
export type SelectiveLogic = 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL';

/**
 * Where an entry's content came from. Surfaced in the v2 composition layer
 * (a follow-up step) to distinguish hand-curated lore from machine-written
 * or imported content.
 */
export type EntrySource =
  | 'manual'
  | 'auto_memory'
  | 'import'
  | 'generated'
  | 'fork';

/**
 * What kind of change a revision record captures. The conflict_* actions are
 * unused until a later phase (per-chat overlays / forking) but are valid
 * values now so revision history written today stays forward-compatible.
 */
export type RevisionAction =
  | 'create'
  | 'edit'
  | 'auto_update'
  | 'conflict_keep'
  | 'conflict_replace'
  | 'conflict_fork';

/** A single point-in-time snapshot of an entry's content before an edit. */
export interface EntryRevision {
  ts: number;
  authorHandle: string;
  action: RevisionAction;
  prevContent: string;
  sourceChatFile?: string;
}

export interface WorldInfoEntry {
  id: string;
  /** Primary keywords – entry activates when ANY appears in scanned text. */
  keys: string[];
  /** Lore content injected into the prompt. Supports macros. */
  content: string;
  /** User comment, shown in the UI only. */
  comment: string;
  /** When false, the entry is ignored entirely. */
  enabled: boolean;
  /** When true, entry is always injected regardless of keyword scanning. */
  constant: boolean;
  /** When true, keyword matching respects case. */
  caseSensitive: boolean;
  /** Where this entry is injected. */
  position: WorldInfoPosition;
  /** Depth from the END of the chat (for position === 'at_depth'). */
  depth: number;
  /** Insertion order within the same position group. Higher = later. */
  order: number;
  /** Secondary keywords (combined with primary via selectiveLogic). */
  keysSecondary: string[];
  /** When true, secondary keys + selectiveLogic are applied to the match. */
  selective: boolean;
  /** How secondary keys combine with the primary match. */
  selectiveLogic: SelectiveLogic;
  /** Per-entry scan depth override (null = use global scanDepth). */
  scanDepth: number | null;
  /** Activation probability 0-100 (only used when useProbability). */
  probability: number;
  /** When true, roll probability each scan before activating. */
  useProbability: boolean;
  /** Group name; entries in the same group compete (only one wins). */
  group: string;
  /** Within a group, override entries always win over non-overrides. */
  groupOverride: boolean;
  /** Weighted-random selection weight within a group. */
  groupWeight: number;
  /** When true, this entry's content is NOT scanned for recursive matches. */
  preventRecursion: boolean;
  /** When true, this entry is NOT matched during recursive passes. */
  excludeRecursion: boolean;
  /** Turns to remain active after being triggered (0 = disabled). */
  sticky: number;
  /** Turns to wait before allowing re-activation (0 = disabled). */
  cooldown: number;
  /** Turns to wait before first activation (0 = disabled). */
  delay: number;
  /**
   * Critical entries are hard continuity facts that must never silently
   * vanish: the token budget never evicts them, and they can only be
   * triggered by real chat text — never by another entry's content during
   * recursive scanning (an entry body echoing a keyword is untrusted as a
   * trigger source for high-stakes lore).
   */
  critical: boolean;
  /**
   * When true, this entry has no meaningful keyword triggers by design and
   * activates purely on the server's semantic/FTS recall (an auto-chunked
   * Data Bank import is the main producer of these — see dataBankStore.ts).
   * Mutually exclusive with `critical` (enforced server-side, both at the
   * schema and DB layer) — a fuzzy semantic match can't also promise
   * "never evict." Purely a validation/authoring-intent marker; it does
   * NOT change local activation behavior (this app's own scan is
   * keyword-only — semantic-only activation only ever happens server-side
   * via /retrieval/context).
   */
  semanticOnly: boolean;
  /** Authoring category tag (see WI_CATEGORIES). Free-form; '' = untagged. */
  category: string;
  /**
   * IDs of entries (same book) that always co-fire when this entry fires,
   * bypassing their own keys/probability/group competition. Timed effects
   * (delay/cooldown) still apply to the pulled-in entry.
   */
  relatedIds: string[];
  /** Where this entry's content came from (manual authoring, auto-memory, etc). */
  source: EntrySource;
  /** Content-edit history, most recent last. Capped at the last 10 records. */
  revisions: EntryRevision[];
  createdAt: number;
  updatedAt: number;
  /**
   * Optimistic-concurrency token from the native /lorebooks API's
   * `server_ts` column — undefined until the first successful native sync
   * (create/update response, or a native fetch). Threaded back as `baseTs`
   * on the next PUT; a mismatch there means another device/tab wrote first.
   * Never persisted to the legacy stm_worldinfo blob (books/entries no
   * longer live there at all — see the module-level sync-contract note).
   */
  serverTs?: number;
}

/**
 * Suggested authoring categories. `category` stays a free string so imports
 * never lose data; the editor offers these as presets.
 */
export const WI_CATEGORIES = [
  'character_fact',
  'world_rule',
  'relationship',
  'location',
  'continuity_note',
  'standing_directive',
] as const;

/** Display form of a category tag: character_fact → "Character fact". */
export function humanizeCategory(cat: string): string {
  const spaced = cat.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whether a book is embedded in a character card or a normal global book. */
export type BookScope = 'character' | 'world';

/** Sharing state for a book — used by the v2 composition layer. */
export type BookVisibility = 'private' | 'shared';

export interface WorldInfoBook {
  id: string;
  name: string;
  entries: WorldInfoEntry[];
  /**
   * Non-null when this book is embedded in / owned by a character card
   * (its avatar filename). Character-owned books are hidden from the
   * global lorebook list and are auto-activated when that character is
   * selected. Null = a normal global book.
   */
  ownerCharacterAvatar: string | null;
  /**
   * True when entries are appended automatically by the auto-memory
   * extraction pass. Surfaced in the editor so the user can tell
   * hand-curated lore from machine-extracted notes.
   */
  autoExtracted?: boolean;
  /**
   * DERIVED field — never authoritative. Always equals
   * `ownerCharacterAvatar != null ? 'character' : 'world'`. Every place that
   * sets ownerCharacterAvatar must recompute this alongside it.
   */
  scope: BookScope;
  /** Handle of the user who owns this book. */
  ownerHandle: string;
  /** Sharing state; only 'shared' books are visible to other users. */
  visibility: BookVisibility;
  createdAt: number;
  updatedAt: number;
  /** Same optimistic-concurrency token as WorldInfoEntry.serverTs — see there. */
  serverTs?: number;
}

const BOOKS_KEY = 'sillytavern_worldinfo_books_v1';
const ACTIVE_BOOKS_KEY = 'sillytavern_worldinfo_active_books_v1';
const SCAN_DEPTH_KEY = 'sillytavern_worldinfo_scan_depth_v1';
const MAX_RECURSION_KEY = 'sillytavern_worldinfo_max_recursion_v1';
const TOKEN_BUDGET_KEY = 'sillytavern_worldinfo_token_budget_v1';
const WI_TIMERS_KEY = 'sillytavern_wi_timers_v1';
const CHAT_LINKED_BOOKS_KEY = 'sillytavern_worldinfo_chat_linked_books_v1';

// Module-level handle tracking so save functions stay signature-compatible.
// Set by initForUser, cleared by resetUser.
let _currentHandle: string | null = null;

function scopedKey(base: string, handle?: string | null): string {
  const h = handle !== undefined ? handle : _currentHandle;
  return h ? `${base}_${h}` : base;
}

/** Current logged-in user's handle, or '' when unauthenticated. */
function currentHandle(): string {
  return _currentHandle ?? '';
}

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

const DEFAULT_SCAN_DEPTH = 4;
const DEFAULT_MAX_RECURSION = 3;
const DEFAULT_TOKEN_BUDGET = 1024;

export const DEFAULT_ENTRY: Omit<
  WorldInfoEntry,
  'id' | 'createdAt' | 'updatedAt'
> = {
  keys: [],
  content: '',
  comment: '',
  enabled: true,
  constant: false,
  caseSensitive: false,
  position: 'before_char',
  depth: 4,
  order: 100,
  keysSecondary: [],
  selective: false,
  selectiveLogic: 'AND_ANY',
  scanDepth: null,
  probability: 100,
  useProbability: false,
  group: '',
  groupOverride: false,
  groupWeight: 100,
  preventRecursion: false,
  excludeRecursion: false,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  critical: false,
  semanticOnly: false,
  category: '',
  relatedIds: [],
  source: 'manual',
  revisions: [],
};

/**
 * Backfill fields added after initial release so old stored data works.
 * Runs on BOTH persistence paths — localStorage (parseBooks) and the
 * server-sync blob (fetchPrefs): blobs written by a pre-update client lack
 * the newer fields, and `relatedIds` in particular is dereferenced as an
 * array throughout the scanner and UI.
 *
 * This is a lazy backfill only: it fills in-memory defaults for whatever a
 * loaded book/entry is missing, but does not eagerly rewrite storage — the
 * backfilled fields persist naturally the next time the book/entry is saved.
 *
 * `handle` defaults to the module's current-user handle so call sites that
 * don't pass one (both existing call sites) keep working unchanged.
 */
function normalizeStoredBooks(
  list: WorldInfoBook[],
  handle: string | null = _currentHandle
): WorldInfoBook[] {
  return list.map((b) => {
    const ownerCharacterAvatar =
      typeof b.ownerCharacterAvatar === 'string' ? b.ownerCharacterAvatar : null;
    return {
      ...b,
      ownerCharacterAvatar,
      // scope is derived — always recompute, never trust a stored value.
      scope: ownerCharacterAvatar != null ? 'character' : 'world',
      ownerHandle:
        typeof b.ownerHandle === 'string' && b.ownerHandle
          ? b.ownerHandle
          : handle ?? '',
      visibility: b.visibility === 'shared' ? 'shared' : 'private',
      entries: b.entries.map((e) => ({
        ...e,
        sticky: e.sticky ?? 0,
        cooldown: e.cooldown ?? 0,
        delay: e.delay ?? 0,
        critical: e.critical === true,
        semanticOnly: e.semanticOnly === true,
        category: typeof e.category === 'string' ? e.category : '',
        relatedIds: Array.isArray(e.relatedIds)
          ? e.relatedIds.filter((id) => typeof id === 'string')
          : [],
        source: isValidEntrySource(e.source)
          ? e.source
          : b.autoExtracted === true || e.comment === 'Auto-extracted'
            ? 'auto_memory'
            : 'manual',
        revisions: Array.isArray(e.revisions) ? e.revisions.slice(-10) : [],
      })),
    };
  });
}

function parseBooks(raw: string): WorldInfoBook[] {
  return normalizeStoredBooks(JSON.parse(raw) as WorldInfoBook[]);
}

function loadBooks(handle?: string | null): WorldInfoBook[] {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const key = scopedKey(BOOKS_KEY, h);
    const raw = localStorage.getItem(key);
    if (raw) return parseBooks(raw);
    // One-time migration: absorb the legacy unscoped key into the first user
    // who logs in after upgrading. Anyone who logs in subsequently starts fresh.
    if (h) {
      const legacy = localStorage.getItem(BOOKS_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(BOOKS_KEY);
        return parseBooks(legacy);
      }
    }
    return [];
  } catch {
    return [];
  }
}

function saveBooks(books: WorldInfoBook[]) {
  try {
    localStorage.setItem(scopedKey(BOOKS_KEY), JSON.stringify(books));
  } catch {
    // ignore quota/security errors
  }
}

function loadActiveBooks(handle?: string | null): string[] {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const key = scopedKey(ACTIVE_BOOKS_KEY, h);
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as string[];
    if (h) {
      const legacy = localStorage.getItem(ACTIVE_BOOKS_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(ACTIVE_BOOKS_KEY);
        return JSON.parse(legacy) as string[];
      }
    }
    return [];
  } catch {
    return [];
  }
}

function saveActiveBooks(ids: string[]) {
  try {
    localStorage.setItem(scopedKey(ACTIVE_BOOKS_KEY), JSON.stringify(ids));
  } catch {
    // ignore
  }
}

function loadChatLinkedBooks(
  handle?: string | null
): Record<string, string[]> {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const raw = localStorage.getItem(scopedKey(CHAT_LINKED_BOOKS_KEY, h));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    if (!parsed || typeof parsed !== 'object') return {};
    const clean: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) clean[k] = v.filter((id) => typeof id === 'string');
    }
    return clean;
  } catch {
    return {};
  }
}

function saveChatLinkedBooks(map: Record<string, string[]>) {
  try {
    localStorage.setItem(
      scopedKey(CHAT_LINKED_BOOKS_KEY),
      JSON.stringify(map)
    );
  } catch {
    // ignore
  }
}

function loadScanDepth(handle?: string | null): number {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const raw = localStorage.getItem(scopedKey(SCAN_DEPTH_KEY, h));
    const n = raw ? parseInt(raw, 10) : DEFAULT_SCAN_DEPTH;
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_SCAN_DEPTH;
  } catch {
    return DEFAULT_SCAN_DEPTH;
  }
}

function saveScanDepth(depth: number) {
  try {
    localStorage.setItem(scopedKey(SCAN_DEPTH_KEY), String(depth));
  } catch {
    // ignore
  }
}

function loadMaxRecursion(handle?: string | null): number {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const raw = localStorage.getItem(scopedKey(MAX_RECURSION_KEY, h));
    const n = raw !== null ? parseInt(raw, 10) : DEFAULT_MAX_RECURSION;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_RECURSION;
  } catch {
    return DEFAULT_MAX_RECURSION;
  }
}

function saveMaxRecursion(steps: number) {
  try {
    localStorage.setItem(scopedKey(MAX_RECURSION_KEY), String(steps));
  } catch {
    // ignore
  }
}

function loadTokenBudget(handle?: string | null): number {
  const h = handle !== undefined ? handle : _currentHandle;
  try {
    const raw = localStorage.getItem(scopedKey(TOKEN_BUDGET_KEY, h));
    const n = raw !== null ? parseInt(raw, 10) : DEFAULT_TOKEN_BUDGET;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOKEN_BUDGET;
  } catch {
    return DEFAULT_TOKEN_BUDGET;
  }
}

function saveTokenBudget(budget: number) {
  try {
    localStorage.setItem(scopedKey(TOKEN_BUDGET_KEY), String(budget));
  } catch {
    // ignore
  }
}

// ---- SillyTavern lorebook format interop --------------------------------
//
// ST stores WI as { entries: { "<uid>": { uid, key[], keysecondary[], comment,
// content, constant, selective, order, position, disable, depth, ... } } }.
// position is an integer:  0 = Before Char, 1 = After Char, 2 = Before AN,
// 3 = After AN, 4 = @Depth, 5 = Before Examples, 6 = After Examples.
// We only support 0-4 in Phase 4.1; anything else maps to 'before_char'.

const ST_POS_TO_LOCAL: Record<number, WorldInfoPosition> = {
  0: 'before_char',
  1: 'after_char',
  2: 'before_an',
  3: 'after_an',
  4: 'at_depth',
  5: 'before_char',
  6: 'after_char',
};

const LOCAL_POS_TO_ST: Record<WorldInfoPosition, number> = {
  before_char: 0,
  after_char: 1,
  before_an: 2,
  after_an: 3,
  at_depth: 4,
};

interface StEntry {
  uid?: number;
  key?: string[];
  keysecondary?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  vectorized?: boolean;
  selective?: boolean;
  selectiveLogic?: number;
  order?: number;
  position?: number;
  disable?: boolean;
  depth?: number;
  scanDepth?: number | null;
  probability?: number;
  useProbability?: boolean;
  group?: string;
  groupOverride?: boolean;
  groupWeight?: number;
  preventRecursion?: boolean;
  excludeRecursion?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  displayIndex?: number;
  caseSensitive?: boolean | null;
  addMemo?: boolean;
  name?: string;
  // GGBC extensions (ignored by SillyTavern, round-tripped by us).
  ggbcId?: string;
  critical?: boolean;
  semanticOnly?: boolean;
  category?: string;
  relatedIds?: string[];
  ggbcSource?: EntrySource;
}

const ST_LOGIC_TO_LOCAL: Record<number, SelectiveLogic> = {
  0: 'AND_ANY',
  1: 'NOT_ALL',
  2: 'NOT_ANY',
  3: 'AND_ALL',
};

const LOCAL_LOGIC_TO_ST: Record<SelectiveLogic, number> = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
};

interface StBook {
  entries?: Record<string, StEntry> | StEntry[];
  name?: string;
}

function pickStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((k): k is string => typeof k === 'string' && !!k.trim())
    : [];
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function entryFromStFormat(raw: StEntry): WorldInfoEntry {
  const now = Date.now();
  const logic =
    typeof raw.selectiveLogic === 'number'
      ? ST_LOGIC_TO_LOCAL[raw.selectiveLogic] || 'AND_ANY'
      : 'AND_ANY';
  const comment = typeof raw.comment === 'string' ? raw.comment : '';
  // Prefer our own round-tripped source tag; otherwise infer, defaulting
  // freshly-imported entries to 'import' rather than the general 'manual'
  // fallback used by normalizeStoredBooks.
  const source: EntrySource = isValidEntrySource(raw.ggbcSource)
    ? raw.ggbcSource
    : comment === 'Auto-extracted'
      ? 'auto_memory'
      : 'import';
  return {
    id: crypto.randomUUID(),
    keys: pickStringArray(raw.key),
    content: typeof raw.content === 'string' ? raw.content : '',
    comment,
    enabled: raw.disable === true ? false : true,
    constant: raw.constant === true,
    caseSensitive: raw.caseSensitive === true,
    position:
      typeof raw.position === 'number'
        ? ST_POS_TO_LOCAL[raw.position] || 'before_char'
        : 'before_char',
    depth: typeof raw.depth === 'number' ? raw.depth : DEFAULT_ENTRY.depth,
    order: typeof raw.order === 'number' ? raw.order : DEFAULT_ENTRY.order,
    keysSecondary: pickStringArray(raw.keysecondary),
    selective: raw.selective === true,
    selectiveLogic: logic,
    scanDepth:
      typeof raw.scanDepth === 'number' && raw.scanDepth >= 0
        ? Math.floor(raw.scanDepth)
        : null,
    probability:
      typeof raw.probability === 'number'
        ? clamp(raw.probability, 0, 100)
        : 100,
    useProbability: raw.useProbability === true,
    group: typeof raw.group === 'string' ? raw.group : '',
    groupOverride: raw.groupOverride === true,
    groupWeight:
      typeof raw.groupWeight === 'number' && raw.groupWeight > 0
        ? raw.groupWeight
        : 100,
    preventRecursion: raw.preventRecursion === true,
    excludeRecursion: raw.excludeRecursion === true,
    sticky: typeof raw.sticky === 'number' && raw.sticky > 0 ? Math.floor(raw.sticky) : 0,
    cooldown: typeof raw.cooldown === 'number' && raw.cooldown > 0 ? Math.floor(raw.cooldown) : 0,
    delay: typeof raw.delay === 'number' && raw.delay > 0 ? Math.floor(raw.delay) : 0,
    critical: raw.critical === true,
    semanticOnly: raw.semanticOnly === true,
    category: typeof raw.category === 'string' ? raw.category : '',
    // Source-file ids; bookFromStFormat remaps these onto the fresh ids.
    relatedIds: pickStringArray(raw.relatedIds),
    source,
    // Never import revision history — imported entries always start fresh.
    revisions: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Remap `relatedIds` after entries get fresh ids on import/duplicate.
 * `idMap` translates source ids → fresh ids; links whose target didn't make
 * it through the import are dropped rather than left dangling.
 */
function remapRelatedIds(
  entries: WorldInfoEntry[],
  idMap: Map<string, string>
): WorldInfoEntry[] {
  return entries.map((e) =>
    e.relatedIds.length === 0
      ? e
      : {
          ...e,
          relatedIds: e.relatedIds
            .map((id) => idMap.get(id))
            .filter((id): id is string => !!id),
        }
  );
}

export function entryToStFormat(
  entry: WorldInfoEntry,
  uid: number
): StEntry {
  return {
    uid,
    key: entry.keys,
    keysecondary: entry.keysSecondary,
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    vectorized: false,
    selective: entry.selective,
    selectiveLogic: LOCAL_LOGIC_TO_ST[entry.selectiveLogic],
    order: entry.order,
    position: LOCAL_POS_TO_ST[entry.position],
    disable: !entry.enabled,
    depth: entry.depth,
    scanDepth: entry.scanDepth,
    probability: entry.probability,
    useProbability: entry.useProbability,
    group: entry.group,
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    preventRecursion: entry.preventRecursion,
    excludeRecursion: entry.excludeRecursion,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    displayIndex: uid,
    caseSensitive: entry.caseSensitive,
    addMemo: !!entry.comment,
    ggbcId: entry.id,
    critical: entry.critical,
    semanticOnly: entry.semanticOnly,
    category: entry.category,
    relatedIds: entry.relatedIds,
    ggbcSource: entry.source,
  };
}

export function bookFromStFormat(name: string, raw: StBook): WorldInfoBook {
  const rawEntries = raw.entries;
  const list: StEntry[] = [];
  if (Array.isArray(rawEntries)) {
    list.push(...rawEntries);
  } else if (rawEntries && typeof rawEntries === 'object') {
    for (const k of Object.keys(rawEntries)) {
      list.push(rawEntries[k] as StEntry);
    }
  }
  const now = Date.now();
  // Fresh ids are generated per import, so related-entry links written by a
  // previous GGBC export (which reference the *source* ids) need remapping.
  const idMap = new Map<string, string>();
  const entries = list.map((rawEntry) => {
    const entry = entryFromStFormat(rawEntry);
    if (typeof rawEntry.ggbcId === 'string' && rawEntry.ggbcId) {
      idMap.set(rawEntry.ggbcId, entry.id);
    }
    return entry;
  });
  const ownerCharacterAvatar: string | null = null;
  return {
    id: crypto.randomUUID(),
    name: raw.name || name || 'Imported Lorebook',
    entries: remapRelatedIds(entries, idMap),
    ownerCharacterAvatar,
    // scope is derived from ownerCharacterAvatar — compute inline rather
    // than trusting any caller-supplied value.
    scope: ownerCharacterAvatar != null ? 'character' : 'world',
    ownerHandle: _currentHandle ?? '',
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  };
}

export function bookToStFormat(book: WorldInfoBook): StBook {
  const entries: Record<string, StEntry> = {};
  book.entries.forEach((e, idx) => {
    entries[String(idx)] = entryToStFormat(e, idx);
  });
  return { name: book.name, entries };
}

// ---- Character Card V2 character_book interop --------------------------
//
// The V2 card spec embeds a lorebook as `data.character_book` with a
// different shape than ST's standalone export: entries are an *array*,
// `position` is the string "before_char"|"after_char", `insertion_order`
// replaces `order`, and our ST-specific fields (depth, scanDepth,
// probability, groups, recursion flags, numeric-position override, etc.)
// go under `entry.extensions` so that SillyTavern can round-trip them.

interface CharacterBookExtensions {
  position?: number; // ST 0-6 numeric position; overrides the spec's string position
  depth?: number;
  scan_depth?: number | null;
  probability?: number;
  useProbability?: boolean;
  selectiveLogic?: number;
  group?: string;
  group_override?: boolean;
  group_weight?: number;
  prevent_recursion?: boolean;
  exclude_recursion?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  // GGBC extensions (round-tripped through the card, ignored elsewhere).
  ggbc_id?: string;
  critical?: boolean;
  semantic_only?: boolean;
  category?: string;
  related_ids?: string[];
  ggbc_source?: EntrySource;
}

function positionFromString(
  pos: string | undefined
): WorldInfoPosition {
  return pos === 'after_char' ? 'after_char' : 'before_char';
}

function positionToString(
  pos: WorldInfoPosition
): 'before_char' | 'after_char' {
  // The V2 spec only has two positions; everything that isn't `after_char`
  // falls back to `before_char`. Full ST position code is preserved in
  // extensions.position so ST can recover the original on import.
  return pos === 'after_char' ? 'after_char' : 'before_char';
}

export function entryFromCharacterBookV2(
  raw: CharacterBookEntryV2
): WorldInfoEntry {
  const now = Date.now();
  const ext = (raw.extensions || {}) as CharacterBookExtensions;

  // Prefer the ST numeric position in extensions when present (it can
  // express at_depth / before_an / after_an which the spec's two-state
  // string cannot).
  const position: WorldInfoPosition =
    typeof ext.position === 'number'
      ? ST_POS_TO_LOCAL[ext.position] || positionFromString(raw.position)
      : positionFromString(raw.position);

  const logic: SelectiveLogic =
    typeof ext.selectiveLogic === 'number'
      ? ST_LOGIC_TO_LOCAL[ext.selectiveLogic] || 'AND_ANY'
      : 'AND_ANY';

  const comment = typeof raw.comment === 'string' ? raw.comment : '';
  // Prefer our own round-tripped source tag; otherwise infer, defaulting
  // freshly-imported entries to 'import' rather than the general 'manual'
  // fallback used by normalizeStoredBooks.
  const source: EntrySource = isValidEntrySource(ext.ggbc_source)
    ? ext.ggbc_source
    : comment === 'Auto-extracted'
      ? 'auto_memory'
      : 'import';

  return {
    id: crypto.randomUUID(),
    keys: pickStringArray(raw.keys),
    content: typeof raw.content === 'string' ? raw.content : '',
    comment,
    enabled: raw.enabled !== false,
    constant: raw.constant === true,
    caseSensitive: raw.case_sensitive === true,
    position,
    depth: typeof ext.depth === 'number' ? ext.depth : DEFAULT_ENTRY.depth,
    order:
      typeof raw.insertion_order === 'number'
        ? raw.insertion_order
        : DEFAULT_ENTRY.order,
    keysSecondary: pickStringArray(raw.secondary_keys),
    selective: raw.selective === true,
    selectiveLogic: logic,
    scanDepth:
      typeof ext.scan_depth === 'number' && ext.scan_depth >= 0
        ? Math.floor(ext.scan_depth)
        : null,
    probability:
      typeof ext.probability === 'number'
        ? clamp(ext.probability, 0, 100)
        : 100,
    useProbability: ext.useProbability === true,
    group: typeof ext.group === 'string' ? ext.group : '',
    groupOverride: ext.group_override === true,
    groupWeight:
      typeof ext.group_weight === 'number' && ext.group_weight > 0
        ? ext.group_weight
        : 100,
    preventRecursion: ext.prevent_recursion === true,
    excludeRecursion: ext.exclude_recursion === true,
    sticky: typeof ext.sticky === 'number' && ext.sticky > 0 ? Math.floor(ext.sticky) : 0,
    cooldown: typeof ext.cooldown === 'number' && ext.cooldown > 0 ? Math.floor(ext.cooldown) : 0,
    delay: typeof ext.delay === 'number' && ext.delay > 0 ? Math.floor(ext.delay) : 0,
    critical: ext.critical === true,
    semanticOnly: ext.semantic_only === true,
    category: typeof ext.category === 'string' ? ext.category : '',
    relatedIds: pickStringArray(ext.related_ids),
    source,
    // Never import revision history — imported entries always start fresh.
    revisions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function entryToCharacterBookV2(
  entry: WorldInfoEntry,
  id: number
): CharacterBookEntryV2 {
  const extensions: CharacterBookExtensions = {
    position: LOCAL_POS_TO_ST[entry.position],
    depth: entry.depth,
    scan_depth: entry.scanDepth,
    probability: entry.probability,
    useProbability: entry.useProbability,
    selectiveLogic: LOCAL_LOGIC_TO_ST[entry.selectiveLogic],
    group: entry.group,
    group_override: entry.groupOverride,
    group_weight: entry.groupWeight,
    prevent_recursion: entry.preventRecursion,
    exclude_recursion: entry.excludeRecursion,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    ggbc_id: entry.id,
    critical: entry.critical,
    semantic_only: entry.semanticOnly,
    category: entry.category,
    related_ids: entry.relatedIds,
    ggbc_source: entry.source,
  };
  return {
    id,
    keys: entry.keys,
    secondary_keys: entry.keysSecondary,
    content: entry.content,
    comment: entry.comment,
    enabled: entry.enabled,
    constant: entry.constant,
    selective: entry.selective,
    case_sensitive: entry.caseSensitive,
    insertion_order: entry.order,
    position: positionToString(entry.position),
    name: entry.comment,
    priority: entry.order,
    extensions: extensions as unknown as Record<string, unknown>,
  };
}

export function bookFromCharacterBookV2(
  raw: CharacterBookV2,
  fallbackName: string,
  ownerCharacterAvatar: string | null
): WorldInfoBook {
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
  const now = Date.now();
  // Same remap as bookFromStFormat: related links reference source-card ids.
  const idMap = new Map<string, string>();
  const entries = rawEntries.map((rawEntry) => {
    const entry = entryFromCharacterBookV2(rawEntry);
    const ext = (rawEntry.extensions || {}) as CharacterBookExtensions;
    if (typeof ext.ggbc_id === 'string' && ext.ggbc_id) {
      idMap.set(ext.ggbc_id, entry.id);
    }
    return entry;
  });
  return {
    id: crypto.randomUUID(),
    name: raw.name || fallbackName || 'Character Lorebook',
    entries: remapRelatedIds(entries, idMap),
    ownerCharacterAvatar,
    // scope is derived from ownerCharacterAvatar — compute inline rather
    // than trusting any caller-supplied value.
    scope: ownerCharacterAvatar != null ? 'character' : 'world',
    ownerHandle: _currentHandle ?? '',
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  };
}

export function bookToCharacterBookV2(book: WorldInfoBook): CharacterBookV2 {
  return {
    name: book.name,
    entries: book.entries.map((e, idx) => entryToCharacterBookV2(e, idx)),
  };
}

// ---- Keyword scanning ----------------------------------------------------

export interface MatchedEntry {
  entry: WorldInfoEntry;
  bookId: string;
  bookName: string;
  /**
   * Number of primary keys that matched when this entry activated by
   * keyword scan. Absent for constant entries, sticky carry-overs, and
   * related-entry pull-ins. Used as a deterministic group tiebreaker.
   */
  matchedKeyCount?: number;
}

/**
 * Filled in by scanMessagesForEntries when the caller passes a report
 * object. Makes budget eviction observable instead of silent.
 */
export interface WorldInfoScanReport {
  /** Entries that matched but were evicted by the token budget. */
  dropped: MatchedEntry[];
  /** Token cost of never-evictable entries (constant + critical). */
  pinnedTokens: number;
  /** Total token cost of everything actually injected. */
  totalTokens: number;
  /** The budget the scan ran against (0 = unlimited). */
  budget: number;
  /**
   * True when the pinned entries alone exceed the budget — the fix is
   * architectural (raise the budget, narrow scope, or demote entries),
   * not something the trimmer can solve.
   */
  pinnedOverBudget: boolean;
}

// ---- WI timer helpers (timed effects: sticky / cooldown / delay) ----------
//
// Timers are persisted per-chat: Record<chatFile, Record<entryId, lastActivatedTurn>>
// where "turn" = number of AI (non-user, non-system) messages before this generation.

/** Load the WI timer state for a given chat file. Returns {} when absent. */
export function loadWiTimers(chatFile: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(WI_TIMERS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, Record<string, number>>;
    return all[chatFile] ?? {};
  } catch {
    return {};
  }
}

/**
 * Persist timer state for a set of freshly activated entry IDs at the given turn.
 * Merges into existing timer state (does not overwrite unrelated entries).
 */
export function saveWiTimers(
  chatFile: string,
  activatedIds: Set<string>,
  currentTurn: number
): void {
  if (activatedIds.size === 0) return;
  try {
    const raw = localStorage.getItem(WI_TIMERS_KEY);
    const all: Record<string, Record<string, number>> = raw ? JSON.parse(raw) : {};
    const existing = all[chatFile] ?? {};
    for (const id of activatedIds) {
      existing[id] = currentTurn;
    }
    all[chatFile] = existing;
    localStorage.setItem(WI_TIMERS_KEY, JSON.stringify(all));
  } catch {
    // ignore quota/security errors
  }
}

/** Remove all WI timer state for a given chat (e.g. when loading a new chat). */
export function clearWiTimers(chatFile: string): void {
  try {
    const raw = localStorage.getItem(WI_TIMERS_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, Record<string, number>>;
    delete all[chatFile];
    localStorage.setItem(WI_TIMERS_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

export interface WorldInfoScanOptions {
  /** Global scan depth – number of trailing non-system messages to scan. */
  scanDepth: number;
  /** Maximum recursive passes over entries that matched earlier. 0 disables. */
  maxRecursionSteps: number;
  /** Maximum total tokens across all matched entries. 0 = unlimited. */
  tokenBudget: number;
  /** Tokenizer profile used when estimating entry content length. */
  profile: TokenizerProfile;
  /**
   * Current AI turn index = count of AI (non-user, non-system) messages before
   * this generation. Used by delay, cooldown, and sticky timed effects.
   * Defaults to 0 when omitted (all timed effects effectively disabled).
   */
  currentTurn?: number;
  /**
   * Per-entry timer state for the active chat: entry.id → last-activated turn.
   * When omitted, timed effects that depend on prior activations are skipped.
   */
  wiTimers?: Record<string, number>;
}

function buildHaystack(
  messages: { content: string; isSystem?: boolean }[],
  depth: number
): string {
  const nonSystem = messages.filter((m) => !m.isSystem);
  const recent = nonSystem.slice(-Math.max(1, depth));
  return recent.map((m) => m.content || '').join('\n');
}

/**
 * Match a single key against the haystack. When the key is wrapped in
 * /slashes/ we attempt to compile it as a regex; on failure we fall back to
 * a case-aware substring match on the literal key text.
 */
function keyMatches(
  haystack: string,
  key: string,
  caseSensitive: boolean
): boolean {
  if (!key) return false;
  const re = key.match(/^\/(.+)\/([gimsuy]*)$/);
  if (re) {
    try {
      let flags = re[2];
      if (!caseSensitive && !flags.includes('i')) flags += 'i';
      const compiled = new RegExp(re[1], flags);
      return compiled.test(haystack);
    } catch {
      // fall through to substring match
    }
  }
  if (caseSensitive) return haystack.includes(key);
  return haystack.toLowerCase().includes(key.toLowerCase());
}

function evalSelectiveLogic(
  mode: SelectiveLogic,
  results: boolean[]
): boolean {
  if (results.length === 0) return true;
  switch (mode) {
    case 'AND_ANY':
      return results.some((r) => r);
    case 'AND_ALL':
      return results.every((r) => r);
    case 'NOT_ANY':
      return !results.some((r) => r);
    case 'NOT_ALL':
      return results.some((r) => !r);
  }
}

/**
 * Returns the number of primary keys matching the haystack (0 = the entry
 * does not activate). Caller is responsible for skipping constant entries.
 */
function entryMatchCount(entry: WorldInfoEntry, haystack: string): number {
  // Primary keys (OR) — count matches for the deterministic group tiebreak.
  if (entry.keys.length === 0) return 0;
  const primaryCount = entry.keys.filter((k) =>
    keyMatches(haystack, k, entry.caseSensitive)
  ).length;
  if (primaryCount === 0) return 0;
  if (entry.selective && entry.keysSecondary.length > 0) {
    const results = entry.keysSecondary.map((k) =>
      keyMatches(haystack, k, entry.caseSensitive)
    );
    if (!evalSelectiveLogic(entry.selectiveLogic, results)) return 0;
  }
  return primaryCount;
}

function rollProbability(entry: WorldInfoEntry): boolean {
  if (!entry.useProbability) return true;
  return Math.random() * 100 < entry.probability;
}

/**
 * Deterministic group winner: highest priority (lowest `order`) first, then
 * most matched primary keys, then alphabetical (comment, else first key,
 * else id) so the same inputs always inject the same fact.
 */
function pickDeterministicWinner(pool: MatchedEntry[]): MatchedEntry {
  const label = (m: MatchedEntry) =>
    (m.entry.comment || m.entry.keys[0] || m.entry.id).toLowerCase();
  return pool.reduce((best, m) => {
    if (m.entry.order !== best.entry.order) {
      return m.entry.order < best.entry.order ? m : best;
    }
    const mCount = m.matchedKeyCount ?? 0;
    const bestCount = best.matchedKeyCount ?? 0;
    if (mCount !== bestCount) return mCount > bestCount ? m : best;
    return label(m) < label(best) ? m : best;
  });
}

/**
 * Resolve inclusion-group conflicts: for each group, pick one winner.
 * Skips groups listed in `wonGroups` (they already have a winner from a
 * previous pass) and updates the set with new winners.
 *
 * When every candidate in the pool has the same groupWeight, the winner is
 * picked deterministically (order → matched-key count → alphabetical): the
 * same chat state always injects the same fact, which is what a lorebook
 * exists to guarantee. Unequal weights opt the group into ST-style
 * weighted-random selection — reserve that for cosmetic variety where
 * *which* entry fires genuinely doesn't matter to continuity.
 */
/**
 * THE sticky ordering contract, used for BOTH group admission and emission
 * (see the two call sites in scanMessagesForEntries). `(order, lowercased
 * label, content)` ascending, where label = comment || keys[0] || id. BOTH
 * string keys compare BY CODE POINT (see compareByCodePoint — `<` is wrong
 * here); the label is case-folded first, then compared, matching the backend's
 * `.lower()` followed by Python's code-point `<`.
 *
 * Sticky entries have no fresh matched-key count — they are injected
 * precisely because nothing matched this turn — so pickDeterministicWinner's
 * middle rank is meaningless for them. Kept as its own comparator (rather
 * than reusing pickDeterministicWinner with a zeroed count) so the rule the
 * backend's `_activation.py` has to mirror is stated in one place.
 *
 * Why `content` is the last key, rather than `id` or either engine's own
 * candidate order: neither of those is mutually computable. The backend's
 * candidate order is SQL `ORDER BY (insertion_order, id)` over random UUIDs,
 * which a browser cannot reproduce, and the two id spaces are not reliably
 * shared in the first place (E2-S5). `content` is the one field both engines
 * hold identically — it is what actually gets injected — so it is the only
 * final key that can make them agree. Ties past it are entries with the same
 * order, label and text: indistinguishable in the prompt either way.
 */
function compareStickyForGroup(
  a: { entry: WorldInfoEntry },
  b: { entry: WorldInfoEntry }
): number {
  if (a.entry.order !== b.entry.order) return a.entry.order - b.entry.order;
  const label = (e: WorldInfoEntry) =>
    (e.comment || e.keys[0] || e.id).toLowerCase();
  // Fold first, THEN compare by code point — the same order as the backend's
  // `(comment or keys[0] or id).lower()` followed by Python's code-point `<`.
  const la = label(a.entry);
  const lb = label(b.entry);
  if (la !== lb) return compareByCodePoint(la, lb);
  return compareByCodePoint(a.entry.content, b.entry.content);
}

/**
 * Compare two strings by unicode CODE POINT, the way Python's `str` ordering
 * does — deliberately not `<`, which compares UTF-16 CODE UNITS.
 *
 * The two disagree on astral characters. U+1F600 is stored as the surrogate
 * pair D83D DE00, so JS reads its first unit as 0xD83D and puts it BELOW
 * U+F8FF, while Python compares 0x1F600 and puts it ABOVE. Both of
 * compareStickyForGroup's string keys exist precisely so the two engines pick
 * the same survivor, so comparing either in code units would reopen the
 * divergence those keys exist to close — an emoji in a lorebook entry would be
 * enough, and `label` is a comment or a key, so users put emoji there too.
 *
 * `localeCompare` is NOT a substitute: it is locale- and ICU-version-dependent
 * collation, which the backend has no way to mirror.
 */
function compareByCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  // Array.from splits on code points, not code units, so surrogate pairs stay
  // whole and each element compares at its true scalar value.
  const ca = Array.from(a);
  const cb = Array.from(b);
  const shared = Math.min(ca.length, cb.length);
  for (let i = 0; i < shared; i++) {
    const pa = ca[i].codePointAt(0) ?? 0;
    const pb = cb[i].codePointAt(0) ?? 0;
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
  // Common prefix: the shorter string sorts first, as in both engines.
  return ca.length - cb.length;
}

function resolveGroups(
  matches: MatchedEntry[],
  wonGroups: Set<string>
): MatchedEntry[] {
  const ungrouped: MatchedEntry[] = [];
  const byGroup = new Map<string, MatchedEntry[]>();
  for (const m of matches) {
    const g = m.entry.group;
    if (!g) {
      ungrouped.push(m);
      continue;
    }
    if (wonGroups.has(g)) continue; // previous pass already picked a winner
    let list = byGroup.get(g);
    if (!list) {
      list = [];
      byGroup.set(g, list);
    }
    list.push(m);
  }

  const winners = [...ungrouped];
  for (const [groupName, groupMatches] of byGroup) {
    const overrides = groupMatches.filter((m) => m.entry.groupOverride);
    const pool = overrides.length > 0 ? overrides : groupMatches;
    const allEqualWeight = pool.every(
      (m) => m.entry.groupWeight === pool[0].entry.groupWeight
    );
    if (allEqualWeight) {
      winners.push(pickDeterministicWinner(pool));
      wonGroups.add(groupName);
      continue;
    }
    const totalWeight = pool.reduce(
      (sum, m) => sum + Math.max(1, m.entry.groupWeight),
      0
    );
    let roll = Math.random() * totalWeight;
    let winner = pool[pool.length - 1];
    for (const m of pool) {
      roll -= Math.max(1, m.entry.groupWeight);
      if (roll <= 0) {
        winner = m;
        break;
      }
    }
    winners.push(winner);
    wonGroups.add(groupName);
  }
  return winners;
}

function applyTokenBudget(
  matches: MatchedEntry[],
  budget: number,
  profile: TokenizerProfile,
  outReport?: WorldInfoScanReport
): MatchedEntry[] {
  const cost = (m: MatchedEntry) => estimateTokens(m.entry.content, profile);
  // Constant and critical entries are always injected — never pruned.
  const pinned = matches.filter((m) => m.entry.constant || m.entry.critical);
  const pinnedCost = pinned.reduce((s, m) => s + cost(m), 0);
  if (outReport) {
    outReport.dropped = [];
    outReport.pinnedTokens = pinnedCost;
    outReport.budget = budget;
    outReport.pinnedOverBudget = false;
  }
  if (budget <= 0) {
    if (outReport) {
      outReport.totalTokens = matches.reduce((s, m) => s + cost(m), 0);
    }
    return matches;
  }
  const budgetable = matches.filter(
    (m) => !m.entry.constant && !m.entry.critical
  );
  const remaining = Math.max(0, budget - pinnedCost);
  // High priority first (lower `order`), drop lowest priority when over budget.
  const sorted = [...budgetable].sort((a, b) => a.entry.order - b.entry.order);
  const costs = sorted.map(cost);
  let total = costs.reduce((s, c) => s + c, 0);
  while (total > remaining && sorted.length > 0) {
    const droppedEntry = sorted.pop();
    total -= costs.pop() || 0;
    if (outReport && droppedEntry) outReport.dropped.push(droppedEntry);
  }
  if (outReport) {
    outReport.totalTokens = pinnedCost + total;
    outReport.pinnedOverBudget = pinnedCost > budget;
  }
  return [...pinned, ...sorted];
}

/**
 * Scan active books for matching entries. Supports primary/secondary keys,
 * regex keys, per-entry scan depth override, probability activation,
 * inclusion groups, recursive scanning, token budgeting, and timed effects
 * (sticky / cooldown / delay).
 *
 * @param outActivatedIds - Optional Set that will be populated with the IDs of
 *   entries that were *freshly* activated this turn (excluding sticky carry-overs)
 *   AND survived the token budget — an entry the budget evicted never reached
 *   the prompt, so it must not start its cooldown/sticky windows either.
 *   Callers should persist this set via saveWiTimers() after a successful
 *   generation to update the timed-effects state for the next turn.
 * @param outScanReport - Optional report object (see WorldInfoScanReport)
 *   populated with what the token budget evicted, so callers can surface
 *   drops instead of letting lore vanish silently.
 */
/**
 * v2 composition contract: callers that support per-chat lore config must
 * run books/activeBookIds through resolveEffectiveBooks (in
 * src/utils/worldInfoComposition.ts, added in a follow-up step) before
 * calling this function. This function itself is frozen for v2 - overlays,
 * exclusions, and local per-chat entries are invisible to it by design,
 * because entry and book ids survive composition unchanged. Do not add
 * config-awareness here.
 */
export function scanMessagesForEntries(
  books: WorldInfoBook[],
  activeBookIds: string[],
  messages: { content: string; isSystem?: boolean }[],
  options: WorldInfoScanOptions,
  outActivatedIds?: Set<string>,
  outScanReport?: WorldInfoScanReport
): MatchedEntry[] {
  const activeBooks = books.filter((b) => activeBookIds.includes(b.id));
  if (activeBooks.length === 0) return [];

  const currentTurn = options.currentTurn ?? 0;
  const wiTimers = options.wiTimers ?? {};

  // Flatten all candidate entries, pairing each with its book for citations.
  interface Candidate {
    entry: WorldInfoEntry;
    bookId: string;
    bookName: string;
  }
  const candidates: Candidate[] = [];
  for (const book of activeBooks) {
    for (const entry of book.entries) {
      if (!entry.enabled) continue;
      if (entry.content.trim().length === 0) continue;
      candidates.push({ entry, bookId: book.id, bookName: book.name });
    }
  }

  /**
   * Returns true when timed-effect constraints allow the entry to activate:
   * - delay: entry won't trigger until currentTurn >= delay
   * - cooldown: entry can't re-trigger within `cooldown` turns of lastActivated
   */
  function timedEffectsAllow(entry: WorldInfoEntry): boolean {
    if (entry.delay > 0 && currentTurn < entry.delay) return false;
    if (entry.cooldown > 0) {
      const last = wiTimers[entry.id];
      if (last !== undefined && currentTurn <= last + entry.cooldown) return false;
    }
    return true;
  }

  const wonGroups = new Set<string>();
  const matchedIds = new Set<string>();
  const initial: MatchedEntry[] = [];
  for (const c of candidates) {
    if (!timedEffectsAllow(c.entry)) continue;
    // Constant entries fire unconditionally, still subject to probability.
    if (c.entry.constant) {
      if (!rollProbability(c.entry)) continue;
      initial.push(c);
      matchedIds.add(c.entry.id);
      continue;
    }
    const depth = c.entry.scanDepth ?? options.scanDepth;
    const haystack = buildHaystack(messages, depth);
    const matchedKeyCount = entryMatchCount(c.entry, haystack);
    if (matchedKeyCount === 0) continue;
    if (!rollProbability(c.entry)) continue;
    initial.push({ ...c, matchedKeyCount });
    matchedIds.add(c.entry.id);
  }

  let matched = resolveGroups(initial, wonGroups);
  // resolveGroups may drop entries that lost their group pick. Reconcile.
  const matchedSet = new Set(matched.map((m) => m.entry.id));
  for (const id of matchedIds) {
    if (!matchedSet.has(id)) matchedIds.delete(id);
  }

  // Recursive passes: use newly-added entries' content as the next haystack.
  let lastAdded = matched;
  for (let step = 0; step < options.maxRecursionSteps; step++) {
    const recursionHaystack = lastAdded
      .filter((m) => !m.entry.preventRecursion)
      .map((m) => m.entry.content)
      .join('\n');
    if (!recursionHaystack) break;

    const newMatches: MatchedEntry[] = [];
    for (const c of candidates) {
      if (matchedIds.has(c.entry.id)) continue;
      if (c.entry.excludeRecursion) continue;
      // Trust partition: other entries' content is untrusted as a trigger
      // source — critical lore only ever fires off real chat text.
      if (c.entry.critical) continue;
      if (c.entry.constant) continue; // constants were decided in initial pass
      if (c.entry.keys.length === 0) continue;
      if (c.entry.group && wonGroups.has(c.entry.group)) continue;
      if (!timedEffectsAllow(c.entry)) continue;
      const matchedKeyCount = entryMatchCount(c.entry, recursionHaystack);
      if (matchedKeyCount === 0) continue;
      if (!rollProbability(c.entry)) continue;
      newMatches.push({ ...c, matchedKeyCount });
      matchedIds.add(c.entry.id);
    }
    if (newMatches.length === 0) break;
    const resolved = resolveGroups(newMatches, wonGroups);
    // Drop any that lost their group from matchedIds.
    const resolvedIds = new Set(resolved.map((m) => m.entry.id));
    for (const m of newMatches) {
      if (!resolvedIds.has(m.entry.id)) matchedIds.delete(m.entry.id);
    }
    matched = matched.concat(resolved);
    lastAdded = resolved;
  }

  // Sticky carry-overs: entries that were recently activated (within their
  // sticky window) and should remain injected even if keywords no longer match.
  // These do NOT reset their timer — only fresh activations do.
  const stickyCandidates: Candidate[] = [];
  for (const c of candidates) {
    if (matchedIds.has(c.entry.id)) continue;
    if (c.entry.sticky <= 0) continue;
    const last = wiTimers[c.entry.id];
    if (last === undefined) continue;
    if (currentTurn <= last + c.entry.sticky) {
      stickyCandidates.push(c);
    }
  }

  // Sticky carry-overs are subject to inclusion-group exclusivity too (#452).
  // They used to be concatenated straight past resolveGroups, which broke the
  // one-entry-per-group contract two ways: a sticky could co-inject with its
  // own group's fresh winner, and two sticky siblings of the same group could
  // both inject when neither freshly matched. A group already claimed this
  // turn — by a fresh winner, or by a sticky admitted just above in this same
  // walk — turns every later sticky in it away.
  const stickyOrdered = [...stickyCandidates].sort(compareStickyForGroup);
  const stickyLosers = new Set<string>();
  for (const c of stickyOrdered) {
    const g = c.entry.group;
    if (!g) continue; // ungrouped stickies never compete
    if (wonGroups.has(g)) {
      stickyLosers.add(c.entry.id);
      continue;
    }
    wonGroups.add(g);
  }
  // Emission uses the SAME order as admission, and deliberately not candidate
  // (book array) order (E4-S0). applyTokenBudget sorts by `order` alone with a
  // stable sort, so whatever order sticky matches arrive in is what breaks
  // ties among equal-`order` entries — i.e. it picks which one the budget trim
  // pops off the tail. The backend cannot adopt candidate order (its own is
  // SQL `(insertion_order, id)` over random UUIDs, not reproducible in a
  // browser), so emitting in book order meant the two engines evicted
  // DIFFERENT entries from the same chat state and put opposite lore in the
  // prompt — measured, not hypothetical. compareStickyForGroup is mutually
  // computable, so both engines can and now do use it.
  //
  // Ordering only. Which stickies are eligible is unchanged: ungrouped ones
  // still skip group exclusivity entirely in the walk above.
  const stickyMatches: MatchedEntry[] = stickyOrdered.filter(
    (c) => !stickyLosers.has(c.entry.id)
  );
  // Every entry that reached the sticky pass this turn, winner or loser. A
  // sticky carry-over is by definition NOT a fresh activation — it is
  // injected precisely because nothing matched — so none of these may ever
  // reach outActivatedIds below. Stamping one would push its timer forward
  // every turn and make the carry-over permanent.
  const stickyCandidateIds = new Set(stickyCandidates.map((c) => c.entry.id));

  const allMatched = matched.concat(stickyMatches);

  // Explicit links: entries listed in relatedIds always co-fire with their
  // source, bypassing their own keys, probability, and group competition —
  // the author's declared pairing is trusted over the usual gates. Timed
  // effects (delay/cooldown) still apply. Transitive, cycle-safe via the
  // included-set; dangling ids (deleted entries, inactive books) are ignored.
  const byId = new Map<string, Candidate>();
  for (const c of candidates) byId.set(c.entry.id, c);
  const included = new Set(allMatched.map((m) => m.entry.id));
  // Sticky group-losers were turned away by the exclusivity walk above and so
  // are NOT in allMatched — which used to leave them looking un-included to
  // the walk below, free to be pulled back in and (via matchedIds) to stamp
  // their own sticky window every turn. `included` doubles as "already
  // decided this turn", so seeding the losers into it restores what group
  // exclusivity just decided: a loser stays out, by both doors.
  for (const id of stickyLosers) included.add(id);
  const queue = [...allMatched];
  while (queue.length > 0) {
    const m = queue.pop() as MatchedEntry;
    for (const relId of m.entry.relatedIds) {
      if (included.has(relId)) continue;
      const rel = byId.get(relId);
      if (!rel) continue;
      if (!timedEffectsAllow(rel.entry)) continue;
      included.add(relId);
      // Pull-ins count as fresh activations so their own sticky/cooldown
      // timers start ticking.
      matchedIds.add(relId);
      const pulled: MatchedEntry = { ...rel };
      allMatched.push(pulled);
      queue.push(pulled);
    }
  }

  const result = applyTokenBudget(
    allMatched,
    options.tokenBudget,
    options.profile,
    outScanReport
  );

  // Report freshly activated IDs to the caller — an entry registers a timer
  // only if it BOTH freshly activated this turn AND survived the budget trim
  // (#452). This used to run before applyTokenBudget, so an evicted entry
  // that never reached the prompt still started its cooldown and sticky
  // windows, and was then blocked from firing on the next turn.
  //
  // Deliberately an INTERSECTION of matchedIds with the surviving ids, not a
  // walk of `result` on its own: applyTokenBudget returns [...pinned,
  // ...sorted] computed over allMatched, which also holds sticky carry-overs.
  // Registering those would re-stamp a sticky entry's window every turn and
  // make it permanent — intersecting with the freshly-activated set is what
  // keeps them excluded. relatedIds pull-ins ARE fresh activations (they are
  // in matchedIds), so they register iff they too survive the trim.
  //
  // stickyCandidateIds is the second lock on the same door: matchedIds is
  // only clean of carry-overs while nothing downstream adds one back, and
  // the relatedIds walk above is exactly such a path. Checking the set
  // states the invariant where it is relied on, instead of deriving it from
  // another pass's bookkeeping.
  if (outActivatedIds) {
    const survivingIds = new Set(result.map((m) => m.entry.id));
    for (const id of matchedIds) {
      if (stickyCandidateIds.has(id)) continue;
      if (survivingIds.has(id)) outActivatedIds.add(id);
    }
  }

  result.sort((a, b) => a.entry.order - b.entry.order);
  return result;
}

// ---- Book health audit ----------------------------------------------------

export interface BookHealth {
  bookId: string;
  /** Enabled entries only — disabled entries cost nothing. */
  entryCount: number;
  constantCount: number;
  criticalCount: number;
  /** Token cost of never-evictable entries (constant or critical). */
  pinnedTokens: number;
  /** Fraction of enabled entries that are constant (0-1). */
  constantShare: number;
  /** Related-entry links whose target no longer exists in this book. */
  danglingRelated: { entryId: string; missingIds: string[] }[];
  /**
   * Related-entry links whose target exists but is disabled or has empty
   * content — the scanner skips those targets, silently breaking the
   * co-fire chain at that point.
   */
  inactiveRelated: { entryId: string; inactiveIds: string[] }[];
}

/**
 * Automated version of the periodic hand-audit: how much of the token
 * budget is spoken for by entries the trimmer can never evict, and which
 * explicit links dangle. The UI compares pinnedTokens (summed across the
 * books active for a chat) against the global token budget — when pinned
 * cost alone exceeds it, the fix is architectural (narrow scope, split
 * entries, or demote something), not more trimming.
 */
export function auditBookHealth(
  book: WorldInfoBook,
  profile: TokenizerProfile
): BookHealth {
  const enabled = book.entries.filter(
    (e) => e.enabled && e.content.trim().length > 0
  );
  const pinned = enabled.filter((e) => e.constant || e.critical);
  const ids = new Set(book.entries.map((e) => e.id));
  const activeIds = new Set(enabled.map((e) => e.id));
  const danglingRelated: BookHealth['danglingRelated'] = [];
  const inactiveRelated: BookHealth['inactiveRelated'] = [];
  for (const e of book.entries) {
    const missing = e.relatedIds.filter((id) => !ids.has(id));
    if (missing.length > 0) {
      danglingRelated.push({ entryId: e.id, missingIds: missing });
    }
    const inactive = e.relatedIds.filter(
      (id) => ids.has(id) && !activeIds.has(id)
    );
    if (inactive.length > 0) {
      inactiveRelated.push({ entryId: e.id, inactiveIds: inactive });
    }
  }
  return {
    bookId: book.id,
    entryCount: enabled.length,
    constantCount: enabled.filter((e) => e.constant).length,
    criticalCount: enabled.filter((e) => e.critical).length,
    pinnedTokens: pinned.reduce(
      (s, e) => s + estimateTokens(e.content, profile),
      0
    ),
    constantShare:
      enabled.length > 0
        ? enabled.filter((e) => e.constant).length / enabled.length
        : 0,
    danglingRelated,
    inactiveRelated,
  };
}

// ---- Store ---------------------------------------------------------------

interface WorldInfoState {
  books: WorldInfoBook[];
  activeBookIds: string[];
  /**
   * Per-chat extra lorebooks to auto-activate, keyed by chat file name
   * (matches the key persona locks use). These stack on top of the
   * globally-active list and the character's own embedded/linked books.
   */
  chatLinkedBookIds: Record<string, string[]>;
  scanDepth: number;
  maxRecursionSteps: number;
  tokenBudget: number;
  error: string | null;

  // ---------------------------------------------------------------------
  // Group-wide sharing (Phase 5) — in-memory only. Fetched fresh from
  // GET /worldinfo/shared, never persisted: NOT part of PersistedShape,
  // never passed to saveBooks, never written into the stm_worldinfo sync
  // blob. Another user's lorebook lives on their own account; this client
  // just caches a read-only view of it for the current session.
  // ---------------------------------------------------------------------
  sharedBooks: WorldInfoBook[];
  sharedOwnerNameByHandle: Record<string, string | null>;
  sharedBooksStatus: 'idle' | 'loading' | 'loaded' | 'error';
  sharedBooksError: string | null;

  // Book CRUD
  createBook: (name: string) => WorldInfoBook;
  /**
   * Creates a book with its entries already populated in one call — the
   * generalization of createCharacterBook's body that any "one document ->
   * one book with N entries" caller needs (currently: dataBankStore.ts's
   * addDocument, one LorebookEntry per chunk). Each entry in `entries` gets
   * DEFAULT_ENTRY-filled, a minted id, and a single 'create' revision, the
   * same as a plain createEntry call — callers only need to supply the
   * fields that differ from the default. `ownerCharacterAvatar` null/omitted
   * makes a standalone world book, matching createBook's own default scope.
   */
  createBookWithEntries: (
    name: string,
    entries: Array<Partial<Omit<WorldInfoEntry, 'id' | 'createdAt' | 'updatedAt'>>>,
    ownerCharacterAvatar?: string | null
  ) => WorldInfoBook;
  renameBook: (bookId: string, name: string) => void;
  deleteBook: (bookId: string) => void;
  duplicateBook: (bookId: string) => WorldInfoBook | null;
  /**
   * Sets a book's sharing state. No-op when the target is an Auto Memory
   * book (`autoExtracted === true`) and `visibility === 'shared'` is
   * requested — machine-extracted notes are never shareable, mirroring the
   * server-side enforcement in the /worldinfo/shared endpoint.
   */
  setBookVisibility: (bookId: string, visibility: BookVisibility) => void;

  // Entry CRUD
  createEntry: (
    bookId: string,
    data?: Partial<Omit<WorldInfoEntry, 'id' | 'createdAt' | 'updatedAt'>>,
    meta?: { sourceChatFile?: string }
  ) => WorldInfoEntry | null;
  updateEntry: (
    bookId: string,
    entryId: string,
    data: Partial<Omit<WorldInfoEntry, 'id' | 'createdAt'>>,
    meta?: {
      action?: RevisionAction;
      sourceChatFile?: string;
      recordRevision?: 'auto' | 'always';
    }
  ) => void;
  deleteEntry: (bookId: string, entryId: string) => void;

  // Activation
  setBookActive: (bookId: string, active: boolean) => void;
  toggleBookActive: (bookId: string) => void;
  setScanDepth: (depth: number) => void;
  setMaxRecursionSteps: (steps: number) => void;
  setTokenBudget: (budget: number) => void;

  // Import / export
  exportBookJson: (bookId: string) => string | null;
  importBookJson: (
    json: string,
    fallbackName?: string,
    ownerAvatar?: string | null
  ) => WorldInfoBook | null;

  // Character-embedded lorebooks: at most one book per character avatar,
  // auto-scoped to that character's chats.
  upsertCharacterBook: (
    ownerAvatar: string,
    raw: CharacterBookV2,
    fallbackName: string
  ) => WorldInfoBook;
  /**
   * Creates a fresh empty book already owned by the given character. When
   * `autoExtracted` is true, the book is created WITH the flag already
   * set (so the very first POST carries it — see bookToWirePayload) rather
   * than patched in after the fact. Ignored (existing book returned
   * as-is) when a book for this avatar already exists — see
   * markBookAutoExtracted for retroactively flagging that case instead.
   */
  createCharacterBook: (
    ownerAvatar: string,
    name: string,
    autoExtracted?: boolean
  ) => WorldInfoBook;
  /**
   * The character's EMBEDDED (card) lorebook, or null. A character can own
   * more than one book — character-scoped Data Bank documents are owned
   * books too — so this deliberately skips document books rather than
   * returning whichever owned book happens to come first; see
   * findEmbeddedBook. Callers that want the character's whole owned set
   * (the chat scan, notably) want getCharacterBooks instead.
   */
  getCharacterBook: (ownerAvatar: string) => WorldInfoBook | null;
  /**
   * EVERY book owned by this character — its embedded card book plus any
   * character-scoped documents. This is the set that is in scope for that
   * character's chats: owned books are deliberately kept OUT of the global
   * activeBookIds (an active foreign character-scoped book disqualifies
   * every other character's chat from server retrieval — see
   * serverRetrieval.ts condition 5), so this union is the only path that
   * reaches them.
   */
  getCharacterBooks: (ownerAvatar: string) => WorldInfoBook[];
  /**
   * Deletes EVERY book owned by this character — used when the character
   * itself is deleted, which leaves owned books unreachable (they are hidden
   * from the world list and only ever activated through their owner). Takes
   * no book id on purpose: the old single-book variant deleted whichever
   * owned book came first, so an unrelated delete could destroy a
   * character-scoped document instead of the card's lorebook (#450 F3). To
   * delete ONE specific book, call deleteBook(bookId).
   */
  deleteCharacterBooks: (ownerAvatar: string) => void;
  /**
   * Persist the auto-extracted flag onto an EXISTING book (one-way ratchet
   * — see update_lorebook's docstring; the backend never lets this un-set
   * once true). No-op if the book is already flagged locally. Used by
   * autoMemoryStore.extractFacts when its first extraction for a
   * character lands on an already-existing hand-curated embedded book
   * (createCharacterBook's "reuse" branch) rather than creating a fresh
   * one — that book was already synced with autoExtracted=false, so a
   * purely-local patch (this store's old behavior) left the SERVER row
   * unprotected: GET /worldinfo/shared's own defense-in-depth filter
   * trusts the DB column, not local client state.
   */
  markBookAutoExtracted: (bookId: string) => void;

  // Chat-scoped lorebooks
  getChatLinkedBookIds: (chatFileName: string) => string[];
  setChatLinkedBookIds: (chatFileName: string, ids: string[]) => void;

  clearError: () => void;

  // Lifecycle: call on login/checkAuth to load the user's books, and on logout
  // to clear in-memory state so one user's books don't bleed into another's.
  initForUser: (handle: string) => void;
  resetUser: () => void;

  /**
   * Two independent legs (Phase 3a):
   *  1. activeBookIds/chatLinkedBookIds/scan settings, from ggbc-backend's
   *     /sync/section/{name} blob — same mechanism as before. Migration on
   *     first call: if the server has no record yet, push the current
   *     localStorage state up as the initial sync. After this returns,
   *     autosave is enabled for these fields — any subsequent mutation
   *     debounces a PUT back to the server.
   *  2. books/entries, from the native /lorebooks API — the system of
   *     record now, not the blob. Runs a one-time (per session)
   *     import-from-blob bootstrap, fetches the current native state, and
   *     populates the legacy id remap (remapLegacyBookId/remapLegacyEntryId)
   *     before applying it to `books`.
   * A failure in leg 1 never blocks leg 2 or vice versa. After both, this
   * also (3) awaits fetchSharedBooks, (4) remaps chatLinkedBookIds/
   * activeBookIds in place (remapChatLinkedAndActiveBookIds), then (5) opens
   * the legacyIdRemapReady() gate — the signal chatLoreConfigStore/
   * characterStore/personaStore wait on before running their own one-time
   * remap pass over whatever book/entry ids they persist.
   */
  fetchPrefs: () => Promise<void>;

  /**
   * Pull every book other users have marked shared from GET /worldinfo/shared
   * and normalize into sharedBooks / sharedOwnerNameByHandle. Never throws -
   * a failure (including a 404 if the backend endpoint hasn't deployed yet)
   * lands in sharedBooksStatus/sharedBooksError instead.
   */
  fetchSharedBooks: () => Promise<void>;

  /**
   * Read-only view combining this user's own books with every shared book,
   * deduplicated by id - the caller's own book wins on collision (e.g. a
   * shared book id colliding with one of the viewer's own from a duplicate
   * ST import). Pure read; not async, not persisted.
   */
  getComposableBooks: () => WorldInfoBook[];

  /**
   * Copies a book out of `sharedBooks` (another user's book) into this
   * user's own `books`: deep-copies entries with fresh ids (remapping
   * relatedIds via the same helper duplicateBook uses), and resets
   * ownership/visibility so the copy behaves like any other owned book.
   * Returns null when `sharedBookId` isn't currently present in
   * `sharedBooks` (e.g. the sharer revoked it since the last fetch).
   */
  copySharedBook: (sharedBookId: string) => WorldInfoBook | null;
}

// ---------------------------------------------------------------------------
// Cross-device sync (A3.1a — lorebooks)
// ---------------------------------------------------------------------------

const SERVER_KEY = 'stm_worldinfo';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

/**
 * Phase 3a: `books` is deliberately ABSENT from this shape now. Native
 * `/lorebooks` (books + entries) is the system of record going forward —
 * the stm_worldinfo blob only still carries activeBookIds/chatLinkedBookIds/
 * scan settings, none of which have a native-table home. A pre-cutover
 * client's blob may still have a `books` field on it (harmless — fetchPrefs
 * reads it ONLY as a one-time remap candidate source, see
 * buildLegacyIdRemap, never applies it to state), and this type simply
 * doesn't describe that field since nothing here writes it anymore.
 */
interface PersistedShape {
  activeBookIds: string[];
  chatLinkedBookIds: Record<string, string[]>;
  scanDepth: number;
  maxRecursionSteps: number;
  tokenBudget: number;
}

// ---------------------------------------------------------------------------
// Native /lorebooks wire conversion (Phase 3a). Every WorldInfoEntry field
// maps 1:1 onto LorebookEntryIn's wire names (app/schemas/lorebook.py's
// aliases match this file's own camelCase field names exactly), so these
// converters are near-trivial — no translation table needed, unlike the
// ST/CharacterBookV2 interop above.
// ---------------------------------------------------------------------------

/** Build the POST /lorebooks payload for a brand-new book. `id` is honored
 *  by the backend (via _coerce_uuid) as the row's actual primary key, and
 *  the create is idempotent on retry — see api.createLorebook's docstring.
 *  `autoExtracted` is included only when explicitly true (never sent as an
 *  explicit false — matches the one-way-ratchet contract create_lorebook/
 *  update_lorebook now enforce server-side; omitting it entirely for an
 *  ordinary book is equivalent, since the server's own default is false).
 *  See createCharacterBook for why this needs to be set correctly in the
 *  very FIRST create request, not patched in after the fact. */
/**
 * True for a "document" book — a Data Bank upload whose entries are
 * machine-chunked prose (see dataBankStore.addDocument).
 *
 * Used for one thing only: keeping such a book from being mistaken for a
 * character's EMBEDDED card lorebook. A character can own several books (its
 * card's, plus any character-scoped documents), but exactly one of them is
 * the card's, and the resolvers below used to take whichever came first in
 * the array — so an unrelated card import, auto-memory append or delete could
 * land on a document instead (#450 F3).
 *
 * Identity first, content second, and the order matters. The registry (see
 * documentBookRegistry.ts) is a DURABLE signal: written when the document is
 * created, persisted locally and synced server-side, and unaffected by any
 * ordinary edit the user makes to the book. The old check ("every entry is
 * semanticOnly") was pure content, so adding a single keyworded entry —
 * which the Data Bank's own copy now tells users to do — unmasked the
 * document and handed it to upsertCharacterBook/importBookJson to overwrite
 * and hard-delete.
 *
 * The content fallbacks below exist because the registry can legitimately
 * be behind (a document created on another device, before that device's
 * dataBankStore.fetchPrefs has landed). Both fallbacks lean the same way —
 * toward CALLING something a document — because that is the direction that
 * cannot destroy data: the cost of a false positive is one extra empty
 * embedded book, the cost of a false negative is a destroyed document.
 *
 * That is also why a book with no visible entries counts as a document
 * while the session's entry fetch is degraded: fetchNativeBooks answers a
 * failed per-book entry GET with `entries: []`, so during such a session
 * "no entries" means "we cannot see them", and guessing from content we
 * do not have is exactly what must not happen.
 */
function isDocumentBook(book: WorldInfoBook): boolean {
  if (isRegisteredDocumentBook(book.id)) return true;
  if (book.entries.length > 0) return book.entries.every((e) => e.semanticOnly);
  // `_entriesFetchDegraded` is declared below with fetchNativeBooks, which
  // owns it; this only ever reads it at call time, never at module init.
  return _entriesFetchDegraded;
}

/**
 * The character's embedded (card) lorebook: the first book it owns that is
 * not a document. Null when the character owns nothing but documents — in
 * which case callers create a fresh embedded book rather than overwriting
 * one of them.
 */
function findEmbeddedBook(
  books: WorldInfoBook[],
  ownerAvatar: string
): WorldInfoBook | null {
  return (
    books.find(
      (b) => b.ownerCharacterAvatar === ownerAvatar && !isDocumentBook(b)
    ) || null
  );
}

function bookToWirePayload(book: WorldInfoBook): Record<string, unknown> {
  return {
    id: book.id,
    name: book.name,
    ownerCharacterAvatar: book.ownerCharacterAvatar,
    visibility: book.visibility,
    ...(book.autoExtracted === true ? { autoExtracted: true } : {}),
  };
}

/** Build the POST/PUT entry payload. Used for both create (as-is) and
 *  update (spread + baseTs added by the caller) since the two share the
 *  exact same full-object wire shape server-side. */
function entryToWirePayload(entry: WorldInfoEntry): Record<string, unknown> {
  return {
    id: entry.id,
    keys: entry.keys,
    content: entry.content,
    comment: entry.comment,
    enabled: entry.enabled,
    constant: entry.constant,
    caseSensitive: entry.caseSensitive,
    position: entry.position,
    depth: entry.depth,
    order: entry.order,
    keysSecondary: entry.keysSecondary,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    scanDepth: entry.scanDepth,
    probability: entry.probability,
    useProbability: entry.useProbability,
    group: entry.group,
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    preventRecursion: entry.preventRecursion,
    excludeRecursion: entry.excludeRecursion,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    critical: entry.critical,
    semanticOnly: entry.semanticOnly,
    category: entry.category,
    relatedIds: entry.relatedIds,
    source: entry.source,
    revisions: entry.revisions,
  };
}

const VALID_POSITIONS_SET: readonly WorldInfoPosition[] = [
  'before_char', 'after_char', 'before_an', 'after_an', 'at_depth',
];
const VALID_LOGIC_SET: readonly SelectiveLogic[] = [
  'AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL',
];

/**
 * Normalize one native LorebookEntryOut-shaped DTO into a full
 * WorldInfoEntry. Defensive same as serverRetrieval.ts's dtoToMatchedEntry —
 * the server already validated this shape, but it's never trusted blindly
 * here either (a malformed/stale row must degrade gracefully, not crash the
 * whole book fetch).
 */
function normalizeNativeEntry(dto: LorebookEntryDTO): WorldInfoEntry {
  const position = VALID_POSITIONS_SET.includes(dto.position as WorldInfoPosition)
    ? (dto.position as WorldInfoPosition)
    : 'before_char';
  const selectiveLogic = VALID_LOGIC_SET.includes(dto.selectiveLogic as SelectiveLogic)
    ? (dto.selectiveLogic as SelectiveLogic)
    : 'AND_ANY';
  const source = isValidEntrySource(dto.source) ? dto.source : 'manual';
  return {
    id: String(dto.id),
    keys: pickStringArray(dto.keys),
    content: typeof dto.content === 'string' ? dto.content : '',
    comment: typeof dto.comment === 'string' ? dto.comment : '',
    enabled: dto.enabled !== false,
    constant: dto.constant === true,
    caseSensitive: dto.caseSensitive === true,
    position,
    depth: typeof dto.depth === 'number' ? dto.depth : DEFAULT_ENTRY.depth,
    order: typeof dto.order === 'number' ? dto.order : DEFAULT_ENTRY.order,
    keysSecondary: pickStringArray(dto.keysSecondary),
    selective: dto.selective === true,
    selectiveLogic,
    scanDepth: typeof dto.scanDepth === 'number' ? dto.scanDepth : null,
    probability: typeof dto.probability === 'number' ? clamp(dto.probability, 0, 100) : 100,
    useProbability: dto.useProbability === true,
    group: typeof dto.group === 'string' ? dto.group : '',
    groupOverride: dto.groupOverride === true,
    groupWeight:
      typeof dto.groupWeight === 'number' && dto.groupWeight > 0 ? dto.groupWeight : 100,
    preventRecursion: dto.preventRecursion === true,
    excludeRecursion: dto.excludeRecursion === true,
    sticky: typeof dto.sticky === 'number' && dto.sticky > 0 ? Math.floor(dto.sticky) : 0,
    cooldown: typeof dto.cooldown === 'number' && dto.cooldown > 0 ? Math.floor(dto.cooldown) : 0,
    delay: typeof dto.delay === 'number' && dto.delay > 0 ? Math.floor(dto.delay) : 0,
    critical: dto.critical === true,
    semanticOnly: dto.semanticOnly === true,
    category: typeof dto.category === 'string' ? dto.category : '',
    relatedIds: pickStringArray(dto.relatedIds),
    source,
    revisions: Array.isArray(dto.revisions) ? (dto.revisions as EntryRevision[]) : [],
    createdAt: typeof dto.createdAt === 'number' ? dto.createdAt : Date.now(),
    updatedAt: typeof dto.updatedAt === 'number' ? dto.updatedAt : Date.now(),
    serverTs: typeof dto.server_ts === 'number' ? dto.server_ts : undefined,
  };
}

/** Normalize one native LorebookWithEntriesOut-shaped DTO into a full WorldInfoBook. */
function normalizeNativeBook(dto: LorebookWithEntriesDTO): WorldInfoBook {
  const ownerCharacterAvatar =
    typeof dto.ownerCharacterAvatar === 'string' ? dto.ownerCharacterAvatar : null;
  return {
    id: String(dto.id),
    name: typeof dto.name === 'string' ? dto.name : 'Untitled Lorebook',
    entries: Array.isArray(dto.entries) ? dto.entries.map(normalizeNativeEntry) : [],
    ownerCharacterAvatar,
    autoExtracted: dto.autoExtracted === true ? true : undefined,
    // scope is derived — recompute from ownerCharacterAvatar, never trust
    // the DTO's own `scope` field blindly (same discipline as every other
    // normalizer in this file).
    scope: ownerCharacterAvatar != null ? 'character' : 'world',
    ownerHandle: typeof dto.ownerHandle === 'string' ? dto.ownerHandle : currentHandle(),
    visibility: dto.visibility === 'shared' ? 'shared' : 'private',
    createdAt: typeof dto.createdAt === 'number' ? dto.createdAt : Date.now(),
    updatedAt: typeof dto.updatedAt === 'number' ? dto.updatedAt : Date.now(),
    serverTs: typeof dto.server_ts === 'number' ? dto.server_ts : undefined,
  };
}

/**
 * One-time (session-scoped) migration bootstrap: import-from-blob is
 * idempotent and repeatable server-side, but there's no reason to call it
 * more than once per logged-in session. Reset by resetUser (logout) so a
 * second user logging into the same browser session gets their OWN import
 * attempt, not a skipped no-op inherited from the previous account.
 *
 * Deliberately a SEPARATE guard from serverRetrieval.ts's own
 * ensureContentImported/contentImportSucceeded, not a shared one: that
 * guard gates the first ELIGIBLE chat turn, this one gates the first
 * fetchPrefs (i.e. login) — the two can legitimately race on a fresh
 * login, which is fine, since the backend endpoint is idempotent either way.
 */
let _blobImportAttempted = false;

async function ensureBlobImported(): Promise<void> {
  if (_blobImportAttempted) return;
  _blobImportAttempted = true;
  try {
    await api.importLorebooksFromBlob();
  } catch (err) {
    // Allow a retry on the next fetchPrefs call in this same session — a
    // failed import would otherwise permanently hide any never-migrated
    // book with no recovery short of a full page reload.
    _blobImportAttempted = false;
    console.warn('[worldInfoStore] import-from-blob failed', err);
  }
}

/**
 * Fetch every native book with its entries. GET /lorebooks has no
 * entries-inclusive bulk variant, so this is list + N parallel per-book
 * GETs — acceptable at this app's scale (a handful of books per user).
 * A single book's entry-fetch failing doesn't drop the whole book: it
 * falls back to the list-level metadata with zero entries, so the book at
 * least stays visible/selectable rather than vanishing outright.
 *
 * That fallback also sets `_entriesFetchDegraded` for the session: a book
 * whose entries silently read as [] makes every entry-liveness judgement
 * downstream unreliable — buildLegacyIdRemap would see a map pair
 * targeting that book's entries as dead, which R2's per-id drop rule
 * would otherwise read as "successor deliberately deleted" and authorize
 * a permanent drop of a live reference (see droppableLegacyEntryId).
 */
let _entriesFetchDegraded = false;

async function fetchNativeBooks(): Promise<WorldInfoBook[]> {
  _entriesFetchDegraded = false;
  const rows = await api.listLorebooks();
  return Promise.all(
    rows.map(async (row) => {
      try {
        return normalizeNativeBook(await api.getLorebook(String(row.id)));
      } catch (err) {
        console.warn('[worldInfoStore] failed to fetch entries for lorebook', row.id, err);
        _entriesFetchDegraded = true;
        return normalizeNativeBook({ ...row, entries: [] } as LorebookWithEntriesDTO);
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Legacy id remap (Phase 3a migration). Exported for the next step
// (chatLoreConfigStore / characterStore / personaStore / AttachBookPicker)
// to translate any locally-persisted reference minted before this cutover.
// Populated once per fetchPrefs call by buildLegacyIdRemap, called AFTER
// the native fetch and BEFORE `books` is applied to state — see fetchPrefs
// itself for the exact ordering guarantee.
// ---------------------------------------------------------------------------

const _legacyBookIdMap = new Map<string, string>();
const _legacyEntryIdMap = new Map<string, string>();

// R2 of the legacy-id strip scoping (docs/legacy-id-strip-scoping.md): the
// RAW key sets of the server-recorded map, captured alongside the filtered
// maps above. The filtered maps deliberately drop pairs whose target no
// longer exists (see buildLegacyIdRemap's liveness checks), which erases
// exactly the signal the per-id drop rule below needs — "the server named
// this id and its successor is verifiably gone" is the ONE case where
// dropping a legacy-pattern reference is a fact rather than a guess.
// Session-scoped like every other module-level flag here: cleared in
// clearLegacyIdRemap (and therefore resetUser), or a same-tab account
// switch would let account A's map keys authorize drops against account B.
const _serverMapBookKeys = new Set<string>();
const _serverMapEntryKeys = new Set<string>();

// The strict legacy id shapes minted by the pre-cutover generateId
// (`${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
// removed in the 2026-08-07 cutover): a 13-digit ms timestamp then a short
// base36 tail. Anchored so the still-live wibook_chatlocal__<chatFile> and
// wi_local_<ts>_<rand> families (non-digit segment right after the prefix)
// never match — those are synthetic runtime ids, not migration targets.
const LEGACY_BOOK_ID_RE = /^wibook_\d{13}_[0-9a-z]{1,6}$/;
const LEGACY_ENTRY_ID_RE = /^wi_\d{13}_[0-9a-z]{1,6}$/;

/** R2's per-id drop rule, book form. Only meaningful at a resolver's drop
 *  branch (the id is already known to be unresolved): a legacy-pattern id
 *  may be dropped only when the server map named it — and since a raw-named
 *  pair whose target is alive would have resolved via `_legacyBookIdMap`
 *  before reaching the drop branch, "raw-named here" means the recorded
 *  successor was deliberately deleted (the `!has` conjunct restates that
 *  for safety should a future caller sit outside the drop branch).
 *  Everything else (blob-present-but-unpaired after a failed import,
 *  cross-user references the caller's own map can never adjudicate,
 *  post-strip stragglers) is kept dangling: dangling ids are inert on
 *  every lore-injection read path (they only ever act as filters over
 *  real books; count-style badges may over-count, a cosmetic trade) —
 *  while a wrong drop is persisted and permanent. */
function droppableLegacyBookId(id: string): boolean {
  return _serverMapBookKeys.has(id) && !_legacyBookIdMap.has(id);
}

/** R2's per-id drop rule, entry form. The extra `_legacyEntryIdMap` guard
 *  exists because the map's entries are target-verified against a FLAT
 *  cross-book id set (see buildLegacyIdRemap) while resolveLegacyEntryId
 *  re-scopes its lookup to the caller's book — a raw-named pair whose
 *  target is alive in a DIFFERENT book reaches the drop branch too, and
 *  must be kept dangling rather than dropped under a dead-target rationale.
 *  `_entriesFetchDegraded` guards the other spoof: a book whose entries
 *  silently fell back to [] this session makes "target not found" mean
 *  "target unknown", not "target deleted" — no entry drop may be
 *  authorized off a degraded view. */
function droppableLegacyEntryId(entryId: string): boolean {
  return (
    !_entriesFetchDegraded &&
    _serverMapEntryKeys.has(entryId) &&
    !_legacyEntryIdMap.has(entryId)
  );
}

/** Shape of the `stm_wi_legacy_id_map` sync section (Phase 3.3 step (a),
 *  ggbc-backend's `_persist_legacy_id_map`) — a backend-authored-only,
 *  read-only-from-here record of every legacy id that
 *  `import_lorebooks_from_blob` has ever replaced with a freshly-minted
 *  UUID. `oldId -> newId`, both directions plain strings; loosely typed
 *  since it rides in through the same untyped `getSettingsBlob()` blob
 *  every other section does. */
interface LegacyIdMapSection {
  books: Record<string, unknown>;
  entries: Record<string, unknown>;
}

/**
 * Translate a book id that predates this cutover (minted by the old
 * `generateId('wibook')` scheme, still sitting in some other store's
 * persisted state) into its current native-table id. Returns null when
 * `oldId` has no known remap: either it's already current (nothing to
 * remap), or it couldn't be matched — see buildLegacyIdRemap's matching
 * strategy and its documented limits. Safe to call before the first
 * fetchPrefs completes (returns null for everything until then).
 */
export function remapLegacyBookId(oldId: string): string | null {
  return _legacyBookIdMap.get(oldId) ?? null;
}

/** Same as remapLegacyBookId, for entry ids. */
export function remapLegacyEntryId(oldId: string): string | null {
  return _legacyEntryIdMap.get(oldId) ?? null;
}

// ---------------------------------------------------------------------------
// Legacy id remap readiness + higher-level resolve helpers (Phase 3a step 2).
// Consumers (chatLoreConfigStore / characterStore / personaStore) need more
// than the raw remap lookup above: they need to know WHEN it's safe to make
// a final "keep / remap / drop" decision, and a "confidently gone" verdict
// requires knowing the fetches that populate `books`/`sharedBooks` actually
// succeeded — a network hiccup at login must never look identical to "this
// book was deleted" and silently destroy a user's real reference.
// ---------------------------------------------------------------------------

/** True once this session's fetchPrefs has applied a SUCCESSFUL native
 *  /lorebooks fetch to `books` (not the "keep last known local state on
 *  failure" fallback). Reset on resetUser. */
let _nativeBooksFetchSucceeded = false;

let _resolveLegacyIdRemapReady: () => void = () => {};
let _legacyIdRemapReadyPromise: Promise<void> = new Promise((resolve) => {
  _resolveLegacyIdRemapReady = resolve;
});

function resetLegacyIdRemapReadyGate(): void {
  _legacyIdRemapReadyPromise = new Promise((resolve) => {
    _resolveLegacyIdRemapReady = resolve;
  });
}

/**
 * Resolves once, per login session, after fetchPrefs has settled BOTH the
 * native books fetch (success or failure) AND fetchSharedBooks (success or
 * failure) — see fetchPrefs. Dependent stores must await this before running
 * their own one-time legacy-id remap pass, or resolveLegacyBookId/
 * resolveLegacyEntryId below would be judging against a not-yet-loaded (or
 * partially-loaded) view of books/sharedBooks. Reset on resetUser (logout)
 * so the next login gets its own fresh gate rather than one already resolved
 * by the previous account.
 */
export function legacyIdRemapReady(): Promise<void> {
  return _legacyIdRemapReadyPromise;
}

/**
 * True only when both the native-books fetch and the shared-books fetch
 * succeeded this session. Gates whether "not found anywhere" is trusted as
 * "confidently gone" (safe to drop) versus merely ambiguous (a fetch
 * failure fell back to stale/partial local data — keep the reference
 * unchanged rather than risk destroying it, it'll be re-evaluated on a
 * future login once the fetch actually succeeds).
 */
export function canConfidentlyDropUnresolvedLegacyIds(): boolean {
  return (
    _nativeBooksFetchSucceeded &&
    useWorldInfoStore.getState().sharedBooksStatus === 'loaded'
  );
}

/**
 * Resolve a (possibly legacy) book id to what a dependent store should use
 * going forward:
 *  - a confident remap exists (buildLegacyIdRemap matched it) -> the new id.
 *  - no remap, but the id is confirmed present in books ∪ sharedBooks as-is
 *    -> the same id, unchanged.
 *  - no remap, not currently found anywhere: for a NATIVE-format id -> null
 *    (drop) IF canConfidentlyDropUnresolvedLegacyIds() is true, exactly as
 *    before. For a strict LEGACY-pattern id (R2 of the legacy-id strip
 *    scoping), that session-health gate is necessary but no longer
 *    sufficient: it is dropped only when the server-recorded map named it
 *    and its recorded successor is verifiably gone (droppableLegacyBookId);
 *    otherwise it is kept dangling — an import failure, a cross-user
 *    reference, or a stripped blob must never read as "confidently gone".
 *  - on an unreliable read (either fetch failed), everything unresolved is
 *    returned unchanged — never dropped.
 * Must only be called after legacyIdRemapReady() has resolved.
 */
export function resolveLegacyBookId(id: string): string | null {
  const mapped = remapLegacyBookId(id);
  if (mapped) return mapped;
  const state = useWorldInfoStore.getState();
  if (state.books.some((b) => b.id === id) || state.sharedBooks.some((b) => b.id === id)) {
    return id;
  }
  if (!canConfidentlyDropUnresolvedLegacyIds()) return id;
  if (LEGACY_BOOK_ID_RE.test(id)) {
    return droppableLegacyBookId(id) ? null : id;
  }
  return null;
}

/**
 * Same idea as resolveLegacyBookId, for an entry id scoped to a book id the
 * caller has ALREADY resolved via resolveLegacyBookId (pass the RESOLVED id,
 * not the original). The book-not-found path is reachable two ways: an
 * unreliable read (either fetch failed), or — since R2 — a reliable read
 * whose resolvedBookId is itself a kept-dangling legacy id (cross-user
 * references, import-failed sessions). Either way that exit applies the
 * SAME per-id drop rule as the in-book exits (_dropOrKeepEntryId), never
 * an unconditional keep or drop.
 *
 * Deliberately NOT used for entry-overlay base ids (see
 * chatLoreConfigStore.ts's remapLegacyIds): an overlay whose base entry
 * can't be matched may be a genuine orphan, which resolveEffectiveBooks
 * already has dedicated promote-to-local-entry handling for — that handling
 * only works if the overlay keeps referencing the SAME base id it always
 * has, so overlays only ever apply a confident remap and never drop.
 */
export function resolveLegacyEntryId(resolvedBookId: string, entryId: string): string | null {
  const state = useWorldInfoStore.getState();
  const book =
    state.books.find((b) => b.id === resolvedBookId) ??
    state.sharedBooks.find((b) => b.id === resolvedBookId);
  if (!book) return _dropOrKeepEntryId(entryId);

  const mapped = remapLegacyEntryId(entryId);
  if (mapped && book.entries.some((e) => e.id === mapped)) return mapped;
  if (book.entries.some((e) => e.id === entryId)) return entryId;
  return _dropOrKeepEntryId(entryId);
}

/** Shared drop branch for resolveLegacyEntryId's two unresolved exits —
 *  same R2 rule as resolveLegacyBookId's: native-format ids keep the old
 *  confident-drop behavior; legacy-pattern ids are dropped only on a
 *  server-verified dead successor (droppableLegacyEntryId), else kept. */
function _dropOrKeepEntryId(entryId: string): string | null {
  if (!canConfidentlyDropUnresolvedLegacyIds()) return entryId;
  if (LEGACY_ENTRY_ID_RE.test(entryId)) {
    return droppableLegacyEntryId(entryId) ? null : entryId;
  }
  return null;
}

/**
 * Best-effort content signature used to pair an old-id entry with its
 * native-fetched counterpart when the id itself can't be trusted to match
 * (see buildLegacyIdRemap). comment+content+sorted-keys is unique enough
 * for a hand-authored lorebook in practice; a genuine collision (two
 * entries with byte-identical comment/content/keys) just leaves one of the
 * pair unmapped rather than silently mismapped — matched greedily below.
 */
function entrySignature(e: WorldInfoEntry): string {
  return JSON.stringify([e.comment, e.content, [...e.keys].sort()]);
}

/**
 * Populate _legacyBookIdMap/_legacyEntryIdMap by pairing `oldBooks` (the
 * last locally-known state, id-keyed by the pre-cutover `generateId`
 * scheme, or a legacy synced blob's `books` field) against `newBooks` (the
 * just-fetched native-table state).
 *
 * Books are grouped by (ownerCharacterAvatar, name) — the same scope key
 * `import_lorebooks_from_blob` itself matches on, server-side — then
 * matched against `newBooks`' single surviving row for that key. This is
 * exact for world-scoped books (DB-unique per user via
 * `lorebooks_user_name_world_uq`) and reliable for character-embedded
 * books (this codebase's own invariant: at most one embedded book per
 * avatar, enforced by createCharacterBook/upsertCharacterBook) — PROVIDED
 * `oldBooks` itself never has two DIFFERENT books sharing that key. Unlike
 * the native tables, nothing in createBook/renameBook ever enforced that
 * pre-cutover, so two genuinely distinct old books legitimately CAN share
 * a scope key (two books both named "Notes", say). When that happens,
 * `import_lorebooks_from_blob` only ever created ONE surviving row for the
 * pair (the loser is silently recorded in its own `skipped` return value,
 * which nothing on the frontend reads) — so blindly mapping BOTH old ids
 * onto that one surviving `match` would misattribute the loser's
 * persona/character/chat references onto a book they were never actually
 * linked to. Guarded against below: a scope-key group with more than one
 * old book only gets a remap when content-signature overlap against
 * `match.entries` picks a single unambiguous winner; every other book in
 * that group is left unmapped, which lets `resolveLegacyBookId` fall
 * through to its own "unresolved" handling (dropped once confidently
 * gone, kept ambiguous otherwise) instead of silently pointing a stale
 * reference at the wrong book's content.
 *
 * Entries within a matched book pair are matched by content signature
 * (see entrySignature) — for anything import-from-blob migrated BEFORE
 * Phase 3.3 step (a) shipped, there is no server-recorded old-id ->
 * new-id trail (the migration endpoint used to mint/preserve ids without
 * reporting a mapping back), so this remains a best-effort heuristic for
 * that cohort: a book containing two entries with byte-identical
 * comment/content/keys leaves one of the pair unmapped (never mismapped)
 * rather than resolving the ambiguity by guessing. For anything migrated
 * AFTER step (a) shipped, `serverMap` (below) supplies an EXACT trail
 * instead and takes precedence over whatever this heuristic guesses.
 */
function buildLegacyIdRemap(
  oldBooks: WorldInfoBook[],
  newBooks: WorldInfoBook[],
  serverMap?: LegacyIdMapSection | null
): void {
  _legacyBookIdMap.clear();
  _legacyEntryIdMap.clear();
  _serverMapBookKeys.clear();
  _serverMapEntryKeys.clear();
  const newByScopeKey = new Map<string, WorldInfoBook>();
  for (const nb of newBooks) {
    newByScopeKey.set(`${nb.ownerCharacterAvatar ?? ''}::${nb.name}`, nb);
  }

  const oldByScopeKey = new Map<string, WorldInfoBook[]>();
  for (const ob of oldBooks) {
    const key = `${ob.ownerCharacterAvatar ?? ''}::${ob.name}`;
    const group = oldByScopeKey.get(key);
    if (group) group.push(ob);
    else oldByScopeKey.set(key, [ob]);
  }

  for (const [key, group] of oldByScopeKey) {
    const match = newByScopeKey.get(key);
    if (!match) continue;

    let winner: WorldInfoBook;
    if (group.length === 1) {
      winner = group[0];
    } else {
      // Ambiguous: two or more old books share this scope key, but only
      // one of them can be `match`'s actual predecessor. Disambiguate by
      // entry-content overlap — the old book sharing the most entries
      // (by content signature) with `match` is the winner, but ONLY if
      // that's a clear, non-zero, untied lead; otherwise every book in
      // the group is left unmapped rather than guessed at.
      const matchSigs = new Set(match.entries.map(entrySignature));
      let bestScore = -1;
      let bestBook: WorldInfoBook | null = null;
      let tie = false;
      for (const ob of group) {
        const score = ob.entries.reduce(
          (n, e) => n + (matchSigs.has(entrySignature(e)) ? 1 : 0),
          0
        );
        if (score > bestScore) {
          bestScore = score;
          bestBook = ob;
          tie = false;
        } else if (score === bestScore) {
          tie = true;
        }
      }
      if (tie || bestScore <= 0 || !bestBook) {
        console.warn(
          `[worldInfoStore] ${group.length} legacy books share scope key "${key}" with no unambiguous content match — leaving all unmapped`
        );
        continue;
      }
      winner = bestBook;
    }

    if (match.id !== winner.id) _legacyBookIdMap.set(winner.id, match.id);

    const newEntriesBySig = new Map<string, WorldInfoEntry[]>();
    for (const ne of match.entries) {
      const sig = entrySignature(ne);
      const list = newEntriesBySig.get(sig);
      if (list) list.push(ne);
      else newEntriesBySig.set(sig, [ne]);
    }
    const usedNewIds = new Set<string>();
    for (const oe of winner.entries) {
      const candidates = newEntriesBySig.get(entrySignature(oe));
      if (!candidates) continue;
      const next = candidates.find((c) => !usedNewIds.has(c.id));
      if (!next) continue;
      usedNewIds.add(next.id);
      if (next.id !== oe.id) _legacyEntryIdMap.set(oe.id, next.id);
    }
  }

  // Phase 3.3 step (b) of the memory-consolidation plan: an EXACT,
  // server-recorded id trail (import_lorebooks_from_blob persists every
  // legacy id it actually reminted — ggbc-backend's
  // _persist_legacy_id_map) takes precedence over the heuristic
  // content-signature matching above, wherever it names something that
  // still genuinely exists. Applied AFTER the heuristic (Map.set
  // overwrites), deliberately: the heuristic is a best-effort fallback
  // for ids the server map doesn't (yet) cover — books/entries migrated
  // before this feature shipped — not the other way around; a
  // server-confirmed pair must never be clobbered by a guess.
  if (serverMap) {
    const newBookIds = new Set(newBooks.map((b) => b.id));
    for (const [oldId, newId] of Object.entries(serverMap.books)) {
      // Raw key captured UNCONDITIONALLY — including pairs the liveness
      // check below discards. A raw-named id that ends up with no filtered
      // pair is exactly the "recorded successor was deliberately deleted"
      // signal R2's per-id drop rule (droppableLegacyBookId) keys on.
      _serverMapBookKeys.add(oldId);
      if (typeof newId === 'string' && newBookIds.has(newId)) {
        _legacyBookIdMap.set(oldId, newId);
      }
    }
    // Flat existence check, matching _legacyEntryIdMap's own flat shape —
    // the per-BOOK association is re-validated anyway at actual use time
    // (resolveLegacyEntryId scopes the lookup to the caller's already-
    // resolved book), so this is a "does this id exist anywhere at all"
    // sanity check, not the authoritative one.
    const allNewEntryIds = new Set<string>();
    for (const nb of newBooks) {
      for (const e of nb.entries) allNewEntryIds.add(e.id);
    }
    for (const [oldId, newId] of Object.entries(serverMap.entries)) {
      _serverMapEntryKeys.add(oldId); // raw key, unconditional — see books arm
      if (typeof newId === 'string' && allNewEntryIds.has(newId)) {
        _legacyEntryIdMap.set(oldId, newId);
      }
    }
  }
}

function clearLegacyIdRemap(): void {
  _legacyBookIdMap.clear();
  _legacyEntryIdMap.clear();
  _serverMapBookKeys.clear();
  _serverMapEntryKeys.clear();
}

/**
 * One-time-per-login remap of the two book-id-keyed fields this store still
 * owns directly on the legacy stm_worldinfo blob: chatLinkedBookIds (the
 * legacy per-chat extra-book map — see getChatLinkedBookIds/
 * setChatLinkedBookIds and AttachBookPicker.tsx) and activeBookIds (the
 * globally-active set, toggleable from the Shared tab too — see
 * WorldInfoPage.tsx — so it CAN legitimately hold a shared book id, unlike
 * chatLinkedBookIds which setChatLinkedBookIds restricts to the caller's own
 * books). Called from fetchPrefs once both native books and shared books
 * have settled (see canConfidentlyDropUnresolvedLegacyIds).
 *
 * Idempotent: a second call once every id is already current/confirmed is a
 * true no-op — no `set()`, no localStorage write, no server patch (the
 * subscribe-based autosave below only fires on an actual `set()`).
 */
function remapChatLinkedAndActiveBookIds(): void {
  const state = useWorldInfoStore.getState();

  const remapIdList = (ids: string[], context: string): { next: string[]; changed: boolean } => {
    const seen = new Set<string>();
    const next: string[] = [];
    let changed = false;
    for (const id of ids) {
      const resolved = resolveLegacyBookId(id);
      if (resolved === null) {
        console.warn(`[worldInfoStore] dropping unresolvable ${context} book id`, id);
        changed = true;
        continue;
      }
      if (resolved !== id) changed = true;
      if (seen.has(resolved)) {
        changed = true;
        continue;
      }
      seen.add(resolved);
      next.push(resolved);
    }
    return { next, changed };
  };

  const { next: nextActive, changed: activeChanged } = remapIdList(
    state.activeBookIds,
    'activeBookIds'
  );

  let chatLinkedChanged = false;
  const nextChatLinked: Record<string, string[]> = {};
  for (const [chatFile, ids] of Object.entries(state.chatLinkedBookIds)) {
    const { next: nextIds, changed: idsChanged } = remapIdList(ids, `chatLinkedBookIds[${chatFile}]`);
    const droppedToEmpty = nextIds.length === 0 && ids.length > 0;
    if (nextIds.length > 0) nextChatLinked[chatFile] = nextIds;
    if (idsChanged || droppedToEmpty) chatLinkedChanged = true;
  }

  if (!activeChanged && !chatLinkedChanged) return;

  if (activeChanged) saveActiveBooks(nextActive);
  if (chatLinkedChanged) saveChatLinkedBooks(nextChatLinked);
  useWorldInfoStore.setState({
    activeBookIds: activeChanged ? nextActive : state.activeBookIds,
    chatLinkedBookIds: chatLinkedChanged ? nextChatLinked : state.chatLinkedBookIds,
  });
}

// ---------------------------------------------------------------------------
// Conflict-retry PUT helpers — mirror patchServerKey's one-retry
// reconcile-and-resend pattern (serverSettings.ts), scoped per-row instead
// of per-section: on a 409, re-apply the SAME local delta on top of the
// server's authoritative current state once, then give up (the caller
// restores its own pre-mutation local snapshot and surfaces the error).
// ---------------------------------------------------------------------------

interface BookPutFields {
  name: string;
  ownerCharacterAvatar: string | null;
  visibility: BookVisibility;
  /** One-way ratchet (update_lorebook only ever honors a client-sent
   *  `true`; a `false` — or this field simply being omitted — never
   *  downgrades an already-true row). Optional and left undefined by
   *  every existing caller (renameBook/setBookVisibility/
   *  syncCharacterBookReplace): `desired`'s spread drops an undefined key
   *  entirely (JSON.stringify never sends it), which the server's own
   *  schema default (false) treats identically to "don't touch this
   *  field" given the ratchet only ever assigns true. Only
   *  markBookAutoExtracted's patch sets this explicitly. */
  autoExtracted?: boolean;
}

/**
 * PUT /lorebooks/{id} with the full-replace gotcha handled correctly:
 * always sends all three of name/ownerCharacterAvatar/visibility
 * (update_lorebook has no partial-patch semantics), where `patch` is the
 * ONE field this mutator actually intends to change and `base` supplies
 * the other two's current value. On a 409, `patch` is re-applied onto the
 * conflict's authoritative `current` (not onto our own stale `base`) so an
 * unrelated field that changed on another device is never silently
 * stomped.
 */
async function putBookWithRetry(
  bookId: string,
  base: BookPutFields,
  patch: Partial<BookPutFields>,
  baseTs: number | undefined
): Promise<LorebookDTO> {
  let desired: BookPutFields = { ...base, ...patch };
  let ts = baseTs;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await api.updateLorebook(bookId, { ...desired, baseTs: ts ?? null });
    } catch (err) {
      if (err instanceof LorebookConflictError && attempt === 0 && err.conflict.current) {
        const c = err.conflict.current;
        const current: BookPutFields = {
          name: typeof c.name === 'string' ? c.name : desired.name,
          ownerCharacterAvatar:
            typeof c.ownerCharacterAvatar === 'string' ? c.ownerCharacterAvatar : null,
          visibility: c.visibility === 'shared' ? 'shared' : 'private',
        };
        desired = { ...current, ...patch };
        ts = err.conflict.current_ts;
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable: putBookWithRetry exhausted its retry loop');
}

/**
 * PUT /lorebooks/{id}/entries/{id} with the merge-then-full-replace gotcha
 * handled: `desired` is the full entry to send on the FIRST attempt
 * (already merged with the caller's intended patch by the mutator); on a
 * 409, `patch` is re-applied onto the conflict's authoritative `current`
 * entry instead of onto our own stale copy.
 */
async function putEntryWithRetry(
  bookId: string,
  entryId: string,
  desired: WorldInfoEntry,
  patch: Partial<WorldInfoEntry>,
  baseTs: number | undefined
): Promise<LorebookEntryDTO> {
  let payload: Record<string, unknown> = { ...entryToWirePayload(desired), baseTs: baseTs ?? null };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await api.updateLorebookEntry(bookId, entryId, payload);
    } catch (err) {
      if (err instanceof LorebookEntryConflictError && attempt === 0 && err.conflict.current) {
        const current = normalizeNativeEntry(err.conflict.current);
        const merged: WorldInfoEntry = { ...current, ...patch, id: entryId };
        payload = { ...entryToWirePayload(merged), baseTs: err.conflict.current_ts };
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable: putEntryWithRetry exhausted its retry loop');
}

// Phase 3.2 of the memory-consolidation plan: session-guarded, same shape
// as chatStore.ts's wiPinnedWarnedChats for the scan-time WI budget toast —
// warn once per book per session, not on every single edit to a book
// that's already over budget. Only checked at the two INTERACTIVE
// single-entry write sites (createEntry/updateEntry below) — never at the
// bulk book-import sites or the delete-triggered sibling relatedIds patch,
// where a toast would fire on an action the user didn't consciously take
// (or, for bulk import, fire many times in a row) rather than on an edit
// they just made.
const pinnedBudgetWarnedBooks = new Set<string>();

function maybeWarnPinnedBudget(bookId: string, dto: LorebookEntryDTO) {
  const warning = dto.pinnedBudgetWarning;
  if (!warning || pinnedBudgetWarnedBooks.has(bookId)) return;
  pinnedBudgetWarnedBooks.add(bookId);
  showToastGlobal(
    `Constant + critical lore in this book (~${warning.pinnedTokens} tokens) exceeds the World Info budget (${warning.budgetTokens}). Raise the budget or demote entries.`,
    'warning'
  );
}

/**
 * Switching a world book off is not a local choice. Server-side retrieval
 * requires EVERY world-scoped book to be active (serverRetrieval.ts
 * condition 4), so one inactive world book demotes every one-on-one chat on
 * the account to the local keyword scan — where a keyless entry (every Data
 * Bank chunk) scores zero and cannot fire at all. The user is entitled to
 * make that trade; they are not entitled to make it without being told.
 *
 * Fires only on the toggle that actually flips the account over: if some
 * other world book is already inactive, retrieval is already off and a
 * second toast would be noise rather than news.
 */
function warnIfLastActiveWorldBook(
  book: WorldInfoBook,
  composable: WorldInfoBook[],
  nextActiveIds: string[]
): void {
  if (book.scope !== 'world') return;
  const active = new Set(nextActiveIds);
  for (const other of composable) {
    if (other.id === book.id) continue;
    if (other.scope !== 'world') continue;
    if (!active.has(other.id)) return;
  }
  showToastGlobal(
    `"${book.name}" is off. Server-side semantic matching needs every world book active, so until it's back on, one-on-one chats fall back to the local keyword scan — keyless entries like document chunks can't fire there.`,
    'warning'
  );
}

export const useWorldInfoStore = create<WorldInfoState>((set, get) => {
  // -------------------------------------------------------------------------
  // Local-state mutation helpers shared by every native-synced mutator's
  // background success/rollback handlers. All are id-scoped (never replace
  // the whole `books` array with a stale snapshot) so a concurrent, unrelated
  // edit made while a network call was in flight is never clobbered.
  // -------------------------------------------------------------------------

  function removeBookLocally(bookId: string) {
    set((s) => {
      const next = s.books.filter((b) => b.id !== bookId);
      saveBooks(next);
      return { books: next };
    });
  }

  function restoreBookLocally(bookId: string, prevBook: WorldInfoBook) {
    set((s) => {
      const next = s.books.map((b) => (b.id === bookId ? prevBook : b));
      saveBooks(next);
      return { books: next };
    });
  }

  function removeEntryLocally(bookId: string, entryId: string) {
    set((s) => {
      const next = s.books.map((b) =>
        b.id !== bookId ? b : { ...b, entries: b.entries.filter((e) => e.id !== entryId) }
      );
      saveBooks(next);
      return { books: next };
    });
  }

  function restoreEntryLocally(bookId: string, entryId: string, prevEntry: WorldInfoEntry) {
    set((s) => {
      const next = s.books.map((b) =>
        b.id !== bookId
          ? b
          : { ...b, entries: b.entries.map((e) => (e.id === entryId ? prevEntry : e)) }
      );
      saveBooks(next);
      return { books: next };
    });
  }

  /** Patch just serverTs/createdAt onto the CURRENT (not a stale snapshot)
   *  local book after a successful create/update response — never blindly
   *  overwrites the whole object, so a newer local edit made while the
   *  network call was in flight survives. */
  function applyServerBookMeta(bookId: string, dto: LorebookDTO) {
    set((s) => {
      const next = s.books.map((b) => {
        if (b.id !== bookId) return b;
        return {
          ...b,
          serverTs: typeof dto.server_ts === 'number' ? dto.server_ts : b.serverTs,
          createdAt: typeof dto.createdAt === 'number' ? (dto.createdAt as number) : b.createdAt,
        };
      });
      saveBooks(next);
      return { books: next };
    });
  }

  /** Same as applyServerBookMeta, for one entry inside one book. */
  function applyServerEntryMeta(bookId: string, entryId: string, dto: LorebookEntryDTO) {
    set((s) => {
      const next = s.books.map((b) => {
        if (b.id !== bookId) return b;
        return {
          ...b,
          entries: b.entries.map((e) => {
            if (e.id !== entryId) return e;
            return {
              ...e,
              serverTs: typeof dto.server_ts === 'number' ? dto.server_ts : e.serverTs,
              createdAt:
                typeof dto.createdAt === 'number' ? (dto.createdAt as number) : e.createdAt,
            };
          }),
        };
      });
      saveBooks(next);
      return { books: next };
    });
  }

  /**
   * Background-sync a freshly-created local book (and its entries, if any)
   * to the native API: POST the book first (entry POSTs target
   * /lorebooks/{lorebook_id}/entries, which needs the parent row to exist),
   * then POST every entry in parallel. On the book POST failing, the whole
   * book is rolled back locally (nothing could have synced without it). On
   * an individual entry POST failing, only that ONE entry rolls back — the
   * book itself did get created successfully, so there's no reason to lose
   * the rest of it too. Reused by createBook, duplicateBook, importBookJson,
   * copySharedBook, and createCharacterBook — every "create a book (+ N
   * entries)" mutator.
   */
  function syncNewBookWithEntries(book: WorldInfoBook) {
    api
      .createLorebook(bookToWirePayload(book))
      .then((bookDto) => {
        applyServerBookMeta(book.id, bookDto);
        return Promise.all(
          book.entries.map((e) =>
            api
              .createLorebookEntry(book.id, entryToWirePayload(e))
              .then((entryDto) => {
                applyServerEntryMeta(book.id, e.id, entryDto);
                return null;
              })
              .catch((err) => {
                console.warn('[worldInfoStore] failed to create entry on server', err);
                removeEntryLocally(book.id, e.id);
                return e;
              })
          )
        );
      })
      .then((results) => {
        const failed = results.filter((e): e is WorldInfoEntry => e !== null);
        if (failed.length === 0) return;
        // Aggregate rather than overwrite: with N entries failing in
        // parallel via Promise.all, each entry's own .catch used to
        // independently call set({error}) — only the LAST one to settle
        // ever survived in the single shared `error` field, silently
        // discarding every other failure's detail (and the overall
        // count). See the Phase 3a review finding this guards against.
        set({
          error:
            failed.length === 1
              ? `Failed to save 1 entry in "${book.name}"`
              : `Failed to save ${failed.length} entries in "${book.name}"`,
        });
      })
      .catch((err) => {
        console.warn('[worldInfoStore] failed to create lorebook on server', err);
        removeBookLocally(book.id);
        set({ error: err instanceof Error ? err.message : 'Failed to save lorebook to server' });
      });
  }

  /**
   * Background-sync a character-embedded book's wholesale replace (the
   * upsertCharacterBook "existing book found" branch): PUT the book's
   * name (full-replace, preserving visibility/ownerCharacterAvatar), then
   * delete every previously-existing native entry and recreate the fresh
   * set — mirrors the local wholesale `entries: fresh.entries` replace
   * exactly, since character-embedded books are re-imported wholesale, not
   * diffed. No local rollback on failure: the local swap already replaced
   * the book the character-import flow is actively showing progress for,
   * and reverting mid-way (with entry deletes potentially already fired)
   * would recreate the exact "silently stale" bug this cutover exists to
   * fix. The user can re-run the import to retry.
   */
  function syncCharacterBookReplace(prevBook: WorldInfoBook, updatedBook: WorldInfoBook) {
    (async () => {
      try {
        const bookDto = await putBookWithRetry(
          updatedBook.id,
          {
            name: prevBook.name,
            ownerCharacterAvatar: prevBook.ownerCharacterAvatar,
            visibility: prevBook.visibility,
          },
          { name: updatedBook.name },
          prevBook.serverTs
        );
        applyServerBookMeta(updatedBook.id, bookDto);

        const deleteResults = await Promise.all(
          prevBook.entries.map((e) =>
            api
              .deleteLorebookEntry(updatedBook.id, e.id)
              .then(() => null)
              .catch((err) => {
                console.warn('[worldInfoStore] failed to delete stale character-book entry', err);
                return e;
              })
          )
        );
        const createResults = await Promise.all(
          updatedBook.entries.map((e) =>
            api
              .createLorebookEntry(updatedBook.id, entryToWirePayload(e))
              .then((entryDto) => {
                applyServerEntryMeta(updatedBook.id, e.id, entryDto);
                return null;
              })
              .catch((err) => {
                console.warn('[worldInfoStore] failed to create character-book entry', err);
                return e;
              })
          )
        );

        const failedDeletes = deleteResults.filter((e): e is WorldInfoEntry => e !== null);
        const failedCreates = createResults.filter((e): e is WorldInfoEntry => e !== null);
        if (failedDeletes.length > 0 || failedCreates.length > 0) {
          // Deliberately still no local rollback (see this function's own
          // docstring above) — but every OTHER mutator in this file
          // surfaces a partial failure via set({error}), and this one
          // previously didn't: each entry failure was only a console.warn,
          // invisible to the user, who was left with a book silently
          // missing entries relative to what the local (already-shown,
          // already-dismissed) UI told them got imported. See the
          // Phase 3a review finding this guards against.
          const parts: string[] = [];
          if (failedCreates.length > 0) {
            parts.push(
              `${failedCreates.length} entr${failedCreates.length === 1 ? 'y' : 'ies'} failed to save`
            );
          }
          if (failedDeletes.length > 0) {
            parts.push(
              `${failedDeletes.length} stale entr${failedDeletes.length === 1 ? 'y' : 'ies'} could not be removed`
            );
          }
          set({
            error: `Failed to fully sync "${updatedBook.name}": ${parts.join(' and ')}. Re-import the character to retry.`,
          });
        }
      } catch (err) {
        console.warn('[worldInfoStore] failed to sync character-book replace', err);
        set({ error: err instanceof Error ? err.message : 'Failed to sync character lorebook' });
      }
    })();
  }

  return {
    // Start empty; populated by initForUser once the authenticated user is known.
    books: [],
    activeBookIds: [],
    chatLinkedBookIds: loadChatLinkedBooks(),
    scanDepth: DEFAULT_SCAN_DEPTH,
    maxRecursionSteps: DEFAULT_MAX_RECURSION,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    error: null,

    sharedBooks: [],
    sharedOwnerNameByHandle: {},
    sharedBooksStatus: 'idle',
    sharedBooksError: null,

    createBook: (name) => {
      const trimmed = name.trim() || 'Untitled Lorebook';
      const now = Date.now();
      const book: WorldInfoBook = {
        id: crypto.randomUUID(),
        name: trimmed,
        entries: [],
        ownerCharacterAvatar: null,
        scope: 'world',
        ownerHandle: currentHandle(),
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      };
      const next = [...get().books, book];
      saveBooks(next);
      set({ books: next });
      syncNewBookWithEntries(book);
      return book;
    },

    createBookWithEntries: (name, entryData, ownerCharacterAvatar = null) => {
      const trimmed = name.trim() || 'Untitled Lorebook';
      const now = Date.now();
      const entries: WorldInfoEntry[] = entryData.map((data) => ({
        ...DEFAULT_ENTRY,
        ...data,
        id: crypto.randomUUID(),
        source: data.source ?? 'manual',
        revisions: [
          {
            ts: now,
            authorHandle: currentHandle(),
            action: 'create',
            prevContent: '',
          },
        ],
        createdAt: now,
        updatedAt: now,
      }));
      const book: WorldInfoBook = {
        id: crypto.randomUUID(),
        name: trimmed,
        entries,
        ownerCharacterAvatar,
        scope: ownerCharacterAvatar != null ? 'character' : 'world',
        ownerHandle: currentHandle(),
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      };
      const next = [...get().books, book];
      saveBooks(next);
      set({ books: next });
      syncNewBookWithEntries(book);
      return book;
    },

    renameBook: (bookId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const prev = get().books.find((b) => b.id === bookId);
      if (!prev) return;
      const now = Date.now();
      const next = get().books.map((b) =>
        b.id === bookId ? { ...b, name: trimmed, updatedAt: now } : b
      );
      saveBooks(next);
      set({ books: next });
      putBookWithRetry(
        bookId,
        { name: prev.name, ownerCharacterAvatar: prev.ownerCharacterAvatar, visibility: prev.visibility },
        { name: trimmed },
        prev.serverTs
      )
        .then((dto) => applyServerBookMeta(bookId, dto))
        .catch((err) => {
          console.warn('[worldInfoStore] failed to rename lorebook on server', err);
          restoreBookLocally(bookId, prev);
          set({ error: err instanceof Error ? err.message : 'Failed to rename lorebook' });
        });
    },

    deleteBook: (bookId) => {
      const prevBook = get().books.find((b) => b.id === bookId);
      if (!prevBook) return;
      const wasActive = get().activeBookIds.includes(bookId);
      const chatFilesLinked = Object.entries(get().chatLinkedBookIds)
        .filter(([, ids]) => ids.includes(bookId))
        .map(([chatFile]) => chatFile);

      const next = get().books.filter((b) => b.id !== bookId);
      const activeNext = get().activeBookIds.filter((id) => id !== bookId);
      const chatNext: Record<string, string[]> = {};
      for (const [k, ids] of Object.entries(get().chatLinkedBookIds)) {
        const filtered = ids.filter((id) => id !== bookId);
        if (filtered.length > 0) chatNext[k] = filtered;
      }
      saveBooks(next);
      saveActiveBooks(activeNext);
      saveChatLinkedBooks(chatNext);
      set({
        books: next,
        activeBookIds: activeNext,
        chatLinkedBookIds: chatNext,
      });

      // The cross-store prune below (chatLoreConfigStore/loreConflictStore)
      // strips real data — per-chat overlays and pending Auto Memory
      // conflict records — that DOES still reference this book id, and
      // both stores autosave any change to the server within ~300ms (see
      // their own subscribe-based autosave), independent of whether the
      // DELETE below actually succeeds. Pruning unconditionally BEFORE
      // confirming the delete (the previous order here) meant a failed
      // delete left the book alive server-side while that overlay/conflict
      // data was already gone for good, both locally and on the server,
      // with no way to reconstruct it. So: prune only AFTER the delete is
      // confirmed; on failure, roll back the local removal above instead
      // (id-scoped, not a full-array restore, so a concurrent unrelated
      // edit made while the request was in flight isn't clobbered) and
      // surface the error, matching every other mutator in this file
      // rather than the previous silent console.warn-only handling. See
      // the Phase 3a review findings this guards against.
      api.deleteLorebook(bookId).then(
        () => {
          useChatLoreConfigStore.getState().pruneBook(bookId);
          useLoreConflictStore.getState().pruneBook(bookId);
        },
        (err) => {
          console.warn('[worldInfoStore] failed to delete lorebook on server', err);
          set((s) => {
            const books = s.books.some((b) => b.id === bookId) ? s.books : [...s.books, prevBook];
            const activeBookIds =
              wasActive && !s.activeBookIds.includes(bookId)
                ? [...s.activeBookIds, bookId]
                : s.activeBookIds;
            let chatLinkedBookIds = s.chatLinkedBookIds;
            if (chatFilesLinked.length > 0) {
              chatLinkedBookIds = { ...s.chatLinkedBookIds };
              for (const chatFile of chatFilesLinked) {
                const ids = chatLinkedBookIds[chatFile] || [];
                if (!ids.includes(bookId)) chatLinkedBookIds[chatFile] = [...ids, bookId];
              }
            }
            saveBooks(books);
            saveActiveBooks(activeBookIds);
            saveChatLinkedBooks(chatLinkedBookIds);
            return {
              books,
              activeBookIds,
              chatLinkedBookIds,
              error: err instanceof Error ? err.message : 'Failed to delete lorebook',
            };
          });
        }
      );
    },

    duplicateBook: (bookId) => {
      const original = get().books.find((b) => b.id === bookId);
      if (!original) return null;
      const now = Date.now();
      // Duplicates are always standalone globals so they don't collide with
      // the original character's embedded-book link.
      const idMap = new Map<string, string>();
      const copiedEntries = original.entries.map((e) => {
        const id = crypto.randomUUID();
        idMap.set(e.id, id);
        return { ...e, id, createdAt: now, updatedAt: now, serverTs: undefined };
      });
      const copy: WorldInfoBook = {
        id: crypto.randomUUID(),
        name: `${original.name} (Copy)`,
        // Related-entry links must point at the copies, not the originals.
        entries: remapRelatedIds(copiedEntries, idMap),
        ownerCharacterAvatar: null,
        // scope is derived — recompute now that ownerCharacterAvatar is cleared.
        scope: 'world',
        ownerHandle: original.ownerHandle,
        // Always private, regardless of the original's visibility - duplicating
        // a shared book must never silently create another shared copy.
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      };
      const next = [...get().books, copy];
      saveBooks(next);
      set({ books: next });
      syncNewBookWithEntries(copy);
      return copy;
    },

    setBookVisibility: (bookId, visibility) => {
      const target = get().books.find((b) => b.id === bookId);
      if (!target) return;
      // Auto Memory books are never shareable - mirrors server-side
      // enforcement in the /worldinfo/shared endpoint, but the client must
      // not even offer it.
      if (target.autoExtracted === true && visibility === 'shared') return;
      const now = Date.now();
      const next = get().books.map((b) =>
        b.id === bookId ? { ...b, visibility, updatedAt: now } : b
      );
      saveBooks(next);
      set({ books: next });
      putBookWithRetry(
        bookId,
        { name: target.name, ownerCharacterAvatar: target.ownerCharacterAvatar, visibility: target.visibility },
        { visibility },
        target.serverTs
      )
        .then((dto) => applyServerBookMeta(bookId, dto))
        .catch((err) => {
          console.warn('[worldInfoStore] failed to set lorebook visibility on server', err);
          restoreBookLocally(bookId, target);
          set({ error: err instanceof Error ? err.message : 'Failed to update lorebook sharing' });
        });
    },

    markBookAutoExtracted: (bookId) => {
      const target = get().books.find((b) => b.id === bookId);
      if (!target || target.autoExtracted === true) return;
      const now = Date.now();
      const next = get().books.map((b) =>
        b.id === bookId ? { ...b, autoExtracted: true, updatedAt: now } : b
      );
      saveBooks(next);
      set({ books: next });
      putBookWithRetry(
        bookId,
        { name: target.name, ownerCharacterAvatar: target.ownerCharacterAvatar, visibility: target.visibility },
        { autoExtracted: true },
        target.serverTs
      )
        .then((dto) => applyServerBookMeta(bookId, dto))
        .catch((err) => {
          // Deliberately NOT rolled back locally, unlike every other
          // mutator's failure handler: this flag only ever ADDS
          // restriction (blocks sharing), so keeping it optimistically
          // true client-side is the safer failure mode even if the
          // server write didn't land — reverting to false would re-open
          // the sharing UI for a book that's genuinely auto-extracted
          // just because of a transient network error. The residual gap
          // this leaves (the server's own auto_extracted column staying
          // false until a retry succeeds) is logged so it's not silently
          // invisible.
          console.warn('[worldInfoStore] failed to persist auto-extracted flag on server', err);
          set({ error: err instanceof Error ? err.message : 'Failed to update lorebook flag' });
        });
    },

    createEntry: (bookId, data, meta) => {
      const book = get().books.find((b) => b.id === bookId);
      if (!book) {
        set({ error: 'Lorebook not found' });
        return null;
      }
      const now = Date.now();
      const entry: WorldInfoEntry = {
        ...DEFAULT_ENTRY,
        ...(data || {}),
        id: crypto.randomUUID(),
        source: data?.source ?? 'manual',
        revisions: [
          {
            ts: now,
            authorHandle: currentHandle(),
            action: 'create',
            prevContent: '',
            ...(meta?.sourceChatFile !== undefined
              ? { sourceChatFile: meta.sourceChatFile }
              : {}),
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const next = get().books.map((b) =>
        b.id === bookId
          ? { ...b, entries: [...b.entries, entry], updatedAt: now }
          : b
      );
      saveBooks(next);
      set({ books: next });
      api
        .createLorebookEntry(bookId, entryToWirePayload(entry))
        .then((dto) => {
          applyServerEntryMeta(bookId, entry.id, dto);
          maybeWarnPinnedBudget(bookId, dto);
        })
        .catch((err) => {
          console.warn('[worldInfoStore] failed to create entry on server', err);
          removeEntryLocally(bookId, entry.id);
          set({ error: err instanceof Error ? err.message : 'Failed to create lorebook entry' });
        });
      return entry;
    },

    updateEntry: (bookId, entryId, data, meta) => {
      const now = Date.now();
      let prevEntry: WorldInfoEntry | undefined;
      let nextEntry: WorldInfoEntry | undefined;
      const next = get().books.map((b) => {
        if (b.id !== bookId) return b;
        return {
          ...b,
          entries: b.entries.map((e) => {
            if (e.id !== entryId) return e;
            prevEntry = e;
            // Content changes get a revision record BEFORE the patch is
            // applied, so prevContent captures the pre-edit state.
            let revisions: EntryRevision[] = e.revisions;
            const contentChanged =
              data.content !== undefined && data.content !== e.content;
            if (contentChanged || meta?.recordRevision === 'always') {
              const rev: EntryRevision = {
                ts: now,
                authorHandle: currentHandle(),
                action: meta?.action ?? 'edit',
                prevContent: e.content,
                ...(meta?.sourceChatFile !== undefined
                  ? { sourceChatFile: meta.sourceChatFile }
                  : {}),
              };
              revisions = [...e.revisions, rev].slice(-10);
            }
            nextEntry = { ...e, ...data, revisions, updatedAt: now };
            return nextEntry;
          }),
          updatedAt: now,
        };
      });
      saveBooks(next);
      set({ books: next });
      if (!prevEntry || !nextEntry) return; // entry not found locally — nothing to sync
      putEntryWithRetry(bookId, entryId, nextEntry, data, prevEntry.serverTs)
        .then((dto) => {
          applyServerEntryMeta(bookId, entryId, dto);
          maybeWarnPinnedBudget(bookId, dto);
        })
        .catch((err) => {
          console.warn('[worldInfoStore] failed to update entry on server', err);
          restoreEntryLocally(bookId, entryId, prevEntry as WorldInfoEntry);
          set({ error: err instanceof Error ? err.message : 'Failed to save lorebook entry' });
        });
    },

    deleteEntry: (bookId, entryId) => {
      const now = Date.now();
      const prevBook = get().books.find((b) => b.id === bookId);
      const siblingsToPatch: WorldInfoEntry[] = [];
      const next = get().books.map((b) =>
        b.id === bookId
          ? {
              ...b,
              entries: b.entries
                .filter((e) => e.id !== entryId)
                // Drop related-entry links that pointed at the deleted entry.
                .map((e) => {
                  if (!e.relatedIds.includes(entryId)) return e;
                  const trimmed = {
                    ...e,
                    relatedIds: e.relatedIds.filter((id) => id !== entryId),
                    updatedAt: now,
                  };
                  siblingsToPatch.push(trimmed);
                  return trimmed;
                }),
              updatedAt: now,
            }
          : b
      );
      saveBooks(next);
      set({ books: next });
      api.deleteLorebookEntry(bookId, entryId).then(
        () => {
          // Best-effort persistence of each trimmed sibling's relatedIds —
          // the local trim is already correct now that the delete is
          // confirmed, so a failure here is logged only, never rolled
          // back: reverting would resurrect a dangling reference the
          // scanner already treats as absent anyway (see
          // scanMessagesForEntries's dangling-id handling).
          for (const sibling of siblingsToPatch) {
            putEntryWithRetry(bookId, sibling.id, sibling, { relatedIds: sibling.relatedIds }, sibling.serverTs)
              .then((dto) => applyServerEntryMeta(bookId, sibling.id, dto))
              .catch((err) => {
                console.warn('[worldInfoStore] failed to persist trimmed relatedIds', err);
              });
          }
        },
        (err) => {
          console.warn('[worldInfoStore] failed to delete entry on server', err);
          set({ error: err instanceof Error ? err.message : 'Failed to delete lorebook entry on server' });
          // Roll back the WHOLE book (entry removal + sibling relatedIds
          // trim together — restoreBookLocally, the same helper
          // renameBook/setBookVisibility already use on their own failure
          // paths) rather than just the one entry: the delete never
          // actually happened server-side, so silently leaving it gone
          // locally would make it vanish from the editor now and reappear
          // un-announced on the next login/reload once fetchPrefs
          // refetches native books. See the Phase 3a review finding this
          // guards against.
          if (prevBook) restoreBookLocally(bookId, prevBook);
        }
      );
    },

    setBookActive: (bookId, active) => {
      const cur = get().activeBookIds;
      const has = cur.includes(bookId);
      let next = cur;
      if (active && !has) next = [...cur, bookId];
      else if (!active && has) next = cur.filter((id) => id !== bookId);
      else return;
      saveActiveBooks(next);
      set({ activeBookIds: next });
    },

    toggleBookActive: (bookId) => {
      const cur = get().activeBookIds;
      const wasActive = cur.includes(bookId);
      const next = wasActive
        ? cur.filter((id) => id !== bookId)
        : [...cur, bookId];
      saveActiveBooks(next);
      set({ activeBookIds: next });
      // The ONLY user-driven activation path (the library row's checkbox);
      // setBookActive above is the programmatic one. Keeping them apart is
      // what lets dataBankStore tell "the user turned this document off"
      // from "our own repair turned it on" — see its opt-out record.
      const book = get().books.find((b) => b.id === bookId);
      notifyUserBookActivation(bookId, !wasActive);
      if (wasActive && book) {
        warnIfLastActiveWorldBook(book, get().getComposableBooks(), next);
      }
    },

    setScanDepth: (depth) => {
      const d = Math.max(1, Math.min(50, Math.floor(depth)));
      saveScanDepth(d);
      set({ scanDepth: d });
    },

    setMaxRecursionSteps: (steps) => {
      const n = Math.max(0, Math.min(10, Math.floor(steps)));
      saveMaxRecursion(n);
      set({ maxRecursionSteps: n });
    },

    setTokenBudget: (budget) => {
      const n = Math.max(0, Math.min(32768, Math.floor(budget)));
      saveTokenBudget(n);
      set({ tokenBudget: n });
    },

    exportBookJson: (bookId) => {
      const book = get().books.find((b) => b.id === bookId);
      if (!book) return null;
      return JSON.stringify(bookToStFormat(book), null, 2);
    },

    importBookJson: (json, fallbackName, ownerAvatar) => {
      try {
        const parsed = JSON.parse(json) as StBook;
        if (!parsed || typeof parsed !== 'object') {
          set({ error: 'Invalid lorebook JSON' });
          return null;
        }
        // Accept either { entries: ... } (ST format) OR a bare object where
        // the top level is the entries map.
        let book: WorldInfoBook;
        if ('entries' in parsed && parsed.entries) {
          book = bookFromStFormat(fallbackName || 'Imported Lorebook', parsed);
        } else {
          // Treat the whole object as an entries map.
          book = bookFromStFormat(fallbackName || 'Imported Lorebook', {
            entries: parsed as unknown as Record<string, StEntry>,
          });
        }
        // When an owner avatar is provided the imported book becomes that
        // character's embedded book. Embedded books are 1-per-character, so
        // any existing embedded book for the same owner is replaced.
        if (ownerAvatar) {
          book.ownerCharacterAvatar = ownerAvatar;
          // scope is derived — recompute alongside ownerCharacterAvatar.
          book.scope = 'character';
          const existing = findEmbeddedBook(get().books, ownerAvatar);
          const without = existing
            ? get().books.filter((b) => b.id !== existing.id)
            : get().books;
          const next = [...without, book];
          saveBooks(next);
          set({ books: next, error: null });
          if (existing) {
            // The local replace above already removed the old book; mirror
            // that server-side. Fire-and-forget, same reasoning as
            // deleteBook — the DELETE is idempotent and low-risk.
            api.deleteLorebook(existing.id).catch((err) => {
              console.warn('[worldInfoStore] failed to delete replaced character book on server', err);
            });
          }
          syncNewBookWithEntries(book);
          return book;
        }
        const next = [...get().books, book];
        saveBooks(next);
        set({ books: next, error: null });
        syncNewBookWithEntries(book);
        return book;
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : 'Failed to parse JSON',
        });
        return null;
      }
    },

    upsertCharacterBook: (ownerAvatar, raw, fallbackName) => {
      const existing = findEmbeddedBook(get().books, ownerAvatar);
      const now = Date.now();
      if (existing) {
        // Preserve the book id (keeps linked-books references stable) and
        // swap in the freshly-parsed entries + name.
        const fresh = bookFromCharacterBookV2(raw, fallbackName, ownerAvatar);
        const updated: WorldInfoBook = {
          ...existing,
          name: fresh.name,
          entries: fresh.entries,
          ownerCharacterAvatar: ownerAvatar,
          // scope is derived — recompute alongside ownerCharacterAvatar.
          scope: ownerAvatar != null ? 'character' : 'world',
          updatedAt: now,
        };
        const next = get().books.map((b) =>
          b.id === existing.id ? updated : b
        );
        saveBooks(next);
        set({ books: next });
        // Wholesale replace (PUT book + delete-all-then-recreate entries) —
        // background, not awaited: this store's public API stays fully
        // synchronous (see the module report on why an awaited variant
        // would require plumbing through characterStore.ts, out of scope
        // for this step).
        syncCharacterBookReplace(existing, updated);
        return updated;
      }
      const book = bookFromCharacterBookV2(raw, fallbackName, ownerAvatar);
      const next = [...get().books, book];
      saveBooks(next);
      set({ books: next });
      syncNewBookWithEntries(book);
      return book;
    },

    createCharacterBook: (ownerAvatar, name, autoExtracted) => {
      // If a book already owned by this character exists, return it rather than
      // creating a second — the model is one embedded book per character.
      // Note: autoExtracted is NOT applied here even if requested — see
      // markBookAutoExtracted for retroactively flagging an existing book.
      const existing = findEmbeddedBook(get().books, ownerAvatar);
      if (existing) return existing;
      const trimmed = name.trim() || 'Character Lorebook';
      const now = Date.now();
      const book: WorldInfoBook = {
        id: crypto.randomUUID(),
        name: trimmed,
        entries: [],
        ownerCharacterAvatar: ownerAvatar,
        // scope is derived — compute inline rather than trusting a caller.
        scope: ownerAvatar != null ? 'character' : 'world',
        ownerHandle: currentHandle(),
        visibility: 'private',
        ...(autoExtracted === true ? { autoExtracted: true } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const next = [...get().books, book];
      saveBooks(next);
      set({ books: next });
      // autoExtracted (when requested) is already baked into `book` above,
      // so the very first POST this fires carries it — see
      // bookToWirePayload. No separate patch-after-create needed.
      syncNewBookWithEntries(book);
      return book;
    },

    getCharacterBook: (ownerAvatar) => {
      return findEmbeddedBook(get().books, ownerAvatar);
    },

    getCharacterBooks: (ownerAvatar) => {
      return get().books.filter((b) => b.ownerCharacterAvatar === ownerAvatar);
    },

    deleteCharacterBooks: (ownerAvatar) => {
      const owned = get().books.filter(
        (b) => b.ownerCharacterAvatar === ownerAvatar
      );
      if (owned.length === 0) return;
      const ownedIds = new Set(owned.map((b) => b.id));
      const next = get().books.filter((b) => !ownedIds.has(b.id));
      const activeNext = get().activeBookIds.filter((id) => !ownedIds.has(id));
      saveBooks(next);
      saveActiveBooks(activeNext);
      set({ books: next, activeBookIds: activeNext });
      for (const book of owned) {
        api.deleteLorebook(book.id).catch((err) => {
          console.warn('[worldInfoStore] failed to delete character lorebook on server', err);
        });
      }
    },

    getChatLinkedBookIds: (chatFileName) => {
      return get().chatLinkedBookIds[chatFileName] || [];
    },

    setChatLinkedBookIds: (chatFileName, ids) => {
      const allBookIds = new Set(get().books.map((b) => b.id));
      const deduped = Array.from(new Set(ids.filter((id) => allBookIds.has(id))));
      const next = { ...get().chatLinkedBookIds };
      if (deduped.length === 0) {
        delete next[chatFileName];
      } else {
        next[chatFileName] = deduped;
      }
      saveChatLinkedBooks(next);
      set({ chatLinkedBookIds: next });
      const existingConfig = useChatLoreConfigStore.getState().getConfig(chatFileName);
      if (existingConfig !== undefined) {
        // The legacy map can only ever hold the caller's OWN book ids (see
        // `allBookIds` above), so a v2 config link that points outside that
        // set — e.g. a shared book attached straight into the config by
        // AttachBookPicker's "Shared with me" section, which can't go through
        // this legacy-map-validated path — isn't something this call was ever
        // asked to touch. Preserve those instead of overwriting linkedBookIds
        // wholesale, or attaching/detaching any of the viewer's own books
        // afterward would silently drop the shared link.
        const nonOwnLinked = existingConfig.linkedBookIds.filter(
          (id) => !allBookIds.has(id)
        );
        useChatLoreConfigStore.getState().updateConfig(chatFileName, {
          linkedBookIds: Array.from(new Set([...deduped, ...nonOwnLinked])),
        });
      }
    },

    getComposableBooks: () => {
      const own = get().books;
      const ownIds = new Set(own.map((b) => b.id));
      // Own books always win a collision (e.g. a shared book id colliding
      // with one of the viewer's own from a duplicate ST import).
      const sharedNonColliding = get().sharedBooks.filter((b) => !ownIds.has(b.id));
      return [...own, ...sharedNonColliding];
    },

    copySharedBook: (sharedBookId) => {
      const original = get().sharedBooks.find((b) => b.id === sharedBookId);
      if (!original) return null;
      const now = Date.now();
      // Same fresh-id + relatedIds-remap dance as duplicateBook.
      const idMap = new Map<string, string>();
      const copiedEntries = original.entries.map((e) => {
        const id = crypto.randomUUID();
        idMap.set(e.id, id);
        return { ...e, id, createdAt: now, updatedAt: now, serverTs: undefined };
      });
      const copy: WorldInfoBook = {
        id: crypto.randomUUID(),
        name: `${original.name} (copy)`,
        entries: remapRelatedIds(copiedEntries, idMap),
        ownerCharacterAvatar: null,
        // scope is derived — recompute now that ownerCharacterAvatar is cleared.
        scope: 'world',
        ownerHandle: currentHandle(),
        visibility: 'private',
        // A copy is always hand-owned going forward, even if (defensively;
        // auto-extracted books should never reach sharedBooks in the first
        // place) the source was somehow flagged auto-extracted.
        autoExtracted: undefined,
        createdAt: now,
        updatedAt: now,
      };
      const next = [...get().books, copy];
      saveBooks(next);
      set({ books: next });
      syncNewBookWithEntries(copy);
      return copy;
    },

    clearError: () => set({ error: null }),

    initForUser: (handle) => {
      _currentHandle = handle;
      // Hydrate from localStorage first so the UI has something to show before
      // fetchPrefs returns. fetchPrefs will overlay the server state if newer.
      _persistEnabled = false;
      set({
        books: loadBooks(handle),
        activeBookIds: loadActiveBooks(handle),
        chatLinkedBookIds: loadChatLinkedBooks(handle),
        scanDepth: loadScanDepth(handle),
        maxRecursionSteps: loadMaxRecursion(handle),
        tokenBudget: loadTokenBudget(handle),
        error: null,
      });
    },

    resetUser: () => {
      _persistEnabled = false;
      _currentHandle = null;
      // Session-scoped migration guards are per-user — reset them so a
      // second account logging into the same browser session gets its own
      // import attempt and its own remap pass, not one inherited (and
      // wrongly skipped/stale) from the previous account.
      _blobImportAttempted = false;
      _nativeBooksFetchSucceeded = false;
      _entriesFetchDegraded = false;
      clearLegacyIdRemap();
      resetLegacyIdRemapReadyGate();
      set({
        books: [],
        activeBookIds: [],
        chatLinkedBookIds: {},
        scanDepth: DEFAULT_SCAN_DEPTH,
        maxRecursionSteps: DEFAULT_MAX_RECURSION,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
        error: null,
        sharedBooks: [],
        sharedOwnerNameByHandle: {},
        sharedBooksStatus: 'idle',
        sharedBooksError: null,
      });
    },

    /**
     * Pulls activeBookIds/chatLinkedBookIds/scan settings from the
     * stm_worldinfo blob (unchanged mechanism), and books/entries from the
     * native /lorebooks API (Phase 3a — the blob no longer carries them at
     * all). The two legs are independent: a blob-fetch hiccup must never
     * block loading books (they live in a completely different system of
     * record now), so each has its own try/catch.
     *
     * Native leg, in order: (1) ensureBlobImported — one-time-per-session
     * idempotent bootstrap of any book that was never migrated off the
     * blob; (2) fetchNativeBooks — the current, authoritative books+entries;
     * (3) buildLegacyIdRemap — pairs whatever old-id-keyed books were known
     * locally (this store's own pre-fetch `books` state, plus the blob's
     * own `books` field if this browser/account still has one) against the
     * freshly-fetched native set, populating remapLegacyBookId/
     * remapLegacyEntryId for the next step's stores to consume; (4) only
     * THEN is `books` applied to state. This ordering is the guarantee the
     * next step can rely on: by the time this Promise resolves, the remap
     * for every book/entry present in this call's old-state snapshot is
     * already populated, strictly before the id it replaces stops being
     * referenced anywhere in `books`.
     */
    fetchPrefs: async () => {
      const oldBooksSnapshot = get().books;
      let legacyBlobBooksForRemap: WorldInfoBook[] = [];
      // Phase 3.3 step (b) of the memory-consolidation plan — carried out
      // of this try block (same reason legacyBlobBooksForRemap is) so the
      // native-fetch leg below can pass it into buildLegacyIdRemap.
      let serverLegacyIdMap: LegacyIdMapSection | null = null;

      try {
        const settings = await getSettingsBlob();
        const stored = settings[SERVER_KEY] as
          | (PersistedShape & { books?: unknown; _ts?: number })
          | undefined;
        const serverTs = Number(stored?._ts || 0);
        if (Array.isArray(stored?.books)) {
          legacyBlobBooksForRemap = normalizeStoredBooks(stored.books as WorldInfoBook[]);
        }

        const legacyMapRaw = settings['stm_wi_legacy_id_map'] as
          | { books?: unknown; entries?: unknown }
          | undefined;
        if (legacyMapRaw && typeof legacyMapRaw === 'object') {
          const books = legacyMapRaw.books;
          const entries = legacyMapRaw.entries;
          serverLegacyIdMap = {
            books: books && typeof books === 'object' && !Array.isArray(books)
              ? (books as Record<string, unknown>)
              : {},
            entries: entries && typeof entries === 'object' && !Array.isArray(entries)
              ? (entries as Record<string, unknown>)
              : {},
          };
        }

        if (!stored) {
          // First-ever sync for this user — seed the server with the
          // localStorage state we just loaded in initForUser.
          _persistEnabled = true;
          const s = get();
          const hasAnything =
            s.activeBookIds.length > 0 || Object.keys(s.chatLinkedBookIds).length > 0;
          if (hasAnything) {
            patchServerKey(
              SERVER_KEY,
              snapshotForServer(s) as unknown as Record<string, unknown>,
              LOCAL_TS_KEY,
            ).catch(() => {});
          }
        } else if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
          // Local has unconfirmed mutations — push them and keep local state.
          _persistEnabled = true;
          patchServerKey(
            SERVER_KEY,
            snapshotForServer(get()) as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        } else {
          // Server has newer (or equal) state — apply it.
          _persistEnabled = false;
          const handle = _currentHandle;
          const activeBookIds = Array.isArray(stored.activeBookIds)
            ? stored.activeBookIds
            : [];
          const chatLinkedBookIds =
            stored.chatLinkedBookIds && typeof stored.chatLinkedBookIds === 'object'
              ? stored.chatLinkedBookIds
              : {};
          set({
            activeBookIds,
            chatLinkedBookIds,
            scanDepth: stored.scanDepth ?? DEFAULT_SCAN_DEPTH,
            maxRecursionSteps: stored.maxRecursionSteps ?? DEFAULT_MAX_RECURSION,
            tokenBudget: stored.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
          });
          // Cache to localStorage so the next cold load is instant.
          if (handle) {
            try {
              localStorage.setItem(scopedKey(ACTIVE_BOOKS_KEY, handle), JSON.stringify(activeBookIds));
              localStorage.setItem(scopedKey(CHAT_LINKED_BOOKS_KEY, handle), JSON.stringify(chatLinkedBookIds));
              localStorage.setItem(scopedKey(SCAN_DEPTH_KEY, handle), String(stored.scanDepth ?? DEFAULT_SCAN_DEPTH));
              localStorage.setItem(scopedKey(MAX_RECURSION_KEY, handle), String(stored.maxRecursionSteps ?? DEFAULT_MAX_RECURSION));
              localStorage.setItem(scopedKey(TOKEN_BUDGET_KEY, handle), String(stored.tokenBudget ?? DEFAULT_TOKEN_BUDGET));
            } catch { /* ignore */ }
          }
          try { recordServerTs(LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
          _persistEnabled = true;
        }
      } catch {
        // Network failure — keep local blob-backed state. Next mutation
        // marks the section dirty, so a future fetchPrefs will detect the
        // local-newer case. The native leg below is independent and still
        // attempted even when this leg fails.
        _persistEnabled = true;
      }

      try {
        await ensureBlobImported();
        const nativeBooks = await fetchNativeBooks();
        const oldBooksById = new Map<string, WorldInfoBook>();
        for (const b of oldBooksSnapshot) oldBooksById.set(b.id, b);
        // The blob's own (pre-cutover) `books` field, if this account still
        // has one, wins on id collision — it's the cross-device source of
        // truth for a fresh browser whose localStorage cache is empty.
        for (const b of legacyBlobBooksForRemap) oldBooksById.set(b.id, b);
        buildLegacyIdRemap(Array.from(oldBooksById.values()), nativeBooks, serverLegacyIdMap);
        saveBooks(nativeBooks);
        set({ books: nativeBooks });
        _nativeBooksFetchSucceeded = true;
      } catch (err) {
        console.warn(
          '[worldInfoStore] failed to load native lorebooks — keeping last known local state',
          err
        );
      }

      // Shared books: independent of everything above (a failure here must
      // never affect fetchPrefs's own success/error handling — fetchSharedBooks
      // itself never throws, see its own docstring). AWAITED (unlike before
      // this migration) because legacyIdRemapReady below must not resolve
      // until sharedBooks is settled too — canConfidentlyDropUnresolvedLegacyIds
      // otherwise couldn't tell "this book is a shared one that hasn't loaded
      // yet" apart from "this book is genuinely gone," and a dependent
      // store's remap pass would risk wrongly dropping a live shared-book
      // reference. No production caller awaits fetchPrefs() itself (every
      // fetchPrefs() call in authStore.ts is fire-and-forget), so this added
      // latency before fetchPrefs's OWN promise resolves is not observable
      // to anything that matters.
      await get().fetchSharedBooks().catch(() => {});

      // One-time-per-login remap of the two book-id-keyed fields this store
      // still owns directly (chatLinkedBookIds/activeBookIds) — see
      // remapChatLinkedAndActiveBookIds. Must run before the readiness gate
      // opens, so a consumer awaiting legacyIdRemapReady() never observes a
      // half-remapped intermediate state.
      remapChatLinkedAndActiveBookIds();
      _resolveLegacyIdRemapReady();
    },

    fetchSharedBooks: async () => {
      set({ sharedBooksStatus: 'loading' });
      try {
        const dtos: SharedWorldInfoBookDTO[] = await api.listSharedWorldInfoBooks();
        const normalizedBooks: WorldInfoBook[] = [];
        const ownerNames: Record<string, string | null> = {};
        for (const dto of dtos) {
          if (!dto || typeof dto !== 'object') continue;
          const rawBook = dto.book as Partial<WorldInfoBook> | null | undefined;
          // Reject (skip, don't crash on) anything missing the fields the rest
          // of this file assumes are always present.
          if (
            !rawBook ||
            typeof rawBook !== 'object' ||
            typeof rawBook.id !== 'string' ||
            typeof rawBook.name !== 'string' ||
            !Array.isArray(rawBook.entries)
          ) {
            continue;
          }
          // Reuse normalizeStoredBooks — same helper fetchPrefs uses to
          // backfill fields a pre-update client's blob may be missing, and the
          // same place scope gets recomputed from ownerCharacterAvatar rather
          // than trusted from storage.
          const [book] = normalizeStoredBooks(
            [rawBook as WorldInfoBook],
            dto.owner_handle
          );
          normalizedBooks.push({
            ...book,
            // Server-authoritative — the field inside the raw book JSON may be
            // stale or absent; never trust it over the DTO's top-level value.
            ownerHandle: dto.owner_handle,
            // Server already filtered on this, but don't trust it blindly.
            visibility: 'shared',
          });
          ownerNames[dto.owner_handle] = dto.owner_name ?? null;
        }
        set({
          sharedBooks: normalizedBooks,
          sharedOwnerNameByHandle: ownerNames,
          sharedBooksStatus: 'loaded',
          sharedBooksError: null,
        });
      } catch (err) {
        // Never let this throw out of the action — including a 404 if the
        // backend endpoint hasn't deployed yet.
        set({
          sharedBooksStatus: 'error',
          sharedBooksError:
            err instanceof Error ? err.message : 'Failed to load shared lorebooks',
        });
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Subscribe-based autosave (debounced) — set up after the store exists so
// useWorldInfoStore is in scope.
// ---------------------------------------------------------------------------

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _persistEnabled = false;

/**
 * Phase 3a: `books` is deliberately NOT part of this snapshot — the native
 * /lorebooks tables are the system of record for books/entries now, synced
 * per-mutator (see createBook/updateEntry/etc. above), not via this
 * whole-store blob PATCH. Only the fields that still live in the
 * stm_worldinfo blob are sent.
 */
function snapshotForServer(s: WorldInfoState): PersistedShape {
  return {
    activeBookIds: s.activeBookIds,
    chatLinkedBookIds: s.chatLinkedBookIds,
    scanDepth: s.scanDepth,
    maxRecursionSteps: s.maxRecursionSteps,
    tokenBudget: s.tokenBudget,
  };
}

useWorldInfoStore.subscribe((state, prev) => {
  // The book list landing (or being replaced by a fresher fetch) is the
  // event dataBankStore's activation repair waits on — its login-time call
  // legitimately runs against an empty or stale `books`. Announced through
  // the leaf registry rather than subscribed to from dataBankStore, which
  // cannot touch this module at its own module scope: the two sit on
  // opposite ends of an init cycle.
  if (state.books !== prev.books) notifyBooksChanged();
  // Unconditional local-cache safety net: every mutator above already calls
  // saveBooks() itself, but a handful of call sites elsewhere in the app
  // (e.g. autoMemoryStore's autoExtracted flip) intentionally reach in via
  // useWorldInfoStore.setState(...) directly, bypassing this store's own
  // mutators entirely. Without this, such a change would survive only in
  // memory for the current tab — this restores "survives a reload in this
  // browser" parity with what the old whole-store blob autosave used to
  // provide (cross-device sync for that specific case remains a known gap;
  // see this cutover's report for why — the backend has no client-facing
  // way to set `auto_extracted` on an existing row at all yet).
  saveBooks(state.books);
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      snapshotForServer(state) as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
});
