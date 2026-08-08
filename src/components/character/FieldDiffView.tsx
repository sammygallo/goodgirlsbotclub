// Compact before/after renderer for a single card-field diff, built on top
// of this repo's shared line-diff util (also used by ForkEntryEditor's
// base-drift view — same line-coloring convention, extended here with a
// tinted background per line and context-collapsing since card fields are
// long paragraphs rather than short lorebook entries).
import { diffLines, type DiffLine } from '../../utils/textDiff';
import type { FieldDiff } from '../../utils/cardAnalyzer/types';

export interface FieldDiffViewProps {
  diff: FieldDiff;
  className?: string;
}

/** Lines of unchanged context kept on each side of a change before the rest
 *  of a same-run gets collapsed into a single marker row. */
const CONTEXT_LINES = 3;

type DisplayItem =
  | { kind: 'line'; line: DiffLine; key: number }
  | { kind: 'collapsed'; count: number; key: number };

/**
 * Collapses long unchanged runs down to `CONTEXT_LINES` of context on each
 * side of a change, replacing the remainder with a single "N unchanged
 * lines" marker. Card fields are often full paragraphs, and a diff that
 * targeted one sentence shouldn't force scrolling through the other twenty
 * unchanged ones on a narrow screen.
 */
function collapseUnchanged(lines: DiffLine[]): DisplayItem[] {
  const n = lines.length;
  const keep = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (lines[i].type !== 'same') {
      keep[i] = true;
      continue;
    }
    for (let d = 0; d <= CONTEXT_LINES; d++) {
      const before = i - d;
      const after = i + d;
      if (
        (before >= 0 && lines[before].type !== 'same') ||
        (after < n && lines[after].type !== 'same')
      ) {
        keep[i] = true;
        break;
      }
    }
  }

  const items: DisplayItem[] = [];
  let i = 0;
  while (i < n) {
    if (keep[i]) {
      items.push({ kind: 'line', line: lines[i], key: i });
      i++;
      continue;
    }
    let j = i;
    while (j < n && !keep[j]) j++;
    items.push({ kind: 'collapsed', count: j - i, key: i });
    i = j;
  }
  return items;
}

const LINE_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-green-500/10 text-green-400',
  del: 'bg-red-500/10 text-red-400',
  same: 'text-[var(--color-text-secondary)]',
};

const LINE_PREFIX: Record<DiffLine['type'], string> = {
  add: '+ ',
  del: '- ',
  same: '  ',
};

export function FieldDiffView({ diff, className = '' }: FieldDiffViewProps) {
  const items = collapseUnchanged(diffLines(diff.before, diff.after));

  return (
    <div
      className={`max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-2 font-mono text-xs ${className}`}
    >
      {items.map((item) =>
        item.kind === 'collapsed' ? (
          <div
            key={item.key}
            className="py-1 text-center text-[10px] italic text-[var(--color-text-secondary)]"
          >
            &hellip; {item.count} unchanged line{item.count === 1 ? '' : 's'} &hellip;
          </div>
        ) : (
          <div
            key={item.key}
            className={`whitespace-pre-wrap break-words rounded-sm px-1 ${LINE_STYLES[item.line.type]}`}
          >
            <span className="select-none">{LINE_PREFIX[item.line.type]}</span>
            {item.line.text || ' '}
          </div>
        )
      )}
    </div>
  );
}
