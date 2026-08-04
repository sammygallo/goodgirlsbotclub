import { BookOpen } from 'lucide-react';
import { useWorldInfoStore } from '../../../stores/worldInfoStore';
import { Button } from '../../ui';

export interface AttachBookPickerProps {
  chatFile: string;
  /** Book ids already shown somewhere in the panel (inherited or attached) — excluded from the candidate list. */
  alreadyShownBookIds: Set<string>;
  onClose: () => void;
}

// Stable fallback so the zustand selector never returns a fresh array
// reference (fresh `[]` per call destabilizes useSyncExternalStore — React #185).
const EMPTY_IDS: string[] = [];

/**
 * Sub-view (not a stacked modal) for attaching an extra world-scoped
 * lorebook to this chat. Reuses the exact same mutator ChatLorebookModal
 * uses today — setChatLinkedBookIds — so this stays byte-for-byte
 * compatible with the pre-v2 "chat-linked books" behavior; it does not
 * reimplement or bypass any of that mutator's legacy-map/v2-config mirroring
 * logic.
 */
export function AttachBookPicker({ chatFile, alreadyShownBookIds, onClose }: AttachBookPickerProps) {
  const books = useWorldInfoStore((s) => s.books);
  const linkedBookIds = useWorldInfoStore((s) => s.chatLinkedBookIds[chatFile] ?? EMPTY_IDS);
  const setChatLinkedBookIds = useWorldInfoStore((s) => s.setChatLinkedBookIds);

  // Only non-character-owned, not-already-shown books are eligible — a book
  // already inherited/attached has nothing left for this picker to add.
  const candidates = books.filter(
    (b) => b.ownerCharacterAvatar == null && !alreadyShownBookIds.has(b.id)
  );

  const attach = (bookId: string) => {
    setChatLinkedBookIds(chatFile, [...linkedBookIds, bookId]);
    onClose();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
        <BookOpen size={14} className="shrink-0 mt-0.5" />
        <p>
          Pick a lorebook to auto-activate for this chat only — useful for
          chat-specific notes, running plot state, or memories.
        </p>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)] py-4 text-center">
          No other lorebooks to attach.
        </p>
      ) : (
        <ul className="space-y-1 max-h-[60vh] overflow-y-auto">
          {candidates.map((book) => (
            <li key={book.id}>
              <button
                type="button"
                onClick={() => attach(book.id)}
                className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--color-bg-tertiary)] text-left"
              >
                <span className="flex-1 min-w-0 text-sm text-[var(--color-text-primary)] truncate">
                  {book.name}
                </span>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {book.entries.length}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end pt-2 border-t border-[var(--color-border)]">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Back
        </Button>
      </div>
    </div>
  );
}
