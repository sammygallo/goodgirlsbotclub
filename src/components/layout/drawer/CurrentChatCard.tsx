import { useEffect, useId, useRef, useState } from 'react';
import { Film } from 'lucide-react';
import { useCharacterStore } from '../../../stores/characterStore';
import { useChatStore, type ChatMessage } from '../../../stores/chatStore';
import type { CharacterInfo } from '../../../api/client';
import { useCharacterSprites } from '../../../hooks/useCharacterSprites';
import { useLivePortraitDiscovery } from '../../../hooks/useLivePortraitDiscovery';
import { haptic } from '../../../utils/haptics';
import { Avatar } from '../../ui';
import { MotionModePicker } from '../../character/MotionModePicker';
import { FOCUS_RING } from './drawerStyles';

const thumbnailUrl = (avatar: string) => `/blobs/character/${encodeURIComponent(avatar)}`;

/** The newest AI message that names who wrote it, or undefined. */
function lastSpeakingMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.isUser && !m.isSystem && m.characterAvatar) return m;
  }
  return undefined;
}

interface CurrentChatCardProps {
  /** Opens the character's details (CharacterPreviewModal). */
  onAbout: (character: CharacterInfo) => void;
}

/**
 * The drawer's current-chat card (D-S5): nothing while the hero is showing, a
 * compact card for a solo chat, and the roster with its last speaker for a group
 * chat. A group chat wins when both a character and group mode are set.
 */
export function CurrentChatCard({ onAbout }: CurrentChatCardProps) {
  const selectedCharacter = useCharacterStore((s) => s.selectedCharacter);
  const isGroupChatMode = useCharacterStore((s) => s.isGroupChatMode);

  if (isGroupChatMode) return <GroupCard />;
  if (selectedCharacter) return <SingleCard character={selectedCharacter} onAbout={onAbout} />;
  return null;
}

function SingleCard({ character, onAbout }: { character: CharacterInfo; onAbout: (c: CharacterInfo) => void }) {
  const { availableEmotions } = useCharacterSprites(character.avatar);
  const { hasClips } = useLivePortraitDiscovery(character.avatar);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [pickerOpen]);

  // Escape closes the popover and nothing behind it: the drawer's own Escape
  // handler listens on the document, so the event must stop before it gets there.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || !pickerOpen) return;
    e.stopPropagation();
    setPickerOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <section aria-label="Current chat" className="flex-shrink-0 border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-3">
        <Avatar src={thumbnailUrl(character.avatar)} alt={character.name} size="md" className="flex-shrink-0" />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text-primary)]">
          {character.name}
        </p>
        <button
          type="button"
          onClick={() => {
            haptic();
            onAbout(character);
          }}
          aria-label={`About ${character.name}`}
          className={`h-8 flex-shrink-0 rounded-lg px-3 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
        >
          About
        </button>
        <div ref={wrapperRef} className="relative flex-shrink-0" onKeyDown={handleKeyDown}>
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            aria-label="Avatar motion"
            aria-expanded={pickerOpen}
            aria-controls={pickerId}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
          >
            <Film size={16} />
          </button>
          <div
            id={pickerId}
            hidden={!pickerOpen}
            className="absolute right-0 top-full z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 shadow-xl"
          >
            <MotionModePicker
              avatar={character.avatar}
              hasLivePortraitClips={hasClips}
              hasExpressionSprites={availableEmotions.length > 0}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function GroupCard() {
  const members = useCharacterStore((s) => s.groupChatCharacters);
  // Primitives out of the selectors, so a streamed token (which replaces the
  // messages array) does not re-render the card unless the speaker changed.
  const recordTitle = useChatStore((s) => s.groupChats.find((g) => g.fileName === s.currentChatFile)?.title ?? null);
  const lastSpeakerAvatar = useChatStore((s) => lastSpeakingMessage(s.messages)?.characterAvatar ?? null);
  const lastSpeakerMessageName = useChatStore((s) => lastSpeakingMessage(s.messages)?.name ?? null);

  const title = recordTitle?.trim() || members.map((m) => m.name).join(', ');

  // Keyed by avatar, never by name: two members of a roster can share a name.
  // With no speaker yet the card falls back to roster slot 0.
  const lastSpeaker = lastSpeakerAvatar
    ? {
        avatar: lastSpeakerAvatar,
        name: members.find((m) => m.avatar === lastSpeakerAvatar)?.name ?? lastSpeakerMessageName ?? '',
      }
    : members[0]
      ? { avatar: members[0].avatar, name: members[0].name }
      : null;

  return (
    <section aria-label="Current chat" className="flex-shrink-0 border-b border-[var(--color-border)] px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">Group chat</p>
      {title && <p className="mt-0.5 truncate text-sm font-semibold text-[var(--color-text-primary)]">{title}</p>}
      {members.length > 0 && (
        // Roster order, always: the ring and the text below carry who spoke last,
        // so the thumbnails never shuffle under a user's pointer or focus.
        <ul aria-label="Members" className="mt-2 flex flex-wrap items-center gap-2">
          {members.map((member) => {
            const isLast = lastSpeaker?.avatar === member.avatar;
            return (
              <li
                key={member.avatar}
                aria-current={isLast ? 'true' : undefined}
                className={`rounded-full ${
                  isLast
                    ? 'ring-2 ring-[var(--color-primary)] ring-offset-2 ring-offset-[var(--color-bg-secondary)]'
                    : ''
                }`}
              >
                <img src={thumbnailUrl(member.avatar)} alt={member.name} className="h-7 w-7 rounded-full object-cover" />
              </li>
            );
          })}
        </ul>
      )}
      {lastSpeaker && (
        <p className="mt-2 truncate text-xs text-[var(--color-text-secondary)]">{`Last to speak: ${lastSpeaker.name}`}</p>
      )}
    </section>
  );
}
