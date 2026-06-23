import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getSettingsBlob, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../utils/serverSettings';

export type MotionMode = 'auto' | 'none' | 'expressions' | 'liveportrait';

// Per-user scoping: the persist key is suffixed with the handle so one account's
// per-character motion modes don't leak into the next on a shared device.
let _currentHandle: string | null = null;

const scopedLocalStorage = {
  getItem: (name: string) =>
    localStorage.getItem(_currentHandle ? `${name}_${_currentHandle}` : name),
  setItem: (name: string, value: string) =>
    localStorage.setItem(_currentHandle ? `${name}_${_currentHandle}` : name, value),
  removeItem: (name: string) =>
    localStorage.removeItem(_currentHandle ? `${name}_${_currentHandle}` : name),
};

// Cross-device sync via the `stm_motion_mode` section.
const SERVER_KEY = 'stm_motion_mode';

function localTsKey(): string {
  return _currentHandle ? `stm:motion-mode-local-ts_${_currentHandle}` : 'stm:motion-mode-local-ts';
}

async function patchServer(modesByAvatar: Record<string, MotionMode>): Promise<void> {
  await patchServerKey(SERVER_KEY, { modesByAvatar }, localTsKey());
}

interface MotionModeState {
  modesByAvatar: Record<string, MotionMode>;
  setMode: (avatar: string, mode: MotionMode) => void;
  getMode: (avatar: string) => MotionMode;
  /** Seed per-character motion modes from the server after login. */
  fetchPrefs: () => Promise<void>;
  initForUser: (handle: string) => void;
  resetUser: () => void;
}

export const useMotionModeStore = create<MotionModeState>()(
  persist(
    (set, get) => ({
      modesByAvatar: {},
      setMode(avatar, mode) {
        const modesByAvatar = { ...get().modesByAvatar, [avatar]: mode };
        set({ modesByAvatar });
        markSectionDirty(localTsKey());
        patchServer(modesByAvatar).catch(() => {});
      },
      getMode(avatar) {
        return get().modesByAvatar[avatar] ?? 'auto';
      },
      fetchPrefs: async () => {
        try {
          const settings = await getSettingsBlob();
          const section = settings[SERVER_KEY] as
            | { modesByAvatar?: Record<string, MotionMode>; _ts?: number }
            | undefined;
          const serverTs = Number(section?._ts || 0);
          if (shouldReuploadSection(localTsKey(), serverTs)) {
            patchServer(get().modesByAvatar).catch(() => {});
            return;
          }
          if (section && section.modesByAvatar && typeof section.modesByAvatar === 'object') {
            set({ modesByAvatar: section.modesByAvatar });
            try { recordServerTs(localTsKey(), serverTs); } catch { /* ignore */ }
          }
        } catch { /* non-fatal — localStorage values remain active */ }
      },
      initForUser(handle) {
        _currentHandle = handle;
        useMotionModeStore.persist.rehydrate();
      },
      resetUser() {
        _currentHandle = null;
        set({ modesByAvatar: {} });
      },
    }),
    {
      name: 'st-mobile-motion-mode',
      version: 1,
      storage: createJSONStorage(() => scopedLocalStorage),
    },
  ),
);

export type ResolvedMotionMode = 'none' | 'expressions' | 'liveportrait';

export function resolveMotionMode(
  mode: MotionMode,
  hasLivePortraitClips: boolean,
  hasExpressionSprites: boolean,
): ResolvedMotionMode {
  if (mode === 'auto') {
    if (hasLivePortraitClips) return 'liveportrait';
    if (hasExpressionSprites) return 'expressions';
    return 'none';
  }
  if (mode === 'liveportrait') return hasLivePortraitClips ? 'liveportrait' : 'none';
  if (mode === 'expressions') return hasExpressionSprites ? 'expressions' : 'none';
  return 'none';
}
