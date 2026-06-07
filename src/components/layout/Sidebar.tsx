import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import {
  X,
  Search,
  Plus,
  MessageSquare,
  Users,
  ChevronLeft,
  UserPlus,
  Check,
  Trash2,
  Upload,
  Star,
  Filter,
  ArrowUpDown,
  Loader2,
  Info,
} from 'lucide-react';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore, type GroupChatInfo } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { can } from '../../utils/permissions';
import { haptic } from '../../utils/haptics';
import { Avatar, Button, Input } from '../ui';
import { CharacterCreation } from '../character/CharacterCreation';
import { CharacterImport } from '../character/CharacterImport';
import { CharacterPreviewModal } from '../character/CharacterPreviewModal';
import { CharacterRichText } from '../character/CharacterRichText';
import { htmlToPlainText } from '../../utils/characterRichText';
import type { CharacterInfo } from '../../api/client';
import { useCharacterSprites } from '../../hooks/useCharacterSprites';
import { getDefaultAvatarUrl, type Emotion } from '../../utils/emotions';
import { LivePortraitVideo } from '../chat/LivePortraitVideo';
import { useLivePortraitDiscovery } from '../../hooks/useLivePortraitDiscovery';
import { MotionModePicker } from '../character/MotionModePicker';
import { useMotionModeStore, resolveMotionMode } from '../../stores/motionModeStore';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

