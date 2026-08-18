/**
 * ChatOptionsMenu — chat-level actions menu.
 *
 * Mobile  → BottomSheet (slides up from bottom)
 * Desktop → compact dropdown anchored above the trigger button
 *
 * Extensions (Author's Note, Summary, Branches) are shown as a compact pill
 * strip rather than individual rows, saving vertical screen real estate.
 *
 * Regenerate / Continue / Impersonate are intentionally absent — those actions
 * live in the inline message action strip directly above the input bar.
 */
import { useEffect, useRef } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  BookOpen, FileText, GitFork, Library, MessageSquare, FolderOpen,
  Trash2, Flag, Users, RefreshCw, ArrowRight, User, Image, ImageOff, BookPlus,
  Palette,
} from 'lucide-react';
import { BottomSheet } from '../ui/BottomSheet';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatPanelState {
  isOpen: boolean;
  hasContent: boolean;
  onToggle: () => void;
}

interface ChatOptionsMenuProps {
  isOpen: boolean;
  onClose: () => void;
  /** Trigger element — used to anchor the desktop dropdown. */
  anchor?: HTMLElement | null;

  authorNote: ChatPanelState;
  summary: ChatPanelState & { enabled: boolean };
  branches: ChatPanelState & { count: number };
  /**
   * `conflictCount` (optional) is the number of pending Auto Memory conflicts
   * for this chat — purely an attention signal for the pill's amber dot; it
   * does not change what the pill does when clicked (still opens
   * ChatLorePanel). Conflict review itself lives in LoreConflictChip's Review
   * button / the Library's per-book pill, not here.
   */
  lorebook: ChatPanelState & { count: number; conflictCount?: number };

  onStartNewChat: () => void;
  /** Undefined in group chat — chat-file management has no group equivalent yet. */
  onManageChatFiles?: () => void;
  onChatStyle?: () => void;
  /** True when this chat has its own style (linked preset or template). */
  chatStyleActive?: boolean;
  onSaveCheckpoint?: () => void;
  onDeleteMessages: () => void;
  onConvertToGroup?: () => void;
  onGenerateLorebook?: () => void;
  onRegenerate?: () => void;
  onContinue?: () => void;
  onImpersonate?: () => void;
  onSetBackground?: () => void;
  onClearBackground?: () => void;
  hasBackground?: boolean;

