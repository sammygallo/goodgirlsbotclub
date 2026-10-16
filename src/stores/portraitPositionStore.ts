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

interface PortraitPositionState {
  positionsByAvatar: Record<string, PortraitPosition>;
  desktopPositionsByAvatar: Record<string, PortraitPosition>;
  getPosition: (avatar: string) => PortraitPosition;
  setPosition: (avatar: string, pos: PortraitPosition) => void;
  resetPosition: (avatar: string) => void;
  setDesktopPosition: (avatar: string, pos: PortraitPosition) => void;
  resetDesktopPosition: (avatar: string) => void;
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
    { name: 'portrait-position', version: 1 },
  ),
);
