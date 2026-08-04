import { useMemo, useState } from 'react';
import { diffLines } from '../../utils/textDiff';
import type { EntryRevision, RevisionAction } from '../../stores/worldInfoStore';
import { ConfirmDialog } from '../ui';

export interface EntryHistoryProps {
  revisions: EntryRevision[];
  currentContent: string;
  onRestore?: (rev: EntryRevision) => void;
}

// Verb shown per revision, keyed on the action that produced it. The
// conflict_* actions aren't written anywhere yet — they're reserved for a
// future per-chat overlay/forking phase — but they're valid RevisionAction
// values today, so a revision tagged with one must still render a real
// label instead of crashing or silently vanishing from the list.
const ACTION_VERBS: Record<RevisionAction, string> = {
  create: 'created',
  edit: 'edited',
  auto_update: 'auto-updated',
  conflict_keep: 'kept this over a conflicting memory',
  conflict_replace: 'replaced this with a conflicting memory',
  conflict_fork: 'forked this over a conflicting memory',
};

/**
 * Small dependency-free relative-time label — no calendar precision needed.
 * Exported so other components (e.g. a later per-chat overlay/forking view)
 * can reuse the same formatting instead of reimplementing it.
 */
export function relativeTime(ts: number): string {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 45) return 'just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.floor(day / 365);
  return `${year}y ago`;
}

/**
 * Revision history for a world info entry, newest-first.
 *
 * `revisions` is stored oldest-first (each record is a snapshot of the
 * content BEFORE that edit was applied). For revision k, the content that
 * edit produced is revision k+1's prevContent — or the entry's current
 * content when k is the most recent revision. So the diff shown per row is
 * `diffLines(revisions[k].prevContent, revisions[k+1]?.prevContent ?? currentContent)`,
 * computed in that original chronological order and only reversed for
 * display, so each row's "what changed" reflects exactly what THAT edit did.
 */
export function EntryHistory({ revisions, currentContent, onRestore }: EntryHistoryProps) {
  const [pendingRestore, setPendingRestore] = useState<EntryRevision | null>(null);

  const rows = useMemo(
    () =>
      revisions
        .map((rev, idx) => ({
          rev,
          diff: diffLines(rev.prevContent, revisions[idx + 1]?.prevContent ?? currentContent),
        }))
        .reverse(),
    [revisions, currentContent]
  );

  if (revisions.length === 0) return null;

  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {rows.map(({ rev, diff }, i) => (
          <li
            key={`${rev.ts}-${i}`}
            className="rounded-lg border border-[var(--color-border)] p-2"
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-[var(--color-text-primary)]">
                <span className="font-medium">{rev.authorHandle || 'unknown'}</span>{' '}
                {ACTION_VERBS[rev.action]}
              </span>
              <span className="flex-shrink-0 text-[var(--color-text-secondary)]">
                {relativeTime(rev.ts)}
              </span>
            </div>

            <details className="group mt-1">
              <summary className="cursor-pointer text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                What changed
              </summary>
              <div className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto overflow-x-auto rounded bg-[var(--color-bg-tertiary)] p-2 font-mono text-xs">
                {diff.map((line, j) => (
                  <div
                    key={j}
                    className={
                      line.type === 'add'
                        ? 'text-green-400'
                        : line.type === 'del'
                          ? 'text-red-400 line-through'
                          : 'text-[var(--color-text-secondary)]'
                    }
                  >
                    <span className="select-none">
                      {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
                    </span>
                    {line.text || ' '}
                  </div>
                ))}
              </div>
            </details>

            {onRestore && (
              <button
                type="button"
                onClick={() => setPendingRestore(rev)}
                className="mt-1.5 text-xs text-[var(--color-primary)] hover:underline"
              >
                Restore this version
              </button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        isOpen={pendingRestore !== null}
        onClose={() => setPendingRestore(null)}
        onConfirm={() => {
          if (pendingRestore) onRestore?.(pendingRestore);
        }}
        title="Restore this version?"
        message="This replaces the current content with this older revision's content. Other fields on the current draft are left as they are."
        confirmLabel="Restore"
        danger
      />
    </div>
  );
}
