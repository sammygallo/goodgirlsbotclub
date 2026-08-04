import type { ReactNode } from 'react';
import { Edit2, Copy, Download, Trash2, User, Globe, Sparkles } from 'lucide-react';
import type { WorldInfoBook } from '../../stores/worldInfoStore';
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
}: LibraryBookRowProps) {
  const isCharacterOwned = book.ownerCharacterAvatar != null;
  const entryCountLabel = `${book.entries.length} entr${book.entries.length === 1 ? 'y' : 'ies'}`;

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

        <span
          className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] cursor-default"
          title="Sharing controls coming later"
        >
          {book.visibility}
        </span>

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
