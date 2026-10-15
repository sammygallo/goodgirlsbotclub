import { useEffect, useRef, useCallback, useState } from 'react';
import { hapticMedium } from '../utils/haptics';
import { useGuidesPanelStore } from '../stores/guidesPanelStore';
import { useProjectStore } from '../stores/projectStore';
import { useSettingsPanelStore } from '../stores/settingsPanelStore';

// Exported so the hero carousel's own swipe (E6-S2, D-H16a) uses the SAME
// numbers: a touch that starts inside the edge zone belongs to the drawer, and
// the carousel must agree on exactly where that zone ends.
export const EDGE_ZONE = 30;     // px from left edge to start open gesture
export const SWIPE_THRESHOLD = 50; // minimum px to trigger open/close

/**
 * D-S14: the drawer and a right panel are never open together. An edge swipe
 * must not open the drawer over a panel that is already up. Read live from the
 * stores at gesture time, so a panel that closed a moment ago no longer blocks.
 */
export function rightPanelOpen(): boolean {
  return (
    useSettingsPanelStore.getState().isOpen ||
    useGuidesPanelStore.getState().isOpen ||
    useProjectStore.getState().isOpen
  );
}

/**
 * Adds swipe-right-from-edge-to-open and swipe-left-to-close gestures
 * to the sidebar. Pass the returned callback ref to the layout root.
 *
 * A callback ref held in state, not a ref object: MainLayout renders a spinner
 * while auth resolves and only then the layout root, and an effect keyed on a
 * ref object's `.current` has already run (and found nothing) by then, so the
 * gesture stayed dead until the drawer had been toggled once (#557). State
 * changing when the root mounts re-runs the effect.
 */
export function useSwipeSidebar(
  isOpen: boolean,
  onOpen: () => void,
  onClose: () => void,
) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const touchState = useRef<{
    startX: number;
    startY: number;
    tracking: boolean;
  } | null>(null);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    const inEdgeZone = touch.clientX < EDGE_ZONE;
    // Start tracking if: opening from edge, or closing while sidebar is open
    if (inEdgeZone || isOpen) {
      touchState.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        tracking: true,
      };
    }
  }, [isOpen]);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    const state = touchState.current;
    if (!state?.tracking) return;
    touchState.current = null;

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - state.startX;
    const deltaY = Math.abs(touch.clientY - state.startY);

    // Ignore if vertical movement dominates (user is scrolling)
    if (deltaY > Math.abs(deltaX)) return;

    if (!isOpen && state.startX < EDGE_ZONE && deltaX > SWIPE_THRESHOLD) {
      // Before the haptic: a swipe that does nothing must not buzz.
      if (rightPanelOpen()) return;
      hapticMedium();
      onOpen();
    } else if (isOpen && deltaX < -SWIPE_THRESHOLD) {
      hapticMedium();
      onClose();
    }
  }, [isOpen, onOpen, onClose]);

  useEffect(() => {
    if (!container) return;

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [container, handleTouchStart, handleTouchEnd]);

  return setContainer;
}
