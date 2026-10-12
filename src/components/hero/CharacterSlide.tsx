import type { CharacterInfo } from '../../api/client';
import { firstSentence } from '../../utils/characterRichText';
import { getDefaultAvatarUrl } from '../../utils/emotions';
import { PRIMARY_CTA, SECONDARY_CTA, SlideFrame, SlideKicker } from './SlideFrame';

interface CharacterSlideProps {
  character: CharacterInfo;
  eager: boolean;
  onChat: (avatar: string) => void;
  onAbout: (character: CharacterInfo) => void;
}

/**
 * A featured character (D-H5): art, name, creator, a one-sentence blurb, and
 * Chat / About.
 *
 * The blurb is the first sentence of `creator_notes` — the author-written,
 * user-facing text — rendered as TEXT. Never `description`: that field is
 * model-facing prompt text, and CharacterPreviewModal documents the same rule.
 * creator_notes may carry HTML, which firstSentence flattens to plain text
 * before it reaches React, so no markup from a card is ever interpreted here.
 */
export function CharacterSlide({ character, eager, onChat, onAbout }: CharacterSlideProps) {
  const creator = character.creator?.trim() || character.data?.creator?.trim() || '';
  const blurb = firstSentence(character.creator_notes?.trim() || character.data?.creator_notes?.trim());

  return (
    <SlideFrame
      image={getDefaultAvatarUrl(character.avatar)}
      imageAlt=""
      eager={eager}
      initial={character.name.trim().charAt(0).toUpperCase()}
    >
      <SlideKicker>Featured</SlideKicker>
      <h3 className="truncate text-xl font-bold sm:text-2xl">{character.name}</h3>
      {creator && <p className="truncate text-sm">by {creator}</p>}
      {blurb && <p className="line-clamp-2 text-base">{blurb}</p>}
      <div className="mt-1 flex flex-wrap gap-3 sm:mt-2">
        <button
          type="button"
          className={PRIMARY_CTA}
          aria-label={`Chat with ${character.name}`}
          onClick={() => onChat(character.avatar)}
        >
          Chat
        </button>
        <button
          type="button"
          className={SECONDARY_CTA}
          aria-label={`About ${character.name}`}
          onClick={() => onAbout(character)}
        >
          About
        </button>
      </div>
    </SlideFrame>
  );
}
