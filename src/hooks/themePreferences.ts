/**
 * Theme system — light/dark/auto mode with accent color presets.
 *
 * Theme = mode (light | dark | auto) + preset (purple | blue | green | red | amber).
 * Each combination maps to 8 CSS variable values applied to <html>.
 *
 * `applyTheme()` must be called synchronously before React renders
 * (in main.tsx) to avoid a flash of wrong colors.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ThemePreset = 'purple' | 'blue' | 'green' | 'red' | 'amber' | 'cyberpunk';

/** Active preset — either a built-in name or `custom:<id>` for user-created themes. */
export type ActivePreset = ThemePreset | `custom:${string}`;

export interface ThemeColors {
  primary: string;
  primaryHover: string;
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  textBold: string;
  textItalic: string;
  textQuote: string;
  textAction: string;
  textThought: string;
  textDialogue: string;
}

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

const DARK_THEMES: Record<ThemePreset, ThemeColors> = {
  purple: {
    primary: '#8b5cf6', primaryHover: '#7c3aed',
    bgPrimary: '#0f0f0f', bgSecondary: '#1a1a1a', bgTertiary: '#262626',
    textPrimary: '#ffffff', textSecondary: '#a1a1aa', border: '#3f3f46',
    textBold: '#ffffff', textItalic: '#ffffff', textQuote: '#a1a1aa',
    textAction: '#fbbf24', textThought: '#a78bfa', textDialogue: '#ffffff',
  },
  blue: {
    primary: '#3b82f6', primaryHover: '#2563eb',
    bgPrimary: '#0f0f0f', bgSecondary: '#1a1a1a', bgTertiary: '#262626',
    textPrimary: '#ffffff', textSecondary: '#a1a1aa', border: '#3f3f46',
    textBold: '#ffffff', textItalic: '#ffffff', textQuote: '#a1a1aa',
    textAction: '#fbbf24', textThought: '#a78bfa', textDialogue: '#ffffff',
  },
  green: {
    primary: '#22c55e', primaryHover: '#16a34a',
    bgPrimary: '#0f0f0f', bgSecondary: '#1a1a1a', bgTertiary: '#262626',
    textPrimary: '#ffffff', textSecondary: '#a1a1aa', border: '#3f3f46',
    textBold: '#ffffff', textItalic: '#ffffff', textQuote: '#a1a1aa',
    textAction: '#fbbf24', textThought: '#a78bfa', textDialogue: '#ffffff',
  },
  red: {
    primary: '#ef4444', primaryHover: '#dc2626',
    bgPrimary: '#0f0f0f', bgSecondary: '#1a1a1a', bgTertiary: '#262626',
    textPrimary: '#ffffff', textSecondary: '#a1a1aa', border: '#3f3f46',
    textBold: '#ffffff', textItalic: '#ffffff', textQuote: '#a1a1aa',
    textAction: '#fbbf24', textThought: '#a78bfa', textDialogue: '#ffffff',
  },
  amber: {
    primary: '#f59e0b', primaryHover: '#d97706',
    bgPrimary: '#0f0f0f', bgSecondary: '#1a1a1a', bgTertiary: '#262626',
    textPrimary: '#ffffff', textSecondary: '#a1a1aa', border: '#3f3f46',
    textBold: '#ffffff', textItalic: '#ffffff', textQuote: '#a1a1aa',
    textAction: '#fbbf24', textThought: '#a78bfa', textDialogue: '#ffffff',
  },
  cyberpunk: {
    primary: '#e040fb', primaryHover: '#ea80fc',
    bgPrimary: '#0a0a0f', bgSecondary: '#12121a', bgTertiary: '#1a1a28',
    textPrimary: '#f0e6ff', textSecondary: '#9a8fad', border: '#2a2540',
    textBold: '#f0e6ff', textItalic: '#f0e6ff', textQuote: '#9a8fad',
    textAction: '#fbbf24', textThought: '#c4b5fd', textDialogue: '#f0e6ff',
  },
};

