import { describe, it, expect } from 'vitest';
import {
  recordWiFired,
  sanitizeWiFired,
  mergeWiFiredMaps,
  wiFiredKey,
  looksLikeLegacyWiFiredKey,
  remapWiFiredKeys,
  type WiFiredMap,
} from './wiFired';

// Realistic pre-cutover ids — same shape as worldInfoStore's own
// LEGACY_BOOK_ID_RE/LEGACY_ENTRY_ID_RE test fixtures
// (worldInfoStore.legacyDropGate.test.ts): a 13-digit ms timestamp plus a
// 1-6 char base36 suffix.
const LEGACY_BOOK = 'wibook_1777000000000_aaaaaa';
const LEGACY_ENTRY = 'wi_1777000000001_bbbbbb';

describe('wiFiredKey', () => {
  it('joins book and entry ids', () => {
    expect(wiFiredKey('book', 'entry')).toBe('book:entry');
  });
});

describe('recordWiFired', () => {
  it('creates a stat row on first fire', () => {
    const map: WiFiredMap = {};
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 3);
    expect(map).toEqual({ 'b1:e1': { first_turn: 3, last_turn: 3, count: 1 } });
  });

  it('advances last_turn and count on later fires', () => {
    const map: WiFiredMap = {};
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 3);
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 7);
    expect(map['b1:e1']).toEqual({ first_turn: 3, last_turn: 7, count: 2 });
  });

  it('counts swipes at the same turn without moving the turn range', () => {
    const map: WiFiredMap = {};
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 7);
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 7);
    expect(map['b1:e1']).toEqual({ first_turn: 7, last_turn: 7, count: 2 });
  });

  it('lowers first_turn when an upstream edit fires at an earlier turn', () => {
    const map: WiFiredMap = {};
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 5);
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 1);
    expect(map['b1:e1']).toEqual({ first_turn: 1, last_turn: 5, count: 2 });
  });

  it('keys the same entry id in different books separately', () => {
    const map: WiFiredMap = {};
    recordWiFired(map, [{ bookId: 'b1', entryId: 'e1' }], 0);
    recordWiFired(map, [{ bookId: 'b2', entryId: 'e1' }], 0);
    expect(Object.keys(map).sort()).toEqual(['b1:e1', 'b2:e1']);
  });

  it('skips rows with empty ids and clamps bad turn values', () => {
    const map: WiFiredMap = {};
    recordWiFired(map, [{ bookId: '', entryId: 'x' }, { bookId: 'b', entryId: '' }], 2);
    expect(map).toEqual({});
    recordWiFired(map, [{ bookId: 'b', entryId: 'e' }], -4);
    expect(map['b:e']).toEqual({ first_turn: 0, last_turn: 0, count: 1 });
    recordWiFired(map, [{ bookId: 'b', entryId: 'e' }], 2.9);
    expect(map['b:e']).toEqual({ first_turn: 0, last_turn: 2, count: 2 });
    const nan: WiFiredMap = {};
    recordWiFired(nan, [{ bookId: 'b', entryId: 'e' }], NaN);
    expect(nan['b:e']).toEqual({ first_turn: 0, last_turn: 0, count: 1 });
  });
});

describe('sanitizeWiFired', () => {
  it('round-trips a map it wrote through JSON unchanged', () => {
    const orig: WiFiredMap = { 'b1:e1': { first_turn: 0, last_turn: 9, count: 4 } };
    expect(sanitizeWiFired(JSON.parse(JSON.stringify(orig)))).toEqual(orig);
  });

  it('returns an empty map for non-object containers', () => {
    for (const bad of [undefined, null, 'x', 42, [], true]) {
      expect(sanitizeWiFired(bad)).toEqual({});
    }
  });

  it('drops malformed entries individually and keeps good ones', () => {
    const mixed = sanitizeWiFired({
      good: { first_turn: 1, last_turn: 2, count: 3 },
      badType: { first_turn: 'x', last_turn: 2, count: 3 },
      badNull: null,
      badArray: [1, 2, 3],
      badMissing: { first_turn: 1, last_turn: 2 },
      badInfinity: { first_turn: Infinity, last_turn: 2, count: 1 },
    });
    expect(Object.keys(mixed)).toEqual(['good']);
  });

  it('clamps negatives, inverted ranges, and sub-1 counts', () => {
    expect(
      sanitizeWiFired({ k: { first_turn: -2, last_turn: -5, count: 0 } }).k
    ).toEqual({ first_turn: 0, last_turn: 0, count: 1 });
    expect(
      sanitizeWiFired({ k: { first_turn: 5, last_turn: 2, count: 1.7 } }).k
    ).toEqual({ first_turn: 5, last_turn: 5, count: 1 });
  });
});

