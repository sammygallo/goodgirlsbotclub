import { Button } from '../../ui';
import type { LoreEntryRowVM } from '../../../utils/chatLoreView';
import type { EntryProvenance } from '../../../utils/worldInfoComposition';

/**
 * Actions a row can emit. The parent (ChatLorePanel, via LoreBookSection)
 * owns every side effect — this component and LoreBookSection are pure
 * presentation plus event plumbing.
 */
export type LoreRowAction =
  | 'toggle'
  | 'fork'
  | 'discardFork'
  | 'viewBase'
  | 'editLocal'
  | 'removeLocal';

export interface LoreEntryRowProps {
  row: LoreEntryRowVM;
  onAction: (action: LoreRowAction) => void;
}

// Status chip per provenance. 'inherited' is deliberately neutral (this is
// the default, unremarkable state); 'overridden' gets the primary tint since
// it's the one state that represents deliberate customization of a shared
// entry; 'local' and 'excluded' get their own distinct, low-emphasis looks.
const PROVENANCE_CHIP: Record<EntryProvenance, { label: string; className: string }> = {
  inherited: {
    label: 'Inherited',
    className: 'bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)]',
  },
  overridden: {
    label: 'Customized',
    className: 'bg-[var(--color-primary)]/15 text-[var(--color-primary)]',
  },
  local: {
    label: 'Chat-only',
    className: 'bg-emerald-500/15 text-emerald-400',
  },
  excluded: {
    label: 'Off',
    className: 'bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] opacity-60',
  },
};

/**
 * A single lore entry row inside a LoreBookSection. Deliberately does not
 * render (or provide any way to reach) position/depth/probability/sticky/
 * cooldown/group controls — those stay out of this panel entirely; the
 * fork editor's Advanced disclosure is the only place they're editable
 * per-chat.
 */
export function LoreEntryRow({ row, onAction }: LoreEntryRowProps) {
  const { effective, provenance, overlayDrifted } = row;
  // Same labeling convention WorldInfoEntryForm's related-entries picker
  // uses: comment first, then first keyword, then the raw id as a last resort.
  const name = effective.comment || effective.keys[0] || effective.id;
  const chip = PROVENANCE_CHIP[provenance];

  return (
    <div
      className={`p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] ${
        provenance === 'excluded' ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center gap-1.5 flex-wrap mb-1">
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${chip.className}`}>
          {chip.label}
        </span>
        {effective.critical && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 font-medium">
            CRITICAL
          </span>
        )}
        {provenance === 'overridden' && overlayDrifted && (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium"
            title="The base entry changed since this was forked."
          >
            Base changed
          </span>
        )}
      </div>

      <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{name}</p>

      <p className="text-xs text-[var(--color-text-secondary)] mb-1.5">
        {effective.constant ? (
          <em>No keywords (always active)</em>
        ) : effective.keys.length > 0 ? (
          effective.keys.map((k, i) => (
            <span
              key={i}
              className="inline-block mr-1 mb-0.5 px-1.5 py-0.5 rounded bg-[var(--color-bg-primary)]"
            >
              {k}
            </span>
          ))
        ) : (
          <em className="text-red-400">Missing keywords</em>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-1">
        {provenance === 'inherited' && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onAction('toggle')}>
              Toggle off
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('fork')}>
              Fork
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('viewBase')}>
              View base
            </Button>
          </>
        )}

        {provenance === 'overridden' && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onAction('toggle')}>
              Toggle off
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('fork')}>
              Fork
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('discardFork')}>
              Discard fork
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('viewBase')}>
              View base
            </Button>
          </>
        )}

        {provenance === 'excluded' && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onAction('toggle')}>
              Toggle on
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('viewBase')}>
              View base
            </Button>
          </>
        )}

        {provenance === 'local' && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onAction('toggle')}>
              {effective.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('editLocal')}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onAction('removeLocal')}>
              Remove
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
