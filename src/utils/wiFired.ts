// World-info fired-state telemetry (story-state phase 0).
//
// Records which world-info entries were actually injected into each
// generation so the future story-bible ingestion (docs/story-state-step2-plan.md)
// can classify lorebook entries as fired/not-fired from real telemetry
// instead of reconstructing activations with an approximate replay
// (probability rolls and sticky/cooldown state are not reproducible
// after the fact). The accumulated map is persisted per chat inside the
// chat header as `wi_fired`, keyed `"<bookId>:<entryId>"`.
//
// Semantics: "fired" means the entry's content was present in the prompt
// of a generation — fresh keyword activations AND sticky carry-overs,
// after token budgeting. `count` increments once per generation, so
// swipes and regenerations of the same turn each count. Telemetry is
// append-only and approximate by design: deleting or branching messages
// does not rewind it.

export interface WiFiredStats {
  /** AI-turn index (count of prior non-user, non-system messages) of the
   *  earliest generation this entry was injected into. */
  first_turn: number;
  /** AI-turn index of the latest generation this entry was injected into. */
  last_turn: number;
  /** Number of generations the entry was injected into. */
  count: number;
}

export type WiFiredMap = Record<string, WiFiredStats>;

export function wiFiredKey(bookId: string, entryId: string): string {
  return `${bookId}:${entryId}`;
}

/**
 * Fold one generation's injected entries into the accumulated map, in place.
 * Returns the same map for convenience.
 */
export function recordWiFired(
  map: WiFiredMap,
  fired: ReadonlyArray<{ bookId: string; entryId: string }>,
  currentTurn: number
): WiFiredMap {
  const turn = Math.max(0, Math.floor(Number.isFinite(currentTurn) ? currentTurn : 0));
  for (const f of fired) {
    if (!f.bookId || !f.entryId) continue;
    const key = wiFiredKey(f.bookId, f.entryId);
    const prev = map[key];
    if (prev) {
      prev.first_turn = Math.min(prev.first_turn, turn);
      prev.last_turn = Math.max(prev.last_turn, turn);
      prev.count += 1;
    } else {
      map[key] = { first_turn: turn, last_turn: turn, count: 1 };
    }
  }
  return map;
}

/**
 * Validate a `header.wi_fired` value read from a persisted chat. Anything
 * malformed — wrong container shape, non-numeric fields — is dropped
 * entry-by-entry rather than failing the whole map, since old clients and
 * out-of-band writers may have produced partial data.
 */
export function sanitizeWiFired(raw: unknown): WiFiredMap {
  const out: WiFiredMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const nums = [v.first_turn, v.last_turn, v.count];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const first = Math.max(0, Math.floor(v.first_turn as number));
    const last = Math.max(first, Math.floor(v.last_turn as number));
    const count = Math.max(1, Math.floor(v.count as number));
    out[key] = { first_turn: first, last_turn: last, count };
  }
  return out;
}

/**
 * Conservative union of two fired-state maps (e.g. local state vs the
 * winner of a save conflict). Both maps describe the same chat history,
 * so per key: earliest first_turn, latest last_turn, larger count.
 */
