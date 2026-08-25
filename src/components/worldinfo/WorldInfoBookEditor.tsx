import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Edit2, Trash2, Check, X, ChevronRight } from 'lucide-react';
import {
  useWorldInfoStore,
  humanizeCategory,
  auditBookHealth,
  type WorldInfoBook,
  type WorldInfoEntry,
} from '../../stores/worldInfoStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { profileForProvider } from '../../utils/tokenizer';
import { lintBook, worstSeverity, type LintFinding } from '../../utils/lorebookLint';
import { Modal, Button, ConfirmDialog } from '../ui';
import { WorldInfoEntryForm } from './WorldInfoEntryForm';
import { BookHealthCard } from './BookHealthCard';

interface WorldInfoBookEditorProps {
  isOpen: boolean;
  onClose: () => void;
  book: WorldInfoBook;
  /**
   * When set and it matches an entry.id in book.entries, open straight into
   * edit mode for that entry (as if the user had clicked it) instead of the
   * list view. Undefined, or no match in the current entries, leaves
   * behavior unchanged (opens to the list view).
   */
  initialEntryId?: string;
  /**
   * Renders this editor read-only: opened from another user's shared book
   * (Phase 5 group sharing), not one of the caller's own. `book.id` isn't in
   * the viewer's own `books`, so the store's createEntry silently fails
   * ('Lorebook not found', never surfaced here) while updateEntry/deleteEntry
   * no-op by id — or, on an id collision with one of the viewer's own books,
   * silently mutate that book instead. Every mutating control must therefore
   * be hidden outright rather than merely disabled. Defaults to false so
   * every existing (own-book) caller is unaffected.
   */
  readOnly?: boolean;
}

const POSITION_LABELS: Record<string, string> = {
  before_char: 'Before Char',
  after_char: 'After Char',
  before_an: 'Before AN',
  after_an: 'After AN',
  at_depth: '@ Depth',
};

