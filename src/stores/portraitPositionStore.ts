import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Per-character object-position values for the portrait panels.
 * Values are CSS percentages (0-100) on each axis. Default of 50/0 matches
 * the original `object-cover object-top` behavior.
 *
 * Mobile and desktop framing are stored separately (D-C8): the wide, short
 * mobile panel crops top and bottom while the tall, narrow desktop panel
 * crops the sides, so one `object-position` would frame different regions.
 */

export interface PortraitPosition {
  x: number;
  y: number;
}

export const DEFAULT_POSITION: PortraitPosition = { x: 50, y: 0 };

/** The persisted shape. Version 1 held only `positionsByAvatar`. */
export interface PersistedPortraitPositions {
  positionsByAvatar: Record<string, PortraitPosition>;
  desktopPositionsByAvatar: Record<string, PortraitPosition>;
}

export const PORTRAIT_POSITION_VERSION = 2;

interface PortraitPositionState extends PersistedPortraitPositions {
  getPosition: (avatar: string) => PortraitPosition;
  setPosition: (avatar: string, pos: PortraitPosition) => void;
  resetPosition: (avatar: string) => void;
  setDesktopPosition: (avatar: string, pos: PortraitPosition) => void;
  resetDesktopPosition: (avatar: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Upgrades a stored blob from any earlier version to version 2. The mobile
 * map is kept exactly as stored — users' mobile framing must survive the
 * bump — and the desktop map starts empty. The blob is user-writable
 * localStorage, so anything that is not an object degrades to defaults
 * rather than throwing during hydration.
 */
export function migratePortraitPositionState(
  persisted: unknown,
  _version: number,
): PersistedPortraitPositions {
  const stored = isPlainObject(persisted) ? persisted : {};
  return {
    positionsByAvatar: isPlainObject(stored.positionsByAvatar)
      ? (stored.positionsByAvatar as Record<string, PortraitPosition>)
      : {},
    desktopPositionsByAvatar: isPlainObject(stored.desktopPositionsByAvatar)
      ? (stored.desktopPositionsByAvatar as Record<string, PortraitPosition>)
      : {},
  };
}

export const usePortraitPositionStore = create<PortraitPositionState>()(
  persist(
    (set, get) => ({
      positionsByAvatar: {},
      desktopPositionsByAvatar: {},

      getPosition(avatar) {
        return get().positionsByAvatar[avatar] ?? DEFAULT_POSITION;
      },

      setPosition(avatar, pos) {
        set((s) => ({
          positionsByAvatar: { ...s.positionsByAvatar, [avatar]: pos },
        }));
      },

      resetPosition(avatar) {
        set((s) => {
          const next = { ...s.positionsByAvatar };
          delete next[avatar];
          return { positionsByAvatar: next };
        });
      },

      setDesktopPosition(avatar, pos) {
        set((s) => ({
          desktopPositionsByAvatar: { ...s.desktopPositionsByAvatar, [avatar]: pos },
        }));
      },

      resetDesktopPosition(avatar) {
        set((s) => {
          const next = { ...s.desktopPositionsByAvatar };
          delete next[avatar];
          return { desktopPositionsByAvatar: next };
        });
      },
    }),
    {
      name: 'portrait-position',
      version: PORTRAIT_POSITION_VERSION,
      // persist merges the migrated data over the live state, so the actions
      // survive; the cast is only because migrate is typed as the full state.
      migrate: (persisted, version) =>
        migratePortraitPositionState(persisted, version) as PortraitPositionState,
    },
  ),
);