describe('mergeWiFiredMaps', () => {
  it('unions keys, taking earliest first_turn / latest last_turn / larger count', () => {
    const local: WiFiredMap = {
      'b:shared': { first_turn: 2, last_turn: 8, count: 5 },
      'b:localOnly': { first_turn: 1, last_turn: 1, count: 1 },
    };
    const server: WiFiredMap = {
      'b:shared': { first_turn: 4, last_turn: 10, count: 3 },
      'b:serverOnly': { first_turn: 0, last_turn: 2, count: 2 },
    };
    const merged = mergeWiFiredMaps(local, server);
    expect(merged['b:shared']).toEqual({ first_turn: 2, last_turn: 10, count: 5 });
    expect(merged['b:localOnly']).toEqual({ first_turn: 1, last_turn: 1, count: 1 });
    expect(merged['b:serverOnly']).toEqual({ first_turn: 0, last_turn: 2, count: 2 });
  });

  it('copies stat rows instead of aliasing the inputs', () => {
    const local: WiFiredMap = { 'b:e': { first_turn: 1, last_turn: 1, count: 1 } };
    const merged = mergeWiFiredMaps(local, {});
    merged['b:e'].count = 99;
    expect(local['b:e'].count).toBe(1);
  });

  it('handles empty maps on either side', () => {
    expect(mergeWiFiredMaps({}, {})).toEqual({});
    const only: WiFiredMap = { 'b:e': { first_turn: 0, last_turn: 3, count: 2 } };
    expect(mergeWiFiredMaps(only, {})).toEqual(only);
    expect(mergeWiFiredMaps({}, only)).toEqual(only);
  });
});

describe('looksLikeLegacyWiFiredKey', () => {
  it('is true when the book half matches the pre-cutover shape', () => {
    expect(looksLikeLegacyWiFiredKey(`${LEGACY_BOOK}:e1`)).toBe(true);
  });

  it('is true when the entry half matches the pre-cutover shape', () => {
    expect(looksLikeLegacyWiFiredKey(`b1:${LEGACY_ENTRY}`)).toBe(true);
  });

  it('is true when both halves match', () => {
    expect(looksLikeLegacyWiFiredKey(`${LEGACY_BOOK}:${LEGACY_ENTRY}`)).toBe(true);
  });

  it('is false for a plain native-shaped key', () => {
    expect(looksLikeLegacyWiFiredKey('b1:e1')).toBe(false);
  });

  it('is false for the chat-local synthetic book prefix — same "wibook_" start, different shape', () => {
    // worldInfoComposition.ts's CHAT_LOCAL_BOOK_PREFIX ('wibook_chatlocal__')
    // shares the legacy scheme's prefix but not its timestamp+suffix tail —
    // a naive prefix check would misflag it as unresolved-legacy.
    expect(looksLikeLegacyWiFiredKey('wibook_chatlocal__some-chat.jsonl:e1')).toBe(false);
  });

  it('is false for a key with no colon separator', () => {
    expect(looksLikeLegacyWiFiredKey('not-a-composite-key')).toBe(false);
  });
});