export function WorldInfoBookEditor({ isOpen, onClose, book, initialEntryId, readOnly = false }: WorldInfoBookEditorProps) {
  const { deleteEntry, updateEntry, tokenBudget } = useWorldInfoStore();

  const [editingEntry, setEditingEntry] = useState<WorldInfoEntry | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WorldInfoEntry | null>(null);

  // Lint the whole book once per change (cross-entry rules need every entry in
  // view), index it by entry id for the per-row badge, and fold the book-level
  // health audit + lint error/warning counts into the same pass so nothing
  // recomputes lintBook a second time for BookHealthCard.
  const activeProvider = useSettingsStore((s) => s.activeProvider);
  const { lintByEntry, audit, lintErrorCount, lintWarningCount } = useMemo(() => {
    const profile = profileForProvider(activeProvider || '');
    const map = new Map<string, LintFinding[]>();
    let errorCount = 0;
    let warningCount = 0;
    for (const result of lintBook(book.entries, profile)) {
      map.set(result.entryId, result.findings);
      const worst = worstSeverity(result.findings);
      if (worst === 'error') errorCount++;
      else if (worst === 'warning') warningCount++;
    }
    return {
      lintByEntry: map,
      audit: auditBookHealth(book, profile),
      lintErrorCount: errorCount,
      lintWarningCount: warningCount,
    };
  }, [book, activeProvider]);

  // Deep-link support: open straight into edit mode for a given entry (e.g.
  // arriving from a notification or search result) instead of the list view.
  // No-ops when initialEntryId is absent or doesn't match a current entry, so
  // every existing caller (which never passes it) is unaffected.
  //
  // One-shot guard (appliedInitialEntryIdRef): book.entries gets a fresh array
  // reference on every store mutation (updateEntry/deleteEntry always copy),
  // so this effect's dependency array alone would re-fire on every Save/
  // Delete/Restore inside the book — forcibly reopening the originally
  // deep-linked entry's edit form and defeating normal navigation (e.g. Save
  // no longer returns to the list). The ref remembers which initialEntryId
  // has already been applied so a mutation-triggered re-run is a no-op; a
  // genuinely new initialEntryId (a different search-result click) still
  // applies normally.
  const appliedInitialEntryIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialEntryId) return;
    if (appliedInitialEntryIdRef.current === initialEntryId) return;
    const match = book.entries.find((e) => e.id === initialEntryId);
    if (match) {
      setEditingEntry(match);
      setIsCreating(false);
      appliedInitialEntryIdRef.current = initialEntryId;
    }
  }, [initialEntryId, book.entries]);

  const handleFormClose = () => {
    setEditingEntry(null);
    setIsCreating(false);
  };

  const formMode = isCreating || editingEntry;
  const title = isCreating
    ? `${book.name} — New Entry`
    : editingEntry
      ? `${book.name} — Edit Entry`
      : book.name;

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
        {formMode ? (
          readOnly ? (
            <ReadOnlyEntryDetail entry={editingEntry} onClose={handleFormClose} />
          ) : (
            <WorldInfoEntryForm
              bookId={book.id}
              entry={editingEntry}
              onClose={handleFormClose}
            />
          )
        ) : (
          <div className="space-y-3">
            <BookHealthCard
              audit={audit}
              lintErrorCount={lintErrorCount}
              lintWarningCount={lintWarningCount}
              tokenBudget={tokenBudget}
            />
            {book.entries.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-sm text-[var(--color-text-secondary)] mb-4">
                  No entries yet. Add one to start building lore.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {book.entries.map((entry) => {
                  const lintFindings = lintByEntry.get(entry.id) ?? [];
                  const lintWorst = worstSeverity(lintFindings);
                  const lintTitle = lintFindings.map((f) => f.message).join('\n');
                  return (
                  <li
                    key={entry.id}
                    className={`
                      p-3 rounded-lg border transition-colors
                      ${
                        entry.enabled
                          ? 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'
                          : 'bg-[var(--color-bg-tertiary)]/40 border-[var(--color-border)] opacity-60'
                      }
                    `}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-medium">
                            {POSITION_LABELS[entry.position] || entry.position}
                          </span>
                          {entry.constant && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">
                              CONSTANT
                            </span>
                          )}
                          {entry.critical && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 font-medium">
                              CRITICAL
                            </span>
                          )}
                          {lintWorst === 'error' && (
                            <span
                              className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium"
                              title={lintTitle}
                            >
                              NEEDS FIX
                            </span>
                          )}
                          {lintWorst === 'warning' && (
                            <span
                              className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium"
                              title={lintTitle}
                            >
                              CHECK
                            </span>
                          )}
                          {entry.category && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)]">
                              {humanizeCategory(entry.category)}
                            </span>
                          )}
                          {entry.relatedIds.length > 0 && (
                            <span className="text-[10px] text-[var(--color-text-secondary)]">
                              links: {entry.relatedIds.length}
                            </span>
                          )}
                          {entry.caseSensitive && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)]">
                              Aa
                            </span>
                          )}
                          <span className="text-[10px] text-[var(--color-text-secondary)]">
                            order {entry.order}
                          </span>
                          {entry.position === 'at_depth' && (
                            <span className="text-[10px] text-[var(--color-text-secondary)]">
                              depth {entry.depth}
                            </span>
                          )}
                        </div>
                        {entry.comment && (
                          <p className="text-xs text-[var(--color-text-primary)] font-medium mb-1 truncate">
                            {entry.comment}
                          </p>
                        )}
                        <p className="text-xs text-[var(--color-text-secondary)] mb-1">
                          {entry.constant ? (
                            <em>No keywords (always active)</em>
                          ) : entry.semanticOnly ? (
                            <em>Semantic only (no keywords needed)</em>
                          ) : entry.keys.length > 0 ? (
                            entry.keys.map((k, i) => (
                              <span
                                key={i}
                                className="inline-block mr-1 mb-0.5 px-1.5 py-0.5 rounded bg-[var(--color-bg-primary)]"
                              >
                                {k}
                              </span>
                            ))
                          ) : (
                            <em className="text-red-400">Missing keywords</em>
                          )}
                        </p>
                        <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2">
                          {entry.content}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {!readOnly && (
                          <>
                            <button
                              onClick={() =>
                                updateEntry(book.id, entry.id, { enabled: !entry.enabled })
                              }
                              className={`p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] ${
                                entry.enabled
                                  ? 'text-green-400'
                                  : 'text-[var(--color-text-secondary)]'
                              }`}
                              title={entry.enabled ? 'Disable' : 'Enable'}
                              aria-label={entry.enabled ? 'Disable entry' : 'Enable entry'}
                            >
                              {entry.enabled ? <Check size={14} /> : <X size={14} />}
                            </button>
                            <button
                              onClick={() => {
                                setEditingEntry(entry);
                                setIsCreating(false);
                              }}
                              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
                              title="Edit entry"
                              aria-label="Edit entry"
                            >
                              <Edit2 size={14} />
                            </button>
                            <button
                              onClick={() => setConfirmDelete(entry)}
                              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10"
                              title="Delete entry"
                              aria-label="Delete entry"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setEditingEntry(entry);
                        setIsCreating(false);
                      }}
                      className="mt-1 text-xs text-[var(--color-primary)] hover:underline flex items-center gap-1"
                    >
                      View details <ChevronRight size={12} />
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}

            {!readOnly && (
              <Button
                variant="primary"
                onClick={() => {
                  setEditingEntry(null);
                  setIsCreating(true);
                }}
                className="w-full"
              >
                <Plus size={18} className="mr-2" />
                New Entry
              </Button>
            )}
          </div>
        )}
      </Modal>

      {!readOnly && confirmDelete && (
        <ConfirmDialog
          isOpen={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteEntry(book.id, confirmDelete.id);
            setConfirmDelete(null);
          }}
          title="Delete Entry"
          message={`Delete this world info entry? This cannot be undone.`}
          confirmLabel="Delete"
          danger
        />
      )}
    </>
  );
}

/** Read-only detail view for an entry in a read-only (shared, not-owned)
 *  book — same information WorldInfoEntryForm would show, minus every
 *  editable control. No store mutators are wired here on purpose. */
function ReadOnlyEntryDetail({
  entry,
  onClose,
}: {
  entry: WorldInfoEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Keywords
        </h3>
        {entry.constant ? (
          <p className="text-sm text-[var(--color-text-secondary)] italic">
            No keywords (always active)
          </p>
        ) : entry.semanticOnly ? (
          <p className="text-sm text-[var(--color-text-secondary)] italic">
            Semantic only — activates on meaning, not keywords. That matching runs
            server-side, so this entry doesn't fire in group chats, or on one-on-one
            turns that fall back to the local keyword scan.
          </p>
        ) : entry.keys.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {entry.keys.map((k, i) => (
              <span
                key={i}
                className="inline-block px-2 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-sm text-[var(--color-text-primary)]"
              >
                {k}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-red-400 italic">Missing keywords</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Content
        </h3>
        <p className="text-sm text-[var(--color-text-primary)] whitespace-pre-wrap p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
          {entry.content}
        </p>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)] italic">
        Shared from another user's library — read-only. Copy it to your own
        library to edit.
      </p>

      <Button variant="secondary" onClick={onClose} className="w-full">
        Back
      </Button>
    </div>
  );
}
