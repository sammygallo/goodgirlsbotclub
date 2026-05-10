/**
 * Server-synced display preferences store.
 *
 * Initialises from localStorage (instant first render), then hydrates from
 * the user's server-side settings blob after login so preferences follow the
 * user across devices.  Every mutation writes to localStorage immediately and
 * patches the server in the background.
 *
 * Server settings blob key: `stm_display`
 *
 * Not synced (device-specific or needs R2):
 *   - mobilePortraitHeight — physical screen constraint, per-device makes sense
 *   - vnBgForCharacter / vnBgGlobal — base64 image blobs; deferred to R2 in v2
 */

import { create } from 'zustand';
import { settingsApi } from '../api/client';
import {
  type ChatLayoutMode,
  type AvatarShape,
  type EnterToSendMode,
  getChatLayoutMode,
  setChatLayoutMode as lsSetLayoutMode,
  getAvatarShape,
  setAvatarShape as lsSetAvatarShape,
  getChatFontSize,
  setChatFontSize as lsSetFontSize,
  getChatMaxWidth,
  setChatMaxWidth as lsSetMaxWidth,
  getVnMode,
  setVnMode as lsSetVnMode,
  getStandardizeMessageFormatting,
  setStandardizeMessageFormatting as lsSetStandardize,
  getEnterToSendMode,
  setEnterToSendMode as lsSetEnterToSend,
  setCostume as lsSetCostume,
  clearCostume as lsClearCostume,
} from '../hooks/displayPreferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DisplayPrefsState {
  chatLayoutMode: ChatLayoutMode;
  avatarShape: AvatarShape;
  chatFontSize: number;
  chatMaxWidth: number;
  vnMode: boolean;
  standardizeMessageFormatting: boolean;
  enterToSendMode: EnterToSendMode;
  /** Per-character costume folder name, keyed by avatar filename. */
  costumes: Record<string, string>;

  /** Fetch from server after login and apply. No-op if no server data yet. */
  fetchPrefs: () => Promise<void>;
  setChatLayoutMode: (mode: ChatLayoutMode) => void;
  setAvatarShape: (shape: AvatarShape) => void;
  setChatFontSize: (px: number) => void;
  setChatMaxWidth: (pct: number) => void;
  setVnMode: (on: boolean) => void;
  setStandardizeMessageFormatting: (on: boolean) => void;
  setEnterToSendMode: (mode: EnterToSendMode) => void;
  setCostume: (avatar: string, name: string) => void;
  clearCostume: (avatar: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitialCostumes(): Record<string, string> {
  const costumes: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('stm:costume-')) {
        const avatar = key.slice('stm:costume-'.length);
        const val = localStorage.getItem(key);
        if (val) costumes[avatar] = val;
      }
    }
  } catch { /* ignore */ }
  return costumes;
}

async function getSettingsBlob(): Promise<Record<string, unknown>> {
  const response = await settingsApi.getSettings();
  if (typeof response.settings === 'string') {
    try { return JSON.parse(response.settings); } catch { return {}; }
  }
  return (response.settings as Record<string, unknown>) || {};
}

async function patchServer(patch: Record<string, unknown>): Promise<void> {
  const settings = await getSettingsBlob();
  const display = (settings.stm_display as Record<string, unknown>) || {};
  Object.assign(display, patch);
  settings.stm_display = display;
  await settingsApi.saveSettings(settings);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDisplayPreferencesStore = create<DisplayPrefsState>((set, get) => ({
  chatLayoutMode: getChatLayoutMode(),
  avatarShape: getAvatarShape(),
  chatFontSize: getChatFontSize(),
  chatMaxWidth: getChatMaxWidth(),
  vnMode: getVnMode(),
  standardizeMessageFormatting: getStandardizeMessageFormatting(),
  enterToSendMode: getEnterToSendMode(),
  costumes: getInitialCostumes(),

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const display = settings.stm_display as Record<string, unknown> | undefined;
      if (!display) return;

      const chatLayoutMode = (display.chatLayoutMode as ChatLayoutMode) ?? get().chatLayoutMode;
      const avatarShape = (display.avatarShape as AvatarShape) ?? get().avatarShape;
      const chatFontSize = typeof display.chatFontSize === 'number' ? display.chatFontSize : get().chatFontSize;
      const chatMaxWidth = typeof display.chatMaxWidth === 'number' ? display.chatMaxWidth : get().chatMaxWidth;
      const vnMode = typeof display.vnMode === 'boolean' ? display.vnMode : get().vnMode;
      const standardizeMessageFormatting = typeof display.standardizeMessageFormatting === 'boolean'
        ? display.standardizeMessageFormatting
        : get().standardizeMessageFormatting;
      const enterToSendMode = (display.enterToSendMode as EnterToSendMode) ?? get().enterToSendMode;
      const costumes = (display.costumes as Record<string, string>) ?? get().costumes;

      // Write back to localStorage so the next cold load is still instant.
      lsSetLayoutMode(chatLayoutMode);
      lsSetAvatarShape(avatarShape);
      lsSetFontSize(chatFontSize);
      lsSetMaxWidth(chatMaxWidth);
      lsSetVnMode(vnMode);
      lsSetStandardize(standardizeMessageFormatting);
      lsSetEnterToSend(enterToSendMode);

      // Restore per-character costumes: remove stale, write new.
      try {
        for (const avatar of Object.keys(get().costumes)) {
          if (!costumes[avatar]) localStorage.removeItem(`stm:costume-${avatar}`);
        }
        for (const [avatar, name] of Object.entries(costumes)) {
          localStorage.setItem(`stm:costume-${avatar}`, name);
        }
      } catch { /* ignore */ }

      set({ chatLayoutMode, avatarShape, chatFontSize, chatMaxWidth, vnMode, standardizeMessageFormatting, enterToSendMode, costumes });
    } catch { /* non-fatal — localStorage values remain active */ }
  },

  setChatLayoutMode: (mode) => {
    lsSetLayoutMode(mode);
    set({ chatLayoutMode: mode });
    patchServer({ chatLayoutMode: mode }).catch(() => {});
  },

  setAvatarShape: (shape) => {
    lsSetAvatarShape(shape);
    set({ avatarShape: shape });
    patchServer({ avatarShape: shape }).catch(() => {});
  },

  setChatFontSize: (px) => {
    lsSetFontSize(px);
    set({ chatFontSize: px });
    patchServer({ chatFontSize: px }).catch(() => {});
  },

  setChatMaxWidth: (pct) => {
    lsSetMaxWidth(pct);
    set({ chatMaxWidth: pct });
    patchServer({ chatMaxWidth: pct }).catch(() => {});
  },

  setVnMode: (on) => {
    lsSetVnMode(on);
    set({ vnMode: on });
    patchServer({ vnMode: on }).catch(() => {});
  },

  setStandardizeMessageFormatting: (on) => {
    lsSetStandardize(on);
    set({ standardizeMessageFormatting: on });
    patchServer({ standardizeMessageFormatting: on }).catch(() => {});
  },

  setEnterToSendMode: (mode) => {
    lsSetEnterToSend(mode);
    set({ enterToSendMode: mode });
    patchServer({ enterToSendMode: mode }).catch(() => {});
  },

  setCostume: (avatar, name) => {
    lsSetCostume(avatar, name);
    const costumes = { ...get().costumes, [avatar]: name };
    set({ costumes });
    patchServer({ costumes }).catch(() => {});
  },

  clearCostume: (avatar) => {
    lsClearCostume(avatar);
    const costumes = { ...get().costumes };
    delete costumes[avatar];
    set({ costumes });
    patchServer({ costumes }).catch(() => {});
  },
}));
