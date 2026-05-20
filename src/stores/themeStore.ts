/**
 * Server-synced theme preferences store.
 *
 * State is initialised from localStorage (so the first render has the right
 * colors instantly), then hydrated from the user's server-side settings blob
 * after login.  Every change is written to localStorage immediately (for fast
 * subsequent loads) and patched to the server in the background.
 *
 * The settings blob field is `stm_theme`.
 */

import { create } from 'zustand';
import { getSettingsBlob, makeLocalTsKey, patchServerKey } from '../utils/serverSettings';
import {
  type ThemeMode,
  type ActivePreset,
  type CustomTheme,
  getThemeMode,
  setThemeMode,
  getActivePreset,
  setActivePreset,
  getCustomThemes,
  saveCustomTheme as lsSave,
  deleteCustomTheme as lsDelete,
  replaceCustomThemes,
  applyTheme,
} from '../hooks/themePreferences';

interface ThemeState {
  mode: ThemeMode;
  activePreset: ActivePreset;
  customThemes: CustomTheme[];

  /** Load theme from server after login and apply it. No-op if no server data yet. */
  fetchTheme: () => Promise<void>;
  setMode: (mode: ThemeMode) => void;
  setPreset: (preset: ActivePreset) => void;
  saveCustomTheme: (theme: CustomTheme) => void;
  deleteCustomTheme: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_KEY = 'stm_theme';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

async function patchServerTheme(patch: {
  mode?: ThemeMode;
  activePreset?: ActivePreset;
  customThemes?: CustomTheme[];
}): Promise<void> {
  const settings = await getSettingsBlob();
  const theme = (settings[SERVER_KEY] as Record<string, unknown>) || {};
  if (patch.mode !== undefined) theme.mode = patch.mode;
  if (patch.activePreset !== undefined) theme.activePreset = patch.activePreset;
  if (patch.customThemes !== undefined) theme.customThemes = patch.customThemes;
  await patchServerKey(SERVER_KEY, theme, LOCAL_TS_KEY);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useThemeStore = create<ThemeState>((set, get) => ({
  // Initialise from localStorage so there's no flash on first render.
  mode: getThemeMode(),
  activePreset: getActivePreset(),
  customThemes: getCustomThemes(),

  fetchTheme: async () => {
    try {
      const settings = await getSettingsBlob();
      const theme = settings.stm_theme as Record<string, unknown> | undefined;
      if (!theme) return; // No server preferences saved yet — keep localStorage values.

      const mode = (theme.mode as ThemeMode) || get().mode;
      const activePreset = (theme.activePreset as ActivePreset) || get().activePreset;
      const customThemes = Array.isArray(theme.customThemes)
        ? (theme.customThemes as CustomTheme[])
        : get().customThemes;

      // Write back to localStorage so the next cold load is still instant.
      setThemeMode(mode);
      setActivePreset(activePreset);
      replaceCustomThemes(customThemes);

      set({ mode, activePreset, customThemes });
      applyTheme();
    } catch { /* non-fatal — localStorage values remain active */ }
  },

  setMode: (mode: ThemeMode) => {
    setThemeMode(mode);
    set({ mode });
    applyTheme();
    patchServerTheme({ mode }).catch(() => {});
  },

  setPreset: (preset: ActivePreset) => {
    setActivePreset(preset);
    set({ activePreset: preset });
    applyTheme();
    patchServerTheme({ activePreset: preset }).catch(() => {});
  },

  saveCustomTheme: (theme: CustomTheme) => {
    lsSave(theme);
    const customThemes = getCustomThemes();
    set({ customThemes });
    patchServerTheme({ customThemes }).catch(() => {});
  },

  deleteCustomTheme: (id: string) => {
    lsDelete(id);
    const customThemes = getCustomThemes();
    const activePreset = getActivePreset(); // lsDelete may have reverted this to 'cyberpunk'
    set({ customThemes, activePreset });
    applyTheme();
    patchServerTheme({ customThemes, activePreset }).catch(() => {});
  },
}));