const LIGHT_THEMES: Record<ThemePreset, ThemeColors> = {
  purple: {
    primary: '#7c3aed', primaryHover: '#6d28d9',
    bgPrimary: '#ffffff', bgSecondary: '#f4f4f5', bgTertiary: '#e4e4e7',
    textPrimary: '#18181b', textSecondary: '#52525b', border: '#d4d4d8',
    textBold: '#18181b', textItalic: '#18181b', textQuote: '#52525b',
    textAction: '#d97706', textThought: '#7c3aed', textDialogue: '#18181b',
  },
  blue: {
    primary: '#2563eb', primaryHover: '#1d4ed8',
    bgPrimary: '#ffffff', bgSecondary: '#f4f4f5', bgTertiary: '#e4e4e7',
    textPrimary: '#18181b', textSecondary: '#52525b', border: '#d4d4d8',
    textBold: '#18181b', textItalic: '#18181b', textQuote: '#52525b',
    textAction: '#d97706', textThought: '#7c3aed', textDialogue: '#18181b',
  },
  green: {
    primary: '#16a34a', primaryHover: '#15803d',
    bgPrimary: '#ffffff', bgSecondary: '#f4f4f5', bgTertiary: '#e4e4e7',
    textPrimary: '#18181b', textSecondary: '#52525b', border: '#d4d4d8',
    textBold: '#18181b', textItalic: '#18181b', textQuote: '#52525b',
    textAction: '#d97706', textThought: '#7c3aed', textDialogue: '#18181b',
  },
  red: {
    primary: '#dc2626', primaryHover: '#b91c1c',
    bgPrimary: '#ffffff', bgSecondary: '#f4f4f5', bgTertiary: '#e4e4e7',
    textPrimary: '#18181b', textSecondary: '#52525b', border: '#d4d4d8',
    textBold: '#18181b', textItalic: '#18181b', textQuote: '#52525b',
    textAction: '#d97706', textThought: '#7c3aed', textDialogue: '#18181b',
  },
  amber: {
    primary: '#d97706', primaryHover: '#b45309',
    bgPrimary: '#ffffff', bgSecondary: '#f4f4f5', bgTertiary: '#e4e4e7',
    textPrimary: '#18181b', textSecondary: '#52525b', border: '#d4d4d8',
    textBold: '#18181b', textItalic: '#18181b', textQuote: '#52525b',
    textAction: '#d97706', textThought: '#7c3aed', textDialogue: '#18181b',
  },
  cyberpunk: {
    // Light mode still uses the neon palette but softened for readability.
    primary: '#c026d3', primaryHover: '#a21caf',
    bgPrimary: '#faf5ff', bgSecondary: '#f3e8ff', bgTertiary: '#e9d5ff',
    textPrimary: '#1a0a2e', textSecondary: '#6b21a8', border: '#d8b4fe',
    textBold: '#1a0a2e', textItalic: '#1a0a2e', textQuote: '#6b21a8',
    textAction: '#a16207', textThought: '#7c3aed', textDialogue: '#1a0a2e',
  },
};

/** Accent swatch colors shown in the settings picker (always the dark variant). */
export const PRESET_SWATCHES: Record<ThemePreset, string> = {
  purple: '#8b5cf6',
  blue: '#3b82f6',
  green: '#22c55e',
  red: '#ef4444',
  amber: '#f59e0b',
  cyberpunk: 'conic-gradient(#8b5cf6, #3b82f6, #22c55e, #ef4444, #f59e0b, #8b5cf6)',
};

export const THEME_PRESETS: ThemePreset[] = ['purple', 'blue', 'green', 'red', 'amber', 'cyberpunk'];

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const MODE_KEY = 'stm:theme-mode';
const PRESET_KEY = 'stm:theme-preset';
const CUSTOM_THEMES_KEY = 'stm:custom-themes';

const VALID_MODES: ThemeMode[] = ['light', 'dark', 'auto'];
const VALID_PRESETS: ThemePreset[] = THEME_PRESETS;

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v && VALID_MODES.includes(v as ThemeMode)) return v as ThemeMode;
  } catch { /* ignore */ }
  return 'dark';
}

export function setThemeMode(mode: ThemeMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}

