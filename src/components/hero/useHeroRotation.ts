import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

/** D-H12: how long each slide stays up. */
export const SLIDE_MS = 6000;

interface UseHeroRotationOptions {
  count: number;
  /**
   * A modal opened from the hero, or the Settings / Guides / Works panel, is
   * open (D-H14). Rotation PAUSES under it and resumes when it closes.
   */
  paused: boolean;
}

/**
 * The hero carousel's clock and its pause state machine (D-H12, D-H14), kept
 * apart from the markup so the rules can be read in one place.
 *
 * Two different things stop the clock, and they must not be confused:
 *
 *   STOPPED  is the user's, and sticky. Keyboard focus entering the carousel
 *            stops it, and so does the rotation button; only that button (or
 *            nothing) starts it again. WCAG 2.2.2: someone tabbing through
 *            must not have the slide change under their cursor.
 *   PAUSED   is the environment's, and lifts on its own: the mouse is over the
 *            carousel, the tab is hidden, a modal or right panel is open.
 *
 * Reduced motion starts the carousel STOPPED (it never auto-advances unless
 * the user presses play); that is JS behaviour CSS cannot provide (D-G6).
 */
export function useHeroRotation({ count, paused }: UseHeroRotationOptions) {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  // Bumped by every manual move so choosing the slide you are already on still
  // restarts the 6 s (the effect depends on it).
  const [cycle, setCycle] = useState(0);
  const [stopped, setStopped] = useState(reducedMotion);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  // The preference can change while the app is open; reduce -> stop. The other
  // direction does not auto-start: starting is always the user's call.
  useEffect(() => {
    if (reducedMotion) setStopped(true);
  }, [reducedMotion]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // What did the user last touch: a pointer or a key? A pointer click focuses
  // a button too, and that must not read as "keyboard focus entered" or one
  // click on Next would stop the carousel for good (contradicting D-H12's
  // timer reset). The listeners are on the DOCUMENT, not the carousel: a Tab
  // arriving from outside is a keydown the carousel never sees. Unknown (focus
  // placed by a script or an assistive technology) counts as keyboard.
  const lastInput = useRef<'pointer' | 'key' | null>(null);
  useEffect(() => {
    const onPointer = () => {
      lastInput.current = 'pointer';
    };
    const onKey = () => {
      lastInput.current = 'key';
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const safeIndex = count > 0 ? Math.min(index, count - 1) : 0;
  const rotating = count > 1 && !stopped && !hovered && !hidden && !paused;

  useEffect(() => {
    if (!rotating) return;
    const id = setTimeout(() => setIndex((safeIndex + 1) % count), SLIDE_MS);
    return () => clearTimeout(id);
  }, [rotating, safeIndex, cycle, count]);

  const goTo = useCallback(
    (target: number) => {
      if (count < 1) return;
      setIndex(((target % count) + count) % count);
      setCycle((c) => c + 1);
    },
    [count],
  );
  const next = useCallback(() => goTo(safeIndex + 1), [goTo, safeIndex]);
  const prev = useCallback(() => goTo(safeIndex - 1), [goTo, safeIndex]);
  const toggleStopped = useCallback(() => setStopped((s) => !s), []);

  const regionHandlers = {
    // Mouse only. Touch fires pointerenter on touch-down and leaves "hovered"
    // stuck after the finger lifts (compat mouse events), which would pause a
    // phone's carousel forever after one tap.
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === 'mouse') setHovered(true);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === 'mouse') setHovered(false);
    },
    // Focus entering the carousel by anything but a pointer stops it (D-H14).
    onFocus: () => {
      if (lastInput.current !== 'pointer') setStopped(true);
    },
  };

  return { index: safeIndex, rotating, stopped, goTo, next, prev, toggleStopped, regionHandlers };
}
