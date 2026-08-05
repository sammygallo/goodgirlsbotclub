import { BookOpen, Users } from 'lucide-react';
import { useWorldInfoStore } from '../../../stores/worldInfoStore';
import { useChatLoreConfigStore } from '../../../stores/chatLoreConfigStore';
import { Button } from '../../ui';

export interface AttachBookPickerProps {
  chatFile: string;
  /** Book ids already shown somewhere in the panel (inherited or attached) — excluded from the candidate list. */
  alreadyShownBookIds: Set<string>;
  /**
   * The chat's current v2-effective linkedBookIds (persisted config if one
   * exists, else the legacy map synthesized by chatLoreConfigStore's own
   * getEffectiveConfig — see ChatLorePanel's `effectiveConfig`). Needed only
   * by the "Shared with me" section below: a shared book id can't go through
   * setChatLinkedBookIds (see attachShared), so that path writes straight to
   * chatLoreConfigStore and has to know what's already linked to append to.
   */
  chatAttachedBookIds: string[];
  onClose: () => void;
}

// Stable fallback so the zustand selector never returns a fresh array
// reference (fresh `[]` per call destabilizes useSyncExternalStore — React #185).
const EMPTY_IDS: string[] = [];

/**
 * Sub-view (not a stacked modal) for attaching an extra lorebook to this
 * chat — either one of the viewer's own world-scoped books, or a book a
 * group member has shared.
 *
 * Own-book attach reuses the exact same mutator ChatLorebookModal uses
 * today — setChatLinkedBookIds — so it stays byte-for-byte compatible with
 * the pre-v2 "chat-linked books" behavior; it does not reimplement or
 * bypass any of that mutator's legacy-map/v2-config mirroring logic.
 *
 * Shared-book attach can't reuse that same mutator: setChatLinkedBookIds
 * validates every id against the caller's OWN books (get().books) before
 * writing the legacy chatLinkedBookIds map, so a shared book's id would be
 * silently filtered back out. Shared attachments instead go straight into
 * the v2 chatLoreConfigStore config's linkedBookIds, which has no such
 * ownership check — see attachShared.
 */
export function AttachBookPicker({
  chatFile,
  alreadyShownBookIds,
  chatAttachedBookIds,
  onClose,
}: AttachBookPickerProps) {
  const books = useWorldInfoStore((s) => s.books);
  const sharedBooks = useWorldInfoStore((s) => s.sharedBooks);
  const sharedOwnerNameByHandle = useWorldInfoStore((s) => s.sharedOwnerNameByHandle);
  const linkedBookIds = useWorldInfoStore((s) => s.chatLinkedBookIds[chatFile] ?? EMPTY_IDS);
  const setChatLinkedBookIds = useWorldInfoStore((s) => s.setChatLinkedBookIds);
  const updateChatLoreConfig = useChatLoreConfigStore((s) => s.updateConfig);

  // Only non-character-owned, not-already-shown books are eligible — a book
  // already inherited/attached has nothing left for this picker to add.
  const candidates = books.filter(
    (b) => b.ownerCharacterAvatar == null && !alreadyShownBookIds.has(b.id)
  );
  const sharedCandidates = sharedBooks.filter(
    (b) => b.ownerCharacterAvatar == null && !alreadyShownBookIds.has(b.id)
  );

  const attach = (bookId: string) => {
    setChatLinkedBookIds(chatFile, [...linkedBookIds, bookId]);
    onClose();
  };

  const attachShared = (bookId: string) => {
    updateChatLoreConfig(chatFile, {
      linkedBookIds: [...chatAttachedBookIds, bookId],
    });
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
        <ul className="space-y-1 max-h-[40vh] overflow-y-auto">
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

      <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          <Users size={14} className="shrink-0" />
          Shared with me
        </div>

        {sharedCandidates.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)] py-4 text-center">
            No shared lorebooks to attach.
          </p>
        ) : (
          <ul className="space-y-1 max-h-[40vh] overflow-y-auto">
            {sharedCandidates.map((book) => (
              <li key={book.id}>
                <button
                  type="button"
                  onClick={() => attachShared(book.id)}
                  className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-[var(--color-bg-tertiary)] text-left"
                >
                  <span className="flex-1 min-w-0 text-sm text-[var(--color-text-primary)] truncate">
                    {book.name}
                  </span>
                  <span className="text-xs text-[var(--color-text-secondary)] truncate max-w-[9rem]">
                    {sharedOwnerNameByHandle[book.ownerHandle] || book.ownerHandle}
                  </span>
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {book.entries.length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end pt-2 border-t border-[var(--color-border)]">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Back
        </Button>
      </div>
    </div>
  );
}
