import { useRef, type KeyboardEvent, type ReactNode, type TouchEvent } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { EDGE_ZONE, SWIPE_THRESHOLD } from '../../hooks/useSwipeSidebar';
import { slideTitle, type HeroSlide } from '../../utils/hero/heroModel';
import { HeroSlideView, type SlideActions } from './HeroSlideView';
import { useHeroRotation } from './useHeroRotation';

/**
 * D-H2: the hero's height, clamped so a short landscape phone still leaves room
 * for the rows. `shrink-0` matters: HeroPage is a scrolling flex column, and an
 * overflow-hidden flex item has a minimum height of zero, so without it the
 * rows below would squash the hero instead of scrolling past it.
 */
export const HERO_HEIGHT_CLASS = 'shrink-0 h-[clamp(320px,58dvh,460px)] sm:h-[clamp(300px,45dvh,440px)]';

interface HeroCarouselProps extends SlideActions {
  slides: HeroSlide[];
  /** A hero-opened modal or a right-hand panel is open: rotation pauses (D-H14). */
  paused: boolean;
}

const CONTROL =
  'focus-ring-contrast flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70';

/**
 * The hero carousel: the WAI-ARIA APG "basic" carousel (D-H17), cross-fading
 * slides (D-H13) on a 6 s clock (D-H12) with the stop/pause rules of D-H14.
 *
 * Source order is the focus order (D-H15): rotation button, Previous, Next,
 * the slide indicators, and only then the slides — whose CTAs are reachable for
 * the visible slide alone, because every other slide is `inert`. The controls
 * are painted bottom-right (top-right on a phone) by CSS; DOM order is what a
 * keyboard sees.
 *
 * Only built for two or more slides. One slide is drawn statically by
 * HeroPage (D-H10), with none of this.
 */
export function HeroCarousel({ slides, paused, onChat, onAbout, onFeatureCta }: HeroCarouselProps) {
  const count = slides.length;
  const { index, rotating, stopped, goTo, next, prev, toggleStopped, regionHandlers } = useHeroRotation({
    count,
    paused,
  });

  const indicatorRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // D-H16: arrows move between slides from the controls only, never from slide
  // content, so a person arrowing through text or a field is not hijacked.
  const arrowKeys = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    }
  };

  const indicatorKeys = (e: KeyboardEvent, i: number) => {
    let target: number | null = null;
    if (e.key === 'ArrowLeft') target = i - 1;
    else if (e.key === 'ArrowRight') target = i + 1;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = count - 1;
    if (target === null) return;
    e.preventDefault();
    const wrapped = ((target % count) + count) % count;
    goTo(wrapped);
    // Focus follows the active indicator; it is already in the DOM.
    indicatorRefs.current[wrapped]?.focus();
  };

  // D-H16a. A touch that starts inside the left edge zone belongs to the
  // drawer's edge-swipe (useSwipeSidebar uses the same constants) and is not
  // ours. Horizontal intent only: a vertical scroll must not flip slides.
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t && t.clientX >= EDGE_ZONE ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next();
      else prev();
    }
  };

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Featured characters and updates"
      className={`relative overflow-hidden bg-black ${HERO_HEIGHT_CLASS}`}
      {...regionHandlers}
    >
      {/* Bottom-right >= 640px, top-right below, so they never sit on the text. */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5 sm:bottom-4 sm:right-6 sm:top-auto">
        <button
          type="button"
          className={CONTROL}
          aria-label={stopped ? 'Start slide rotation' : 'Stop slide rotation'}
          onClick={toggleStopped}
        >
          {stopped ? <Play size={18} aria-hidden="true" /> : <Pause size={18} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={CONTROL}
          aria-label="Previous slide"
          aria-controls="hero-slides"
          onClick={prev}
          onKeyDown={arrowKeys}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={CONTROL}
          aria-label="Next slide"
          aria-controls="hero-slides"
          onClick={next}
          onKeyDown={arrowKeys}
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
        {/* A dark capsule behind the dots: white dots floating on a white or sky-bright
            piece of art would vanish, and a control has to hold 3:1 over any artwork
            (1.4.11). Worst case it composites to #666: the active dot is 5.7:1, the
            inactive one 3.2:1. */}
        <div className="flex items-center rounded-full bg-black/60 px-1.5">
          {slides.map((slide, i) => (
            <button
              key={slide.key}
              ref={(el) => {
                indicatorRefs.current[i] = el;
              }}
              type="button"
              aria-label={`Go to slide ${i + 1}: ${slideTitle(slide)}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => goTo(i)}
              onKeyDown={(e) => indicatorKeys(e, i)}
              className="focus-ring-contrast flex h-6 w-6 items-center justify-center rounded-full"
            >
              {/* 8px dot in a 24x24 target; the active one stretches to the full 24px (D-H15). */}
              <span
                aria-hidden="true"
                className={`block h-2 rounded-full transition-all duration-300 motion-reduce:transition-none ${
                  i === index ? 'w-6 bg-white' : 'w-2 bg-white/60'
                }`}
              />
            </button>
          ))}
        </div>
      </div>

      <div
        id="hero-slides"
        aria-live={rotating ? 'off' : 'polite'}
        className="absolute inset-0 touch-pan-y"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => {
          touchStart.current = null;
        }}
      >
        {slides.map((slide, i): ReactNode => {
          const active = i === index;
          return (
            <div
              key={slide.key}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}: ${slideTitle(slide)}`}
              // Inert, not merely aria-hidden: a hidden slide's CTAs must be
              // neither focusable nor announced (D-H17).
              inert={!active}
              className={`absolute inset-0 transition-opacity duration-300 ease-out motion-reduce:transition-none ${
                active ? 'z-10 opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <HeroSlideView
                slide={slide}
                // D-H8: the first two slides load eagerly, the rest lazily.
                eager={i < 2}
                onChat={onChat}
                onAbout={onAbout}
                onFeatureCta={onFeatureCta}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
