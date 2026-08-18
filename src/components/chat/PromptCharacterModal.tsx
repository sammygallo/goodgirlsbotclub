import type { CharacterInfo } from '../../api/client';
import { Modal } from '../ui/Modal';
import { getDefaultAvatarUrl } from '../../utils/emotions';

interface PromptCharacterModalProps {
  isOpen: boolean;
  onClose: () => void;
  characters: CharacterInfo[];
  disabled?: boolean;
  onSelect: (character: CharacterInfo) => void;
}

/**
 * Lets the user force a specific group member to generate their next
 * message, without waiting for the activation strategy to pick them (#412).
 * Mirrors GroupChatControls' per-member force-talk button, just reachable
 * from the input bar's chat-options menu instead of the collapsible panel.
 */
export function PromptCharacterModal({
  isOpen,
  onClose,
  characters,
  disabled,
  onSelect,
}: PromptCharacterModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Prompt a character" size="sm">
      <ul className="space-y-1">
        {characters.map((c) => (
          <li key={c.avatar}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                onSelect(c);
                onClose();
              }}
              className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <img
                src={getDefaultAvatarUrl(c.avatar)}
                alt=""
                className="w-8 h-8 rounded-full object-cover bg-[var(--color-bg-tertiary)] flex-shrink-0"
                onError={(e) => {
                  e.currentTarget.style.visibility = 'hidden';
                }}
              />
              <span className="flex-1 truncate">{c.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
