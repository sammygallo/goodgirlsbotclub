import type { LibraryScope } from '../../utils/bookAttachments';

// ---------------------------------------------------------------------------
// Lorebook v2 — library scope filter bar
// ---------------------------------------------------------------------------
//
// Five pill buttons ("All" / "Character" / "World" / "Auto Memory" /
// "Shared with me"), each with a small count badge. Visually this follows
// the Sidebar's existing "Tags" filter-pill precedent exactly (Sidebar.tsx,
// filter-controls row): generic bg-[var(--color-primary)]/20 +
// text-[var(--color-primary)] tint for the active segment, a solid
// bg-[var(--color-primary)] + text-white pill for the count badge, and the
// same neutral/hover treatment for inactive segments. We deliberately did
// NOT borrow the Sidebar's "Favorites" yellow-star styling — that color is
// specific to the favorites concept, whereas these segments are generic
// filters just like Sidebar's "Tags" pill, so "Tags" is the correct
// precedent to match.

export type { LibraryScope };

export interface LibraryFilterBarProps {
  scope: LibraryScope;
  onScopeChange: (scope: LibraryScope) => void;
  counts: Record<LibraryScope, number>;
}

const SEGMENTS: { value: LibraryScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'character', label: 'Character' },
  { value: 'world', label: 'World' },
  { value: 'auto_memory', label: 'Auto Memory' },
  { value: 'shared', label: 'Shared with me' },
];

export function LibraryFilterBar({ scope, onScopeChange, counts }: LibraryFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {SEGMENTS.map((segment) => {
        const isActive = scope === segment.value;
        const count = counts[segment.value] ?? 0;
        return (
          <button
            key={segment.value}
            onClick={() => onScopeChange(segment.value)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
              isActive
                ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
            }`}
            aria-pressed={isActive}
            title={`Show ${segment.label.toLowerCase()} lorebooks`}
          >
            <span>{segment.label}</span>
            <span className="bg-[var(--color-primary)] text-white px-1 rounded text-[10px]">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
