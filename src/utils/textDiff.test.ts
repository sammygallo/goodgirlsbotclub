import { describe, it, expect } from 'vitest';

import { diffLines } from './textDiff';
import type { DiffLine } from './textDiff';

// ---------------------------------------------------------------------------
// Lorebook v2 — textDiff tests
// ---------------------------------------------------------------------------
//
// diffLines splits both inputs on '\n' and walks a standard LCS dynamic-
// program. A couple of consequences of that are exercised deliberately below
// rather than assumed:
//   - ''.split('\n') === [''] (one empty-string line, not zero lines), so
//     "empty string" is not the same thing as "no lines".
//   - The algorithm is not a minimal diff — it doesn't try to shorten del/add
//     runs — so the reordering test only asserts the general invariant that
//     no line is lost/duplicated, not a specific shape.
// ---------------------------------------------------------------------------

function linesOf(s: string): string[] {
  return s.split('\n');
}

/** Every 'same' or 'del' line, in order — should always reconstruct `before`. */
function reconstructBefore(diff: DiffLine[]): string[] {
  return diff.filter((d) => d.type === 'same' || d.type === 'del').map((d) => d.text);
}

/** Every 'same' or 'add' line, in order — should always reconstruct `after`. */
function reconstructAfter(diff: DiffLine[]): string[] {
  return diff.filter((d) => d.type === 'same' || d.type === 'add').map((d) => d.text);
}

describe('diffLines — identical input', () => {
  it('produces only "same" lines for identical multi-line strings', () => {
    const text = 'line one\nline two\nline three';
    const result = diffLines(text, text);

    expect(result.every((d) => d.type === 'same')).toBe(true);
    expect(result.map((d) => d.text)).toEqual(linesOf(text));
  });

  it('produces only "same" lines for identical single-line strings', () => {
    const result = diffLines('just one line', 'just one line');
    expect(result).toEqual([{ type: 'same', text: 'just one line' }]);
  });
});

describe('diffLines — pure addition (before is a prefix of after)', () => {
  it('emits the shared lines as "same" and the new trailing lines as "add", with no "del" at all', () => {
    const before = 'a\nb';
    const after = 'a\nb\nc\nd';
    const result = diffLines(before, after);

    expect(result.some((d) => d.type === 'del')).toBe(false);
    expect(result).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'add', text: 'c' },
      { type: 'add', text: 'd' },
    ]);
  });
});

describe('diffLines — pure deletion (after is a prefix of before)', () => {
  it('emits the shared lines as "same" and the removed trailing lines as "del", with no "add" at all', () => {
    const before = 'a\nb\nc\nd';
    const after = 'a\nb';
    const result = diffLines(before, after);

    expect(result.some((d) => d.type === 'add')).toBe(false);
    expect(result).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'del', text: 'c' },
      { type: 'del', text: 'd' },
    ]);
  });
});

describe('diffLines — a single line changed in the middle', () => {
  it('emits a "del" immediately followed by an "add" for the changed line, with unchanged neighbors tagged "same"', () => {
    const before = 'a\nb\nc';
    const after = 'a\nx\nc';
    const result = diffLines(before, after);

    expect(result).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('handles multiple separate single-line changes, each as its own del/add pair', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nX\nc\nY\ne';
    const result = diffLines(before, after);

    expect(result).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'X' },
      { type: 'same', text: 'c' },
      { type: 'del', text: 'd' },
      { type: 'add', text: 'Y' },
      { type: 'same', text: 'e' },
    ]);
  });
});

describe('diffLines — empty-string inputs', () => {
  it('does not crash on both sides empty, and treats it as one same blank line (split on "\\n" yields [""])', () => {
    const result = diffLines('', '');
    expect(result).toEqual([{ type: 'same', text: '' }]);
  });

  it('handles empty before / non-empty after without crashing or losing any line', () => {
    const result = diffLines('', 'a\nb');

    expect(() => diffLines('', 'a\nb')).not.toThrow();
    // The lone empty-string "line" on the before side and the two real lines
    // on the after side must both be fully accounted for.
    expect(reconstructBefore(result)).toEqual(['']);
    expect(reconstructAfter(result)).toEqual(['a', 'b']);
    // Every after-line actually shows up tagged 'add' (nothing to match against).
    expect(result.filter((d) => d.type === 'add').map((d) => d.text)).toEqual(['a', 'b']);
  });

  it('handles non-empty before / empty after without crashing or losing any line', () => {
    const result = diffLines('a\nb', '');

    expect(() => diffLines('a\nb', '')).not.toThrow();
    expect(reconstructBefore(result)).toEqual(['a', 'b']);
    expect(reconstructAfter(result)).toEqual(['']);
    expect(result.filter((d) => d.type === 'del').map((d) => d.text)).toEqual(['a', 'b']);
  });
});

describe('diffLines — multi-line reordering', () => {
  it('produces a diff that accounts for every before/after line, without crashing, for a fully reversed sequence', () => {
    const before = 'alpha\nbeta\ngamma\ndelta\nepsilon';
    const after = 'epsilon\ndelta\ngamma\nbeta\nalpha';

    expect(() => diffLines(before, after)).not.toThrow();
    const result = diffLines(before, after);

    // Not necessarily a minimal diff, but no line may be lost or invented.
    expect(reconstructBefore(result)).toEqual(linesOf(before));
    expect(reconstructAfter(result)).toEqual(linesOf(after));
  });

  it('produces a diff that accounts for every before/after line, without crashing, for a shuffled sequence with repeats', () => {
    const before = 'one\ntwo\nthree\ntwo\nfour';
    const after = 'four\none\ntwo\ntwo\nthree';

    expect(() => diffLines(before, after)).not.toThrow();
    const result = diffLines(before, after);

    expect(reconstructBefore(result)).toEqual(linesOf(before));
    expect(reconstructAfter(result)).toEqual(linesOf(after));
  });
});
