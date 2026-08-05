import { useState, type ReactNode } from 'react';
import { Edit2, Copy, Download, Trash2, User, Globe, Sparkles, AlertTriangle } from 'lucide-react';
import { useWorldInfoStore, type WorldInfoBook } from '../../stores/worldInfoStore';
import { useAuthStore } from '../../stores/authStore';
import { hasPermission } from '../../utils/permissions';
import type { BookAttachments } from '../../utils/bookAttachments';
import { Avatar } from '../ui';

// ---------------------------------------------------------------------------
// Lorebook v2 — single library row
// ---------------------------------------------------------------------------
//
// Extracted from WorldInfoPage.tsx's inline <li> book row (the checkbox +
// rename-in-place + name button + rename/duplicate/export/delete icon
// buttons). That existing behavior and styling is preserved exactly here,
// just reorganized behind props instead of page-local closures/state.
//
// New-in-Phase-3 pieces (scope badge, Auto badge, visibility chip, entry/
// token counts, owner chip) are genuinely new information the old row never
// displayed, so they follow the codebase's existing "pill badge" convention
// (Sidebar.tsx's Tags/tag-chip styling: text-xs, rounded-full, tinted
// bg/text pair) rather than reusing the row's original layout verbatim.
//
// Attachment-chips composition: this component does NOT render
// BookAttachmentChips.tsx itself — building/wiring that composition is a
// later integration step's job (it also needs resolveCharacter/
// onCharacterClick wiring this row has no business owning), and this step's
// job is only to leave a well-defined seam for it. The `attachments` prop is
// accepted per the Phase-3 prop contract (the caller already has this data
// per-book) but is intentionally not read by this component. Composition
// happens via the optional `attachmentsSlot: ReactNode` prop: the parent
// builds `<BookAttachmentChips attachments={attachments} resolveCharacter={...}
// onCharacterClick={...} />` itself and passes the resulting node in here,
// and this component just reserves + renders the layout slot for it (a
// no-op when the slot is omitted). Chosen over a bare placeholder-only
// `<div data-slot="attachments">` because a typed prop is discoverable at
// the call site and doesn't require the integration step to go hunting for
// a magic data attribute to portal into.
//
// Phase 5 (group sharing): `readOnly` renders a deliberately different,
// much smaller row for a book that belongs to someone else (surfaced via
// the store's `sharedBooks`) — see the branch near the bottom of this
// component. Own-row-only affordances (rename/delete/export, the sharing
// pill, conflict pill, attachment chips) never apply to another user's
// book, so they're hidden outright rather than disabled. The sharing pill
// itself (own rows only) reads `worldinfo:manage` and `sharedOwnerNameByHandle`
// straight from their stores here rather than via props — there's no
// existing prop seam for either, and both are cheap, render-only reads.

export interface LibraryBookRowProps {
  book: WorldInfoBook;
  isActive: boolean;
  ownerCharacter: { avatar: string; name: string } | null;
  attachments: BookAttachments;
  tokenEstimate: number;
  isRenaming: boolean;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  onStartRename: () => void;
  onToggleActive: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onOwnerChipClick?: (avatar: string) => void;
  /** Slot for a parent-composed <BookAttachmentChips> (or similar) node. */
  attachmentsSlot?: ReactNode;
  /**
   * Count of pending Auto Memory conflicts for this book (Lorebook v2 Phase
   * 4). Optional and additive — omitted/0 renders nothing extra, so every
   * existing caller is unaffected.
   */
  conflictCount?: number;
  /** Opens this book's conflict-resolution sheet. Required alongside a
   * truthy conflictCount for the pill to render. */
  onResolveConflicts?: () => void;
  /**
   * Renders this row read-only: another user's shared book, not one of the
   * caller's own. Hides rename/delete/export, the sharing pill, the
   * conflict pill, and attachment chips; adds an owner chip and a "Copy to
   * my library" action instead. The own-row-only props above (isRenaming,
   * onDuplicate, etc.) are simply ignored in this mode — still required so
   * every existing call site stays unchanged, but the caller may pass inert
   * placeholders (e.g. `isRenaming={false}`, `onDuplicate={() => {}}`) for a
   * readOnly row. Defaults to false so every existing (own-book) caller is
   * unaffected.
   */
  readOnly?: boolean;
  /** Required (and only used) when `readOnly` — copies the shared book into
   *  the caller's own library. */
  onCopyToLibrary?: () => void;
}

