import { useRef, useState } from 'react';
import { BookOpen, Edit2, Upload } from 'lucide-react';
import type {
  PersonaDescriptionPosition,
  PersonaDescriptionRole,
} from '../../stores/personaStore';
import { useWorldInfoStore } from '../../stores/worldInfoStore';
import { WorldInfoBookEditor } from '../worldinfo/WorldInfoBookEditor';

interface PersonaSettingsFieldsProps {
  descriptionPosition: PersonaDescriptionPosition;
  onDescriptionPositionChange: (v: PersonaDescriptionPosition) => void;
  descriptionDepth: number;
  onDescriptionDepthChange: (v: number) => void;
  descriptionRole: PersonaDescriptionRole;
  onDescriptionRoleChange: (v: PersonaDescriptionRole) => void;
  isDefault: boolean;
  onIsDefaultChange: (v: boolean) => void;
  linkedBookIds: string[];
  /** Accepts a value OR a functional updater (React setState-style). The
   *  updater form matters for the async lorebook-upload path below: it must
   *  compose against the LATEST linked-book list, not a value captured before
   *  `await file.text()`, or a checkbox toggled during the read is lost. */
  onLinkedBookIdsChange: (update: string[] | ((prev: string[]) => string[])) => void;
}

/**
 * The persona's mechanical settings — description injection position/depth/
 * role, the "set as default" toggle, and the linked-lorebook picker/upload.
 * Extracted from PersonaForm so both the plain form and the wizard's review
 * step render the exact same controls and stay in sync (mirrors how the
 * character wizard shares CoreCardFields/AdvancedCardFields with its own
 * simple form). Purely controlled for the injection/default/linkedBook
 * state; owns only the local lorebook-upload input, the edit-modal target,
 * and its own inline upload notice.
 */
export function PersonaSettingsFields({
  descriptionPosition,
  onDescriptionPositionChange,
  descriptionDepth,
  onDescriptionDepthChange,
  descriptionRole,
  onDescriptionRoleChange,
  isDefault,
  onIsDefaultChange,
  linkedBookIds,
  onLinkedBookIdsChange,
}: PersonaSettingsFieldsProps) {
  const importBookJson = useWorldInfoStore((s) => s.importBookJson);
  const books = useWorldInfoStore((s) => s.books);
  // Only global (non-character-owned) books are picker-eligible — linking
  // another character's embedded book from a persona would be surprising.
  const candidateBooks = books.filter((b) => b.ownerCharacterAvatar == null);

  const lorebookImportInputRef = useRef<HTMLInputElement>(null);
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<{ error: boolean; message: string } | null>(null);

  const handleLorebookUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadNotice(null);

    try {
      const json = await file.text();
      const fallback = file.name.replace(/\.json$/i, '') || 'Imported Lorebook';
      const book = importBookJson(json, fallback);
      if (!book) {
        setUploadNotice({ error: true, message: 'Could not parse lorebook JSON.' });
        return;
      }
      // Functional updater — composes against the latest list, so a checkbox
      // toggled while the file was being read isn't clobbered by a stale spread.
      onLinkedBookIdsChange((prev) => (prev.includes(book.id) ? prev : [...prev, book.id]));
      setUploadNotice({ error: false, message: `Linked "${book.name}" (${book.entries.length} entries).` });
    } catch (err) {
      setUploadNotice({
        error: true,
        message: err instanceof Error ? err.message : 'Failed to upload lorebook.',
      });
    }
  };

  return (
    <>
      <input
        ref={lorebookImportInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleLorebookUpload}
      />

      <div>
        <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
          Description Position
        </label>
        <select
          value={descriptionPosition}
          onChange={(e) => onDescriptionPositionChange(e.target.value as PersonaDescriptionPosition)}
          className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          <option value="in_prompt">In system prompt</option>
          <option value="before_char">Before character info</option>
          <option value="after_char">After character info</option>
          <option value="at_depth">At specific depth in chat</option>
        </select>
      </div>

      {descriptionPosition === 'at_depth' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Injection Depth
            </label>
            <input
              type="number"
              min={0}
              max={20}
              value={descriptionDepth}
              onChange={(e) => onDescriptionDepthChange(Number(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Role
            </label>
            <select
              value={descriptionRole}
              onChange={(e) => onDescriptionRoleChange(e.target.value as PersonaDescriptionRole)}
              className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              <option value="system">System</option>
              <option value="user">User</option>
              <option value="assistant">Assistant</option>
            </select>
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--color-text-primary)]">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => onIsDefaultChange(e.target.checked)}
          className="w-4 h-4 accent-[var(--color-primary)]"
        />
        Set as default persona
      </label>

      {/* Persona lorebooks — auto-activated whenever this persona is active */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-[var(--color-text-secondary)]" />
          <h3 className="text-sm font-medium text-[var(--color-text-primary)]">Lorebooks</h3>
          <button
            type="button"
            onClick={() => lorebookImportInputRef.current?.click()}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
          >
            <Upload size={12} />
            Upload Lorebook
          </button>
        </div>

        {uploadNotice && (
          <div
            className={`rounded-md border px-3 py-2 text-xs ${
              uploadNotice.error
                ? 'border-red-500/40 bg-red-500/10 text-[var(--color-text-primary)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
            }`}
            role={uploadNotice.error ? 'alert' : 'status'}
          >
            {uploadNotice.message}
          </div>
        )}

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3">
          {candidateBooks.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)]">
              No global lorebooks yet. Use Upload Lorebook to add one, or create them in Settings → World Info.
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
                        onChange={() =>
                          onLinkedBookIdsChange(
                            checked
                              ? linkedBookIds.filter((id) => id !== book.id)
                              : [...linkedBookIds, book.id]
                          )
                        }
                        className="w-4 h-4 accent-[var(--color-primary)]"
                      />
                      <span className="flex-1 min-w-0 text-sm text-[var(--color-text-primary)] truncate">
                        {book.name}
                      </span>
                      <span className="text-xs text-[var(--color-text-secondary)]">{book.entries.length}</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setEditingBookId(book.id)}
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
                      aria-label={`Edit ${book.name}`}
                      title="Edit lorebook entries"
                    >
                      <Edit2 size={12} />
                      Edit
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
            Linked books are auto-activated whenever this persona is active.
          </p>
        </div>
      </section>

      {editingBookId &&
        (() => {
          const editing = books.find((b) => b.id === editingBookId);
          return editing ? (
            <WorldInfoBookEditor isOpen={true} onClose={() => setEditingBookId(null)} book={editing} />
          ) : null;
        })()}
    </>
  );
}
