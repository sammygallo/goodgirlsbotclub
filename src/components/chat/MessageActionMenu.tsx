import { useEffect, useRef } from 'react';
import { Pencil, Copy, Trash2, RefreshCw, GitFork, Puzzle, Clapperboard } from 'lucide-react';

export interface MessageActionExtra {
  key: string;
  label: string;
  tooltip?: string;
  onClick: () => void;
}

interface MessageActionMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onRegenerate?: () => void;
  showRegenerate?: boolean;
  /** Phase 8.6: create a checkpoint at this message. */
  onCheckpoint?: () => void;
  /** Scene-video: render the message as a ~30s video via Replicate. */
  onGenerateScene?: () => void;
  /** Extension-contributed entries rendered before Delete. */
  extras?: MessageActionExtra[];
  anchorRight?: boolean;
}

export function MessageActionMenu({
  isOpen,
  onClose,
  onEdit,
  onCopy,
  onDelete,
  onRegenerate,
  showRegenerate,
  onCheckpoint,
  onGenerateScene,
  extras,
  anchorRight,
}: MessageActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Delay to avoid catching the triggering click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
      document.addEventListener('keydown', handleEsc);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const actions = [
    { key: 'edit',     icon: Pencil,    label: 'Edit',       onClick: onEdit },
    { key: 'copy',     icon: Copy,      label: 'Copy',       onClick: onCopy },
    ...(onCheckpoint
      ? [{ key: 'checkpoint', icon: GitFork, label: 'Checkpoint', onClick: onCheckpoint }]
      : []),
    ...(showRegenerate && onRegenerate
      ? [{ key: 'regen', icon: RefreshCw, label: 'Regenerate', onClick: onRegenerate }]
      : []),
    ...(onGenerateScene
      ? [{ key: 'scene', icon: Clapperboard, label: 'Generate scene', onClick: onGenerateScene }]
      : []),
    ...(extras ?? []).map((e) => ({
      key: `ext_${e.key}`,
      icon: Puzzle,
      label: e.label,
      onClick: e.onClick,
      tooltip: e.tooltip,
    })),
    { key: 'delete', icon: Trash2, label: 'Delete', onClick: onDelete, danger: true },
  ];

  return (
    <div
      ref={menuRef}
      className={`
        absolute z-20 min-w-[140px]
        bg-[var(--color-bg-secondary)] border border-[var(--color-border)]
        rounded-lg shadow-xl overflow-hidden
        ${anchorRight ? 'right-0' : 'left-0'}
      `}
      style={{ top: '100%', marginTop: '4px' }}
    >
      {actions.map((action) => {
        const Icon = action.icon;
        const isDanger = 'danger' in action && action.danger;
        const tooltip = 'tooltip' in action ? action.tooltip : undefined;
        return (
          <button
            key={action.key}
            onClick={() => {
              action.onClick();
              onClose();
            }}
            title={tooltip}
            className={`
              w-full flex items-center gap-3 px-3 py-2 text-sm text-left
              hover:bg-[var(--color-bg-tertiary)] transition-colors
              ${isDanger ? 'text-red-400' : 'text-[var(--color-text-primary)]'}
            `}
          >
            <Icon size={14} />
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}
