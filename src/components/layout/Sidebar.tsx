import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useModalFocus } from '../../hooks/useModalFocus';
import {
  X,
  Search,
  Plus,
  MessageSquare,
  Users,
  UserPlus,
  Check,
  Trash2,
  Upload,
  Star,
  Filter,
  ArrowUpDown,
  Loader2,
  Info,
  Library,
} from 'lucide-react';
import { useCharacterStore } from '../../stores/characterStore';
import { useCharacterInterviewStore } from '../../stores/characterInterviewStore';
import { useChatStore, type GroupChatInfo } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useProjectStore } from '../../stores/projectStore';
import { can, hasPermission } from '../../utils/permissions';
import { haptic } from '../../utils/haptics';
import { Avatar, Button, Input } from '../ui';
import { CharacterCreation, type ManualDraftFormData, type ManualDraftAdvanced } from '../character/CharacterCreation';
import { CharacterInterview } from '../character/interview/CharacterInterview';
import { CharacterImport } from '../character/CharacterImport';
import { CharacterPreviewModal } from '../character/CharacterPreviewModal';
import { firstSentence } from '../../utils/characterRichText';
import type { CharacterInfo } from '../../api/client';
import { CurrentChatCard } from './drawer/CurrentChatCard';
import { PersonalSection } from './drawer/PersonalSection';
import { SidebarSection } from './drawer/SidebarSection';
import { FOCUS_RING } from './drawer/drawerStyles';
import { useSidebarSections } from './drawer/sidebarSections';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

/** The slide-out lasts this long (D-S4); the root stays shown until it is over. */
const DRAWER_EXIT_MS = 200;

// Manual drafts nest the name under `formData`, interview drafts under
// `draft` (the interview's in-progress character card) — check both.
function draftPreviewName(payload: Record<string, unknown>): string {
  const formData = payload.formData as { name?: string } | undefined;
  if (formData?.name?.trim()) return formData.name.trim();
  const draft = payload.draft as { name?: string } | undefined;
  if (draft?.name?.trim()) return draft.name.trim();
  return 'Untitled character';
}

// Thumbnail URL for small avatars in list. ST's /thumbnail is gone in B1;
// browsers down-scale the full PNG client-side.
const getThumbnailUrl = (avatar: string) => `/blobs/character/${encodeURIComponent(avatar)}`;

/** Row actions are hidden until hover on hover-capable devices, and always shown for keyboard focus (WCAG 2.4.7). */
const ROW_ACTION_VISIBILITY =
  'opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100';

/**
 * The app's navigation drawer (E6-S3, A1): hidden at every width, opened from the
 * header's menu button or an edge swipe, closed on load. Top to bottom: the Home
 * and Close buttons, the current-chat card, the scroller (My Characters with its
 * nested Group chats, then Works), and the Personal block pinned beneath.
 */
