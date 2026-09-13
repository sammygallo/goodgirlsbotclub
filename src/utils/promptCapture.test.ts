/**
 * `createPromptCapture`'s snapshot contract (E2-S3): the array handed in is
 * copied before freezing, the copy is deep-frozen, and the caller's live
 * array is left untouched — see `snapshotMessages`'s own doc comment for why.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPromptCapture, structurallyEqual } from './promptCapture';

function mkParams(messages: unknown) {
  return {
    seam: 'send' as const,
    messages,
    collapsedByInstruct: false,
    replacedByInterceptor: false,
    provider: 'openai',
    model: 'gpt-4o',
    textCompletionMode: false,
    imagesFolded: 0,
    characterName: 'Ivy',
    breakdown: null,
  };
}

describe('createPromptCapture — snapshot semantics', () => {
  it('the capture is unaffected by a later mutation of the live array', () => {
    const live = [{ role: 'user', content: 'before' }];
    const capture = createPromptCapture(mkParams(live));

    live[0].content = 'after';

    expect((capture.messages[0] as { content: string }).content).toBe('before');
  });

  it('the live array itself is never frozen', () => {
    const live = [{ role: 'user', content: 'hi' }];
    createPromptCapture(mkParams(live));

    expect(Object.isFrozen(live)).toBe(false);
  });

  it('the capture array is frozen, including nested entries', () => {
    const live = [{ role: 'user', content: 'hi' }];
    const capture = createPromptCapture(mkParams(live));

    expect(Object.isFrozen(capture.messages)).toBe(true);
    expect(Object.isFrozen(capture.messages[0])).toBe(true);
  });

  it('a circular structure does not throw — structuredClone handles the cycle and the capture holds a frozen clone', () => {
    const live: Record<string, unknown>[] = [{ role: 'user', content: 'hi' }];
    live[0].self = live;

    const capture = createPromptCapture(mkParams(live));

    expect(capture.messages).not.toBe(live);
    expect(Object.isFrozen(capture.messages)).toBe(true);
  });

  it('records capturedAt as the current time', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-02T15:04:05'));
      const capture = createPromptCapture(mkParams([{ role: 'user', content: 'hi' }]));
      expect(capture.capturedAt).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the JSON round-trip fallback when structuredClone throws, still yielding a frozen copy', () => {
    vi.stubGlobal('structuredClone', () => {
      throw new Error('structuredClone unavailable');
    });
    try {
      const live = [{ role: 'user', content: 'before' }];
      const capture = createPromptCapture(mkParams(live));

      expect(capture.messages).not.toBe(live);
      expect(Object.isFrozen(capture.messages)).toBe(true);

      live[0].content = 'after';
      expect((capture.messages[0] as { content: string }).content).toBe('before');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('takes the JSON round-trip fallback when structuredClone is unavailable, still yielding a frozen copy', () => {
    vi.stubGlobal('structuredClone', undefined);
    try {
      const live = [{ role: 'user', content: 'before' }];
      const capture = createPromptCapture(mkParams(live));

      expect(capture.messages).not.toBe(live);
      expect(Object.isFrozen(capture.messages)).toBe(true);

      live[0].content = 'after';
      expect((capture.messages[0] as { content: string }).content).toBe('before');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the original, unfrozen reference when both structuredClone and the JSON round-trip throw', () => {
    // A value structuredClone rejects (a function) together with one
    // JSON.stringify also rejects (a BigInt) in the same payload — the one
    // shape that reaches the `return arr` fallback.
    vi.stubGlobal('structuredClone', () => {
      throw new Error('structuredClone unavailable');
    });
    try {
      const live: unknown[] = [{ role: 'user', content: 'hi', fn: () => {}, big: 1n }];

      const capture = createPromptCapture(mkParams(live));

      expect(capture.messages).toBe(live);
      expect(Object.isFrozen(live)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('structurallyEqual', () => {
  it('treats key order as irrelevant', () => {
    expect(structurallyEqual({ role: 'user', content: 'hi' }, { content: 'hi', role: 'user' })).toBe(true);
  });

  it('compares nested arrays element-by-element, in order', () => {
    expect(structurallyEqual([{ a: [1, 2] }], [{ a: [1, 2] }])).toBe(true);
    expect(structurallyEqual([{ a: [1, 2] }], [{ a: [2, 1] }])).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('treats an explicit undefined value as different from a missing key', () => {
    expect(structurallyEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });

  it('rejects when the second object has a key the first does not, even if every shared key matches', () => {
    expect(structurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structurallyEqual({ role: 'user' }, { role: 'user', content: 'hi' })).toBe(false);
  });

  it('compares non-object primitives by strict equality', () => {
    expect(structurallyEqual(5, 5)).toBe(true);
    expect(structurallyEqual(5, '5')).toBe(false);
    expect(structurallyEqual(null, null)).toBe(true);
    expect(structurallyEqual(null, {})).toBe(false);
  });
});
