import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return hasMatchMedia() && window.matchMedia(QUERY).matches;
}

/**
 * Whether the user asked the OS for reduced motion (D-G6), kept live: toggling
 * the setting while the app is open re-renders consumers.
 *
 * This is the hook for behaviour that CSS cannot express — the hero's
 * auto-rotation, which has to START stopped rather than merely fade for 0 ms,
 * and programmatic scrolling. Pure presentation should use Tailwind's
 * `motion-reduce:` variants instead.
 *
 * Reports false where `matchMedia` does not exist (jsdom, very old browsers):
 * motion is the default and reduction the opt-in.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
