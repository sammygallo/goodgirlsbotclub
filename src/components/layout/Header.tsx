import { useEffect, useRef, useState } from 'react';
import { BookOpen, Download, HelpCircle, Key, Menu, MoreVertical, Settings, LogOut, Pencil, UserCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useGuidesPanelStore } from '../../stores/guidesPanelStore';
import { useCharacterStore } from '../../stores/characterStore';
import { can } from '../../utils/permissions';
import { Avatar, Button } from '../ui';
import { CharacterEdit } from '../character/CharacterEdit';
import { HelpChat } from '../help/HelpChat';
import { PersonaSelector, PersonaManager } from '../persona';
import { usePwaInstall } from '../../hooks/usePwaInstall';
import type { CharacterInfo } from '../../api/client';

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const navigate = useNavigate();
  const { currentUser, logout } = useAuthStore();
  const { selectedCharacter, fetchCharacters } = useCharacterStore();
  const userRole = currentUser?.role;
  const canEdit = can(userRole, 'character:edit');
  const canViewSettings = can(userRole, 'settings:view');
  const canViewGuides = canEdit;
  const { canInstall, install: installPwa } = usePwaInstall();
  const [showEditModal, setShowEditModal] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [convertToPersonaData, setConvertToPersonaData] = useState<
    { name: string; description: string } | null
  >(null);

  useEffect(() => {
    if (!overflowOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [overflowOpen]);

  const runAndCloseOverflow = (action: () => void) => {
    setOverflowOpen(false);
    action();
  };

  const handleConvertToPersona = (character: CharacterInfo) => {
    const desc =
      character.description ||
      character.data?.description ||
      '';
    setConvertToPersonaData({ name: character.name, description: desc });
  };

  const handleDuplicated = async () => {
    // Refresh character list to show the new duplicate
    await fetchCharacters();
  };

  const getAvatarUrl = (avatar: string) => `/blobs/character/${encodeURIComponent(avatar)}`;

  return (
    <header className="sticky top-0 z-20 flex-shrink-0 h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center px-4 gap-3 safe-top">
      {/* Menu Button (Mobile) */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onMenuClick}
        className="lg:hidden p-2"
        aria-label="Open menu"
      >
        <Menu size={24} />
      </Button>

      {/* Character Info */}
      <div className="flex-1 flex items-center gap-3 min-w-0">
        {selectedCharacter ? (
          <>
            <Avatar src={getAvatarUrl(selectedCharacter.avatar)} alt={selectedCharacter.name} size="sm" />
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
                {selectedCharacter.name}
              </h1>
            </div>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="p-2 flex-shrink-0"
                aria-label="Edit character"
                onClick={() => setShowEditModal(true)}
              >
                <Pencil size={18} />
              </Button>
            )}
          </>
        ) : (
          <img src="/logo.png" alt="Good Girls Bot Club" className="h-8 w-auto" />
        )}
      </div>

      {/* User Menu */}
      <div className="flex items-center gap-1 flex-shrink-0">

        {canInstall && (
          <Button
            variant="ghost"
            size="sm"
            className="p-2"
            aria-label="Install app"
            onClick={installPwa}
          >
            <Download size={20} />
          </Button>
        )}
        <PersonaSelector />

        {/* Below sm the secondary actions collapse into a kebab so the row
            doesn't bleed off the right edge of narrow viewports. */}
        <div className="hidden sm:contents">
          {canViewGuides && (
            <Button
              variant="ghost"
              size="sm"
              className="p-2"
              aria-label="Guides"
              onClick={() => useGuidesPanelStore.getState().open()}
            >
              <BookOpen size={20} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="p-2"
            aria-label="Help"
            onClick={() => setShowHelp(true)}
          >
            <HelpCircle size={20} />
          </Button>
          {canViewSettings && (
            <Button
              variant="ghost"
              size="sm"
              className="p-2"
              aria-label="Settings"
              onClick={() => useSettingsPanelStore.getState().open()}
            >
              <Settings size={20} />
            </Button>
          )}
          {!canViewSettings && can(userRole, 'settings:personal') && (
            <Button
              variant="ghost"
              size="sm"
              className="p-2"
              aria-label="My API Keys"
              onClick={() => useSettingsPanelStore.getState().openToPage('my-keys')}
            >
              <Key size={20} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/profile')}
            className="p-2"
            aria-label="Profile"
          >
            <UserCircle size={20} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="p-2"
            aria-label="Logout"
          >
            <LogOut size={20} />
          </Button>
        </div>

        {/* Mobile-only overflow menu */}
        <div ref={overflowRef} className="relative sm:hidden">
          <Button
            variant="ghost"
            size="sm"
            className="p-2"
            aria-label="More actions"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((o) => !o)}
          >
            <MoreVertical size={20} />
          </Button>
          {overflowOpen && (
            <div className="fixed right-2 top-[3.75rem] w-[calc(100vw-1rem)] max-h-[calc(100vh-4.5rem)] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50 flex flex-col">
              <div className="overflow-y-auto py-1">
                {canViewGuides && (
                  <button
                    onClick={() => runAndCloseOverflow(() => useGuidesPanelStore.getState().open())}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <BookOpen size={18} className="text-[var(--color-text-secondary)]" />
                    Guides
                  </button>
                )}
                <button
                  onClick={() => runAndCloseOverflow(() => setShowHelp(true))}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <HelpCircle size={18} className="text-[var(--color-text-secondary)]" />
                  Help
                </button>
                {canViewSettings && (
                  <button
                    onClick={() => runAndCloseOverflow(() => useSettingsPanelStore.getState().open())}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <Settings size={18} className="text-[var(--color-text-secondary)]" />
                    Settings
                  </button>
                )}
                {!canViewSettings && can(userRole, 'settings:personal') && (
                  <button
                    onClick={() => runAndCloseOverflow(() => useSettingsPanelStore.getState().openToPage('my-keys'))}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <Key size={18} className="text-[var(--color-text-secondary)]" />
                    My API Keys
                  </button>
                )}
                <button
                  onClick={() => runAndCloseOverflow(() => navigate('/profile'))}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <UserCircle size={18} className="text-[var(--color-text-secondary)]" />
                  Profile
                </button>
                <button
                  onClick={() => runAndCloseOverflow(logout)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] border-t border-[var(--color-border)]"
                >
                  <LogOut size={18} className="text-[var(--color-text-secondary)]" />
                  Logout
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Character Edit Modal */}
      {selectedCharacter && (
        <CharacterEdit
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          character={selectedCharacter}
          onDuplicated={handleDuplicated}
          onConvertToPersona={handleConvertToPersona}
        />
      )}


      {/* In-app help assistant */}
      <HelpChat isOpen={showHelp} onClose={() => setShowHelp(false)} />

      {/* Persona Manager (opened from convert-to-persona) */}
      {convertToPersonaData && (
        <PersonaManager
          isOpen={!!convertToPersonaData}
          onClose={() => setConvertToPersonaData(null)}
          initialPersona={convertToPersonaData}
        />
      )}
    </header>
  );
}
