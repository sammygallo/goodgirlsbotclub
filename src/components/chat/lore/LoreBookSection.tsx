import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LoreSourceSectionVM, LoreEntryRowVM } from '../../../utils/chatLoreView';
import { LoreEntryRow, type LoreRowAction } from './LoreEntryRow';

export interface LoreBookSectionProps {
  section: LoreSourceSectionVM;
  expanded: boolean;
  onToggleExpanded: () => void;
  onBookToggle: () => void;
  onRowAction: (row: LoreEntryRowVM, action: LoreRowAction) => void;
}

/**
 * A real (native) tri-state checkbox — `indeterminate` isn't settable via a
 * JSX prop, only imperatively on the DOM node, so this wraps that in one
 * place rather than repeating the ref/effect dance at the call site.
 */
function TriStateCheckbox({
  state,
  onChange,
  label,
}: {
  state: 'on' | 'off' | 'mixed';
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mixed';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'on'}
      onChange={onChange}
      className="w-4 h-4 flex-shrink-0 accent-[var(--color-primary)]"
      aria-label={label}
    />
  );
}

/**
 * One collapsible source section (a world/character/persona/chat_attached
 * book, or the always-present synthetic chat_local section). The chat_local
 * section never renders a book-level toggle — there is no "book" to
 * attach/detach, only individual chat-only entries underneath.
 */
export function LoreBookSection({
  section,
  expanded,
  onToggleExpanded,
  onBookToggle,
  onRowAction,
}: LoreBookSectionProps) {
  const isLocal = section.labelKind === 'chat_local';

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="p-1 -ml-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] flex-shrink-0"
          aria-label={expanded ? 'Collapse section' : 'Expand section'}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        {!isLocal && (
          <TriStateCheckbox
            state={section.bookToggle}
            onChange={onBookToggle}
            label={
              section.bookToggle === 'on'
                ? `Turn off ${section.labelName} for this chat`
                : `Turn on ${section.labelName} for this chat`
            }
          />
        )}

        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex-1 min-w-0 text-left"
        >
          <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
            {section.labelName}
          </p>
        </button>

        <span className="text-xs text-[var(--color-text-secondary)] flex-shrink-0">
          {isLocal ? section.totalCount : `${section.inheritedCount}/${section.totalCount}`}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-[var(--color-border)] p-2 space-y-1.5">
          {section.rows.length === 0 ? (
            <p className="text-xs text-[var(--color-text-secondary)] text-center py-2">
              {isLocal ? 'No chat-only entries yet.' : 'No entries in this book.'}
            </p>
          ) : (
            section.rows.map((row) => (
              <LoreEntryRow
                key={row.base.id}
                row={row}
                onAction={(action) => onRowAction(row, action)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