export function getActivePreset(): ActivePreset {
  try {
    const v = localStorage.getItem(PRESET_KEY);
    if (!v) return 'cyberpunk';
    if (VALID_PRESETS.includes(v as ThemePreset)) return v as ThemePreset;
    if (v.startsWith('custom:')) return v as ActivePreset;
  } catch { /* ignore */ }
  return 'cyberpunk';
}

/** @deprecated Use getActivePreset() for new code */
export function getThemePreset(): ThemePreset {
  const active = getActivePreset();
  if (active.startsWith('custom:')) return 'cyberpunk';
  return active as ThemePreset;
}

export function setActivePreset(preset: ActivePreset): void {
  try { localStorage.setItem(PRESET_KEY, preset); } catch { /* ignore */ }
}

/** @deprecated Use setActivePreset() for new code */
export function setThemePreset(preset: ThemePreset): void {
  setActivePreset(preset);
}

// ---------------------------------------------------------------------------
// Custom theme CRUD
// ---------------------------------------------------------------------------

export interface CustomTheme {
  id: string;
  name: string;
  dark: ThemeColors;
  light: ThemeColors;
  /** When true, applies the cyberpunk rainbow border + glow effects regardless
   *  of color choices. Defaults true for themes forked from the cyberpunk
   *  preset, false otherwise. */
  rainbowEffects?: boolean;
}

export interface CustomThemeExport {
  name: string;
  version: 1;
  dark: ThemeColors;
  light: ThemeColors;
  rainbowEffects?: boolean;
}

export function getCustomThemes(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return [];
}

function saveCustomThemes(themes: CustomTheme[]): void {
  try { localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes)); } catch { /* ignore */ }
}

export function saveCustomTheme(theme: CustomTheme): void {
  const themes = getCustomThemes();
  const idx = themes.findIndex(t => t.id === theme.id);
  if (idx >= 0) themes[idx] = theme;
  else themes.push(theme);
  saveCustomThemes(themes);
}

/** Replace the entire custom theme list (used by server-sync on login). */
export function replaceCustomThemes(themes: CustomTheme[]): void {
  saveCustomThemes(themes);
}

export function deleteCustomTheme(id: string): void {
  const themes = getCustomThemes().filter(t => t.id !== id);
  saveCustomThemes(themes);
  // If the deleted theme was active, revert to the default (cyberpunk).
  const active = getActivePreset();
  if (active === `custom:${id}`) {
    setActivePreset('cyberpunk');
    applyTheme();
  }
}

export function generateThemeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Get colors for a custom theme by id, or null if not found. */
function getCustomThemeColors(id: string, mode: 'light' | 'dark'): ThemeColors | null {
  const theme = getCustomThemes().find(t => t.id === id);
  if (!theme) return null;
  return theme[mode];
}

/** Validate that an object has all 8 required ThemeColors keys with string values. */
export function isValidThemeColors(obj: unknown): obj is ThemeColors {
  if (!obj || typeof obj !== 'object') return false;
  const keys: (keyof ThemeColors)[] = ['primary', 'primaryHover', 'bgPrimary', 'bgSecondary', 'bgTertiary', 'textPrimary', 'textSecondary', 'border'];
  return keys.every(k => typeof (obj as Record<string, unknown>)[k] === 'string');
}

/**
 * Fill in defaults for the formatting/RP color keys when loading a theme that
 * was saved before those fields existed. Defaults preserve current rendering.
 */
export function fillThemeDefaults(colors: ThemeColors): ThemeColors {
  const c = colors as Partial<ThemeColors> & ThemeColors;
  return {
    ...colors,
    textBold: c.textBold ?? colors.textPrimary,
    textItalic: c.textItalic ?? colors.textPrimary,
    textQuote: c.textQuote ?? colors.textSecondary,
    textAction: c.textAction ?? '#fbbf24',
    textThought: c.textThought ?? '#a78bfa',
    textDialogue: c.textDialogue ?? colors.textPrimary,
  };
}

// ---------------------------------------------------------------------------
// Theme application
// ---------------------------------------------------------------------------

