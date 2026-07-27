import { describe, it, expect } from 'vitest';
import {
  recordWiFired,
  sanitizeWiFired,
  mergeWiFiredMaps,
  wiFiredKey,
  type WiFiredMap,
} from './wiFired';

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
