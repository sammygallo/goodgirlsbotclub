/**
 * Persisted height of the mobile chat portrait strip, as a fraction of the
 * viewport (e.g. 0.30 = 30vh). Only applied on mobile portrait orientation
 * outside VN mode; desktop and VN paths are unaffected.
 */

const KEY = 'stm:mobile-portrait-height';

export const MIN_PORTRAIT_HEIGHT = 0.20;
export const MAX_PORTRAIT_HEIGHT = 0.50;
export const DEFAULT_PORTRAIT_HEIGHT = 0.30;
export const PORTRAIT_HEIGHT_STEP = 0.02;

export function clampPortraitHeight(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PORTRAIT_HEIGHT;
  return Math.max(MIN_PORTRAIT_HEIGHT, Math.min(MAX_PORTRAIT_HEIGHT, v));
}

export function getMobilePortraitHeight(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PORTRAIT_HEIGHT;
    return clampPortraitHeight(parseFloat(raw));
  } catch {
    return DEFAULT_PORTRAIT_HEIGHT;
  }
}

export function setMobilePortraitHeight(v: number): void {
  try {
    localStorage.setItem(KEY, String(clampPortraitHeight(v)));
  } catch {
    /* ignore */
  }
}

const COLLAPSED_KEY = 'stm:mobile-portrait-collapsed';

export function getMobilePortraitCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMobilePortraitCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}