describe('remapWiFiredKeys', () => {
  it('remaps both halves when both are known, and reports full coverage', () => {
    const map: WiFiredMap = {
      [`${LEGACY_BOOK}:${LEGACY_ENTRY}`]: { first_turn: 2, last_turn: 5, count: 3 },
    };
    const out = remapWiFiredKeys(
      map,
      (id) => (id === LEGACY_BOOK ? 'native-book-1' : null),
      (id) => (id === LEGACY_ENTRY ? 'native-entry-1' : null)
    );
    expect(out.map).toEqual({
      'native-book-1:native-entry-1': { first_turn: 2, last_turn: 5, count: 3 },
    });
    expect(out.partial).toBe(false);
  });

  it('leaves an already-native key unchanged and does NOT flag it partial', () => {
    // No remap found for either half (remapBookId/remapEntryId both return
    // null), but neither half LOOKS legacy — the common post-cutover case,
    // where null just means "nothing to remap," not "couldn't resolve."
    const map: WiFiredMap = { 'b1:e1': { first_turn: 0, last_turn: 0, count: 1 } };
    const out = remapWiFiredKeys(map, () => null, () => null);
    expect(out.map).toEqual(map);
    expect(out.partial).toBe(false);
  });

  it('KEEPS an unresolvable legacy key rather than dropping it, and flags partial coverage (T1/T2)', () => {
    // The core regression this function exists to prevent: a cheap wrong
    // implementation that silently drops an unmapped legacy key (or that
    // omits the shape check and never sets `partial`) must fail this.
    const map: WiFiredMap = {
      [`${LEGACY_BOOK}:${LEGACY_ENTRY}`]: { first_turn: 4, last_turn: 9, count: 7 },
    };
    const out = remapWiFiredKeys(map, () => null, () => null);
    expect(
      out.map[`${LEGACY_BOOK}:${LEGACY_ENTRY}`],
      'an unresolved legacy key must be KEPT, never dropped'
    ).toEqual({ first_turn: 4, last_turn: 9, count: 7 });
    expect(out.partial, 'an unresolved legacy-shaped key must flag partial coverage').toBe(true);
  });

  it('a legacy book half that resolves next to a plain-native entry half is fully resolved, not partial', () => {
    // 'e1' isn't legacy-shaped, so its lookup miss is the ordinary
    // post-cutover case, not an unresolved remap — see
    // looksLikeLegacyWiFiredKey. NOT a "one half resolves, one doesn't"
    // case: neither half is actually left unresolved-and-legacy-shaped
    // here, which is why this alone cannot pin the book-half conjunct in
    // remapWiFiredKeys — see the BOOK-half test below for that.
    const out = remapWiFiredKeys(
      { [`${LEGACY_BOOK}:e1`]: { first_turn: 0, last_turn: 0, count: 1 } },
      (id) => (id === LEGACY_BOOK ? 'native-book-1' : null),
      () => null
    );
    expect(out.map).toEqual({ 'native-book-1:e1': { first_turn: 0, last_turn: 0, count: 1 } });
    expect(out.partial).toBe(false);
  });

  it('flags partial from the ENTRY half alone: legacy-shaped and unresolved, next to a plain-native book half', () => {
    // 'b1' isn't legacy-shaped and never resolves either, but that's
    // irrelevant to the book conjunct (it only fires for a legacy-SHAPED
    // unresolved id) — so partial here can only come from the entry half,
    // isolating that conjunct.
    const out = remapWiFiredKeys(
      { [`b1:${LEGACY_ENTRY}`]: { first_turn: 0, last_turn: 0, count: 1 } },
      () => null,
      () => null
    );
    expect(out.partial, 'the unresolved legacy entry half must still be caught').toBe(true);
  });

  it('flags partial from the BOOK half alone: legacy-shaped and unresolved, even though the entry half resolves', () => {
    // The book-half conjunct in isolation — every other case in this file
    // either resolves the book or gives it a non-legacy shape, so deleting
    // `(!mappedBook && LEGACY_BOOK_ID_RE.test(bookId)) ||` from
    // remapWiFiredKeys leaves them all green. Here the entry half DOES
    // resolve, so only the book conjunct can produce `partial: true`. This
    // is also the reachable production case: buildLegacyIdRemap
    // (worldInfoStore.ts) remaps books and entries independently, so a key
    // whose entry half maps while its book half doesn't is a real state,
    // not a hypothetical.
    const out = remapWiFiredKeys(
      { [`${LEGACY_BOOK}:${LEGACY_ENTRY}`]: { first_turn: 4, last_turn: 9, count: 7 } },
      () => null,
      (id) => (id === LEGACY_ENTRY ? 'native-entry-1' : null)
    );
    expect(out.map).toEqual({
      [`${LEGACY_BOOK}:native-entry-1`]: { first_turn: 4, last_turn: 9, count: 7 },
    });
    expect(
      out.partial,
      'an unresolved legacy BOOK half must flag partial even when the entry half resolves'
    ).toBe(true);
  });

  it('models pre-readiness (T2): every legacy key unresolved reports partial, not silent success', () => {
    // Simulates calling before worldInfoStore's legacyIdRemapReady() has
    // resolved — remapLegacyBookId/remapLegacyEntryId return null for
    // everything until then. The failure mode this guards is "the gate
    // wasn't ready and every legacy key silently read as needing no remap."
    const map: WiFiredMap = {
      [`${LEGACY_BOOK}:${LEGACY_ENTRY}`]: { first_turn: 0, last_turn: 0, count: 1 },
    };
    const preReadiness = (_id: string) => null;
    const out = remapWiFiredKeys(map, preReadiness, preReadiness);
    expect(out.partial).toBe(true);
    expect(Object.keys(out.map)).toEqual([`${LEGACY_BOOK}:${LEGACY_ENTRY}`]);
  });

  it('merges two keys that remap onto the same current key: sums count, spans first/last turn', () => {
    // Distinct from mergeWiFiredMaps's max-count union of two OBSERVATIONS
    // of the same generations — here two DIFFERENT keys (a pre-cutover id
    // and its post-cutover successor) describe DISJOINT generations, so
    // counts add rather than take a high-water mark.
    const map: WiFiredMap = {
      [`${LEGACY_BOOK}:${LEGACY_ENTRY}`]: { first_turn: 0, last_turn: 2, count: 3 },
      'native-book-1:native-entry-1': { first_turn: 10, last_turn: 15, count: 4 },
    };
    const out = remapWiFiredKeys(
      map,
      (id) => (id === LEGACY_BOOK ? 'native-book-1' : null),
      (id) => (id === LEGACY_ENTRY ? 'native-entry-1' : null)
    );
    expect(out.map).toEqual({
      'native-book-1:native-entry-1': { first_turn: 0, last_turn: 15, count: 7 },
    });
    expect(out.partial).toBe(false);
  });

  it('passes a malformed (colon-less) key through unchanged instead of throwing', () => {
    const map: WiFiredMap = { malformed: { first_turn: 1, last_turn: 1, count: 1 } };
    const out = remapWiFiredKeys(map, () => null, () => null);
    expect(out.map).toEqual(map);
    expect(out.partial).toBe(false);
  });

  it('does not mutate the input map', () => {
    const map: WiFiredMap = { 'b1:e1': { first_turn: 0, last_turn: 0, count: 1 } };
    const snapshot = JSON.parse(JSON.stringify(map));
    remapWiFiredKeys(
      map,
      () => 'other-book',
      () => 'other-entry'
    );
    expect(map).toEqual(snapshot);
  });
});

describe('reload-then-save round-trip (Phase 0 acceptance)', () => {
  it('previously persisted fired-state survives hydrate and keeps accumulating', () => {
    // session 1: entries fire, map is serialized into the header
    const session1: WiFiredMap = {};
    recordWiFired(session1, [{ bookId: 'b', entryId: 'a' }, { bookId: 'b', entryId: 'c' }], 0);
    recordWiFired(session1, [{ bookId: 'b', entryId: 'a' }], 1);
    const headerJson = JSON.stringify({ user_name: 'u', wi_fired: session1 });

    // session 2 (reload): hydrate from header, fire more, re-serialize
    const hydrated = sanitizeWiFired(JSON.parse(headerJson).wi_fired);
    expect(hydrated).toEqual(session1);
    recordWiFired(hydrated, [{ bookId: 'b', entryId: 'a' }], 2);
    expect(hydrated['b:a']).toEqual({ first_turn: 0, last_turn: 2, count: 3 });
    expect(hydrated['b:c']).toEqual({ first_turn: 0, last_turn: 0, count: 1 });
  });
});