// Condensed teaser for list rows / the collapsed portrait blurb. Strips any
// HTML markup first so notes that opted into rich formatting show clean text
// here instead of a half-open tag, then clips to the first sentence.
function firstSentence(text?: string): string {
  const plain = htmlToPlainText(text);
  if (!plain) return '';
  const idx = plain.search(/[.!?]/);
  return (idx === -1 ? plain : plain.slice(0, idx + 1)).trim();
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { currentUser } = useAuthStore();
  const userRole = currentUser?.role;
  const canCreateCharacters = can(userRole, 'character:create');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showCharacterList, setShowCharacterList] = useState(false);
  const [failedExpressions, setFailedExpressions] = useState<Set<string>>(new Set());
  const [descExpanded, setDescExpanded] = useState(false);
  const [isGroupSelectMode, setIsGroupSelectMode] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [previewCharacter, setPreviewCharacter] = useState<CharacterInfo | null>(null);
  const {
    selectedCharacter,
    isLoading,
    fetchCharacters,
    selectCharacter,
    groupChatCharacters,
    toggleGroupChatCharacter,
    startGroupChat,
    exitGroupChat,
    isCharacterInGroup,
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
  } = useCharacterStore();
  const { messages, startNewGroupChat, groupChats, loadGroupChat, deleteGroupChat } = useChatStore();
  const [showGroupChats, setShowGroupChats] = useState(false);

  const filteredCharacters = getFilteredCharacters();
  const allTags = getAllTags();
  const activeFilterCount =
    selectedTags.size + (showFavoritesOnly ? 1 : 0) + (searchQuery.trim() ? 1 : 0);

  // Fetch actual sprite paths from API (hook extracts character name from avatar filename)
  const { getSpritePath, availableEmotions } = useCharacterSprites(selectedCharacter?.avatar);

  // Get the latest character message's emotion for the portrait
  const latestEmotion = useMemo(() => {
    const characterMessages = messages.filter((m) => !m.isUser && !m.isSystem);
    if (characterMessages.length === 0) return null;
    return (characterMessages[characterMessages.length - 1] as { emotion?: Emotion | null }).emotion ?? null;
  }, [messages]);

  const {
    clips: livePortraitClips,
    hasClips: hasLivePortraitClips,
    loading: livePortraitLoading,
  } = useLivePortraitDiscovery(selectedCharacter?.avatar);
  const hasExpressionSprites = availableEmotions.length > 0;
  const motionMode = useMotionModeStore((s) =>
    selectedCharacter ? s.modesByAvatar[selectedCharacter.avatar] ?? 'auto' : 'auto',
  );
  const resolvedMotionMode = resolveMotionMode(
    motionMode,
    hasLivePortraitClips,
    hasExpressionSprites,
  );
  const hasLivePortrait = resolvedMotionMode === 'liveportrait';
  const portraitEmotion = resolvedMotionMode === 'expressions' ? latestEmotion : null;

  useEffect(() => {
    fetchCharacters();
  }, [fetchCharacters]);

  // Phase 6.3: Pull-to-refresh on character list
  const charListRef = useRef<HTMLDivElement>(null);
  const { pullDistance, isRefreshing } = usePullToRefresh(charListRef, fetchCharacters);

  // When a character is selected, hide the list (show portrait)
  useEffect(() => {
    if (selectedCharacter) {
      setShowCharacterList(false);
      setFailedExpressions(new Set());
      setDescExpanded(false);
    }
  }, [selectedCharacter]);

  const handleCharacterCreated = (avatarUrl: string) => {
    selectCharacter(avatarUrl);
    setShowCharacterList(false);
    onClose();
  };

  const handleCharacterImported = (avatarUrl: string) => {
    selectCharacter(avatarUrl);
    setShowCharacterList(false);
    onClose();
  };

  const handleCharacterSelect = (avatar: string) => {
    haptic();
    selectCharacter(avatar);
    setShowCharacterList(false);
    onClose();
  };

  const handleGroupChatSelect = async (groupChat: GroupChatInfo) => {
    // Set up group chat mode with the characters from the saved group chat
    await setGroupChatCharacters(groupChat.characterAvatars);
    loadGroupChat(groupChat);
    setShowGroupChats(false);
    setShowCharacterList(false);
    onClose();
  };

  const handleDeleteGroupChat = (e: React.MouseEvent, fileName: string) => {
    e.stopPropagation();
    if (confirm('Delete this group chat?')) {
      deleteGroupChat(fileName);
    }
  };

  // Thumbnail URL for small avatars in list. ST's /thumbnail is gone in B1;
  // browsers down-scale the full PNG client-side.
  const getThumbnailUrl = (avatar: string) => `/blobs/character/${encodeURIComponent(avatar)}`;

  // Full-size image URL for portrait view (with expression support)
  const getFullImageUrl = useCallback(
    (avatar: string, emotion?: Emotion | null) => {
      const expressionKey = `${avatar}-${emotion}`;

      // Check if this expression previously failed
      if (emotion && failedExpressions.has(expressionKey)) {
        const fallback = getDefaultAvatarUrl(avatar);
        console.log('[Sidebar Expression] Using fallback:', { emotion, fallback });
        return fallback;
      }

      // Try to use actual sprite path from API
      if (emotion) {
        const spritePath = getSpritePath(emotion);
        if (spritePath) {
          console.log('[Sidebar Expression] Using API sprite path:', { emotion, path: spritePath });
          return spritePath;
        }
      }

      // Fall back to default avatar
      const fallback = getDefaultAvatarUrl(avatar);
      console.log('[Sidebar Expression] No sprite found, using default:', { avatar, emotion, fallback });
      return fallback;
    },
    [getSpritePath, failedExpressions]
  );

  // Determine what to show: character portrait or character list
  const showPortrait = selectedCharacter && !showCharacterList;

  return (
    <>
      {/* Overlay (Mobile) */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          w-72 bg-[var(--color-bg-secondary)]
          border-r border-[var(--color-border)]
          flex flex-col
          transform transition-transform duration-200 ease-in-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        {showPortrait ? (
          /* Character Portrait View */
          <>
            {/* Header with switch button */}
            <div className="h-14 flex items-center justify-between px-4 border-b border-[var(--color-border)] safe-top">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCharacterList(true)}
                className="p-2 -ml-2"
                aria-label="Switch character"
              >
                <Users size={20} />
              </Button>
              <h2 className="font-semibold text-[var(--color-text-primary)] truncate flex-1 text-center px-2">
                {selectedCharacter.name}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="lg:hidden p-2 -mr-2"
                aria-label="Close sidebar"
              >
                <X size={20} />
              </Button>
            </div>

            {/* Full Character Portrait */}
            <div className="flex-1 flex flex-col items-center justify-center p-4 overflow-hidden">
              <div className="relative w-full max-w-[240px] aspect-[2/3] rounded-xl overflow-hidden shadow-lg border border-[var(--color-border)]">
                {hasLivePortrait ? (
                  <LivePortraitVideo
                    clips={livePortraitClips!}
                    emotion={latestEmotion}
                    fill
                    shape="square"
                  />
                ) : (
                  <img
                    key={`${selectedCharacter.avatar}-${portraitEmotion ?? 'neutral'}`}
                    src={getFullImageUrl(selectedCharacter.avatar, portraitEmotion)}
                    alt={selectedCharacter.name}
                    className="w-full h-full object-cover transition-opacity duration-300"
                    onLoad={(e) => {
                      console.log('[Sidebar Expression] Image loaded:', e.currentTarget.src);
                    }}
                    onError={(e) => {
                      console.log('[Sidebar Expression] Image FAILED:', e.currentTarget.src);
                      if (latestEmotion) {
                        const expressionKey = `${selectedCharacter.avatar}-${latestEmotion}`;
                        setFailedExpressions((prev) => new Set(prev).add(expressionKey));
                      }
                    }}
                  />
                )}
                {livePortraitLoading && !hasLivePortrait && (
                  <div className="absolute bottom-2 right-2 rounded-full bg-black/40 p-1.5 backdrop-blur-sm">
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  </div>
                )}
              </div>

              {/* Motion mode picker */}
              <div className="mt-3 w-full px-2">
                <MotionModePicker
                  avatar={selectedCharacter.avatar}
                  hasLivePortraitClips={hasLivePortraitClips}
                  hasExpressionSprites={hasExpressionSprites}
                />
              </div>

              {/* Character Info */}
              <div className="mt-3 text-center w-full px-2">
                <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {selectedCharacter.name}
                </h3>
                {latestEmotion && (
                  <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] capitalize">
                    {latestEmotion}
                  </span>
                )}
                {firstSentence(selectedCharacter.creator_notes) && (
                  <div className="mt-2 text-left w-full">
                    {descExpanded ? (
                      // Full notes: render any creator HTML/CSS (sanitised +
                      // style-isolated inside .character-rich).
                      <CharacterRichText
                        content={selectedCharacter.creator_notes ?? ''}
                      />
                    ) : (
                      <p className="text-sm text-[var(--color-text-secondary)] line-clamp-3">
                        {firstSentence(selectedCharacter.creator_notes)}
                      </p>
                    )}
                    {htmlToPlainText(selectedCharacter.creator_notes).length > 150 && (
                      <button
                        onClick={() => setDescExpanded(!descExpanded)}
                        className="text-xs text-[var(--color-primary)] hover:underline mt-1"
                      >
                        {descExpanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Switch Character Button */}
            <div className="p-3 pb-4 border-t border-[var(--color-border)] input-safe-bottom">
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => setShowCharacterList(true)}
              >
                <Users size={18} className="mr-2" />
                Switch Character
              </Button>
            </div>
          </>
        ) : (
          /* Character List View */
          <>
            {/* Sidebar Header */}
            <div className="h-14 flex items-center justify-between px-4 border-b border-[var(--color-border)] safe-top">
              {selectedCharacter && !isGroupSelectMode ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCharacterList(false)}
                  className="p-2 -ml-2"
                  aria-label="Back to character"
                >
                  <ChevronLeft size={20} />
                </Button>
              ) : isGroupSelectMode ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsGroupSelectMode(false);
                    exitGroupChat();
                  }}
                  className="p-2 -ml-2"
                  aria-label="Cancel group selection"
                >
                  <X size={20} />
                </Button>
              ) : (
                <div className="w-9" />
              )}
              <h2 className="font-semibold text-[var(--color-text-primary)]">
                {isGroupSelectMode ? `Group Chat (${groupChatCharacters.length})` : 'Characters'}
              </h2>
              <div className="flex items-center gap-1">
                {!isGroupSelectMode && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsGroupSelectMode(true)}
                    className="p-2"
                    aria-label="Start group chat"
                    title="Group Chat"
                  >
                    <UserPlus size={20} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  className="lg:hidden p-2 -mr-2"
                  aria-label="Close sidebar"
                >
                  <X size={20} />
                </Button>
              </div>
            </div>

            {/* Search & Filters */}
            <div className="p-3 border-b border-[var(--color-border)] space-y-2">
              <div className="relative">
                <Search
                  size={18}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]"
                />
                <Input
                  type="search"
                  placeholder="Search characters..."
                  className="pl-10"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              {/* Filter controls */}
              <div className="flex flex-wrap items-center gap-1">
                <button
                  onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
                    showFavoritesOnly
                      ? 'bg-yellow-500/20 text-yellow-400'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                  }`}
                  title="Show favorites only"
                >
                  <Star size={12} fill={showFavoritesOnly ? 'currentColor' : 'none'} />
                  <span className="hidden sm:inline">Favorites</span>
                </button>
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
                    showFilters || selectedTags.size > 0
                      ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                  }`}
                  title="Tag filters"
                >
                  <Filter size={12} />
                  <span className="hidden sm:inline">Tags</span>
                  {selectedTags.size > 0 && (
                    <span className="bg-[var(--color-primary)] text-white px-1 rounded text-[10px]">
                      {selectedTags.size}
                    </span>
                  )}
                </button>
                <span className="flex items-center">
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as never)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-[var(--color-text-secondary)] bg-transparent hover:bg-[var(--color-bg-tertiary)] cursor-pointer appearance-none focus:outline-none"
                    title="Sort mode"
                  >
                    <option value="name">Name</option>
                    <option value="date_added">Recently added</option>
                    <option value="date_last_chat">Recent chat</option>
                  </select>
                  <ArrowUpDown size={12} className="text-[var(--color-text-secondary)] -ml-1" />
                </span>
                {activeFilterCount > 0 && (
                  <button
                    onClick={() => {
                      clearTagFilters();
                      setShowFavoritesOnly(false);
                      setSearchQuery('');
                    }}
                    className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] underline"
                    title="Clear all filters"
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
                        key={tag}
                        onClick={() => toggleTagFilter(tag)}
                        className={`text-xs px-2 py-1 rounded-full transition-colors ${
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

            {/* Character List */}
            <div ref={charListRef} className="flex-1 overflow-y-auto">
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
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--color-primary)]" />
                </div>
              ) : filteredCharacters.length === 0 ? (
                <div className="text-center py-8 px-4">
                  <MessageSquare size={32} className="mx-auto text-[var(--color-text-secondary)] mb-2" />
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    {activeFilterCount > 0
                      ? 'No characters match your filters'
                      : 'No characters found'}
                  </p>
                </div>
              ) : (
                <ul className="py-2">
                  {filteredCharacters.map((character) => {
                    const isInGroup = isCharacterInGroup(character.avatar);
                    const isFav = favorites.has(character.avatar);
                    return (
                      <li key={character.avatar} className="group">
                        <div
                          className={`
                            relative flex items-center
                            ${
                              isGroupSelectMode && isInGroup
                                ? 'bg-[var(--color-primary)]/20 border-l-2 border-[var(--color-primary)]'
                                : selectedCharacter?.avatar === character.avatar && !isGroupSelectMode
                                  ? 'bg-[var(--color-primary)]/20 border-l-2 border-[var(--color-primary)]'
                                  : 'hover:bg-[var(--color-bg-tertiary)]'
                            }
                          `}
                        >
                          <button
                            onClick={() => {
                              if (isGroupSelectMode) {
                                toggleGroupChatCharacter(character.avatar);
                              } else {
                                handleCharacterSelect(character.avatar);
                              }
                            }}
                            className="flex-1 flex items-center gap-3 px-4 py-3 text-left transition-colors min-w-0"
                          >
                            {/* Checkbox for group select mode */}
                            {isGroupSelectMode && (
                              <div
                                className={`
                                  w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0
                                  ${
                                    isInGroup
                                      ? 'bg-[var(--color-primary)] border-[var(--color-primary)]'
                                      : 'border-[var(--color-text-secondary)]'
                                  }
                                `}
                              >
                                {isInGroup && <Check size={14} className="text-white" />}
                              </div>
                            )}
                            <Avatar
                              src={getThumbnailUrl(character.avatar)}
                              alt={character.name}
                              size="md"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                                {character.name}
                              </p>
                              {firstSentence(character.creator_notes) && (
                                <p className="text-xs text-[var(--color-text-secondary)] truncate">
                                  {firstSentence(character.creator_notes)}
                                </p>
                              )}
                              {(() => {
                                const tags = character.tags || character.data?.tags || [];
                                if (tags.length === 0) return null;
                                return (
                                  <div className="flex flex-wrap gap-1 mt-0.5">
                                    {tags.slice(0, 3).map((tag) => (
                                      <span
                                        key={tag}
                                        className="text-[10px] px-1.5 py-0 leading-4 bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] rounded-full border border-[var(--color-border)]"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                    {tags.length > 3 && (
                                      <span className="text-[10px] text-[var(--color-text-secondary)] leading-4">
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
                                onClick={(e) => {
                                  e.stopPropagation();
                                  haptic();
                                  setPreviewCharacter(character);
                                }}
                                className="p-2 rounded-lg text-[var(--color-text-secondary)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-primary)] transition-opacity"
                                title={`Preview ${character.name}`}
                                aria-label={`Preview ${character.name}`}
                              >
                                <Info size={16} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFavorite(character.avatar);
                                }}
                                className={`p-2 mr-2 rounded-lg transition-opacity ${
                                  isFav
                                    ? 'text-yellow-400 opacity-100'
                                    : 'text-[var(--color-text-secondary)] opacity-0 group-hover:opacity-100 hover:text-yellow-400'
                                }`}
                                title={isFav ? 'Unfavorite' : 'Favorite'}
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

            {/* Group Chats Section */}
            {groupChats.length > 0 && !isGroupSelectMode && (
              <div className="border-t border-[var(--color-border)]">
                <button
                  onClick={() => setShowGroupChats(!showGroupChats)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <span className="flex items-center gap-2">
                    <Users size={16} />
                    Group Chats ({groupChats.length})
                  </span>
                  <ChevronLeft
                    size={16}
                    className={`transform transition-transform ${showGroupChats ? '-rotate-90' : ''}`}
                  />
                </button>
                {showGroupChats && (
                  <ul className="pb-2">
                    {groupChats.map((groupChat) => (
                      <li key={groupChat.fileName}>
                        <button
                          onClick={() => handleGroupChatSelect(groupChat)}
                          className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--color-bg-tertiary)] group"
                        >
                          <div className="w-10 h-10 rounded-full bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0">
                            <Users size={18} className="text-[var(--color-primary)]" />
                          </div>
                          <div className="flex-1 min-w-0 text-left">
                            <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                              {groupChat.characterNames.join(', ')}
                            </p>
                            <p className="text-xs text-[var(--color-text-secondary)] truncate">
                              {groupChat.lastMessage || 'No messages yet'}
                            </p>
                          </div>
                          <button
                            onClick={(e) => handleDeleteGroupChat(e, groupChat.fileName)}
                            className="p-1.5 text-[var(--color-text-secondary)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete group chat"
                          >
                            <Trash2 size={14} />
                          </button>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Footer Buttons */}
            <div className="p-3 pb-4 border-t border-[var(--color-border)] input-safe-bottom">
              {isGroupSelectMode ? (
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
              ) : canCreateCharacters ? (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onClick={() => setShowImportModal(true)}
                  >
                    <Upload size={18} className="mr-2" />
                    Import
                  </Button>
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onClick={() => setShowCreateModal(true)}
                  >
                    <Plus size={18} className="mr-2" />
                    New
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </aside>

      {/* Character Creation Modal */}
      <CharacterCreation
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={handleCharacterCreated}
      />

      {/* Character Import Modal */}
      <CharacterImport
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImported={handleCharacterImported}
      />

      {/* Character Preview Modal — read-only details view shown before
          committing to opening a chat. Triggered by the per-row info button. */}
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
