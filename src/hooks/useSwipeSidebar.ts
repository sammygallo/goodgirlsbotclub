import { useEffect, useRef, useCallback } from 'react';
import { hapticMedium } from '../utils/haptics';

// Exported so the hero carousel's own swipe (E6-S2, D-H16a) uses the SAME
// numbers: a touch that starts inside the edge zone belongs to the drawer, and
// the carousel must agree on exactly where that zone ends.
export const EDGE_ZONE = 30;     // px from left edge to start open gesture
export const SWIPE_THRESHOLD = 50; // minimum px to trigger open/close

/**
 * Adds swipe-right-from-edge-to-open and swipe-left-to-close gestures
 * to the sidebar. Attach the returned `containerRef` to the layout root.
 */
export function useSwipeSidebar(
  isOpen: boolean,
  onOpen: () => void,
  onClose: () => void,
) {
  const containerRef = useRef<HTMLDivElement>(null);
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
      hapticMedium();
      onOpen();
    } else if (isOpen && deltaX < -SWIPE_THRESHOLD) {
      hapticMedium();
      onClose();
    }
  }, [isOpen, onOpen, onClose]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchEnd]);

  return containerRef;
}
