import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';
import { useModalFocus } from '../../hooks/useModalFocus';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const EXIT_MS = 180;

export function Modal({ isOpen, onClose, title, children, size = 'md' }: ModalProps) {
  const [mounted, setMounted] = useState(isOpen);
  const [exiting, setExiting] = useState(false);
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (mounted) {
      setExiting(true);
      const t = setTimeout(() => setMounted(false), EXIT_MS);
      return () => clearTimeout(t);
    }
  }, [isOpen, mounted]);

  // Body scroll lock — active while mounted (covers exit anim).
  useEffect(() => {
    if (!mounted) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mounted]);

  // Focus containment, focus restore and Escape (D-G5). Active only while OPEN,
  // not while merely mounted: the 180ms exit animation keeps the DOM around
  // after isOpen goes false, and the page behind must be live — and focus back
  // on the opener — from the moment the user closes it, not 180ms later.
  useModalFocus({ active: isOpen && mounted, rootRef, dialogRef, onEscape: onClose });

  if (!mounted) return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
  };

  return createPortal(
    <div ref={rootRef} className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm motion-reduce:animate-none ${
          exiting ? 'animate-modal-backdrop-out' : 'animate-modal-backdrop-in'
        }`}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`
          relative w-full ${sizes[size]}
          bg-[var(--color-bg-secondary)]
          border border-[var(--color-border)]
          rounded-xl shadow-2xl
          max-h-[90vh] overflow-hidden
          flex flex-col
          focus:outline-none
          motion-reduce:animate-none
          ${exiting ? 'animate-modal-out' : 'animate-modal-in'}
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <h2 id={titleId} className="text-lg font-semibold text-[var(--color-text-primary)]">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="p-2 -mr-2"
            aria-label="Close"
          >
            <X size={20} />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
