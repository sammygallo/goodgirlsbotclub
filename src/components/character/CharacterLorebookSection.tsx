import { useRef, useState } from 'react';
import { BookOpen, Download, Edit2, Plus, Trash2, Upload } from 'lucide-react';
import { useWorldInfoStore } from '../../stores/worldInfoStore';
import { WorldInfoBookEditor } from '../worldinfo/WorldInfoBookEditor';

interface CharacterLorebookSectionProps {
  /** The character's avatar filename (unique id). */
  avatar: string;
  /** Human-readable character name, used when creating a new embedded book. */
  characterName?: string;
  /** Currently-linked extra book ids (staged). */
  linkedBookIds: string[];
  /** Called with the new full list whenever the user toggles a checkbox. */
  onLinkedBookIdsChange: (ids: string[]) => void;
}

/**
 * CharacterEdit sub-section that surfaces the character's embedded
 * lorebook (if any) and lets the user attach extra non-owner global
 * lorebooks to auto-activate whenever the character is selected.
 */
export function CharacterLorebookSection({
  avatar,
  characterName,
  linkedBookIds,
  onLinkedBookIdsChange,
}: CharacterLorebookSectionProps) {
  const books = useWorldInfoStore((s) => s.books);
  const createCharacterBook = useWorldInfoStore((s) => s.createCharacterBook);
  const deleteCharacterBook = useWorldInfoStore((s) => s.deleteCharacterBook);
  const deleteBook = useWorldInfoStore((s) => s.deleteBook);
  const importBookJson = useWorldInfoStore((s) => s.importBookJson);
  const exportBookJson = useWorldInfoStore((s) => s.exportBookJson);
  const [editingEmbedded, setEditingEmbedded] = useState(false);
  const [editingLinkedBookId, setEditingLinkedBookId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDeleteBookId, setConfirmDeleteBookId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importEmbeddedInputRef = useRef<HTMLInputElement>(null);

  const handleLorebookUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError(null);
    setImportNotice(null);
    try {
      const json = await file.text();
      const fallback = file.name.replace(/\.json$/i, '') || 'Imported Lorebook';
      const book = importBookJson(json, fallback);
      if (!book) {
        setImportError('Could not parse lorebook JSON.');
        return;
      }
      // Auto-link the freshly imported book to this character so it
      // activates whenever this character is the scan target.
      if (!linkedBookIds.includes(book.id)) {
        onLinkedBookIdsChange([...linkedBookIds, book.id]);
      }
      setImportNotice(`Linked "${book.name}" (${book.entries.length} entries).`);
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Failed to upload lorebook.'
      );
    }
  };

  const handleEmbeddedImport = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportError(null);
    setImportNotice(null);
    try {
      const json = await file.text();
      const fallback = characterName
        ? `${characterName}'s Lorebook`
        : file.name.replace(/\.json$/i, '') || 'Imported Lorebook';
      const book = importBookJson(json, fallback, avatar);
      if (!book) {
        setImportError('Could not parse lorebook JSON.');
        return;
      }
      setImportNotice(
        `Imported "${book.name}" as embedded lorebook (${book.entries.length} entries).`
      );
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Failed to import lorebook.'
      );
    }
  };

  const embeddedBook = books.find((b) => b.ownerCharacterAvatar === avatar);
  // Only non-character-owned books are eligible to be linked as extras
  // (picking another character's embedded book would be surprising).
  const candidateBooks = books.filter((b) => b.ownerCharacterAvatar == null);

  const toggleLink = (bookId: string) => {
    if (linkedBookIds.includes(bookId)) {
      onLinkedBookIdsChange(linkedBookIds.filter((id) => id !== bookId));
    } else {
      onLinkedBookIdsChange([...linkedBookIds, bookId]);
    }
  };

  // Download the embedded book as a JSON file so it can be taken into
  // external tools. Mirrors the export handler on the World Info page.
  const handleExportEmbedded = () => {
    if (!embeddedBook) return;
    const json = exportBookJson(embeddedBook.id);
    if (!json) return;
    const safeName =
      embeddedBook.name.replace(/[^a-z0-9_\-\s]/gi, '_').trim() || 'lorebook';
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <BookOpen size={16} className="text-[var(--color-text-secondary)]" />
        <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
          Lorebooks
        </h3>
      </div>

      {(importError || importNotice) && (
        <div
          className={`rounded-md px-2 py-1.5 text-xs ${
            importError
              ? 'border border-red-500/40 bg-red-500/10 text-red-300'
              : 'border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]'
          }`}
        >
          {importError || importNotice}
        </div>
      )}

      {/* Embedded book */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3">
        <p className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wide mb-2">
          Embedded Lorebook
        </p>
        {embeddedBook ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                {embeddedBook.name}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {embeddedBook.entries.length} entr
                {embeddedBook.entries.length === 1 ? 'y' : 'ies'} · auto-active
                for this character
              </p>
            </div>
            <button
              type="button"
              onClick={handleExportEmbedded}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
              aria-label="Export embedded lorebook as JSON"
              title="Download this lorebook as a JSON file"
            >
              <Download size={13} />
              Export
            </button>
            <button
              type="button"
              onClick={() => setEditingEmbedded(true)}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
              aria-label="Edit embedded lorebook"
            >
              <Edit2 size={13} />
              Edit
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-[var(--color-border)]"
              aria-label="Remove embedded lorebook"
            >
              <Trash2 size={13} />
              Remove
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 min-w-[8rem] text-sm text-[var(--color-text-secondary)]">
              No embedded lorebook yet.
            </p>
            <button
              type="button"
              onClick={() => importEmbeddedInputRef.current?.click()}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
              aria-label="Import embedded lorebook from JSON"
            >
              <Upload size={13} />
              Import Lorebook
            </button>
            <button
              type="button"
              onClick={() => {
                const fallback = characterName
                  ? `${characterName}'s Lorebook`
                  : 'Character Lorebook';
                createCharacterBook(avatar, fallback);
                setEditingEmbedded(true);
              }}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
              aria-label="Add embedded lorebook"
            >
              <Plus size={13} />
              Add Lorebook
            </button>
          </div>
        )}
        {confirmRemove && embeddedBook && (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-[var(--color-text-primary)]">
            <p>Remove the embedded lorebook and all its entries? This cannot be undone.</p>
            <div className="mt-2 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteCharacterBook(avatar);
                  setConfirmRemove(false);
                }}
                className="px-2 py-1 rounded bg-red-500/80 text-white hover:bg-red-500"
              >
                Remove
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Linked books */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wide">
            Additional Lorebooks
          </p>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
          >
            <Upload size={12} />
            Upload Lorebook
          </button>
        </div>

        {candidateBooks.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">
            No global lorebooks linked yet. Use Upload Lorebook to import one,
            or create books in Settings → World Info.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {candidateBooks.map((book) => {
              const checked = linkedBookIds.includes(book.id);
              return (
                <li key={book.id} className="flex items-center gap-1">
                  <label className="flex-1 flex items-center gap-2.5 cursor-pointer rounded-md px-1.5 py-1 hover:bg-[var(--color-bg-secondary)] min-w-0">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleLink(book.id)}
                      className="w-4 h-4 accent-[var(--color-primary)]"
                    />
                    <span className="flex-1 min-w-0 text-sm text-[var(--color-text-primary)] truncate">
                      {book.name}
                    </span>
                    <span className="text-xs text-[var(--color-text-secondary)]">
                      {book.entries.length}
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setEditingLinkedBookId(book.id)}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
                    aria-label={`Edit ${book.name}`}
                    title="Edit lorebook entries"
                  >
                    <Edit2 size={12} />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteBookId(book.id)}
                    className="shrink-0 p-1.5 rounded-md text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10"
                    aria-label={`Delete ${book.name}`}
                    title="Permanently delete lorebook"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {confirmDeleteBookId && (() => {
          const book = candidateBooks.find((b) => b.id === confirmDeleteBookId);
          return book ? (
            <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-[var(--color-text-primary)]">
              <p>Permanently delete &ldquo;{book.name}&rdquo; and all its entries? This cannot be undone.</p>
              <div className="mt-2 flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmDeleteBookId(null)}
                  className="px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    deleteBook(confirmDeleteBookId);
                    onLinkedBookIdsChange(linkedBookIds.filter((id) => id !== confirmDeleteBookId));
                    setConfirmDeleteBookId(null);
                  }}
                  className="px-2 py-1 rounded bg-red-500/80 text-white hover:bg-red-500"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : null;
        })()}
        <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
          Linked books are auto-activated (in addition to globally-active
          books) whenever this character is the scan target.
        </p>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleLorebookUpload}
      />
      <input
        ref={importEmbeddedInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleEmbeddedImport}
      />

      {embeddedBook && editingEmbedded && (
        <WorldInfoBookEditor
          isOpen={editingEmbedded}
          onClose={() => setEditingEmbedded(false)}
          book={embeddedBook}
        />
      )}

      {editingLinkedBookId && (() => {
        const editing = books.find((b) => b.id === editingLinkedBookId);
        return editing ? (
          <WorldInfoBookEditor
            isOpen={true}
            onClose={() => setEditingLinkedBookId(null)}
            book={editing}
          />
        ) : null;
      })()}
    </section>
  );
}
