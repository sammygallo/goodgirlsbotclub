import { useRef } from 'react';
import type { CharacterInfo } from '../../../api/client';

interface GroupThumbnailStripProps {
  /** The roster, in roster order — never re-sorted by who spoke. */
  members: readonly CharacterInfo[];
  focusedAvatar: string | null;
  onPin: (avatar: string) => void;
}

const thumbnailUrl = (avatar: string) => `/blobs/character/${encodeURIComponent(avatar)}`;

/**
 * Group members along the bottom of the panel (D-C7, D-C12): 48px circular
 * buttons in stable roster order; the focused member has a 2px white ring and
 * `aria-pressed`. One Tab stop (the pressed button, else the first) enters the
 * strip; ArrowLeft/ArrowRight and Home/End move between members; Enter or
 * Space pins one. The strip scrolls sideways when it overflows.
 */
export function GroupThumbnailStrip({ members, focusedAvatar, onPin }: GroupThumbnailStripProps) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pressedIndex = members.findIndex((m) => m.avatar === focusedAvatar);
  const tabStop = pressedIndex >= 0 ? pressedIndex : 0;

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    const last = members.length - 1;
    let next: number;
    switch (e.key) {
      case 'ArrowRight': next = index === last ? 0 : index + 1; break;
      case 'ArrowLeft': next = index === 0 ? last : index - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = last; break;
      default: return;
    }
    e.preventDefault();
    buttonRefs.current[next]?.focus();
  };

  return (
    <ul aria-label="Group members" className="flex gap-2 overflow-x-auto p-1">
      {members.map((member, index) => {
        const pressed = member.avatar === focusedAvatar;
        return (
          <li key={member.avatar} className="flex-none">
            <button
              ref={(el) => {
                buttonRefs.current[index] = el;
              }}
              type="button"
              aria-label={`Show ${member.name}`}
              aria-pressed={pressed}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => onPin(member.avatar)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`block h-12 w-12 overflow-hidden rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                pressed ? 'ring-2 ring-white' : 'opacity-80 hover:opacity-100'
              }`}
            >
              {/* Decorative: the button's label names the member. */}
              <img src={thumbnailUrl(member.avatar)} alt="" draggable={false} className="h-full w-full object-cover" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
