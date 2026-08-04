import { useState } from 'react';
import { Globe, MessageSquare } from 'lucide-react';
import { Avatar, Modal } from '../ui';
import type { BookAttachments } from '../../utils/bookAttachments';

// ---------------------------------------------------------------------------
// Lorebook v2 — book attachment chips (Phase 3)
// ---------------------------------------------------------------------------
//
// Small read-only summary row for a single book's BookAttachments: renders
// only the chips that apply (never an empty/placeholder chip for something
// the book isn't attached to). Chip visual language follows this app's
// existing tag/pill convention (TagInput.tsx, LibraryFilterBar.tsx):
// `bg-[var(--color-primary)]/20 text-[var(--color-primary)]` tint,
// `rounded-full`, `text-xs`.

const chipBase =
  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs whitespace-nowrap';
const chipTinted = `${chipBase} bg-[var(--color-primary)]/20 text-[var(--color-primary)]`;
const chipNeutral = `${chipBase} bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]`;

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export interface BookAttachmentChipsProps {
  attachments: BookAttachments;
  resolveCharacter: (avatar: string) => { avatar: string; name: string } | null;
  onCharacterClick?: (avatar: string) => void;
}

export function BookAttachmentChips({
  attachments,
  resolveCharacter,
  onCharacterClick,
}: BookAttachmentChipsProps) {
  const [chatListOpen, setChatListOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {attachments.globallyActive && (
        <span className={chipTinted}>
          <Globe size={11} />
          Global
        </span>
      )}

      {attachments.linkedByCharacterAvatars.map((avatar) => {
        const character = resolveCharacter(avatar);
        if (!character) {
          // Character not loaded/found client-side — show the raw filename
          // as plain, non-clickable text rather than a broken link.
          return (
            <span key={avatar} className={chipNeutral} title={avatar}>
              {avatar}
            </span>
          );
        }
        const content = (
          <>
            <Avatar src={`/api/avatar/${character.avatar}`} size="sm" alt={character.name} />
            {character.name}
          </>
        );
        return onCharacterClick ? (
          <button
            key={avatar}
            type="button"
            onClick={() => onCharacterClick(avatar)}
            className={`${chipNeutral} hover:bg-[var(--color-primary)]/20 hover:text-[var(--color-primary)] transition-colors`}
          >
            {content}
          </button>
        ) : (
          <span key={avatar} className={chipNeutral}>
            {content}
          </span>
        );
      })}

      {attachments.linkedByPersonas.length > 0 && (
        <span
          className={chipNeutral}
          title={attachments.linkedByPersonas.map((p) => p.name).join(', ')}
        >
          {pluralize(attachments.linkedByPersonas.length, 'persona')}
        </span>
      )}

      {attachments.chatFiles.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setChatListOpen(true)}
            className={`${chipNeutral} hover:bg-[var(--color-primary)]/20 hover:text-[var(--color-primary)] transition-colors`}
          >
            <MessageSquare size={11} />
            {pluralize(attachments.chatFiles.length, 'chat')}
          </button>

          <Modal
            isOpen={chatListOpen}
            onClose={() => setChatListOpen(false)}
            title="Linked chats"
            size="sm"
          >
            <ul className="space-y-1">
              {attachments.chatFiles.map((chatFile) => (
                // Purely informational — chat files aren't mapped to a
                // character/avatar client-side (BookAttachments only carries
                // the raw file name), so a per-row deep-link into that chat
                // isn't implemented yet. Intentional scope for this step,
                // not a missing feature.
                <li
                  key={chatFile}
                  className="px-2 py-1.5 rounded-md text-sm text-[var(--color-text-primary)] bg-[var(--color-bg-tertiary)]"
                >
                  {chatFile.replace(/\.jsonl$/i, '')}
                </li>
              ))}
            </ul>
          </Modal>
        </>
      )}
    </div>
  );
}
