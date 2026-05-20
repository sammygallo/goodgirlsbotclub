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
 * Sync strategy — gap 1 fix (failed patch recovery):
 *   LOCAL_TS_KEY is stamped with Date.now() on every mutation.
 *   patchServer embeds the same timestamp as _ts in the blob and, only on
 *   success, updates LOCAL_TS_KEY to match.  A failed patch therefore leaves
 *   LOCAL_TS_KEY > server._ts.  fetchPrefs detects this and re-uploads the
 *   full local state rather than overwriting it with the stale server copy.
 *
 * Not synced (device-specific or needs R2):
 *   - mobilePortraitHeight — physical screen constraint, per-device makes sense
 *   - vnBgForCharacter / vnBgGlobal — base64 image blobs; deferred to R2 in v2
 */

import { create } from 'zustand';
import { getSettingsBlob, patchServerKey } from '../utils/serverSettings';
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

/** localStorage key tracking the timestamp of the last local mutation. */
const LOCAL_TS_KEY = 'stm:display-local-ts';

function markLocalDirty(): void {
  try { localStorage.setItem(LOCAL_TS_KEY, String(Date.now())); } catch { /* ignore */ }
}

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

/**
 * PUT the merged stm_display section. patchServerKey advances LOCAL_TS_KEY
 * only on a successful 2xx, so a network failure leaves LOCAL_TS_KEY ahead
 * of the server's server_ts and the next fetchPrefs re-uploads.
 */
async function patchServer(patch: Record<string, unknown>): Promise<void> {
  const settings = await getSettingsBlob();
  const display = (settings.stm_display as Record<string, unknown>) || {};
  Object.assign(display, patch);
  await patchServerKey('stm_display', display, LOCAL_TS_KEY);
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
      const localTs = Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
      const serverTs = Number(display?._ts || 0);

      if (localTs > serverTs) {
        // Local has mutations that never confirmed to the server — re-upload them.
        const s = get();
        patchServer({
          chatLayoutMode: s.chatLayoutMode,
          avatarShape: s.avatarShape,
          chatFontSize: s.chatFontSize,
          chatMaxWidth: s.chatMaxWidth,
          vnMode: s.vnMode,
          standardizeMessageFormatting: s.standardizeMessageFormatting,
          enterToSendMode: s.enterToSendMode,
          costumes: s.costumes,
        }).catch(() => {});
        return; // keep local values — they are newer
      }

      if (!display) return; // No server prefs and no local changes — keep defaults.

      // Server is current or newer — apply server values and write back to localStorage.
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

      // Advance LOCAL_TS_KEY so a future fetchPrefs doesn't re-upload stale local state.
      try { localStorage.setItem(LOCAL_TS_KEY, String(serverTs)); } catch { /* ignore */ }

      set({ chatLayoutMode, avatarShape, chatFontSize, chatMaxWidth, vnMode, standardizeMessageFormatting, enterToSendMode, costumes });
    } catch { /* non-fatal — localStorage values remain active */ }
  },

  setChatLayoutMode: (mode) => {
    lsSetLayoutMode(mode);
    set({ chatLayoutMode: mode });
    markLocalDirty();
    patchServer({ chatLayoutMode: mode }).catch(() => {});
  },

  setAvatarShape: (shape) => {
    lsSetAvatarShape(shape);
    set({ avatarShape: shape });
    markLocalDirty();
    patchServer({ avatarShape: shape }).catch(() => {});
  },

  setChatFontSize: (px) => {
    lsSetFontSize(px);
    set({ chatFontSize: px });
    markLocalDirty();
    patchServer({ chatFontSize: px }).catch(() => {});
  },

  setChatMaxWidth: (pct) => {
    lsSetMaxWidth(pct);
    set({ chatMaxWidth: pct });
    markLocalDirty();
    patchServer({ chatMaxWidth: pct }).catch(() => {});
  },

  setVnMode: (on) => {
    lsSetVnMode(on);
    set({ vnMode: on });
    markLocalDirty();
    patchServer({ vnMode: on }).catch(() => {});
  },

  setStandardizeMessageFormatting: (on) => {
    lsSetStandardize(on);
    set({ standardizeMessageFormatting: on });
    markLocalDirty();
    patchServer({ standardizeMessageFormatting: on }).catch(() => {});
  },

  setEnterToSendMode: (mode) => {
    lsSetEnterToSend(mode);
    set({ enterToSendMode: mode });
    markLocalDirty();
    patchServer({ enterToSendMode: mode }).catch(() => {});
  },

  setCostume: (avatar, name) => {
    lsSetCostume(avatar, name);
    const costumes = { ...get().costumes, [avatar]: name };
    set({ costumes });
    markLocalDirty();
    patchServer({ costumes }).catch(() => {});
  },

  clearCostume: (avatar) => {
    lsClearCostume(avatar);
    const costumes = { ...get().costumes };
    delete costumes[avatar];
    set({ costumes });
    markLocalDirty();
    patchServer({ costumes }).catch(() => {});
  },
}));
