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
