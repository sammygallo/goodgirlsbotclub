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

describe('replaySupported', () => {
  it('refuses group chats — they never scan world info at all', () => {
    expect(replaySupported(false)).toBe(true);
    expect(replaySupported(true)).toBe(false);
  });
});