  isGroupChat: boolean;
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function ActionRow({
  icon: Icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors
        disabled:opacity-40 disabled:cursor-not-allowed
        ${danger
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
        }`}
    >
      <Icon size={15} className="flex-shrink-0" />
      <span>{label}</span>
    </button>
  );
}

function Divider() {
  return <div className="my-1 mx-4 border-t border-[var(--color-border)]" />;
}

// ---------------------------------------------------------------------------
// Shared menu body (used by both mobile sheet and desktop dropdown)
// ---------------------------------------------------------------------------

function MenuBody({
  wrap,
  extensionPanels,
  onStartNewChat,
  onManageChatFiles,
  onChatStyle,
  chatStyleActive,
  onSaveCheckpoint,
  onDeleteMessages,
  onConvertToGroup,
  onGenerateLorebook,
  onRegenerate,
  onContinue,
  onImpersonate,
  onSetBackground,
  onClearBackground,
  hasBackground,
  isGroupChat,
}: {
  wrap: (fn: () => void) => () => void;
  extensionPanels: Array<{
    id: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    label: string;
    isOpen: boolean;
    hasContent: boolean;
    onToggle: () => void;
    /** True when this pill wants a small amber attention dot next to its label. */
    attention?: boolean;
  }>;
  onStartNewChat: () => void;
  /** Undefined in group chat — chat-file management has no group equivalent yet. */
  onManageChatFiles?: () => void;
  onChatStyle?: () => void;
  chatStyleActive?: boolean;
  onSaveCheckpoint?: () => void;
  onDeleteMessages: () => void;
  onConvertToGroup?: () => void;
  onGenerateLorebook?: () => void;
  onRegenerate?: () => void;
  onContinue?: () => void;
  onImpersonate?: () => void;
  onSetBackground?: () => void;
  onClearBackground?: () => void;
  hasBackground?: boolean;
  isGroupChat: boolean;
}) {
  const hasAiActions = !!(onRegenerate || onContinue || onImpersonate);

  return (
    <>
      {/* Extension panel pills */}
      <div className="px-4 pt-3 pb-2">
        <p className="text-xs text-[var(--color-text-secondary)] mb-2">Panels</p>
        <div className="flex gap-1.5 flex-wrap">
          {extensionPanels.map((panel) => {
            const Icon = panel.icon;
            const active = panel.isOpen || panel.hasContent;
            return (
              <button
                key={panel.id}
                type="button"
                onClick={panel.onToggle}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border
                  ${active
                    ? 'bg-[var(--color-primary)]/15 border-[var(--color-primary)]/40 text-[var(--color-primary)]'
                    : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-secondary)]/40'
                  }`}
              >
                <Icon size={11} />
                <span>{panel.label}</span>
                {panel.attention && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <Divider />

      <div className="py-1">
        <ActionRow icon={MessageSquare} label="Start new chat" onClick={wrap(onStartNewChat)} />
        {onManageChatFiles && (
          <ActionRow icon={FolderOpen} label="Manage chat files" onClick={wrap(onManageChatFiles)} />
        )}
        {onChatStyle && (
          <ActionRow
            icon={Palette}
            label={chatStyleActive ? 'Chat style (custom)' : 'Chat style'}
            onClick={wrap(onChatStyle)}
          />
        )}
        {onSaveCheckpoint && (
          <ActionRow icon={Flag} label="Save checkpoint" onClick={wrap(onSaveCheckpoint)} />
        )}
        {!isGroupChat && onConvertToGroup && (
          <ActionRow icon={Users} label="Convert to group" onClick={wrap(onConvertToGroup)} />
        )}
        {onGenerateLorebook && (
          <ActionRow icon={BookPlus} label="Create lorebook from chat" onClick={wrap(onGenerateLorebook)} />
        )}
        {onSetBackground && (
          <ActionRow
            icon={Image}
            label={hasBackground ? 'Change background image' : 'Add background image'}
            onClick={wrap(onSetBackground)}
          />
        )}
        {hasBackground && onClearBackground && (
          <ActionRow
            icon={ImageOff}
            label="Remove background image"
            onClick={wrap(onClearBackground)}
          />
        )}
      </div>

      {hasAiActions && (
        <>
          <Divider />
          <div className="py-1">
            {onRegenerate && <ActionRow icon={RefreshCw} label="Generate alternative" onClick={wrap(onRegenerate)} />}
            {onContinue && <ActionRow icon={ArrowRight} label="Continue" onClick={wrap(onContinue)} />}
            {onImpersonate && <ActionRow icon={User} label="Impersonate" onClick={wrap(onImpersonate)} />}
          </div>
        </>
      )}

      <Divider />

      <div className="py-1">
        <ActionRow icon={Trash2} label="Delete messages" onClick={wrap(onDeleteMessages)} danger />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Desktop dropdown
// ---------------------------------------------------------------------------

function DesktopDropdown({
  isOpen,
  onClose,
  anchor,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  anchor?: HTMLElement | null;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Position the panel above the anchor button
  useEffect(() => {
    if (!isOpen || !anchor || !panelRef.current) return;
    const rect = anchor.getBoundingClientRect();
    const panel = panelRef.current;
    panel.style.left = `${rect.left}px`;
    panel.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  }, [isOpen, anchor]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onMouse = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          anchor && !anchor.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onMouse);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose, anchor]);

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className="fixed z-50 w-56 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="overflow-y-auto max-h-[70vh]">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function ChatOptionsMenu({
  isOpen,
  onClose,
  anchor,
  authorNote,
  summary,
  branches,
  lorebook,
  onStartNewChat,
  onManageChatFiles,
  onChatStyle,
  chatStyleActive,
  onSaveCheckpoint,
  onDeleteMessages,
  onConvertToGroup,
  onGenerateLorebook,
  onRegenerate,
  onContinue,
  onImpersonate,
  onSetBackground,
  onClearBackground,
  hasBackground,
  isGroupChat,
}: ChatOptionsMenuProps) {
  const isMobile = useIsMobile();
  const wrap = (fn: () => void) => () => { fn(); onClose(); };

  const extensionPanels = [
    {
      id: 'authorNote',
      icon: BookOpen,
      label: "Author's Note",
      isOpen: authorNote.isOpen,
      hasContent: authorNote.hasContent,
      onToggle: wrap(authorNote.onToggle),
    },
    ...(summary.enabled
      ? [{
          id: 'summary',
          icon: FileText,
          label: 'Summary',
          isOpen: summary.isOpen,
          hasContent: summary.hasContent,
          onToggle: wrap(summary.onToggle),
        }]
      : []),
    {
      id: 'branches',
      icon: GitFork,
      label: `Branches${branches.count > 0 ? ` (${branches.count})` : ''}`,
      isOpen: branches.isOpen,
      hasContent: branches.count > 0,
      onToggle: wrap(branches.onToggle),
    },
    {
      id: 'lorebook',
      icon: Library,
      label: `Lorebook${lorebook.count > 0 ? ` (${lorebook.count})` : ''}`,
      isOpen: lorebook.isOpen,
      hasContent: lorebook.count > 0,
      onToggle: wrap(lorebook.onToggle),
      attention: (lorebook.conflictCount ?? 0) > 0,
    },
  ];

  const body = (
    <MenuBody
      wrap={wrap}
      extensionPanels={extensionPanels}
      onStartNewChat={onStartNewChat}
      onManageChatFiles={onManageChatFiles}
      onChatStyle={onChatStyle}
      chatStyleActive={chatStyleActive}
      onSaveCheckpoint={onSaveCheckpoint}
      onDeleteMessages={onDeleteMessages}
      onConvertToGroup={onConvertToGroup}
      onGenerateLorebook={onGenerateLorebook}
      onRegenerate={onRegenerate}
      onContinue={onContinue}
      onImpersonate={onImpersonate}
      onSetBackground={onSetBackground}
      onClearBackground={onClearBackground}
      hasBackground={hasBackground}
      isGroupChat={isGroupChat}
    />
  );

  // Render only one branch — never both simultaneously. The DesktopDropdown
  // registers a document-level mousedown listener when open; if it rendered
  // alongside the BottomSheet (even CSS-hidden), that listener would fire on
  // every tap inside the sheet and call onClose, closing the menu.
  if (isMobile) {
    return (
      <BottomSheet isOpen={isOpen} onClose={onClose} title="Chat Options">
        {body}
      </BottomSheet>
    );
  }

  return (
    <DesktopDropdown isOpen={isOpen} onClose={onClose} anchor={anchor}>
      {body}
    </DesktopDropdown>
  );
}
