import { useEffect, useRef, useState } from 'react';
import { EDGE_ZONE } from '../../../hooks/useSwipeSidebar';
import { DEFAULT_POSITION, usePortraitPositionStore } from '../../../stores/portraitPositionStore';

/** Arrow-key steps for framing mode, in object-position percent (D-C8). */
export const FRAMING_STEP = 5;
export const FRAMING_FINE_STEP = 1;

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/**
 * Desktop framing for the avatar panel (D-C8): the panel's own
 * object-position, stored apart from the mobile one, and the framing mode
 * that edits it.
 *
 * While framing, a pointer drag repositions (the mobile panel's maths), and
 * the arrow keys move the image the way a drag in that direction would: 5%
 * per press, 1% with Shift. Enter or Escape leaves the mode; Escape stops
 * there so nothing behind the panel (the drawer, a sheet) also closes.
 */
export function useDesktopFraming(avatar: string | null, onExit: () => void) {
  // Primitives out of the selectors, as ChatView's mobile framing does.
  const storedX = usePortraitPositionStore((s) =>
    avatar ? s.desktopPositionsByAvatar[avatar]?.x ?? DEFAULT_POSITION.x : DEFAULT_POSITION.x,
  );
  const storedY = usePortraitPositionStore((s) =>
    avatar ? s.desktopPositionsByAvatar[avatar]?.y ?? DEFAULT_POSITION.y : DEFAULT_POSITION.y,
  );
  const setDesktopPosition = usePortraitPositionStore((s) => s.setDesktopPosition);
  const resetDesktopPosition = usePortraitPositionStore((s) => s.resetDesktopPosition);

  const [position, setPosition] = useState({ x: storedX, y: storedY });
  useEffect(() => {
    setPosition({ x: storedX, y: storedY });
  }, [storedX, storedY, avatar]);

  const [framing, setFraming] = useState(false);

  // The drag remembers its avatar: if the group panel's focus moves mid-drag,
  // the drag ends and saves to the avatar it started on, never the new one.
  const dragState = useRef<{
    avatar: string;
    startX: number;
    startY: number;
    posX: number;
    posY: number;
    last: { x: number; y: number };
    pointerId: number;
  } | null>(null);

  const commit = (next: { x: number; y: number }) => {
    setPosition(next);
    if (avatar) setDesktopPosition(avatar, next);
  };

  const exit = () => {
    setFraming(false);
    onExit();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!framing || !avatar) return;
    if ((e.target as HTMLElement).closest('button')) return;
    // A touch that starts inside the edge zone belongs to the drawer (E6-S2).
    if (e.pointerType === 'touch' && e.clientX < EDGE_ZONE) return;
    dragState.current = {
      avatar,
      startX: e.clientX,
      startY: e.clientY,
      posX: position.x,
      posY: position.y,
      last: position,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const endDrag = () => {
    const drag = dragState.current;
    if (!drag) return;
    setDesktopPosition(drag.avatar, drag.last);
    dragState.current = null;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.avatar !== avatar) {
      endDrag();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // object-position decreases visually-rightward content as % grows, so a
    // rightward drag DECREASES x (reveals the left side of the image).
    const dx = -((e.clientX - drag.startX) / rect.width) * 100;
    const dy = -((e.clientY - drag.startY) / rect.height) * 100;
    drag.last = { x: clamp(drag.posX + dx), y: clamp(drag.posY + dy) };
    setPosition(drag.last);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    endDrag();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!framing) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exit();
      return;
    }
    const step = e.shiftKey ? FRAMING_FINE_STEP : FRAMING_STEP;
    // Same sign convention as the drag: the image moves the way the arrow points.
    let { x, y } = position;
    switch (e.key) {
      case 'ArrowLeft': x += step; break;
      case 'ArrowRight': x -= step; break;
      case 'ArrowUp': y += step; break;
      case 'ArrowDown': y -= step; break;
      default: return;
    }
    e.preventDefault();
    commit({ x: clamp(x), y: clamp(y) });
  };

  const reset = () => {
    if (avatar) resetDesktopPosition(avatar);
    setPosition({ ...DEFAULT_POSITION });
  };

  return {
    position,
    framing,
    setFraming,
    reset,
    surfaceHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown },
  };
}
