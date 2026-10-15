/**
 * Keyboard focus ring for the drawer's plain buttons (D-S13, WCAG 2.4.7). The
 * ring is inset so the drawer's own edge and the scroller's `overflow` never
 * clip it, and `focus-visible` keeps it off mouse clicks.
 */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]';
