import { describe, it, expect } from 'vitest';
import { replaySupported, replayWorldInfo, type ReplayEntry } from './wiReplay';
import type { IngestMessage } from './types';

function msg(
  id: string,
  content: string,
  isUser = false,
  isSystem = false
): IngestMessage {
  return {
    id,
    name: isUser ? 'You' : 'Ivy',
    isUser,
    isSystem,
    content,
    timestamp: 0,
    swipeIdx: 0,
    swipesCount: 1,
  };
}

function entry(over: Partial<ReplayEntry> = {}): ReplayEntry {
  return {
    id: 'e1',
    bookId: 'b1',
    keys: ['duke'],
    content: 'The duke rules the Reach.',
    enabled: true,
    constant: false,
    caseSensitive: false,
    relatedIds: [],
    ...over,
  };
}

const TRANSCRIPT = [
  msg('m1', 'Tell me about the duke.', true),
  msg('m2', 'He rules from the drowned keep.'),
  msg('m3', 'And the archive?', true),
  msg('m4', 'Beneath the keep.'),
];

describe('replayWorldInfo', () => {
  it('fires an entry whose key appears in the scan window', () => {
    const out = replayWorldInfo(TRANSCRIPT, [entry()]);
    expect(out.fired['b1:e1']).toBeTruthy();
    expect(out.neverFired).toEqual([]);
    // Replayed, so it must be flagged approximate.
    expect(out.approximate).toBe(true);
  });

  it('reports an entry that never matched', () => {
    const out = replayWorldInfo(TRANSCRIPT, [entry({ keys: ['dragon'] })]);
    expect(out.fired['b1:e1']).toBeUndefined();
    expect(out.neverFired).toEqual(['b1:e1']);
    expect(out.approximate).toBe(false);
  });

  it('fires constant entries regardless of keywords', () => {
    const out = replayWorldInfo(
      TRANSCRIPT,
      [entry({ keys: ['nothing-matches'], constant: true })]
    );
    expect(out.fired['b1:e1']?.count).toBeGreaterThan(0);
  });

  it('skips disabled and empty entries', () => {
    const out = replayWorldInfo(TRANSCRIPT, [
      entry({ id: 'off', enabled: false }),
      entry({ id: 'blank', content: '   ' }),
    ]);
    expect(Object.keys(out.fired)).toEqual([]);
    expect(out.neverFired).toEqual([]);
  });

  it('honours case sensitivity', () => {
    const caseless = replayWorldInfo(TRANSCRIPT, [entry({ keys: ['DUKE'] })]);
    expect(caseless.fired['b1:e1']).toBeTruthy();
    const strict = replayWorldInfo(
      TRANSCRIPT,
      [entry({ keys: ['DUKE'], caseSensitive: true })]
    );
    expect(strict.fired['b1:e1']).toBeUndefined();
  });

  it('supports regex keys and survives an uncompilable one', () => {
    const rx = replayWorldInfo(TRANSCRIPT, [entry({ keys: ['/du[k]e/'] })]);
    expect(rx.fired['b1:e1']).toBeTruthy();
    // A malformed regex key is the author's typo — fall back to a literal
    // match rather than dropping the entry.
    const broken = replayWorldInfo(
      [msg('m1', 'contains /du[ke/ literally', true), msg('m2', 'ok')],
      [entry({ keys: ['/du[ke/'] })]
    );
    expect(broken.fired['b1:e1']).toBeTruthy();
  });

  it('ignores system messages', () => {
    const out = replayWorldInfo(
      [msg('s1', 'duke duke duke', false, true), msg('m2', 'hello')],
      [entry()]
    );
    expect(out.fired['b1:e1']).toBeUndefined();
  });
});

describe('relatedIds co-firing', () => {
  it('co-fires a related entry whose own keys never match', () => {
    const out = replayWorldInfo(TRANSCRIPT, [
      entry({ id: 'a', relatedIds: ['b'] }),
      entry({ id: 'b', keys: ['nothing-matches'] }),
    ]);
    expect(out.fired['b1:a']).toBeTruthy();
    expect(out.fired['b1:b']).toBeTruthy();
    expect(out.neverFired).toEqual([]);
  });

  it('follows transitive chains: A → B → C fires all three', () => {
    const out = replayWorldInfo(TRANSCRIPT, [
      entry({ id: 'a', relatedIds: ['b'] }),
      entry({ id: 'b', keys: ['nothing-matches'], relatedIds: ['c'] }),
      entry({ id: 'c', keys: ['nothing-matches'] }),
    ]);
    expect(out.fired['b1:a']).toBeTruthy();
    expect(out.fired['b1:b']).toBeTruthy();
    expect(out.fired['b1:c']).toBeTruthy();
    expect(out.neverFired).toEqual([]);
  });

  it('terminates on cycles: A → B → A fires both', () => {
    const out = replayWorldInfo(TRANSCRIPT, [
      entry({ id: 'a', relatedIds: ['b'] }),
      entry({ id: 'b', keys: ['nothing-matches'], relatedIds: ['a'] }),
    ]);
    expect(out.fired['b1:a']).toBeTruthy();
    expect(out.fired['b1:b']).toBeTruthy();
  });

  it('ignores dangling relatedIds', () => {
    const out = replayWorldInfo(TRANSCRIPT, [
      entry({ id: 'a', relatedIds: ['ghost'] }),
    ]);
    expect(out.fired['b1:a']).toBeTruthy();
    expect(Object.keys(out.fired)).toEqual(['b1:a']);
  });
});

