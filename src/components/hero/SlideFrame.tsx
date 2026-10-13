import { useState, type ReactNode } from 'react';

interface SlideFrameProps {
  image: string;
  /** '' = decorative: the image is hidden from assistive technology. */
  imageAlt: string;
  /** D-H8: the first two slides load eagerly, the rest lazily. */
  eager: boolean;
  /** Shown 64px large if the image fails. */
  initial: string;
  children: ReactNode;
}

/**
 * The one frame every hero slide is drawn on (D-H7, D-H8), whatever it
 * carries: full-bleed art, a scrim, and a text block laid over the scrim.
 *
 * - >= 640px: the side scrim, text left-aligned and vertically centred. The
 *   text block is capped at min(620px, 55% of the width): D-H7 allows 620px,
 *   but D-H20's contrast guarantee only holds where scrim alpha is >= .55,
 *   which is the first 55% of --scrim-hero-side. Below ~1127px a 620px block
 *   would run past it.
 * - < 640px: the bottom scrim, text stacked at the bottom.
 *   The scrim layer is at least 28.75rem tall (anchored to the bottom, clipped by
 *   the hero), so on a short viewport the >= .55 band — 45% of the layer —
 *   still covers the text block rather than shrinking with the hero.
 *
 * The art is unblurred and `object-fit: cover`, anchored to the top because
 * faces usually are.
 */
export function SlideFrame({ image, imageAlt, eager, initial, children }: SlideFrameProps) {
  // Keyed by src so a different image gets a fresh chance after a failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === image;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--color-bg-tertiary)]">
      {failed ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex items-start justify-center pt-12 sm:items-center sm:justify-end sm:pt-0 sm:pr-[14%]"
        >
          <span className="text-[64px] font-semibold leading-none text-[var(--color-text-primary)]">{initial}</span>
        </div>
      ) : (
        <img
          src={image}
          alt={imageAlt}
          aria-hidden={imageAlt === '' ? true : undefined}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailedSrc(image)}
          className="absolute inset-0 h-full w-full object-cover object-[50%_0%]"
        />
      )}

      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-[max(100%,28.75rem)] sm:hidden"
        style={{ backgroundImage: 'var(--scrim-hero)' }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 hidden sm:block"
        style={{ backgroundImage: 'var(--scrim-hero-side)' }}
      />

      <div className="absolute inset-0 flex items-end px-4 pb-4 pt-14 sm:items-center sm:px-8 sm:py-6 lg:px-12">
        <div className="flex w-full min-w-0 flex-col gap-2 text-[color:var(--on-scrim-text)] sm:max-w-[min(620px,55%)] sm:gap-3">
          {children}
        </div>
      </div>
    </div>
  );
}

/** The kicker pill above a title (frames H1, H2). Hidden below 640px to keep the stacked block short. */
export function SlideKicker({ children }: { children: ReactNode }) {
  return (
    <span className="hidden self-start rounded-full border border-white/40 bg-black/30 px-3 py-1 text-xs font-medium uppercase tracking-wider text-[color:var(--on-scrim-text)] sm:inline-block">
      {children}
    </span>
  );
}

const CTA_BASE =
  'focus-ring-contrast inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors';

/** D-H20: the primary CTA is a solid white button with near-black text (18.9:1). */
export const PRIMARY_CTA = `${CTA_BASE} bg-white text-[#111111] hover:bg-[#e5e5e5]`;

/** D-H20: the secondary CTA is transparent with a 1px white border. */
export const SECONDARY_CTA = `${CTA_BASE} border border-white/80 bg-transparent text-[color:var(--on-scrim-text)] hover:bg-white/12`;
