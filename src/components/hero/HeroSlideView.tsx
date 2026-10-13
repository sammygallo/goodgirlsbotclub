import type { CharacterInfo } from '../../api/client';
import type { HeroSlide } from '../../utils/hero/heroModel';
import { CharacterSlide } from './CharacterSlide';
import { FeatureSlide } from './FeatureSlide';

export interface SlideActions {
  onChat: (avatar: string) => void;
  onAbout: (character: CharacterInfo) => void;
  onFeatureCta: (slide: Extract<HeroSlide, { type: 'feature' }>) => void;
}

interface HeroSlideViewProps extends SlideActions {
  slide: HeroSlide;
  eager: boolean;
}

/** One slide, whichever kind: the carousel and the static single-slide hero both draw through this. */
export function HeroSlideView({ slide, eager, onChat, onAbout, onFeatureCta }: HeroSlideViewProps) {
  if (slide.type === 'character') {
    return <CharacterSlide character={slide.character} eager={eager} onChat={onChat} onAbout={onAbout} />;
  }
  return <FeatureSlide config={slide.config} eager={eager} onCta={() => onFeatureCta(slide)} />;
}
