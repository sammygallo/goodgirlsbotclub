/**
 * ChatPickerModal — two-step picker used by the World Info page to choose a
 * saved chat to generate a lorebook from: character first, then one of that
 * character's chat files. Emits the selection; the parent loads the messages.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, MessageSquare } from 'lucide-react';
import { Modal } from '../ui';
import { api } from '../../api/client';
import { useCharacterStore } from '../../stores/characterStore';

export interface ChatSelection {
  avatar: string;
  characterName: string;
  fileName: string;
}

interface ChatFileMeta {
  file_name: string;
  message_count: number;
  last_mes: string;
}

interface ChatPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (selection: ChatSelection) => void;
}

export function ChatPickerModal({ isOpen, onClose, onSelect }: ChatPickerModalProps) {
  const characters = useCharacterStore((s) => s.characters);

  const [picked, setPicked] = useState<{ avatar: string; name: string } | null>(null);
  const [chats, setChats] = useState<ChatFileMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the character list whenever the modal (re)opens.
  useEffect(() => {
    if (isOpen) {
      setPicked(null);
      setChats([]);
      setError(null);
    }
  }, [isOpen]);

  const handlePickCharacter = async (avatar: string, name: string) => {
    setPicked({ avatar, name });
    setLoading(true);
    setError(null);
    try {
      const list = await api.getChats(avatar);
      setChats(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load chats.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={picked ? `Chats with ${picked.name}` : 'Choose a character'}
      size="md"
    >
      {picked ? (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setPicked(null)}
            className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <ArrowLeft size={16} />
            Back to characters
          </button>

          {loading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-[var(--color-text-secondary)]">
              <Loader2 size={16} className="animate-spin" />
              Loading chats…
            </div>
          ) : error ? (
            <p className="text-sm text-red-400 py-4">{error}</p>
          ) : chats.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)] py-6 text-center">
              No saved chats for this character.
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-[50vh] overflow-y-auto">
              {chats.map((chat) => (
                <li key={chat.file_name}>
                  <button
                    type="button"
                    onClick={() =>
                      onSelect({
                        avatar: picked.avatar,
                        characterName: picked.name,
                        fileName: chat.file_name,
                      })
                    }
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    <MessageSquare
                      size={16}
                      className="flex-shrink-0 text-[var(--color-text-secondary)]"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate">
                        {chat.file_name.replace(/\.jsonl$/i, '')}
                      </span>
                      <span className="block text-xs text-[var(--color-text-secondary)] truncate">
                        {chat.message_count} message
                        {chat.message_count === 1 ? '' : 's'}
                        {chat.last_mes ? ` · ${chat.last_mes}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : characters.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)] py-6 text-center">
          You don't have any characters yet.
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {characters.map((c) => (
            <li key={c.avatar}>
              <button
                type="button"
                onClick={() => handlePickCharacter(c.avatar, c.name)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                <img
                  src={`/api/avatar/${c.avatar}`}
                  alt={c.name}
                  className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
                <span className="flex-1 truncate text-sm">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