export function mergeWiFiredMaps(a: WiFiredMap, b: WiFiredMap): WiFiredMap {
  const out: WiFiredMap = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (x && y) {
      out[key] = {
        first_turn: Math.min(x.first_turn, y.first_turn),
        last_turn: Math.max(x.last_turn, y.last_turn),
        count: Math.max(x.count, y.count),
      };
    } else {
      const only = (x ?? y) as WiFiredStats;
      out[key] = { ...only };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legacy-id remap (E2-S5, story-state phase 0 follow-up).
//
// `wi_fired` shipped fa3cd1bf on 2026-07-26, 12 days BEFORE worldInfoStore's
// native-CRUD cutover (77e689d2, 2026-08-07). Firings captured in that
// window are keyed off the pre-cutover generateId('wibook'|'wi') scheme —
// `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
// verified against the removed implementation as it stood at 12f5c113 — a
// 13-digit ms timestamp plus a 1-6 char base36 suffix. Nothing remapped
// those keys onto their current native ids, so a pre-cutover firing reads
// as "this entry never fired" once the native id takes over: the false
// signal a future "unused entry" audit (E5-S1) must not be built on.
//
// This module stays store-agnostic on purpose (mirrors wiReplay.ts's own
// "never import worldInfoStore" stance) — the actual remap lookups
// (worldInfoStore's remapLegacyBookId/remapLegacyEntryId) are injected by
// the caller (chatStore.ts) rather than imported here.
// ---------------------------------------------------------------------------

// Mirrors worldInfoStore.ts's private LEGACY_BOOK_ID_RE/LEGACY_ENTRY_ID_RE
// exactly. Duplicated rather than imported: this story keeps
// worldInfoStore.ts read-only, and those consts aren't exported. A key that
// matches NEITHER pattern is either already a native (server-minted) id, or
// a same-prefix-but-unrelated synthetic id — e.g.
// worldInfoComposition.ts's chat-local `wibook_chatlocal__<chatFile>` book
// id, which fails this pattern precisely because it lacks the
// timestamp+suffix tail — and must never be treated as unresolved-legacy.
const LEGACY_BOOK_ID_RE = /^wibook_\d{13}_[0-9a-z]{1,6}$/;
const LEGACY_ENTRY_ID_RE = /^wi_\d{13}_[0-9a-z]{1,6}$/;

/**
 * True when at least one half of a `wiFiredKey` composite (`bookId:entryId`)
 * matches the pre-cutover id shape. This is the only way to tell "this key
 * never needed remapping" (the ordinary post-cutover case) apart from "this
 * key needed remapping and none was found" (T2, or a genuinely unmatched
 * legacy id) — both look identical as a plain lookup miss, since a legacy
 * remap function returning null is documented to mean either.
 */
export function looksLikeLegacyWiFiredKey(key: string): boolean {
  const sep = key.indexOf(':');
  if (sep < 0) return false;
  return LEGACY_BOOK_ID_RE.test(key.slice(0, sep)) || LEGACY_ENTRY_ID_RE.test(key.slice(sep + 1));
}

export interface WiFiredRemapResult {
  map: WiFiredMap;
  /** True when at least one key looked pre-cutover (looksLikeLegacyWiFiredKey)
   *  and had no confident remap available — either because the caller's
   *  remap lookups haven't finished populating yet (worldInfoStore's
   *  legacyIdRemapReady() gate), or because no successor was ever recorded
   *  for it. The returned map's absence of a key is therefore not proof an
   *  entry never fired, only that this map can't say either way for it. */
  partial: boolean;
}

/**
 * Re-key a captured fired-map through the caller's legacy-id remap lookups.
 * Remap-or-KEEP: a key with no resolvable remap is copied through
 * UNCHANGED, never dropped — dropping a wi_fired key destroys measured
 * history, which is the exact under-reporting this function exists to fix
 * (see captureWiFired's neighbor comment in chatStore.ts, and R2's
 * keep-dangling-by-default rule for legacy ids generally). Pass
 * worldInfoStore's remapLegacyBookId/remapLegacyEntryId directly — NOT
 * resolveLegacyBookId/resolveLegacyEntryId, which can drop.
 *
 * Two keys that remap onto the same current key are merged (earliest
 * first_turn, latest last_turn, SUMMED count) rather than one clobbering
 * the other — unlike mergeWiFiredMaps's max-count union of two overlapping
 * OBSERVATIONS of the same generations, a pre-cutover key and its
 * post-cutover successor describe DISJOINT sets of generations (one side
 * of the cutover each), so their counts add rather than take a high-water
 * mark — the same accounting recordWiFired already uses to fold repeat
 * firings of one key into `count`.
 *
 * Purely a read-time view: does not mutate `map`, so callers that DON'T
 * persist the result (see wiFired.ts's own header + chatStore.ts's
 * getWiFiredForChat) get a reversible remap rather than a silent migration.
 */
export function remapWiFiredKeys(
  map: WiFiredMap,
  remapBookId: (id: string) => string | null,
  remapEntryId: (id: string) => string | null
): WiFiredRemapResult {
  const out: WiFiredMap = {};
  let partial = false;

  const putMerged = (key: string, stats: WiFiredStats) => {
    const prev = out[key];
    out[key] = prev
      ? {
          first_turn: Math.min(prev.first_turn, stats.first_turn),
          last_turn: Math.max(prev.last_turn, stats.last_turn),
          count: prev.count + stats.count,
        }
      : { ...stats };
  };

  for (const [key, stats] of Object.entries(map)) {
    const sep = key.indexOf(':');
    if (sep < 0) {
      // Malformed key — sanitizeWiFired only validates the VALUE shape, not
      // the key's own format. Keep it verbatim rather than throw or drop.
      putMerged(key, stats);
      continue;
    }
    const bookId = key.slice(0, sep);
    const entryId = key.slice(sep + 1);
    const mappedBook = remapBookId(bookId);
    const mappedEntry = remapEntryId(entryId);
    putMerged(wiFiredKey(mappedBook ?? bookId, mappedEntry ?? entryId), stats);

    if (
      (!mappedBook && LEGACY_BOOK_ID_RE.test(bookId)) ||
      (!mappedEntry && LEGACY_ENTRY_ID_RE.test(entryId))
    ) {
      partial = true;
    }
  }

  return { map: out, partial };
}
