import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MODAL_EXEMPT_ATTRIBUTE } from '../../hooks/useModalFocus';

/**
 * Renders its children into a container of their own on <body>, carrying the
 * attribute that useModalFocus's inert walk skips. The children position
 * themselves (`fixed`); the container has no box of its own.
 */
export function ModalExemptPortal({ children }: { children: ReactNode }) {
  const [container] = useState(() => {
    const el = document.createElement('div');
    el.setAttribute(MODAL_EXEMPT_ATTRIBUTE, '');
    return el;
  });

  // Attached before paint, so there is no frame where the children are missing.
  useLayoutEffect(() => {
    document.body.appendChild(container);
    return () => container.remove();
  }, [container]);

  return createPortal(children, container);
}
