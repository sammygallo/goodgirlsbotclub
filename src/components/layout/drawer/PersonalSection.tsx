import type { ReactNode } from 'react';
import { Download, Key, LogOut, Settings, UserCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../../stores/authStore';
import { useSettingsPanelStore } from '../../../stores/settingsPanelStore';
import { usePwaInstall } from '../../../hooks/usePwaInstall';
import { can } from '../../../utils/permissions';
import { PersonaSelector } from '../../persona/PersonaSelector';
import { FOCUS_RING } from './drawerStyles';
import { SidebarSection } from './SidebarSection';

interface PersonalSectionProps {
  open: boolean;
  onToggle: () => void;
  /** Closes the drawer. Every item that navigates or opens a right panel calls it first (D-S14). */
  onClose: () => void;
  /** Forwarded to the persona row: whether a persona surface it launched is open (D-E6S3-1). */
  onPersonaSurfaceChange: (open: boolean) => void;
}

const ROW =
  'flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)]';

function Row({ icon, label, onClick, className = '' }: { icon: ReactNode; label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`${ROW} ${FOCUS_RING} ${className}`}>
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-[var(--color-text-secondary)]">{icon}</span>
      {label}
    </button>
  );
}

/**
 * The drawer's Personal block (D-S9), pinned under the scroller: Profile, Persona,
 * Settings (or My API Keys), Install app when the browser offers it, and Logout
 * below a rule. Collapsing it hides the region; it stays mounted, because the
 * browser fires `beforeinstallprompt` once and usePwaInstall has to be listening.
 */
export function PersonalSection({ open, onToggle, onClose, onPersonaSurfaceChange }: PersonalSectionProps) {
  const navigate = useNavigate();
  const userRole = useAuthStore((s) => s.currentUser?.role);
  const logout = useAuthStore((s) => s.logout);
  const { canInstall, install: installPwa } = usePwaInstall();
  const canViewSettings = can(userRole, 'settings:view');

  return (
    <div id="app-drawer-personal" className="flex-shrink-0 border-t border-[var(--color-border)] input-safe-bottom">
      <SidebarSection id="personal" label="Personal" level={2} open={open} onToggle={onToggle}>
        <ul>
          <li>
            <Row
              icon={<UserCircle size={18} />}
              label="Profile"
              onClick={() => {
                onClose();
                navigate('/profile');
              }}
            />
          </li>
          <li>
            <PersonaSelector variant="row" onSurfaceOpenChange={onPersonaSurfaceChange} />
          </li>
          {canViewSettings && (
            <li>
              <Row
                icon={<Settings size={18} />}
                label="Settings"
                onClick={() => {
                  onClose();
                  useSettingsPanelStore.getState().open();
                }}
              />
            </li>
          )}
          {!canViewSettings && can(userRole, 'settings:personal') && (
            <li>
              <Row
                icon={<Key size={18} />}
                label="My API Keys"
                onClick={() => {
                  onClose();
                  useSettingsPanelStore.getState().openToPage('my-keys');
                }}
              />
            </li>
          )}
          {canInstall && (
            <li>
              <Row icon={<Download size={18} />} label="Install app" onClick={installPwa} />
            </li>
          )}
          <li className="border-t border-[var(--color-border)]">
            <Row icon={<LogOut size={18} />} label="Logout" onClick={logout} className="hover:text-[var(--color-error)]" />
          </li>
        </ul>
      </SidebarSection>
    </div>
  );
}
