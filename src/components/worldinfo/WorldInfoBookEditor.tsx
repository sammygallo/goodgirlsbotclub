import { useState } from 'react';
import { Plus, Edit2, Trash2, Check, X, ChevronRight } from 'lucide-react';
import {
  useWorldInfoStore,
  humanizeCategory,
  type WorldInfoBook,
  type WorldInfoEntry,
} from '../../stores/worldInfoStore';
import { Modal, Button, ConfirmDialog } from '../ui';
import { WorldInfoEntryForm } from './WorldInfoEntryForm';

interface WorldInfoBookEditorProps {
  isOpen: boolean;
  onClose: () => void;
  book: WorldInfoBook;
}

const POSITION_LABELS: Record<string, string> = {
  before_char: 'Before Char',
  after_char: 'After Char',
  before_an: 'Before AN',
  after_an: 'After AN',
  at_depth: '@ Depth',
};

export function WorldInfoBookEditor({ isOpen, onClose, book }: WorldInfoBookEditorProps) {
  const { deleteEntry, updateEntry } = useWorldInfoStore();

  const [editingEntry, setEditingEntry] = useState<WorldInfoEntry | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WorldInfoEntry | null>(null);

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
          <WorldInfoEntryForm
            bookId={book.id}
            entry={editingEntry}
            onClose={handleFormClose}
          />
        ) : (
          <div className="space-y-3">
            {book.entries.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-sm text-[var(--color-text-secondary)] mb-4">
                  No entries yet. Add one to start building lore.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {book.entries.map((entry) => (
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
                ))}
              </ul>
            )}

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
          </div>
        )}
      </Modal>

      {confirmDelete && (
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