export function LibraryBookRow({
  book,
  isActive,
  ownerCharacter,
  tokenEstimate,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onFinishRename,
  onCancelRename,
  onStartRename,
  onToggleActive,
  onOpen,
  onDuplicate,
  onExport,
  onDelete,
  onOwnerChipClick,
  attachmentsSlot,
  conflictCount,
  onResolveConflicts,
  readOnly = false,
  onCopyToLibrary,
}: LibraryBookRowProps) {
  const isCharacterOwned = book.ownerCharacterAvatar != null;
  const entryCountLabel = `${book.entries.length} entr${book.entries.length === 1 ? 'y' : 'ies'}`;

  // Sharing pill (own rows only) + "shared by" chip (readOnly rows only)
  // both need store state this component previously had no reason to read
  // directly. Called unconditionally per rules-of-hooks even though only
  // one branch below ends up using each.
  const currentUser = useAuthStore((s) => s.currentUser);
  const canManageSharing = hasPermission(currentUser, 'worldinfo:manage');
  const setBookVisibility = useWorldInfoStore((s) => s.setBookVisibility);
  const sharedOwnerNameByHandle = useWorldInfoStore((s) => s.sharedOwnerNameByHandle);
  const [confirmingShare, setConfirmingShare] = useState(false);

  if (readOnly) {
    const ownerLabel = sharedOwnerNameByHandle[book.ownerHandle] ?? book.ownerHandle;
    return (
      <li className="p-3 rounded-lg border transition-colors bg-[var(--color-bg-tertiary)] border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label className="flex items-center cursor-pointer flex-shrink-0">
            <input
              type="checkbox"
              checked={isActive}
              onChange={onToggleActive}
              className="w-4 h-4 accent-[var(--color-primary)]"
              aria-label={`${isActive ? 'Deactivate' : 'Activate'} ${book.name}`}
            />
          </label>
          <button onClick={onOpen} className="flex-1 min-w-0 text-left">
            <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
              {book.name}
            </p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              {entryCountLabel} · ~{tokenEstimate} tok
              {isActive ? ' · active' : ''}
            </p>
          </button>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button
              onClick={onCopyToLibrary}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
              title="Copy to my library"
              aria-label={`Copy ${book.name} to my library`}
            >
              <Copy size={14} />
            </button>
          </div>
        </div>

        {/* Badges row: scope / auto-extracted / shared-by owner chip. No
            sharing pill, conflict pill, or attachment chips — none of that
            is this viewer's to control on someone else's book. */}
        <div className="mt-2 pl-0.5 flex flex-wrap items-center gap-1.5">
          {book.scope === 'character' ? (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
              <User size={12} />
              Character
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
              <Globe size={12} />
              World
            </span>
          )}

          {book.autoExtracted && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
              <Sparkles size={12} />
              Auto
            </span>
          )}

          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
            <User size={12} />
            {ownerLabel}
          </span>
        </div>
      </li>
    );
  }

  // Own-row sharing pill: inert (today's behavior) unless the viewer holds
  // worldinfo:manage. Auto Memory books are never shareable — the pill is
  // disabled with an explanatory title rather than hidden, so the user
  // understands why. Sharing (private -> shared) asks for a lightweight
  // inline confirmation first, since it exposes the book to everyone in the
  // group; un-sharing (shared -> private) is a single click, no confirmation
  // needed — it only ever narrows visibility.
  const sharingPill = !canManageSharing ? (
    <span
      className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] cursor-default"
      title="Sharing controls coming later"
    >
      {book.visibility}
    </span>
  ) : book.autoExtracted ? (
    <span
      className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] cursor-not-allowed"
      title="Auto Memory books can't be shared — they're built from your private chats"
    >
      {book.visibility}
    </span>
  ) : confirmingShare ? (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
      Share with everyone in your group?
      <button
        onClick={() => {
          setBookVisibility(book.id, 'shared');
          setConfirmingShare(false);
        }}
        className="font-semibold underline underline-offset-2"
      >
        Share
      </button>
      <button onClick={() => setConfirmingShare(false)} className="underline underline-offset-2">
        Cancel
      </button>
    </span>
  ) : (
    <button
      onClick={() =>
        book.visibility === 'shared'
          ? setBookVisibility(book.id, 'private')
          : setConfirmingShare(true)
      }
      className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
        book.visibility === 'shared'
          ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
          : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]'
      }`}
      title={
        book.visibility === 'shared'
          ? 'Shared with your group — click to make private'
          : 'Private — click to share with your group'
      }
    >
      {book.visibility}
    </button>
  );

  return (
    <li
      className={`
        p-3 rounded-lg border transition-colors
        ${
          isActive
            ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]'
            : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'
        }
      `}
    >
      <div className="flex items-center gap-2">
        {isCharacterOwned ? (
          <span
            className="flex-shrink-0 text-[10px] text-[var(--color-text-secondary)] italic whitespace-nowrap"
            title="Auto-activated whenever this character is active"
          >
            {ownerCharacter ? `auto-active with ${ownerCharacter.name}` : 'auto-active'}
          </span>
        ) : (
          <label className="flex items-center cursor-pointer flex-shrink-0">
            <input
              type="checkbox"
              checked={isActive}
              onChange={onToggleActive}
              className="w-4 h-4 accent-[var(--color-primary)]"
              aria-label={`${isActive ? 'Deactivate' : 'Activate'} ${book.name}`}
            />
          </label>
        )}
        {isRenaming ? (
          <input
            type="text"
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onBlur={onFinishRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onFinishRename();
              if (e.key === 'Escape') onCancelRename();
            }}
            autoFocus
            className="flex-1 px-2 py-1 text-sm bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
          />
        ) : (
          <button onClick={onOpen} className="flex-1 min-w-0 text-left">
            <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
              {book.name}
            </p>
            <p className="text-xs text-[var(--color-text-secondary)]">
              {entryCountLabel} · ~{tokenEstimate} tok
              {isActive ? ' · active' : ''}
            </p>
          </button>
        )}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={onStartRename}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
            title="Rename"
            aria-label="Rename lorebook"
          >
            <Edit2 size={14} />
          </button>
          <button
            onClick={onDuplicate}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
            title="Duplicate"
            aria-label="Duplicate lorebook"
          >
            <Copy size={14} />
          </button>
          <button
            onClick={onExport}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
            title="Export JSON"
            aria-label="Export lorebook"
          >
            <Download size={14} />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10"
            title="Delete"
            aria-label="Delete lorebook"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Badges row: scope / auto-extracted / visibility / owner chip. */}
      <div className="mt-2 pl-0.5 flex flex-wrap items-center gap-1.5">
        {book.scope === 'character' ? (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
            <User size={12} />
            Character
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
            <Globe size={12} />
            World
          </span>
        )}

        {book.autoExtracted && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
            <Sparkles size={12} />
            Auto
          </span>
        )}

        {!!conflictCount && onResolveConflicts && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onResolveConflicts();
            }}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
          >
            <AlertTriangle size={12} />
            {conflictCount} conflict{conflictCount === 1 ? '' : 's'}
          </button>
        )}

        {sharingPill}

        {ownerCharacter &&
          (onOwnerChipClick ? (
            <button
              onClick={() => onOwnerChipClick(ownerCharacter.avatar)}
              className="inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-secondary)] transition-colors"
            >
              <Avatar src={`/api/avatar/${book.ownerCharacterAvatar}`} size="sm" alt={ownerCharacter.name} />
              {ownerCharacter.name}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text-secondary)]">
              <Avatar src={`/api/avatar/${book.ownerCharacterAvatar}`} size="sm" alt={ownerCharacter.name} />
              {ownerCharacter.name}
            </span>
          ))}
      </div>

      {/* Attachment chips, composed by the parent — see header comment. */}
      {attachmentsSlot && <div className="mt-2">{attachmentsSlot}</div>}
    </li>
  );
}
