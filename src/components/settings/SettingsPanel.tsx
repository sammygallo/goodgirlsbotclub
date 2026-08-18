import { useState, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useSettingsPanelStore, type SettingsPageId } from '../../stores/settingsPanelStore';
import { SettingsNavProvider, type SettingsNavActions } from './SettingsNavContext';
import { SettingsPage } from './SettingsPage';
import { GenerationSettingsPage } from './GenerationSettingsPage';
import { PromptTemplatesPage } from './PromptTemplatesPage';
import { InvitationManager } from './InvitationManager';
import { UserManagementPage } from './UserManagementPage';
import { PermissionGroupsPage } from './PermissionGroupsPage';
import { QuickReplyPage } from './QuickReplyPage';
import { ExtensionsPage } from './ExtensionsPage';
import { CharacterManagementPage } from './CharacterManagementPage';
import { GalleryPage } from './GalleryPage';
import { ThemeEditorPage } from './ThemeEditorPage';
import { AISettingsPage } from './AISettingsPage';
import { UsagePage } from './UsagePage';
import { ProviderCatalogPage } from './ProviderCatalogPage';
import { MyKeysPage } from './MyKeysPage';
import { WorldInfoPage } from '../worldinfo';
import { RegexScriptPage } from '../regexscripts';

// ---------------------------------------------------------------------------
// Page component map
// ---------------------------------------------------------------------------

const PAGE_COMPONENTS: Record<SettingsPageId, React.ComponentType<{ params?: Record<string, string> }>> = {
  main: SettingsPage,
  'my-keys': MyKeysPage,
  ai: AISettingsPage,
  'ai-catalog': ProviderCatalogPage,
  generation: GenerationSettingsPage,
  prompts: PromptTemplatesPage,
  worldinfo: WorldInfoPage,
  regex: RegexScriptPage,
  invitations: InvitationManager,
  users: UserManagementPage,
  'permission-groups': PermissionGroupsPage,
  characters: CharacterManagementPage,
  quickreplies: QuickReplyPage,
  extensions: ExtensionsPage,
  gallery: GalleryPage,
  themes: ThemeEditorPage,
  usage: UsagePage,
};

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

export function SettingsPanel() {
  const { isOpen, close, pushPage, goBack } = useSettingsPanelStore();
  const currentEntry = useSettingsPanelStore((s) => s.pageStack[s.pageStack.length - 1]);

  // Animation state: mount → visible → hidden → unmount
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Lock body scroll
  useEffect(() => {
    if (mounted) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [mounted]);

  // Escape to close
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, close]);

  // Navigation actions for sub-pages
  const navActions: SettingsNavActions = useMemo(() => ({
    navigateToPage: (page, params) => pushPage(page, params),
    goBack,
    closePanel: close,
  }), [pushPage, goBack, close]);

  if (!mounted) return null;

  const PageComponent = PAGE_COMPONENTS[currentEntry.page] ?? SettingsPage;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={close}
      />

      {/* Panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[90vw] sm:max-w-4xl
          bg-[var(--color-bg-primary)] border-l border-[var(--color-border)] shadow-2xl
          flex flex-col overflow-hidden
          transform transition-transform duration-300 ease-in-out
          ${visible ? 'translate-x-0' : 'translate-x-full'}
        `}
      >
        {/* Close button */}
        <button
          onClick={close}
          className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
          aria-label="Close settings"
        >
          <X size={20} />
        </button>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <SettingsNavProvider value={navActions}>
            <PageComponent params={currentEntry.params} />
          </SettingsNavProvider>
        </div>
      </div>
    </>
  );
}
