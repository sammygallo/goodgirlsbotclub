// ---------------------------------------------------------------------------
// Lorebook v2 — pure line-based text diff
// ---------------------------------------------------------------------------
//
// A small, dependency-free line diff used by the chat-lore UI to show what an
// overlay changed relative to its base entry (or what a base entry drifted to
// since an overlay forked it). Entry content in this app is short — well
// under a few hundred lines — so a plain O(n*m) LCS dynamic-program is more
// than fast enough; this deliberately does not implement Myers diff or any
// other minimal-edit-script algorithm.

export interface DiffLine {
  type: 'same' | 'del' | 'add';
  text: string;
}

/**
 * Line-based diff of `before` vs `after`. Splits both strings on newlines,
 * computes the longest common subsequence of lines via a standard DP table,
 * then walks the table to emit 'same' lines plus 'del' lines (before-only)
 * immediately followed by 'add' lines (after-only) at each divergence point.
 *
 * This is not a minimal diff (no move/rename detection, no attempt to
 * shorten the del/add runs further) — just a correct, readable one.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..n) and b[j..m)
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', text: a[i] });
      i++;
    } else {
      result.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: 'del', text: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j] });
    j++;
  }
  return result;
}
