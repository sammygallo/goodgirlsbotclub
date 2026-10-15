import { useState } from 'react';
import { BookOpen, HelpCircle, Menu, Pencil } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useGuidesPanelStore } from '../../stores/guidesPanelStore';
import { useCharacterStore } from '../../stores/characterStore';
import { can } from '../../utils/permissions';
import { Avatar, Button } from '../ui';
import { CharacterEdit } from '../character/CharacterEdit';
import { HelpChat } from '../help/HelpChat';
import { PersonaManager } from '../persona';
import type { CharacterInfo } from '../../api/client';

interface HeaderProps {
  onMenuClick: () => void;
  /** Whether the drawer the menu button opens is open (mirrored into aria-expanded). */
  menuOpen: boolean;
}

/**
 * The app header (D-S10): the menu button, who or what is open, and Guides and
 * Help. The account items (Profile, Persona, Settings, Install, Logout) live in
 * the drawer's Personal section; Help stays here so it is in the same place on
 * every screen (WCAG 3.2.6).
 */
export function Header({ onMenuClick, menuOpen }: HeaderProps) {
  const { currentUser } = useAuthStore();
  const { selectedCharacter, fetchCharacters } = useCharacterStore();
  const userRole = currentUser?.role;
  const canEdit = can(userRole, 'character:edit');
  const canViewGuides = canEdit;
  const [showEditModal, setShowEditModal] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [convertToPersonaData, setConvertToPersonaData] = useState<
    { name: string; description: string } | null
  >(null);

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
      {/* Menu button, at every width: the drawer is the only navigation. */}
      <Button
        variant="ghost"
        size="sm"
        // WebKit does not focus a button on click, and useModalFocus records the
        // opener from the focused element: focus it, so closing the drawer can
        // return here on Safari as it does elsewhere.
        onClick={(e) => {
          e.currentTarget.focus();
          onMenuClick();
        }}
        className="p-2"
        aria-label="Open menu"
        aria-expanded={menuOpen}
        aria-controls="app-drawer"
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

      {/* Guides and Help; everything else moved into the drawer. */}
      <div className="flex items-center gap-1 flex-shrink-0">
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