/** Resolve 'auto' to an actual mode based on OS preference. */
export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'auto') return mode;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Read saved preferences, resolve the active mode, and set all 8 CSS
 * variables on `<html>`. Also updates `<meta name="theme-color">` and
 * the `color-scheme` CSS property for native form controls.
 *
 * Call this synchronously before `createRoot()` in main.tsx and again
 * whenever the user changes theme settings.
 */
/** Apply a ThemeColors object to CSS variables on `<html>`. */
export function applyColors(colors: ThemeColors): void {
  const root = document.documentElement;
  root.style.setProperty('--color-primary', colors.primary);
  root.style.setProperty('--color-primary-hover', colors.primaryHover);
  root.style.setProperty('--color-bg-primary', colors.bgPrimary);
  root.style.setProperty('--color-bg-secondary', colors.bgSecondary);
  root.style.setProperty('--color-bg-tertiary', colors.bgTertiary);
  root.style.setProperty('--color-text-primary', colors.textPrimary);
  root.style.setProperty('--color-text-secondary', colors.textSecondary);
  root.style.setProperty('--color-border', colors.border);
  // Fallback for legacy custom themes saved before these keys existed.
  const legacy = colors as Partial<ThemeColors>;
  root.style.setProperty('--color-text-bold', legacy.textBold ?? colors.textPrimary);
  root.style.setProperty('--color-text-italic', legacy.textItalic ?? colors.textPrimary);
  root.style.setProperty('--color-text-quote', legacy.textQuote ?? colors.textSecondary);
  root.style.setProperty('--color-text-action', legacy.textAction ?? '#fbbf24');
  root.style.setProperty('--color-text-thought', legacy.textThought ?? '#a78bfa');
  root.style.setProperty('--color-text-dialogue', legacy.textDialogue ?? colors.textPrimary);
}

/** True if the cyberpunk rainbow effects (animated borders + neon glow) should
 *  apply for the given active preset. The cyberpunk built-in preset always
 *  enables them; custom themes opt in via the `rainbowEffects` flag. */
export function isRainbowEffectsEnabled(active: ActivePreset): boolean {
  if (active === 'cyberpunk') return true;
  if (active.startsWith('custom:')) {
    const id = active.slice(7);
    const theme = getCustomThemes().find(t => t.id === id);
    return theme?.rainbowEffects === true;
  }
  return false;
}

/** Toggle the rainbow effects on the document root. Used by the theme editor
 *  for live preview while a custom theme is being edited. */
export function applyRainbowEffects(enabled: boolean): void {
  const root = document.documentElement;
  if (enabled) {
    root.setAttribute('data-theme', 'cyberpunk');
    root.style.setProperty(
      '--rainbow-gradient',
      'linear-gradient(135deg, #8b5cf6, #3b82f6, #22c55e, #f59e0b, #ef4444, #e040fb, #8b5cf6)'
    );
  } else {
    root.removeAttribute('data-theme');
    root.style.removeProperty('--rainbow-gradient');
  }
}

export function applyTheme(): void {
  const mode = getThemeMode();
  const active = getActivePreset();
  const resolved = resolveMode(mode);

  let colors: ThemeColors;
  if (active.startsWith('custom:')) {
    const id = active.slice(7);
    const custom = getCustomThemeColors(id, resolved);
    colors = custom ?? (resolved === 'light' ? LIGHT_THEMES.cyberpunk : DARK_THEMES.cyberpunk);
  } else {
    const preset = active as ThemePreset;
    colors = resolved === 'light' ? LIGHT_THEMES[preset] : DARK_THEMES[preset];
  }

  applyColors(colors);
  applyRainbowEffects(isRainbowEffectsEnabled(active));

  // Native form controls and scrollbars respect color-scheme
  document.documentElement.style.colorScheme = resolved;

  // Update mobile status bar color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', colors.bgPrimary);
}

/** Get the ThemeColors for a built-in preset at the given mode. */
export function getPresetColors(preset: ThemePreset, mode: 'light' | 'dark'): ThemeColors {
  return mode === 'light' ? LIGHT_THEMES[preset] : DARK_THEMES[preset];
}