describe('captured telemetry beats replay', () => {
  it('keeps the measured count instead of inflating it', () => {
    const captured = { 'b1:e1': { first_turn: 0, last_turn: 9, count: 40 } };
    const out = replayWorldInfo(TRANSCRIPT, [entry()], {
      capturedFired: captured,
    });
    // The replay also matched, but a real measurement wins.
    expect(out.fired['b1:e1'].count).toBe(40);
    expect(out.fired['b1:e1'].last_turn).toBe(9);
  });

  it('is exact when captured telemetry covers everything', () => {
    const out = replayWorldInfo(
      TRANSCRIPT,
      [entry({ keys: ['nothing-matches'] })],
      { capturedFired: { 'b1:e1': { first_turn: 1, last_turn: 2, count: 3 } } }
    );
    expect(out.approximate).toBe(false);
    expect(out.fired['b1:e1'].count).toBe(3);
  });

  it('ignores malformed captured telemetry rather than trusting it', () => {
    const out = replayWorldInfo(TRANSCRIPT, [entry({ keys: ['zzz'] })], {
      capturedFired: { 'b1:e1': { first_turn: 'x' } },
    });
    expect(out.fired['b1:e1']).toBeUndefined();
  });
});

// Realistic pre-cutover ids — same shape as worldInfoStore's own
// LEGACY_BOOK_ID_RE/LEGACY_ENTRY_ID_RE test fixtures
// (worldInfoStore.legacyDropGate.test.ts).
const LEGACY_KEY = 'wibook_1777000000000_aaaaaa:wi_1777000000001_bbbbbb';

describe('notObservable — orphaned pre-cutover captured keys (E2-S5 Gap 2)', () => {
  it('downgrades neverFired to notObservable when a captured key looks legacy and matches no active entry', () => {
    const out = replayWorldInfo(
      TRANSCRIPT,
      [entry({ keys: ['nothing-matches'] })], // b1:e1 — would otherwise never-fire
      { capturedFired: { [LEGACY_KEY]: { first_turn: 0, last_turn: 0, count: 1 } } }
    );
    expect(out.neverFired, 'a chat with unplaced legacy residue must not assert never-fired').toEqual([]);
    expect(out.notObservable).toEqual(['b1:e1']);
  });

  it('covers every currently-missing active entry, not just one', () => {
    const out = replayWorldInfo(
      TRANSCRIPT,
      [
        entry({ id: 'e1', keys: ['nothing-matches'] }),
        entry({ id: 'e2', keys: ['also-nothing'] }),
      ],
      { capturedFired: { [LEGACY_KEY]: { first_turn: 0, last_turn: 0, count: 1 } } }
    );
    expect(out.neverFired).toEqual([]);
    expect(out.notObservable.sort()).toEqual(['b1:e1', 'b1:e2']);
  });

  it('leaves neverFired alone when captured telemetry has no legacy-shaped residue', () => {
    // A ordinary post-cutover capturedFired map, unrelated to the entry
    // that never fires — the common case, and existing callers' neverFired
    // reads must not regress.
    const out = replayWorldInfo(
      TRANSCRIPT,
      [entry({ keys: ['nothing-matches'] })],
      { capturedFired: { 'other-book:other-entry': { first_turn: 0, last_turn: 0, count: 1 } } }
    );
    expect(out.neverFired).toEqual(['b1:e1']);
    expect(out.notObservable).toEqual([]);
  });

  it('does not treat a legacy-shaped key as orphaned when it matches an active entry exactly', () => {
    // The entry itself still carries its pre-cutover id (never migrated) —
    // the captured key IS placed, so there is nothing unobservable about
    // it. A SECOND, genuinely-never-fired entry ('e2') is what makes this
    // test able to fail: with only one (firing) entry, `missing` would be
    // empty regardless of whether the placement guard exists at all, so
    // this row would pass even with the guard deleted (caught in review by
    // mutation-testing the guard away — it left this original one-entry
    // version green).
    const [legacyBookId, legacyEntryId] = LEGACY_KEY.split(':');
    const out = replayWorldInfo(
      TRANSCRIPT,
      [
        entry({ id: legacyEntryId, bookId: legacyBookId, keys: ['nothing-matches'] }),
        entry({ id: 'e2', keys: ['also-nothing'] }),
      ],
      { capturedFired: { [LEGACY_KEY]: { first_turn: 0, last_turn: 0, count: 5 } } }
    );
    expect(out.fired[LEGACY_KEY].count).toBe(5);
    expect(
      out.neverFired,
      "a placed legacy key must not downgrade an unrelated entry's neverFired verdict"
    ).toEqual(['b1:e2']);
    expect(out.notObservable).toEqual([]);
  });

  it('is empty (not the whole active set) when capturedFired is absent entirely', () => {
    // No captured telemetry at all is NOT itself a partial-coverage signal
    // — the replay scan still confidently watched the whole transcript.
    const out = replayWorldInfo(TRANSCRIPT, [entry({ keys: ['nothing-matches'] })]);
    expect(out.neverFired).toEqual(['b1:e1']);
    expect(out.notObservable).toEqual([]);
  });

  it('leaves approximate meaning what it always meant — untouched by notObservable', () => {
    // AC2: approximate must not be overloaded to also carry the
    // never-fired/not-observable distinction.
    const out = replayWorldInfo(TRANSCRIPT, [entry()], {
      capturedFired: { [LEGACY_KEY]: { first_turn: 0, last_turn: 0, count: 1 } },
    });
    // b1:e1 fires via keyword match (replay), so approximate is still
    // driven purely by whether replay contributed to `fired` — unrelated
    // to the unplaced legacy residue this describe block is about.
    expect(out.approximate).toBe(true);
  });
});

describe('replaySupported', () => {
  it('refuses group chats — they never scan world info at all', () => {
    expect(replaySupported(false)).toBe(true);
    expect(replaySupported(true)).toBe(false);
  });
});
