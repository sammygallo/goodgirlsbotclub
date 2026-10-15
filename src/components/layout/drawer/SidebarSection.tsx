import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { FOCUS_RING } from './drawerStyles';
import type { SectionId } from './sidebarSections';

interface SidebarSectionProps {
  id: SectionId;
  label: string;
  /** 2 for a top-level section, 3 for one nested inside another (Group chats). */
  level: 2 | 3;
  open: boolean;
  onToggle: () => void;
  /** Shown after the label, e.g. the number of works. */
  count?: number;
  /**
   * Controls that belong to the section header (Import, New, group select). They
   * sit beside the heading rather than in the region, so they stay reachable
   * while the section is collapsed.
   */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * One collapsible drawer section (D-S16): a heading holding the toggle button,
 * and the region it controls.
 *
 * Collapsing sets `hidden` on the region, which removes it from the
 * accessibility tree as well as from view. Its children stay mounted, so the
 * state and listeners inside a collapsed section (the PWA install prompt capture
 * in Personal, the search text in My Characters) survive a collapse.
 */
export function SidebarSection({ id, label, level, open, onToggle, count, actions, children }: SidebarSectionProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  const regionId = `sidebar-sec-${id}`;

  return (
    <>
      <div className="flex items-center gap-1 pr-2">
        <Heading className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={onToggle}
            className={`flex min-h-11 w-full items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] ${
              level === 2 ? 'px-4' : 'pl-8 pr-4'
            } ${FOCUS_RING}`}
          >
            <ChevronDown
              size={14}
              className={`flex-shrink-0 transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`}
            />
            <span className="truncate">{label}</span>
            {/* The literal space keeps the accessible name "Works (3)"; flex layout ignores it. */}
            {count !== undefined && (
              <>
                {' '}
                <span className="flex-shrink-0 font-normal">({count})</span>
              </>
            )}
          </button>
        </Heading>
        {actions}
      </div>
      <div id={regionId} hidden={!open}>
        {children}
      </div>
    </>
  );
}
