import { create } from 'zustand';
import { estimateTokens, type TokenizerProfile } from '../utils/tokenizer';
import { getSettingsBlob, makeLocalTsKey, patchServerKey } from '../utils/serverSettings';
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
  createdAt: number;
  updatedAt: number;
}

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
  createdAt: number;
  updatedAt: number;
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
};

function parseBooks(raw: string): WorldInfoBook[] {
  const list = JSON.parse(raw) as WorldInfoBook[];
  // Backfill fields added after initial release so old stored data works.
  return list.map((b) => ({
    ...b,
    ownerCharacterAvatar:
      typeof b.ownerCharacterAvatar === 'string'
        ? b.ownerCharacterAvatar
        : null,
    entries: b.entries.map((e) => ({
      ...e,
      sticky: e.sticky ?? 0,
      cooldown: e.cooldown ?? 0,
      delay: e.delay ?? 0,
    })),
  }));
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

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  return {
    id: generateId('wi'),
    keys: pickStringArray(raw.key),
    content: typeof raw.content === 'string' ? raw.content : '',
    comment: typeof raw.comment === 'string' ? raw.comment : '',
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
    createdAt: now,
    updatedAt: now,
  };
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
  return {
    id: generateId('wibook'),
    name: raw.name || name || 'Imported Lorebook',
    entries: list.map(entryFromStFormat),
    ownerCharacterAvatar: null,
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

  return {
    id: generateId('wi'),
    keys: pickStringArray(raw.keys),
    content: typeof raw.content === 'string' ? raw.content : '',
    comment: typeof raw.comment === 'string' ? raw.comment : '',
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
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const now = Date.now();
  return {
    id: generateId('wibook'),
    name: raw.name || fallbackName || 'Character Lorebook',
    entries: entries.map(entryFromCharacterBookV2),
    ownerCharacterAvatar,
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

function entryActivates(entry: WorldInfoEntry, haystack: string): boolean {
  // Primary keys (OR). Caller is responsible for skipping constant entries.
  if (entry.keys.length === 0) return false;
  const primary = entry.keys.some((k) =>
    keyMatches(haystack, k, entry.caseSensitive)
  );
  if (!primary) return false;
  if (entry.selective && entry.keysSecondary.length > 0) {
    const results = entry.keysSecondary.map((k) =>
      keyMatches(haystack, k, entry.caseSensitive)
    );
    if (!evalSelectiveLogic(entry.selectiveLogic, results)) return false;
  }
  return true;
}

function rollProbability(entry: WorldInfoEntry): boolean {
  if (!entry.useProbability) return true;
  return Math.random() * 100 < entry.probability;
}

/**
 * Resolve inclusion-group conflicts: for each group, pick one winner.
 * Skips groups listed in `wonGroups` (they already have a winner from a
 * previous pass) and updates the set with new winners.
 */
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
  profile: TokenizerProfile
): MatchedEntry[] {
  if (budget <= 0) return matches;
  // Constant entries are always injected — never pruned by the budget.
  const constantMatches = matches.filter((m) => m.entry.constant);
  const budgetable = matches.filter((m) => !m.entry.constant);
  const constantCost = constantMatches.reduce(
    (s, m) => s + estimateTokens(m.entry.content, profile),
    0
  );
  const remaining = Math.max(0, budget - constantCost);
  // High priority first (lower `order`), drop lowest priority when over budget.
  const sorted = [...budgetable].sort((a, b) => a.entry.order - b.entry.order);
  const costs = sorted.map((m) => estimateTokens(m.entry.content, profile));
  let total = costs.reduce((s, c) => s + c, 0);
  while (total > remaining && sorted.length > 0) {
    sorted.pop();
    total -= costs.pop() || 0;
  }
  return [...constantMatches, ...sorted];
}

/**
 * Scan active books for matching entries. Supports primary/secondary keys,
 * regex keys, per-entry scan depth override, probability activation,
 * inclusion groups, recursive scanning, token budgeting, and timed effects
 * (sticky / cooldown / delay).
 *
 * @param outActivatedIds - Optional Set that will be populated with the IDs of
 *   entries that were *freshly* activated this turn (excluding sticky carry-overs).
 *   Callers should persist this set via saveWiTimers() after a successful
 *   generation to update the timed-effects state for the next turn.
 */
export function scanMessagesForEntries(
  books: WorldInfoBook[],
  activeBookIds: string[],
  messages: { content: string; isSystem?: boolean }[],
  options: WorldInfoScanOptions,
  outActivatedIds?: Set<string>
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
    if (!entryActivates(c.entry, haystack)) continue;
    if (!rollProbability(c.entry)) continue;
    initial.push(c);
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
      if (c.entry.constant) continue; // constants were decided in initial pass
      if (c.entry.keys.length === 0) continue;
      if (c.entry.group && wonGroups.has(c.entry.group)) continue;
      if (!timedEffectsAllow(c.entry)) continue;
      if (!entryActivates(c.entry, recursionHaystack)) continue;
      if (!rollProbability(c.entry)) continue;
      newMatches.push(c);
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
  const stickyMatches: MatchedEntry[] = [];
  for (const c of candidates) {
    if (matchedIds.has(c.entry.id)) continue;
    if (c.entry.sticky <= 0) continue;
    const last = wiTimers[c.entry.id];
    if (last === undefined) continue;
    if (currentTurn <= last + c.entry.sticky) {
      stickyMatches.push(c);
    }
  }

  // Report freshly activated IDs to the caller (excludes sticky carry-overs).
  if (outActivatedIds) {
    for (const id of matchedIds) {
      outActivatedIds.add(id);
    }
  }

  const allMatched = matched.concat(stickyMatches);
  const result = applyTokenBudget(allMatched, options.tokenBudget, options.profile);
  result.sort((a, b) => a.entry.order - b.entry.order);
  return result;
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

  // Book CRUD
  createBook: (name: string) => WorldInfoBook;
  renameBook: (bookId: string, name: string) => void;
  deleteBook: (bookId: string) => void;
  duplicateBook: (bookId: string) => WorldInfoBook | null;

  // Entry CRUD
  createEntry: (
    bookId: string,
    data?: Partial<Omit<WorldInfoEntry, 'id' | 'createdAt' | 'updatedAt'>>
  ) => WorldInfoEntry | null;
  updateEntry: (
    bookId: string,
    entryId: string,
    data: Partial<Omit<WorldInfoEntry, 'id' | 'createdAt'>>
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
  /** Creates a fresh empty book already owned by the given character. */
  createCharacterBook: (ownerAvatar: string, name: string) => WorldInfoBook;
  getCharacterBook: (ownerAvatar: string) => WorldInfoBook | null;
  deleteCharacterBook: (ownerAvatar: string) => void;

  // Chat-scoped lorebooks
  getChatLinkedBookIds: (chatFileName: string) => string[];
  setChatLinkedBookIds: (chatFileName: string, ids: string[]) => void;

  clearError: () => void;

  // Lifecycle: call on login/checkAuth to load the user's books, and on logout
  // to clear in-memory state so one user's books don't bleed into another's.
  initForUser: (handle: string) => void;
  resetUser: () => void;

  /**
   * Pull this user's lorebook state from ggbc-backend's /sync/section/{name}.
   *
   * Migration on first call: if the server has no record yet, push the
   * current localStorage state up as the initial sync (so users who built
   * up lorebooks pre-A3 don't lose them). After this returns, autosave is
   * enabled — any subsequent mutation debounces a PUT back to the server.
   */
  fetchPrefs: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Cross-device sync (A3.1a — lorebooks)
// ---------------------------------------------------------------------------

const SERVER_KEY = 'stm_worldinfo';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

interface PersistedShape {
  books: WorldInfoBook[];
  activeBookIds: string[];
  chatLinkedBookIds: Record<string, string[]>;
  scanDepth: number;
  maxRecursionSteps: number;
  tokenBudget: number;
}

export const useWorldInfoStore = create<WorldInfoState>((set, get) => ({
  // Start empty; populated by initForUser once the authenticated user is known.
  books: [],
  activeBookIds: [],
  chatLinkedBookIds: loadChatLinkedBooks(),
  scanDepth: DEFAULT_SCAN_DEPTH,
  maxRecursionSteps: DEFAULT_MAX_RECURSION,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  error: null,

  createBook: (name) => {
    const trimmed = name.trim() || 'Untitled Lorebook';
    const now = Date.now();
    const book: WorldInfoBook = {
      id: generateId('wibook'),
      name: trimmed,
      entries: [],
      ownerCharacterAvatar: null,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().books, book];
    saveBooks(next);
    set({ books: next });
    return book;
  },

  renameBook: (bookId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = get().books.map((b) =>
      b.id === bookId ? { ...b, name: trimmed, updatedAt: Date.now() } : b
    );
    saveBooks(next);
    set({ books: next });
  },

  deleteBook: (bookId) => {
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
  },

  duplicateBook: (bookId) => {
    const original = get().books.find((b) => b.id === bookId);
    if (!original) return null;
    const now = Date.now();
    // Duplicates are always standalone globals so they don't collide with
    // the original character's embedded-book link.
    const copy: WorldInfoBook = {
      id: generateId('wibook'),
      name: `${original.name} (Copy)`,
      entries: original.entries.map((e) => ({
        ...e,
        id: generateId('wi'),
        createdAt: now,
        updatedAt: now,
      })),
      ownerCharacterAvatar: null,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().books, copy];
    saveBooks(next);
    set({ books: next });
    return copy;
  },

  createEntry: (bookId, data) => {
    const book = get().books.find((b) => b.id === bookId);
    if (!book) {
      set({ error: 'Lorebook not found' });
      return null;
    }
    const now = Date.now();
    const entry: WorldInfoEntry = {
      ...DEFAULT_ENTRY,
      ...(data || {}),
      id: generateId('wi'),
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
    return entry;
  },

  updateEntry: (bookId, entryId, data) => {
    const now = Date.now();
    const next = get().books.map((b) => {
      if (b.id !== bookId) return b;
      return {
        ...b,
        entries: b.entries.map((e) =>
          e.id === entryId ? { ...e, ...data, updatedAt: now } : e
        ),
        updatedAt: now,
      };
    });
    saveBooks(next);
    set({ books: next });
  },

  deleteEntry: (bookId, entryId) => {
    const now = Date.now();
    const next = get().books.map((b) =>
      b.id === bookId
        ? {
            ...b,
            entries: b.entries.filter((e) => e.id !== entryId),
            updatedAt: now,
          }
        : b
    );
    saveBooks(next);
    set({ books: next });
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
    const next = cur.includes(bookId)
      ? cur.filter((id) => id !== bookId)
      : [...cur, bookId];
    saveActiveBooks(next);
    set({ activeBookIds: next });
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
        const existing = get().books.find(
          (b) => b.ownerCharacterAvatar === ownerAvatar
        );
        const without = existing
          ? get().books.filter((b) => b.id !== existing.id)
          : get().books;
        const next = [...without, book];
        saveBooks(next);
        set({ books: next, error: null });
        return book;
      }
      const next = [...get().books, book];
      saveBooks(next);
      set({ books: next, error: null });
      return book;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to parse JSON',
      });
      return null;
    }
  },

  upsertCharacterBook: (ownerAvatar, raw, fallbackName) => {
    const existing = get().books.find(
      (b) => b.ownerCharacterAvatar === ownerAvatar
    );
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
        updatedAt: now,
      };
      const next = get().books.map((b) =>
        b.id === existing.id ? updated : b
      );
      saveBooks(next);
      set({ books: next });
      return updated;
    }
    const book = bookFromCharacterBookV2(raw, fallbackName, ownerAvatar);
    const next = [...get().books, book];
    saveBooks(next);
    set({ books: next });
    return book;
  },

  createCharacterBook: (ownerAvatar, name) => {
    // If a book already owned by this character exists, return it rather than
    // creating a second — the model is one embedded book per character.
    const existing = get().books.find(
      (b) => b.ownerCharacterAvatar === ownerAvatar
    );
    if (existing) return existing;
    const trimmed = name.trim() || 'Character Lorebook';
    const now = Date.now();
    const book: WorldInfoBook = {
      id: generateId('wibook'),
      name: trimmed,
      entries: [],
      ownerCharacterAvatar: ownerAvatar,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().books, book];
    saveBooks(next);
    set({ books: next });
    return book;
  },

  getCharacterBook: (ownerAvatar) => {
    return (
      get().books.find((b) => b.ownerCharacterAvatar === ownerAvatar) || null
    );
  },

  deleteCharacterBook: (ownerAvatar) => {
    const existing = get().books.find(
      (b) => b.ownerCharacterAvatar === ownerAvatar
    );
    if (!existing) return;
    const next = get().books.filter((b) => b.id !== existing.id);
    const activeNext = get().activeBookIds.filter((id) => id !== existing.id);
    saveBooks(next);
    saveActiveBooks(activeNext);
    set({ books: next, activeBookIds: activeNext });
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
    set({
      books: [],
      activeBookIds: [],
      chatLinkedBookIds: {},
      scanDepth: DEFAULT_SCAN_DEPTH,
      maxRecursionSteps: DEFAULT_MAX_RECURSION,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      error: null,
    });
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | (PersistedShape & { _ts?: number })
        | undefined;
      const localTs = Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
      const serverTs = Number(stored?._ts || 0);

      if (!stored) {
        // First-ever sync for this user — seed the server with the
        // localStorage state we just loaded in initForUser.
        _persistEnabled = true;
        const s = get();
        const hasAnything =
          s.books.length > 0 ||
          s.activeBookIds.length > 0 ||
          Object.keys(s.chatLinkedBookIds).length > 0;
        if (hasAnything) {
          patchServerKey(
            SERVER_KEY,
            snapshotForServer(s) as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
        return;
      }

      if (localTs > serverTs) {
        // Local has unconfirmed mutations — push them and keep local state.
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          snapshotForServer(get()) as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      // Server has newer (or equal) state — apply it.
      _persistEnabled = false;
      const handle = _currentHandle;
      const books = Array.isArray(stored.books) ? stored.books : [];
      const activeBookIds = Array.isArray(stored.activeBookIds)
        ? stored.activeBookIds
        : [];
      const chatLinkedBookIds =
        stored.chatLinkedBookIds && typeof stored.chatLinkedBookIds === 'object'
          ? stored.chatLinkedBookIds
          : {};
      set({
        books,
        activeBookIds,
        chatLinkedBookIds,
        scanDepth: stored.scanDepth ?? DEFAULT_SCAN_DEPTH,
        maxRecursionSteps: stored.maxRecursionSteps ?? DEFAULT_MAX_RECURSION,
        tokenBudget: stored.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      });
      // Cache to localStorage so the next cold load is instant.
      if (handle) {
        try {
          localStorage.setItem(scopedKey(BOOKS_KEY, handle), JSON.stringify(books));
          localStorage.setItem(scopedKey(ACTIVE_BOOKS_KEY, handle), JSON.stringify(activeBookIds));
          localStorage.setItem(scopedKey(CHAT_LINKED_BOOKS_KEY, handle), JSON.stringify(chatLinkedBookIds));
          localStorage.setItem(scopedKey(SCAN_DEPTH_KEY, handle), String(stored.scanDepth ?? DEFAULT_SCAN_DEPTH));
          localStorage.setItem(scopedKey(MAX_RECURSION_KEY, handle), String(stored.maxRecursionSteps ?? DEFAULT_MAX_RECURSION));
          localStorage.setItem(scopedKey(TOKEN_BUDGET_KEY, handle), String(stored.tokenBudget ?? DEFAULT_TOKEN_BUDGET));
        } catch { /* ignore */ }
      }
      try { localStorage.setItem(LOCAL_TS_KEY, String(serverTs)); } catch { /* ignore */ }
      _persistEnabled = true;
    } catch {
      // Network failure — keep local state. Next mutation marks LOCAL_TS_KEY
      // dirty, so a future fetchPrefs will detect the local-newer case.
      _persistEnabled = true;
    }
  },
}));

// ---------------------------------------------------------------------------
// Subscribe-based autosave (debounced) — set up after the store exists so
// useWorldInfoStore is in scope.
// ---------------------------------------------------------------------------

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _persistEnabled = false;

function snapshotForServer(s: WorldInfoState): PersistedShape {
  return {
    books: s.books,
    activeBookIds: s.activeBookIds,
    chatLinkedBookIds: s.chatLinkedBookIds,
    scanDepth: s.scanDepth,
    maxRecursionSteps: s.maxRecursionSteps,
    tokenBudget: s.tokenBudget,
  };
}

useWorldInfoStore.subscribe((state) => {
  if (!_persistEnabled) return;
  try { localStorage.setItem(LOCAL_TS_KEY, String(Date.now())); } catch { /* ignore */ }
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
