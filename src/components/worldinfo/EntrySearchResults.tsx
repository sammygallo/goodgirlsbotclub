import type { EntrySearchHit } from '../../utils/lorebookSearch';
import { entryLabel } from '../../utils/lorebookLint';

// ---------------------------------------------------------------------------
// Lorebook v2 — global entry search results (Phase 3)
// ---------------------------------------------------------------------------
//
// Renders the flat hit list from searchEntries(). Badge styling follows the
// same tinted-pill convention as BookAttachmentChips.tsx / TagInput.tsx /
// LibraryFilterBar.tsx (`bg-[var(--color-primary)]/20 text-[var(--color-primary)]`
// for the "notable" auto-extracted flag, a neutral tertiary tint for the
// plain scope/book badge) since no dedicated LibraryBookRow badge component
// exists yet to borrow from.

const badgeBase = 'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap';
const badgeNeutral = `${badgeBase} bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]`;
const badgeAuto = `${badgeBase} bg-[var(--color-primary)]/20 text-[var(--color-primary)]`;

const SCOPE_LABEL: Record<EntrySearchHit['scope'], string> = {
  character: 'Character',
  world: 'World',
};

export interface EntrySearchResultsProps {
  hits: EntrySearchHit[];
  query: string;
  onOpenEntry: (bookId: string, entryId: string) => void;
}

export function EntrySearchResults({ hits, query, onOpenEntry }: EntrySearchResultsProps) {
  if (hits.length === 0 && query.trim().length > 0) {
    return (
      <p className="text-sm text-[var(--color-text-secondary)] py-4 text-center">
        No entries match &quot;{query}&quot;.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {hits.map((hit) => (
        <li key={`${hit.bookId}:${hit.entry.id}`}>
          <button
            type="button"
            onClick={() => onOpenEntry(hit.bookId, hit.entry.id)}
            className="w-full flex flex-col gap-1 px-3 py-2 rounded-lg text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                {entryLabel(hit.entry)}
              </span>
              <span className="flex items-center gap-1 flex-shrink-0">
                <span className={badgeNeutral}>
                  {hit.bookName} · {SCOPE_LABEL[hit.scope]}
                </span>
                {hit.autoExtracted && <span className={badgeAuto}>Auto</span>}
              </span>
            </div>
            <span className="text-xs text-[var(--color-text-secondary)] truncate">
              {hit.snippet}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
