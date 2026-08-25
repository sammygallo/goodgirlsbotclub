import { AlertTriangle } from 'lucide-react';
import type { DocumentOrphan } from '../../utils/documentBookOrphans';

export interface DocumentOrphanNoticeProps {
  orphans: DocumentOrphan[];
}

/**
 * E4-S0 — the user-visible half of orphaned-document detection.
 *
 * Renders nothing at all when there is nothing to report, which is the
 * ordinary case: this is a section that only exists on the accounts that
 * have the problem, not a permanent panel with an "all clear" state.
 *
 * REPORT ONLY, by design. There is no delete button, no "clean up" action
 * and no reassign control here, and adding one would be a mistake: an
 * orphaned document is text the user uploaded and can no longer reach, so
 * the failure mode of a repair button is destroying the only copy. Telling
 * them it exists is the whole job.
 */
export function DocumentOrphanNotice({ orphans }: DocumentOrphanNoticeProps) {
  if (orphans.length === 0) return null;

  const stranded = orphans.filter((o) => o.kind === 'owner-gone');
  const leftover = orphans.filter((o) => o.kind === 'unresolved-registration');

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
        <AlertTriangle size={14} className="text-amber-400 shrink-0" />
        Orphaned documents ({orphans.length})
      </h2>

      {stranded.length > 0 && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-2">
          <p className="text-xs text-amber-400">
            {stranded.length === 1 ? 'This document belongs' : 'These documents belong'}{' '}
            to a character that no longer exists. A character-scoped document
            only ever reaches the scan through its owner, so{' '}
            {stranded.length === 1 ? 'it is' : 'they are'} out of every chat —
            global and per-character alike. The text is still here; nothing has
            been deleted.
          </p>
          <ul className="space-y-1">
            {stranded.map((o) => (
              <li key={o.documentId} className="text-xs">
                <span className="text-[var(--color-text-primary)] font-medium">
                  {o.bookName}
                </span>
                <span className="text-[var(--color-text-secondary)]">
                  {' '}
                  — owner{' '}
                  <code className="text-[11px]">{o.ownerCharacterAvatar}</code>{' '}
                  not found
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Find {stranded.length === 1 ? 'it' : 'them'} under the Character
            filter in the library below to read, export or delete{' '}
            {stranded.length === 1 ? 'it' : 'them'} yourself.
          </p>
        </div>
      )}

      {leftover.length > 0 && (
        <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] space-y-2">
          <p className="text-xs text-[var(--color-text-secondary)]">
            {leftover.length} document record
            {leftover.length === 1 ? '' : 's'} on this account{' '}
            {leftover.length === 1 ? 'points' : 'point'} at a lorebook that is
            not here. Usually that means the document was deleted from the
            library and the record outlived it — no text is missing. If you
            added {leftover.length === 1 ? 'it' : 'them'} on another device and
            expected {leftover.length === 1 ? 'it' : 'them'} here, the sync did
            not bring {leftover.length === 1 ? 'it' : 'them'} across.
          </p>
          <ul className="space-y-1">
            {leftover.map((o) => (
              <li
                key={o.documentId}
                className="text-xs text-[var(--color-text-secondary)]"
              >
                <code className="text-[11px]">{o.documentId}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
