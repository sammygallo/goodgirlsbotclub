import type { FeatureSlideConfig } from '../../utils/hero/featureSlides';
import { PRIMARY_CTA, SlideFrame, SlideKicker } from './SlideFrame';

interface FeatureSlideProps {
  config: FeatureSlideConfig;
  eager: boolean;
  onCta: () => void;
}

/**
 * A product announcement or feature slide (D-H6), drawn from first-party config
 * on the same frame as a character slide. Title and body are plain TEXT — the
 * config may not carry markup — and only the CTA's modal body goes through
 * Markdown (FeatureInfoModal).
 */
export function FeatureSlide({ config, eager, onCta }: FeatureSlideProps) {
  return (
    <SlideFrame
      image={config.image}
      imageAlt={config.imageAlt}
      eager={eager}
      initial={config.title.trim().charAt(0).toUpperCase()}
    >
      <SlideKicker>Feature</SlideKicker>
      <h3 className="line-clamp-2 text-xl font-bold sm:text-2xl">{config.title}</h3>
      <p className="line-clamp-3 text-base sm:line-clamp-2">{config.body}</p>
      <div className="mt-1 flex flex-wrap gap-3 sm:mt-2">
        <button type="button" className={PRIMARY_CTA} onClick={onCta}>
          {config.cta.label}
        </button>
      </div>
    </SlideFrame>
  );
}