export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.currentUser);
  const userRole = currentUser?.role;
  const canCreateCharacters = can(userRole, 'character:create');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showInterviewModal, setShowInterviewModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [isGroupSelectMode, setIsGroupSelectMode] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [previewCharacter, setPreviewCharacter] = useState<CharacterInfo | null>(null);
  const [personaSurfaceOpen, setPersonaSurfaceOpen] = useState(false);
  const {
    selectedCharacter,
    isLoading,
    fetchCharacters,
    selectCharacter,
    clearSelection,
    groupChatCharacters,
    toggleGroupChatCharacter,
    startGroupChat,
    exitGroupChat,
    isCharacterInGroup,
    isGroupChatMode,
    setGroupChatCharacters,
    favorites,
    toggleFavorite,
    searchQuery,
    setSearchQuery,
    selectedTags,
    toggleTagFilter,
    clearTagFilters,
    showFavoritesOnly,
    setShowFavoritesOnly,
    sortMode,
    setSortMode,
    getAllTags,
    getFilteredCharacters,
    manualDraft,
    loadManualDraft,
    discardManualDraft,
  } = useCharacterStore();
  const {
    resumableDraft: interviewDraft,
    loadDraft: loadInterviewDraft,
    hydrateFromDraft: hydrateInterviewFromDraft,
    discardDraft: discardInterviewDraft,
  } = useCharacterInterviewStore();
  const [resumeManualData, setResumeManualData] = useState<
    Partial<ManualDraftFormData & ManualDraftAdvanced> | undefined
  >(undefined);
  // Bumped on every explicit "Resume draft" click so <CharacterCreation>
  // remounts and re-seeds its internal state from the fresh initialData —
  // it otherwise stays mounted across opens/closes so a plain Cancel
  // doesn't lose whatever the user was mid-typing.
  const [manualResumeKey, setManualResumeKey] = useState(0);
  // Selectors, not the whole store: the whole-store form would re-render the
  // drawer on every streamed token while it sits closed.
  const startNewGroupChat = useChatStore((s) => s.startNewGroupChat);
  const groupChats = useChatStore((s) => s.groupChats);
  const loadGroupChat = useChatStore((s) => s.loadGroupChat);
  const deleteGroupChat = useChatStore((s) => s.deleteGroupChat);
  const busy = useChatStore((s) => s.isSending || s.isStreaming);
  const canViewWorks = hasPermission(currentUser, 'project:view');
  const canManageWorks = hasPermission(currentUser, 'project:manage');
  const works = useProjectStore((s) => s.items);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const openWorksPanel = useProjectStore((s) => s.openPanel);
  const { sections, toggle: toggleSection } = useSidebarSections();

  useEffect(() => {
    if (canViewWorks) fetchProjects();
  }, [canViewWorks, fetchProjects]);

  useEffect(() => {
    if (!canCreateCharacters) return;
    loadManualDraft();
    loadInterviewDraft();
  }, [canCreateCharacters, loadManualDraft, loadInterviewDraft]);

  const handleResumeManualDraft = () => {
    if (!manualDraft) return;
    const payload = manualDraft.payload as {
      formData?: Partial<ManualDraftFormData>;
      advanced?: Partial<ManualDraftAdvanced>;
    };
    setResumeManualData({ ...payload.formData, ...payload.advanced });
    setManualResumeKey((n) => n + 1);
    setShowCreateModal(true);
  };

  const handleResumeInterviewDraft = () => {
    hydrateInterviewFromDraft();
    setShowInterviewModal(true);
  };

  const filteredCharacters = getFilteredCharacters();
  const allTags = getAllTags();
  const activeFilterCount =
    selectedTags.size + (showFavoritesOnly ? 1 : 0) + (searchQuery.trim() ? 1 : 0);

  useEffect(() => {
    fetchCharacters();
  }, [fetchCharacters]);

  // Phase 6.3: Pull-to-refresh on the scroller (the element that actually scrolls)
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { pullDistance, isRefreshing } = usePullToRefresh(scrollerRef, fetchCharacters);

  // A character selected from outside the drawer (the hero's Chat button) ends
  // group selection, as the cancel button and startGroupChat do. Otherwise a
  // row click would go on toggling membership instead of choosing a character.
  useEffect(() => {
    if (selectedCharacter) setIsGroupSelectMode(false);
  }, [selectedCharacter]);

  // --- The drawer shell (D-S4, D-S12, D-S15) -----------------------------------
  const reducedMotion = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  // `hidden` is display:none, so the slide-out needs the root to stay shown for
  // DRAWER_EXIT_MS after `isOpen` goes false. Opening is derived while rendering,
  // not set from an effect: the drawer is shown in the very commit that carries
  // `isOpen`, so a caller that focuses something inside it a tick later (the
  // hero's Browse) finds it there.
  const [displayed, setDisplayed] = useState(isOpen);
  if (isOpen && !displayed) setDisplayed(true);
  useEffect(() => {
    if (isOpen || !displayed) return;
    const t = window.setTimeout(() => setDisplayed(false), reducedMotion ? 0 : DRAWER_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [isOpen, displayed, reducedMotion]);
  const exiting = displayed && !isOpen;
  // Active while OPEN, not while shown: the page behind is live, and focus is
  // back on the menu button, from the moment the user closes it.
  useModalFocus({ active: isOpen, rootRef, onEscape: onClose });

  // --- D-E6S3-1: a surface launched from the drawer closes the drawer ----------
  // Layering puts Modal (z 100) beneath the drawer (z 1000), so the drawer has to
  // leave. It must leave AFTER the surface has pushed onto useModalFocus's stack:
  // the hook then moves the surface's return focus from the soon-hidden drawer
  // button to the drawer's own opener, the menu button. React runs every effect
  // cleanup in a commit before any setup, so closing in the click handler (or in
  // the same commit as a Modal that mounts one commit after `isOpen`) pops the
  // drawer first and the Modal captures a dead opener. Hop 1 lands one render
  // after the launch; hop 2 closes the drawer in the render after that, when the
  // Modal has pushed whether it activates at once (About) or a commit later (Import).
  const launchedOpen =
    showCreateModal || showInterviewModal || showImportModal || previewCharacter !== null || personaSurfaceOpen;
  const [launchedSeen, setLaunchedSeen] = useState(false);
  useEffect(() => {
    setLaunchedSeen(launchedOpen);
  }, [launchedOpen]);
  useEffect(() => {
    if (isOpen && launchedSeen) onClose();
  }, [isOpen, launchedSeen, onClose]);

  // --- Actions -------------------------------------------------------------------
  const handleCharacterCreated = (avatarUrl: string) => {
    selectCharacter(avatarUrl);
    onClose();
  };

  const handleCharacterImported = (avatarUrl: string) => {
    selectCharacter(avatarUrl);
    onClose();
  };

  const handleCharacterSelect = (avatar: string) => {
    haptic();
    selectCharacter(avatar);
    onClose();
  };

  const handleGroupChatSelect = async (groupChat: GroupChatInfo) => {
    // Set up group chat mode with the characters from the saved group chat
    await setGroupChatCharacters(groupChat.characterAvatars);
    loadGroupChat(groupChat);
    onClose();
  };

  const handleDeleteGroupChat = (fileName: string) => {
    if (confirm('Delete this group chat?')) {
      deleteGroupChat(fileName);
    }
  };

  // D-S6. Group mode ends BEFORE the selection is cleared: a group chat's
  // identity is its roster, and the roster is read from this state.
  const handleHome = () => {
    if (busy) return;
    haptic();
    if (isGroupChatMode) exitGroupChat();
    clearSelection();
    navigate('/');
    onClose();
  };

  // D-S13: ArrowUp / ArrowDown move between rows' primary buttons, Home / End go
  // to the first and last. An accelerator only: every button stays in Tab order.
  const handleListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (!target.matches('[data-row-primary]')) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-row-primary]'));
    const at = rows.indexOf(target);
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(at + 1, rows.length - 1);
        break;
      case 'ArrowUp':
        next = Math.max(at - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    rows[next]?.focus();
  };

  const characterActions = (
    <div className="flex flex-shrink-0 items-center gap-0.5">
      {isGroupSelectMode ? (
        <button
          type="button"
          onClick={() => {
            setIsGroupSelectMode(false);
            exitGroupChat();
          }}
          aria-label="Cancel group selection"
          className={`flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
        >
          <X size={16} />
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setIsGroupSelectMode(true)}
            aria-label="Start group chat"
            title="Group Chat"
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
          >
            <UserPlus size={16} />
          </button>
          {canCreateCharacters && (
            <>
              <button
                type="button"
                onClick={() => setShowImportModal(true)}
                aria-label="Import character"
                className={`flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
              >
                <Upload size={14} />
                Import
              </button>
              <button
                type="button"
                onClick={() => setShowInterviewModal(true)}
                aria-label="New character"
                className={`flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
              >
                <Plus size={14} />
                New
              </button>
            </>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      {/*
        The root is the dialog AND the useModalFocus surface, so the inert walk
        takes in the page around it. It has NO class of its own on purpose: a
        static box holding only fixed children creates no stacking context, so the
        scrim and the panel compete with Modal (z 100) and the toasts in the root
        context, which is what the z-index table in D-S14 assumes. The scrim lives
        inside the root because everything outside it is inert and would ignore
        the click.
      */}
      <div ref={rootRef} id="app-drawer" role="dialog" aria-modal="true" aria-label="Menu" hidden={!displayed}>
        <div
          aria-hidden="true"
          onClick={onClose}
          className={`fixed inset-0 z-[999] bg-black/50 ${exiting ? 'animate-drawer-scrim-out pointer-events-none' : 'animate-drawer-scrim-in'}`}
        />
        <nav
          aria-label="Main"
          className={`fixed inset-y-0 left-0 z-[1000] flex w-80 max-w-full flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)] ${
            exiting ? 'animate-drawer-out pointer-events-none' : 'animate-drawer-in'
          }`}
        >
          {/* 1. Top bar */}
          <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 safe-top">
            <button
              type="button"
              onClick={handleHome}
              aria-label="Home"
              aria-disabled={busy}
              title={busy ? 'Wait for the reply to finish' : undefined}
              className={`rounded-lg px-1 py-1 ${busy ? 'cursor-not-allowed opacity-50' : 'hover:bg-[var(--color-bg-tertiary)]'} ${FOCUS_RING}`}
            >
              <img src="/logo.png" alt="" className="h-8 w-auto" />
            </button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="p-2"
              aria-label="Close menu"
              aria-expanded="true"
              aria-controls="app-drawer"
            >
              <X size={20} />
            </Button>
          </div>

          {/* 2. Current chat (nothing while the hero is showing) */}
          <CurrentChatCard onAbout={setPreviewCharacter} />

          {/* 3. Sections */}
          <div id="app-drawer-scroll" ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto scroll-py-2">
            {/* Pull-to-refresh indicator */}
            {(pullDistance > 0 || isRefreshing) && (
              <div
                className="flex items-center justify-center overflow-hidden transition-all"
                style={{ height: isRefreshing ? 40 : pullDistance }}
              >
                <Loader2
                  size={18}
                  className={`text-[var(--color-primary)] ${isRefreshing ? 'animate-spin' : ''}`}
                  style={{ opacity: Math.min(1, pullDistance / 60) }}
                />
              </div>
            )}

            <SidebarSection
              id="characters"
              label="My Characters"
              level={2}
              open={sections.characters}
              onToggle={() => toggleSection('characters')}
              actions={characterActions}
            >
              {/* Search & Filters */}
              <div className="space-y-2 border-b border-[var(--color-border)] p-3">
                <div className="relative">
                  <Search
                    size={18}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]"
                  />
                  <Input
                    type="search"
                    id="character-search"
                    name="character-search"
                    autoComplete="off"
                    placeholder="Search characters..."
                    aria-label="Search characters"
                    className="pl-10"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                {/* Filter controls */}
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                    aria-label="Show favorites only"
                    aria-pressed={showFavoritesOnly}
                    className={`flex min-h-8 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${FOCUS_RING} ${
                      showFavoritesOnly
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                    }`}
                  >
                    <Star size={12} fill={showFavoritesOnly ? 'currentColor' : 'none'} />
                    Favorites
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowFilters(!showFilters)}
                    aria-label="Filter by tags"
                    aria-expanded={showFilters}
                    className={`flex min-h-8 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${FOCUS_RING} ${
                      showFilters || selectedTags.size > 0
                        ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                    }`}
                  >
                    <Filter size={12} />
                    Tags
                    {selectedTags.size > 0 && (
                      <span className="rounded bg-[var(--color-primary)] px-1 text-[10px] text-white">
                        {selectedTags.size}
                      </span>
                    )}
                  </button>
                  <span className="flex items-center">
                    <select
                      value={sortMode}
                      onChange={(e) => setSortMode(e.target.value as never)}
                      aria-label="Sort characters"
                      className="flex min-h-8 cursor-pointer appearance-none items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    >
                      <option value="name">Name</option>
                      <option value="date_added">Recently added</option>
                      <option value="date_last_chat">Recent chat</option>
                    </select>
                    <ArrowUpDown size={12} className="-ml-1 text-[var(--color-text-secondary)]" />
                  </span>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        clearTagFilters();
                        setShowFavoritesOnly(false);
                        setSearchQuery('');
                      }}
                      aria-label="Clear all filters"
                      className={`ml-auto min-h-8 rounded-md px-2 text-xs text-[var(--color-text-secondary)] underline hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Tag filter chips */}
                {showFilters && allTags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {allTags.map((tag) => {
                      const isSelected = selectedTags.has(tag);
                      return (
                        <button
                          type="button"
                          key={tag}
                          onClick={() => toggleTagFilter(tag)}
                          aria-pressed={isSelected}
                          className={`rounded-full px-2 py-1 text-xs transition-colors ${FOCUS_RING} ${
                            isSelected
                              ? 'bg-[var(--color-primary)] text-white'
                              : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]'
                          }`}
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Drafts strip */}
              {canCreateCharacters && !isGroupSelectMode && (interviewDraft || manualDraft) && (
                <div className="flex flex-col gap-1.5 border-b border-[var(--color-border)] p-3">
                  {interviewDraft && (
                    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2">
                      <button
                        type="button"
                        onClick={handleResumeInterviewDraft}
                        className={`min-w-0 flex-1 truncate rounded text-left text-xs text-[var(--color-text-secondary)] ${FOCUS_RING}`}
                      >
                        Resume interview:{' '}
                        <span className="font-medium text-[var(--color-text-primary)]">
                          {draftPreviewName(interviewDraft.payload)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => discardInterviewDraft()}
                        className={`flex-shrink-0 rounded text-xs text-[var(--color-text-secondary)] hover:text-red-400 ${FOCUS_RING}`}
                      >
                        Discard
                      </button>
                    </div>
                  )}
                  {manualDraft && (
                    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2">
                      <button
                        type="button"
                        onClick={handleResumeManualDraft}
                        className={`min-w-0 flex-1 truncate rounded text-left text-xs text-[var(--color-text-secondary)] ${FOCUS_RING}`}
                      >
                        Resume draft:{' '}
                        <span className="font-medium text-[var(--color-text-primary)]">
                          {draftPreviewName(manualDraft.payload)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => discardManualDraft()}
                        className={`flex-shrink-0 rounded text-xs text-[var(--color-text-secondary)] hover:text-red-400 ${FOCUS_RING}`}
                      >
                        Discard
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Character List */}
              <div id="character-list" tabIndex={-1} className="focus:outline-none">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-[var(--color-primary)]" />
                  </div>
                ) : filteredCharacters.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <MessageSquare size={32} className="mx-auto mb-2 text-[var(--color-text-secondary)]" />
                    <p className="text-sm text-[var(--color-text-secondary)]">
                      {activeFilterCount > 0 ? 'No characters match your filters' : 'No characters found'}
                    </p>
                  </div>
                ) : (
                  <ul className="py-2" onKeyDown={handleListKeyDown}>
                    {filteredCharacters.map((character) => {
                      const isInGroup = isCharacterInGroup(character.avatar);
                      const isFav = favorites.has(character.avatar);
                      const isActive = selectedCharacter?.avatar === character.avatar && !isGroupSelectMode;
                      return (
                        <li key={character.avatar} className="group">
                          <div
                            className={`relative flex items-center ${
                              (isGroupSelectMode && isInGroup) || isActive
                                ? 'border-l-2 border-[var(--color-primary)] bg-[var(--color-primary)]/20'
                                : 'hover:bg-[var(--color-bg-tertiary)]'
                            }`}
                          >
                            <button
                              type="button"
                              data-row-primary
                              aria-current={isActive ? 'true' : undefined}
                              aria-pressed={isGroupSelectMode ? isInGroup : undefined}
                              onClick={() => {
                                if (isGroupSelectMode) {
                                  toggleGroupChatCharacter(character.avatar);
                                } else {
                                  handleCharacterSelect(character.avatar);
                                }
                              }}
                              className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left transition-colors ${FOCUS_RING}`}
                            >
                              {/* Checkbox for group select mode */}
                              {isGroupSelectMode && (
                                <div
                                  className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 ${
                                    isInGroup
                                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]'
                                      : 'border-[var(--color-text-secondary)]'
                                  }`}
                                >
                                  {isInGroup && <Check size={14} className="text-white" />}
                                </div>
                              )}
                              <Avatar src={getThumbnailUrl(character.avatar)} alt={character.name} size="md" />
                              <div className="min-w-0 flex-1">
                                <p
                                  className={`truncate text-sm text-[var(--color-text-primary)] ${
                                    isActive ? 'font-semibold' : 'font-medium'
                                  }`}
                                >
                                  {character.name}
                                </p>
                                {firstSentence(character.creator_notes) && (
                                  <p className="truncate text-xs text-[var(--color-text-secondary)]">
                                    {firstSentence(character.creator_notes)}
                                  </p>
                                )}
                                {(() => {
                                  const tags = character.tags || character.data?.tags || [];
                                  if (tags.length === 0) return null;
                                  return (
                                    <div className="mt-0.5 flex flex-wrap gap-1">
                                      {tags.slice(0, 3).map((tag) => (
                                        <span
                                          key={tag}
                                          className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0 text-[10px] leading-4 text-[var(--color-text-secondary)]"
                                        >
                                          {tag}
                                        </span>
                                      ))}
                                      {tags.length > 3 && (
                                        <span className="text-[10px] leading-4 text-[var(--color-text-secondary)]">
                                          +{tags.length - 3}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            </button>
                            {!isGroupSelectMode && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    haptic();
                                    setPreviewCharacter(character);
                                  }}
                                  className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition-opacity hover:text-[var(--color-primary)] ${ROW_ACTION_VISIBILITY} ${FOCUS_RING}`}
                                  title={`About ${character.name}`}
                                  aria-label={`About ${character.name}`}
                                >
                                  <Info size={16} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => toggleFavorite(character.avatar)}
                                  className={`mr-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-opacity ${FOCUS_RING} ${
                                    isFav
                                      ? 'text-yellow-400 opacity-100'
                                      : `text-[var(--color-text-secondary)] hover:text-yellow-400 ${ROW_ACTION_VISIBILITY}`
                                  }`}
                                  title={isFav ? 'Unfavorite' : 'Favorite'}
                                  aria-label={`Favorite ${character.name}`}
                                  aria-pressed={isFav}
                                >
                                  <Star size={16} fill={isFav ? 'currentColor' : 'none'} />
                                </button>
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Group Chats, nested under My Characters (D-S7) */}
              {groupChats.length > 0 && !isGroupSelectMode && (
                <SidebarSection
                  id="groups"
                  label="Group chats"
                  level={3}
                  count={groupChats.length}
                  open={sections.groups}
                  onToggle={() => toggleSection('groups')}
                >
                  <ul className="pb-2">
                    {groupChats.map((groupChat) => (
                      <li key={groupChat.fileName} className="group">
                        <div className="flex items-center hover:bg-[var(--color-bg-tertiary)]">
                          <button
                            type="button"
                            onClick={() => handleGroupChatSelect(groupChat)}
                            className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2 pl-8 pr-2 text-left ${FOCUS_RING}`}
                          >
                            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/20">
                              <Users size={18} className="text-[var(--color-primary)]" />
                            </div>
                            <div className="min-w-0 flex-1 text-left">
                              <p className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                                {groupChat.characterNames.join(', ')}
                              </p>
                              <p className="truncate text-xs text-[var(--color-text-secondary)]">
                                {groupChat.lastMessage || 'No messages yet'}
                              </p>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteGroupChat(groupChat.fileName)}
                            className={`mr-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition-opacity hover:text-red-400 ${ROW_ACTION_VISIBILITY} ${FOCUS_RING}`}
                            aria-label="Delete group chat"
                            title="Delete group chat"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </SidebarSection>
              )}
            </SidebarSection>

            {/* Works — the project container above chats */}
            {canViewWorks && !isGroupSelectMode && (
              <SidebarSection
                id="works"
                label="Works"
                level={2}
                count={works.length}
                open={sections.works}
                onToggle={() => toggleSection('works')}
              >
                <ul className="pb-2">
                  {works.map((work) => (
                    <li key={work.id}>
                      <button
                        type="button"
                        onClick={() => {
                          haptic();
                          onClose();
                          openWorksPanel(work.id);
                        }}
                        className={`flex min-h-11 w-full items-center gap-3 px-4 py-2 hover:bg-[var(--color-bg-tertiary)] ${FOCUS_RING}`}
                      >
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/20">
                          <Library size={18} className="text-[var(--color-primary)]" />
                        </div>
                        <div className="min-w-0 flex-1 text-left">
                          <p
                            className={`truncate text-sm font-medium ${
                              work.status === 'archived'
                                ? 'text-[var(--color-text-secondary)]'
                                : 'text-[var(--color-text-primary)]'
                            }`}
                          >
                            {work.name}
                          </p>
                          <p className="truncate text-xs text-[var(--color-text-secondary)]">
                            {work.chat_count} chat{work.chat_count === 1 ? '' : 's'} ·{' '}
                            {work.character_count} character{work.character_count === 1 ? '' : 's'}
                            {work.status === 'archived' ? ' · archived' : ''}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                  {canManageWorks && (
                    <li>
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          openWorksPanel();
                        }}
                        className={`flex min-h-11 w-full items-center gap-3 px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] ${FOCUS_RING}`}
                      >
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--color-border)]">
                          <Plus size={16} />
                        </div>
                        {works.length === 0 ? 'Start your first work' : 'New work'}
                      </button>
                    </li>
                  )}
                </ul>
              </SidebarSection>
            )}
          </div>

          {/* Group selection's action bar: a sibling of the scroller, never over it */}
          {isGroupSelectMode && (
            <div className="flex-shrink-0 border-t border-[var(--color-border)] p-3">
              <Button
                variant="primary"
                className="w-full"
                onClick={() => {
                  if (groupChatCharacters.length >= 2) {
                    startGroupChat();
                    startNewGroupChat(groupChatCharacters);
                    setIsGroupSelectMode(false);
                    onClose();
                  }
                }}
                disabled={groupChatCharacters.length < 2}
              >
                <Users size={18} className="mr-2" />
                Start Group Chat ({groupChatCharacters.length}/2+)
              </Button>
            </div>
          )}

          {/* 4. Personal, pinned */}
          <PersonalSection
            open={sections.personal}
            onToggle={() => toggleSection('personal')}
            onClose={onClose}
            onPersonaSurfaceChange={setPersonaSurfaceOpen}
          />
        </nav>
      </div>

      {/* Character Creation Modal — plain form, reached via the interview
          wizard's "Use the simple form instead" escape hatch, or the
          "Resume draft" row above when a saved manual-form draft exists. */}
      <CharacterCreation
        key={manualResumeKey}
        isOpen={showCreateModal}
        onClose={() => {
          setShowCreateModal(false);
          setResumeManualData(undefined);
        }}
        onCreated={handleCharacterCreated}
        initialData={resumeManualData}
      />

      {/* Character Interview Wizard — default "New" flow */}
      <CharacterInterview
        isOpen={showInterviewModal}
        onClose={() => setShowInterviewModal(false)}
        onCreated={handleCharacterCreated}
        onUseSimpleForm={() => {
          setShowInterviewModal(false);
          setShowCreateModal(true);
        }}
      />

      {/* Character Import Modal */}
      <CharacterImport
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImported={handleCharacterImported}
      />

      {/* Character Preview Modal — read-only details view shown before
          committing to opening a chat. Triggered by the per-row info button
          and the current-chat card's About. */}
      <CharacterPreviewModal
        isOpen={previewCharacter !== null}
        character={previewCharacter}
        onClose={() => setPreviewCharacter(null)}
        onStartChat={(avatar) => {
          setPreviewCharacter(null);
          handleCharacterSelect(avatar);
        }}
      />
    </>
  );
}
