import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, Users, Settings2, Pencil, Square, Search, ChevronUp, ChevronDown, X, Check, Clapperboard, PanelTopClose, PanelTopOpen, Wallpaper } from 'lucide-react';
import { showToastGlobal } from '../ui/Toast';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore } from '../../stores/chatStore';
import { useSelfieStore, baseSelfieEligible } from '../../stores/selfieStore';
// Side-effect import: registers the in-chat [selfie: …] finish-edge dispatch
// (its module-level useChatStore.subscribe). Imported here — a runtime component,
// loaded after the stores initialize — so the subscription never runs during
// chatStore's own module init. See stores/selfieDispatch.
import { triggerSelfie } from '../../stores/selfieDispatch';
import { TakeSelfieModal } from './TakeSelfieModal';
import type { SelfieTier } from '../../api/selfieGen';
import { useProjectStore } from '../../stores/projectStore';
import { usePersonaStore } from '../../stores/personaStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { processMacros, type MacroContext } from '../../utils/macros';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { UsageGauge } from './UsageGauge';
import { ChatOptionsMenu } from './ChatOptionsMenu';
import { BottomSheet } from '../ui/BottomSheet';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { ChatLorePanel } from './lore/ChatLorePanel';
import { LoreConflictChip } from './lore/LoreConflictChip';
import { ConflictResolutionSheet } from '../worldinfo/ConflictResolutionSheet';
import { ChatStyleModal } from './ChatStyleModal';
import { CHAT_STYLE_NONE } from '../../utils/chatStyles';
import { GenerateLorebookModal } from '../worldinfo/GenerateLorebookModal';
import { GenerateSceneModal } from './GenerateSceneModal';
import type { TranscriptMsg } from '../../utils/lorebookFromTranscript';
import { useWorldInfoStore } from '../../stores/worldInfoStore';
import { useChatLoreConfigStore } from '../../stores/chatLoreConfigStore';
import { useLoreConflictStore } from '../../stores/loreConflictStore';
import { GroupChatControls } from './GroupChatControls';
import { AuthorNote } from './AuthorNote';
import { SummaryPanel } from './SummaryPanel';
import { BranchPanel } from './BranchPanel';
import { useBranchStore } from '../../stores/branchStore';
import { TypingIndicator } from './TypingIndicator';
import { ImageGenModal } from './ImageGenModal';
import { QuickReplyBar } from './QuickReplyBar';
import { useExtensionStore } from '../../stores/extensionStore';
import { useExpressionsStore } from '../../stores/expressionsStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useOrientation } from '../../hooks/useOrientation';
import { useKeyboardHeight } from '../../hooks/useKeyboardHeight';
import { useSummarizeStore } from '../../stores/summarizeStore';
import { useAutoMemoryStore } from '../../stores/autoMemoryStore';
import { useCharacterSprites } from '../../hooks/useCharacterSprites';
import { LivePortraitVideo } from './LivePortraitVideo';
import { useLivePortraitDiscovery } from '../../hooks/useLivePortraitDiscovery';
import { useMotionModeStore, resolveMotionMode } from '../../stores/motionModeStore';
import { MotionModePicker } from '../character/MotionModePicker';
import { useGenerationStore } from '../../stores/generationStore';
import { usePromptTemplateStore } from '../../stores/promptTemplateStore';
import { usePortraitPositionStore } from '../../stores/portraitPositionStore';
import {
  getExpressionThumbnailUrl,
  getDefaultAvatarUrl,
  mapEmotionToAvailable,
  stripEmotionTag,
  type Emotion,
} from '../../utils/emotions';
import { generateSceneVideo } from '../../api/sceneVideoGen';
import { useAuthStore } from '../../stores/authStore';
import { hasPermission } from '../../utils/permissions';
import {
  compressImageFiles,
  ACCEPTED_IMAGE_MIMES,
} from '../../utils/images';
import { getTtsAutoRead } from '../../hooks/speechLanguage';
import { speakText } from '../../hooks/useSpeechSynthesis';
import {
  getMobilePortraitHeight,
  setMobilePortraitHeight,
  clampPortraitHeight,
  MIN_PORTRAIT_HEIGHT,
  MAX_PORTRAIT_HEIGHT,
  PORTRAIT_HEIGHT_STEP,
  getMobilePortraitCollapsed,
  setMobilePortraitCollapsed,
} from '../../hooks/mobilePortraitHeight';
import {
  getChatLayoutMode,
  getAvatarShape,
  getChatFontSize,
  getChatMaxWidth,
  getVnBgForCharacter,
  setVnBgForCharacter,
  clearVnBgForCharacter,
  getVnBgGlobal,
  setVnBgGlobal,
  clearVnBgGlobal,
  getCostume,
} from '../../hooks/displayPreferences';
import { useDisplayPreferencesStore } from '../../stores/displayPreferencesStore';
import { fireSandboxLifecycleEvent } from '../../extensions/sandbox/sandboxEventBus';

// How many of the most recent messages render on open, and how many more each
// "Load older" click reveals. Purely a render window — the store still holds
// (and saves) the whole chat, so nothing that reads `messages` is affected.
const MESSAGE_PAGE_SIZE = 20;

// Search / send-to-background / collapse-toggle button trio shared by the
// mobile portrait header (expanded) and the collapsed character bar — kept
// as one implementation so the two states can't drift out of sync.
function PortraitHeaderActions({
  variant,
  onSearch,
  onBackground,
  onToggleCollapse,
}: {
  variant: 'expanded' | 'collapsed';
  onSearch: () => void;
  onBackground: () => void;
  onToggleCollapse: () => void;
}) {
  const isExpanded = variant === 'expanded';
  const buttonClass = isExpanded
    ? 'p-1.5 rounded-full bg-black/30 text-white/80 backdrop-blur-sm hover:bg-black/50 transition-colors'
    : 'p-1.5 rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors';
  return (
    <>
      <button onClick={onSearch} className={buttonClass} aria-label="Search messages" title="Search messages">
        <Search size={15} />
      </button>
      <button onClick={onBackground} className={buttonClass} aria-label="Send character to background" title="Send character to background">
        <Wallpaper size={15} />
      </button>
      <button
        onClick={onToggleCollapse}
        className={buttonClass}
        aria-label={isExpanded ? 'Close character view' : 'Show character view'}
        title={isExpanded ? 'Close character view' : 'Show character view'}
      >
        {isExpanded ? <PanelTopClose size={15} /> : <PanelTopOpen size={15} />}
      </button>
    </>
  );
}

export function ChatView() {
  const routerNavigate = useNavigate();
  const storeSetVnMode = useDisplayPreferencesStore(s => s.setVnMode);
  const storeSetCostume = useDisplayPreferencesStore(s => s.setCostume);
  const storeClearCostume = useDisplayPreferencesStore(s => s.clearCostume);
  // Transient "📸 … is taking a selfie" indicator (Phase 2 in-chat selfie).
  const selfieGeneratingFor = useSelfieStore((s) => s.generatingFor);
  const { selectedCharacter, isGroupChatMode, groupChatCharacters, exitGroupChat, characters: allCharacters } = useCharacterStore();
  const {
    messages,
    isSending,
    isStreaming,
    error,
    sendMessage,
    sendGroupMessage,
    startNewChat,
    fetchChatFiles,
    loadChat,
    chatFiles,
    clearChat,
    editMessageAndRegenerate,
    editMessage,
    deleteMessage,
    toggleMessageHidden,
    swipeLeft,
    swipeRight,
    regenerateMessage,
    continueMessage,
    impersonate,
    stopGeneration,
    insertImageMessage,
    insertVideoMessage,
    currentChatFile,
    currentSpeakerName,
    setGroupTitle,
    convertCurrentToGroup,
  } = useChatStore();
  // Subscribe to the current group-chat record for title + strategy display.
  const groupChatRecord = useChatStore((s) =>
    isGroupChatMode && currentChatFile
      ? s.groupChats.find((g) => g.fileName === currentChatFile) || null
      : null
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  /** Whether the user is scrolled near the bottom (within 150px). */
  const isNearBottomRef = useRef(true);
  const lastCharacterRef = useRef<string | null>(null);
  const lastGroupModeRef = useRef<boolean>(false);

  // Phase 7.3: display preferences (read from localStorage on mount/render)
  const chatLayoutMode = getChatLayoutMode();
  const avatarShapePref = getAvatarShape();
  const chatFontSize = getChatFontSize();
  const chatMaxWidth = getChatMaxWidth();
  // Phase 6.4: VN mode — read reactively from the store (not local state) so
  // toggling it from Settings, while ChatView stays mounted underneath the
  // Settings overlay, is reflected immediately instead of going stale.
  const isVnMode = useDisplayPreferencesStore(s => s.vnMode);
  // Phase 6.3: Mobile UX hooks
  const isMobile = useIsMobile();
  const { isLandscape } = useOrientation();
  const keyboardHeight = useKeyboardHeight();
  const isMobileLandscape = isMobile && isLandscape;

  const [failedExpressions, setFailedExpressions] = useState<Set<string>>(new Set());
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined);
  const [portraitHeight, setPortraitHeight] = useState<number>(getMobilePortraitHeight);
  // Mobile: user-collapsed the character portrait to maximize chat reading space.
  const [isPortraitCollapsed, setIsPortraitCollapsedState] = useState<boolean>(getMobilePortraitCollapsed);

  const handlePortraitResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = portraitHeight;
    const viewportHeight = window.innerHeight || 1;
    let latest = startHeight;

    const onMove = (ev: PointerEvent) => {
      latest = clampPortraitHeight(startHeight + (ev.clientY - startY) / viewportHeight);
      setPortraitHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setMobilePortraitHeight(latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [portraitHeight]);

  const handlePortraitResizeKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const delta = e.key === 'ArrowUp' ? -PORTRAIT_HEIGHT_STEP : PORTRAIT_HEIGHT_STEP;
    setPortraitHeight((prev) => {
      const next = clampPortraitHeight(prev + delta);
      setMobilePortraitHeight(next);
      return next;
    });
  }, []);

  const handleTogglePortraitCollapsed = useCallback(() => {
    setIsPortraitCollapsedState((prev) => {
      const next = !prev;
      setMobilePortraitCollapsed(next);
      return next;
    });
  }, []);

  const [prefillNonce, setPrefillNonce] = useState(0);
  const [showGroupControls, setShowGroupControls] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Phase 6.1: drag-drop staging — data URLs to append to ChatInput's
  // attachment set, re-triggered by the nonce so identical payloads fire.
  const [droppedImages, setDroppedImages] = useState<string[]>([]);
  const [droppedImagesNonce, setDroppedImagesNonce] = useState(0);
  const [editLastNonce, setEditLastNonce] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  // Phase 7.1: image generation modal
  const [isImageGenOpen, setIsImageGenOpen] = useState(false);
  // Scene-video: progress (0..1) of the in-flight generation job, or null
  // when idle. One job at a time — generation takes minutes, not seconds.
  const [sceneGenProgress, setSceneGenProgress] = useState<number | null>(null);
  const dragCounter = useRef(0);

  // Chat options menu + controlled panel states
  const [isChatMenuOpen, setIsChatMenuOpen] = useState(false);
  const [chatMenuAnchor, setChatMenuAnchor] = useState<HTMLElement | null>(null);
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState(false);
  const [authorNoteOpen, setAuthorNoteOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [chatLorebookOpen, setChatLorebookOpen] = useState(false);
  // v2 chat-lore config (linkedBookIds) supersedes the legacy per-chat map
  // once it exists for this chat; fall back to the legacy count until then.
  const chatLoreV2LinkedCount = useChatLoreConfigStore((s) =>
    currentChatFile ? s.configs[currentChatFile]?.linkedBookIds.length : undefined
  );
  const legacyChatLorebookCount = useWorldInfoStore((s) =>
    currentChatFile ? (s.chatLinkedBookIds[currentChatFile]?.length ?? 0) : 0
  );
  const chatLorebookCount =
    chatLoreV2LinkedCount !== undefined ? chatLoreV2LinkedCount : legacyChatLorebookCount;
  // Lorebook v2 Phase 4: Auto Memory conflict resolution sheet for this chat.
  const [conflictSheetOpen, setConflictSheetOpen] = useState(false);
  // Whole-map subscription (never a selector-derived array) — see
  // LoreConflictChip.tsx's own comment on this store's React #185 discipline.
  const loreConflictRecords = useLoreConflictStore((s) => s.records);
  const chatConflictCount = useMemo(() => {
    if (!currentChatFile) return 0;
    return Object.values(loreConflictRecords).filter(
      (r) => r.chatFile === currentChatFile
    ).length;
  }, [loreConflictRecords, currentChatFile]);
  // Per-chat style: chat-linked preset/template ids. Subscribed reactively so
  // editing links in the Chat Style modal re-applies them while the chat is
  // open (the transient-load effects below depend on these).
  const [chatStyleOpen, setChatStyleOpen] = useState(false);
  const chatLinkedPresetId = useGenerationStore((s) =>
    currentChatFile ? s.linkedPresetByChatFile[currentChatFile] : undefined
  );
  const chatLinkedTemplateId = usePromptTemplateStore((s) =>
    currentChatFile ? s.linkedTemplateByChatFile[currentChatFile] : undefined
  );

  // Phase 6.4: VN mode — background image and costume
  const [vnBg, setVnBgState] = useState<string | null>(null);
  const [activeCostume, setActiveCostumeState] = useState<string | null>(null);
  const [costumeInputVisible, setCostumeInputVisible] = useState(false);
  const [costumeDraft, setCostumeDraft] = useState('');
  const bgInputRef = useRef<HTMLInputElement>(null);

  // Phase 8.6: checkpoint creation dialog
  const [checkpointMessageId, setCheckpointMessageId] = useState<string | null>(null);
  const [checkpointName, setCheckpointName] = useState('');
  const checkpointInputRef = useRef<HTMLInputElement>(null);
  const createBranch = useBranchStore((s) => s.createBranch);
  const loadBranchesForChat = useBranchStore((s) => s.loadBranchesForChat);
  const branchCount = useBranchStore((s) => s.branches.length);
  const authorNoteContent = useChatStore((s) =>
    s.currentChatFile ? (s.authorNotes[s.currentChatFile]?.content ?? '') : ''
  );

  // Phase 9.1: in-chat message search
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isConvertToGroupOpen, setIsConvertToGroupOpen] = useState(false);
  const [isGenLorebookOpen, setIsGenLorebookOpen] = useState(false);
  const [convertGroupSelected, setConvertGroupSelected] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const messageRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Render window: how many of the oldest messages are hidden. `null` means
  // "default window" — a count derived from the current length, so appending a
  // message keeps the window pinned to the last MESSAGE_PAGE_SIZE. Once the
  // user reveals older messages this becomes a fixed number, so new messages
  // extend the window instead of pushing revealed history back out of view.
  const [hiddenOlderCount, setHiddenOlderCount] = useState<number | null>(null);
  /** Scroll metrics captured just before a "load older" re-render, for pinning. */
  const pendingScrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const { getSpritePath, availableEmotions } = useCharacterSprites(selectedCharacter?.avatar, activeCostume);
  const noExpressionFallback = useExpressionsStore((s) => s.noFallback);

  const latestEmotion = useMemo(() => {
    const characterMessages = messages.filter((m) => !m.isUser && !m.isSystem);
    if (characterMessages.length === 0) return null;
    return characterMessages[characterMessages.length - 1].emotion ?? null;
  }, [messages]);

  // Whether a real expression sprite (typically a transparent PNG) resolves
  // for the current latest emotion. Used to decide if it's safe to render
  // the full-screen VN sprite layer over a chat background — falling back
  // to the opaque default avatar would otherwise obscure the background.
  const hasRealSpriteForLatest = useMemo(() => {
    if (!selectedCharacter || !latestEmotion) return false;
    const key = `${selectedCharacter.avatar}-${latestEmotion}`;
    if (failedExpressions.has(key)) return false;
    const mapped = mapEmotionToAvailable(latestEmotion, availableEmotions);
    return !!getSpritePath(mapped || latestEmotion);
  }, [selectedCharacter, latestEmotion, failedExpressions, availableEmotions, getSpritePath]);

  // When the "no fallback" toggle is on and a sprite is missing, walk back
  // through the chat to find the most recent emotion whose sprite still
  // resolves — so the previous expression sticks instead of snapping to the
  // default avatar. Returns the resolved sprite URL, or null if none found.
  const findPreviousValidSpritePath = useCallback(
    (avatar: string): string | null => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.isUser || m.isSystem || !m.emotion) continue;
        const msgAvatar = isGroupChatMode && m.characterAvatar
          ? m.characterAvatar
          : selectedCharacter?.avatar;
        if (msgAvatar !== avatar) continue;
        const key = `${avatar}-${m.emotion}`;
        if (failedExpressions.has(key)) continue;
        const mapped = mapEmotionToAvailable(m.emotion, availableEmotions);
        const path = getSpritePath(mapped || m.emotion);
        if (path) return path;
      }
      return null;
    },
    [messages, failedExpressions, availableEmotions, getSpritePath, isGroupChatMode, selectedCharacter?.avatar]
  );

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
  const expressionsActive = resolvedMotionMode === 'expressions';
  const portraitEmotion = expressionsActive ? latestEmotion : null;

  // Per-character draggable framing for the mobile portrait panel.
  // Stored as {x%, y%} object-position values, persisted via Zustand.
  // Selectors return primitives to avoid Zustand getSnapshot identity churn.
  const portraitAvatar = selectedCharacter?.avatar ?? null;
  const storedPortraitX = usePortraitPositionStore((s) =>
    portraitAvatar ? s.positionsByAvatar[portraitAvatar]?.x ?? 50 : 50,
  );
  const storedPortraitY = usePortraitPositionStore((s) =>
    portraitAvatar ? s.positionsByAvatar[portraitAvatar]?.y ?? 0 : 0,
  );
  const setStoredPortraitPos = usePortraitPositionStore((s) => s.setPosition);
  const [livePortraitPos, setLivePortraitPos] = useState({ x: storedPortraitX, y: storedPortraitY });
  useEffect(() => {
    setLivePortraitPos({ x: storedPortraitX, y: storedPortraitY });
  }, [storedPortraitX, storedPortraitY, portraitAvatar]);

  const portraitDragRef = useRef<HTMLDivElement>(null);
  const portraitDragState = useRef<{
    startX: number;
    startY: number;
    posX: number;
    posY: number;
    pointerId: number;
  } | null>(null);

  const handlePortraitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!portraitAvatar) return;
    // Don't hijack taps on overlay buttons (search, etc.)
    if ((e.target as HTMLElement).closest('button')) return;
    portraitDragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      posX: livePortraitPos.x,
      posY: livePortraitPos.y,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePortraitPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = portraitDragState.current;
    const el = portraitDragRef.current;
    if (!drag || !el || drag.pointerId !== e.pointerId) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // object-position decreases visually-rightward content as % grows, so a
    // rightward finger drag should DECREASE x (reveal the left side of image).
    const dx = -((e.clientX - drag.startX) / rect.width) * 100;
    const dy = -((e.clientY - drag.startY) / rect.height) * 100;
    setLivePortraitPos({
      x: Math.max(0, Math.min(100, drag.posX + dx)),
      y: Math.max(0, Math.min(100, drag.posY + dy)),
    });
  };

  const handlePortraitPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = portraitDragState.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (portraitAvatar) {
      setStoredPortraitPos(portraitAvatar, livePortraitPos);
    }
    portraitDragState.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Find the last AI message id for swipe control display
  const lastAiMessageId = useMemo(() => {
    const aiMessages = messages.filter((m) => !m.isUser && !m.isSystem);
    return aiMessages.length > 0 ? aiMessages[aiMessages.length - 1].id : null;
  }, [messages]);

  const lastUserMessageId = useMemo(() => {
    const userMessages = messages.filter((m) => m.isUser);
    return userMessages.length > 0 ? userMessages[userMessages.length - 1].id : null;
  }, [messages]);

  const hasAiMessage = useMemo(
    () => messages.some((m) => !m.isUser && !m.isSystem),
    [messages]
  );

  // Enough back-and-forth to make lorebook extraction worthwhile.
  const nonSystemMessageCount = useMemo(
    () => messages.filter((m) => !m.isSystem).length,
    [messages]
  );

  // Build a macro context used to resolve {{user}}/{{char}}/etc. at render time.
  const activeModel = useSettingsStore((s) => s.activeModel);
  const displayPersona = usePersonaStore((s) =>
    s.getPersonaForContext(selectedCharacter?.avatar)
  );
  const displayMacroCtx = useMemo<MacroContext>(() => {
    const userName = displayPersona?.name || 'User';
    return {
      charName: selectedCharacter?.name || '',
      userName,
      personaName: userName,
      personaDescription: displayPersona?.description || '',
      characterDescription: selectedCharacter?.description || (selectedCharacter as any)?.data?.description || '',
      characterPersonality: selectedCharacter?.personality || (selectedCharacter as any)?.data?.personality || '',
      characterScenario: selectedCharacter?.scenario || (selectedCharacter as any)?.data?.scenario || '',
      model: activeModel,
    };
  }, [selectedCharacter, displayPersona, activeModel]);

  // Scene-video: render the current chat moment as a short video. Tapping
  // "Generate scene" opens GenerateSceneModal, which asks the backend for
  // the motion menu: on the self-hosted Wan-Animate path the user picks a
  // curated motion driver (no LLM call); on the Replicate path the active
  // text model distills the transcript into an editable scene prompt +
  // motion beats. The result lands in chat as a new message with an inline
  // player, like image-gen results. generation:video is owner-only by
  // default — the backend enforces it too; this just hides the menu entry.
  const currentUser = useAuthStore((s) => s.currentUser);
  const canGenerateScene = hasPermission(currentUser, 'generation:video');

  // Manual "Take selfie" message action (docs/character-selfies-design.md
  // Phase 2.5). canSelfieNsfw mirrors canGenerateScene's shape exactly — the
  // nsfw tier reuses the same self-hosted RunPod endpoint scene-video keeps
  // owner-only, so it inherits that containment. No client-side RunPod-key
  // pre-check (no precedent for that either — see TakeSelfieModal's docstring);
  // a missing key just surfaces as a normal error via the toast below.
  const canSelfieNsfw = hasPermission(currentUser, 'generation:video');
  const [selfieModalOpen, setSelfieModalOpen] = useState(false);
  const handleTakeSelfie = () => setSelfieModalOpen(true);
  const handleSelfieGenerate = (descriptors: string, tier: SelfieTier) => {
    if (!selectedCharacter) return;
    void triggerSelfie({
      characterName: selectedCharacter.name,
      descriptors,
      characterAvatar: selectedCharacter.avatar,
      tier,
      // Unlike the silent auto-dispatch path, a user who explicitly clicked
      // "Take selfie" needs to see a failure, not silence.
      onError: (err) => showToastGlobal(err.message, 'error'),
    });
  };

  const [sceneModal, setSceneModal] = useState<{
    transcript: TranscriptMsg[];
    fallbackPrompt: string;
  } | null>(null);
  const handleGenerateScene = (messageId: string, content: string) => {
    if (!selectedCharacter) return;
    if (sceneGenProgress !== null) {
      showToastGlobal('A scene video is already generating', 'error');
      return;
    }
    const fallbackPrompt = stripEmotionTag(processMacros(content, displayMacroCtx)).trim();
    if (!fallbackPrompt) {
      showToastGlobal('Nothing to render — the message is empty', 'error');
      return;
    }
    // Summarize only the transcript up to the chosen message — later
    // messages would leak a scene the user didn't pick.
    const idx = messages.findIndex((m) => m.id === messageId);
    const transcript = (idx >= 0 ? messages.slice(0, idx + 1) : messages)
      .filter((m) => !m.isSystem && !m.hidden) // #414: hidden excluded from scene generation too
      .map((m) => ({
        name: m.name,
        isUser: m.isUser,
        isSystem: m.isSystem,
        content: stripEmotionTag(processMacros(m.content, displayMacroCtx)).trim(),
      }))
      .filter((m) => m.content.length > 0);
    setSceneModal({ transcript, fallbackPrompt });
  };

  const startSceneRender = async (prompt: string, beats: string[], driverId?: string) => {
    if (!selectedCharacter) return;
    setSceneGenProgress(0);
    try {
      const videoUrl = await generateSceneVideo(
        selectedCharacter.name,
        prompt,
        beats,
        driverId,
        (s) => {
          setSceneGenProgress(s.progress);
        }
      );
      await insertVideoMessage(
        videoUrl,
        selectedCharacter.name,
        selectedCharacter.avatar,
        selectedCharacter
      );
      showToastGlobal('Scene video added to chat', 'success');
    } catch (err) {
      showToastGlobal(
        err instanceof Error ? err.message : 'Scene generation failed',
        'error'
      );
    } finally {
      setSceneGenProgress(null);
    }
  };

  // Phase 9.1: IDs of messages matching the search query (excludes system messages)
  const searchMatchIds = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return messages
      .filter((m) => !m.isSystem && m.content.toLowerCase().includes(q))
      .map((m) => m.id);
  }, [messages, searchQuery]);

  // Pure chat (companion) mode — the greeting/opening scene is hidden from
  // the rendered chat too, so the session reads as plain texting from the
  // user's first message. Purely presentational: the messages stay in the
  // store/backend and reappear when the mode is toggled off.
  const pureChatMode = usePromptTemplateStore((s) =>
    currentChatFile ? s.chatCompanionModeByChatFile[currentChatFile] ?? false : false
  );

  // Messages to actually render — filtered when search is active, otherwise
  // windowed to the most recent slice. `hiddenCount` is how many older messages
  // the window is leaving out (0 when everything is on screen).
  const { displayedMessages, hiddenCount } = useMemo(() => {
    let base = messages;
    if (pureChatMode) {
      const firstUserIdx = base.findIndex((m) => m.isUser && !m.isSystem);
      base = firstUserIdx === -1 ? [] : base.slice(firstUserIdx);
    }
    // Search shows every match across the whole chat — the render window would
    // silently drop old hits, which reads as "search is broken".
    if (isSearchOpen && searchQuery.trim()) {
      const matchSet = new Set(searchMatchIds);
      return { displayedMessages: base.filter((m) => matchSet.has(m.id)), hiddenCount: 0 };
    }
    // Cap at `length - PAGE_SIZE` so a stale count (after a delete, branch load,
    // or edit-and-regenerate shortened the chat) can never hide the whole view.
    const hidden = Math.max(
      0,
      Math.min(hiddenOlderCount ?? base.length, base.length - MESSAGE_PAGE_SIZE)
    );
    return {
      displayedMessages: hidden > 0 ? base.slice(hidden) : base,
      hiddenCount: hidden,
    };
  }, [isSearchOpen, searchQuery, messages, searchMatchIds, pureChatMode, hiddenOlderCount]);

  const getAvatarUrl = useCallback(
    (avatar: string, emotion?: Emotion | null) => {
      if (emotion) {
        const expressionKey = `${avatar}-${emotion}`;
        if (!failedExpressions.has(expressionKey)) {
          // Try alias mapping (e.g. "happy" → "joy") then direct lookup
          const mapped = mapEmotionToAvailable(emotion, availableEmotions);
          const spritePath = getSpritePath(mapped || emotion);
          if (spritePath) return spritePath;
        }
      }
      if (noExpressionFallback) {
        const prev = findPreviousValidSpritePath(avatar);
        if (prev) return prev;
      }
      return getExpressionThumbnailUrl(avatar, null);
    },
    [getSpritePath, failedExpressions, availableEmotions, noExpressionFallback, findPreviousValidSpritePath]
  );

  const getFullImageUrl = useCallback(
    (avatar: string, emotion?: Emotion | null) => {
      const expressionKey = `${avatar}-${emotion}`;
      if (emotion && !failedExpressions.has(expressionKey)) {
        const spritePath = getSpritePath(emotion);
        if (spritePath) return spritePath;
      }
      if (noExpressionFallback) {
        const prev = findPreviousValidSpritePath(avatar);
        if (prev) return prev;
      }
      return getDefaultAvatarUrl(avatar);
    },
    [getSpritePath, failedExpressions, noExpressionFallback, findPreviousValidSpritePath]
  );

  // Phase 9.1: focus the search input when the bar opens
  useEffect(() => {
    if (!isSearchOpen) return;
    const t = setTimeout(() => searchInputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [isSearchOpen]);

  // Phase 8.7: STscript modal state
  const [stscriptModal, setStscriptModal] = useState<{
    type: 'popup' | 'input' | 'buttons';
    message: string;
    buttons?: string[];
    defaultValue?: string;
    resolve: (value: string) => void;
  } | null>(null);

  // Phase 8.7: Register STscript UI callbacks so slash commands can interact with the UI.
  useEffect(() => {
    import('../../utils/stscript').then(({ registerUICallbacks }) => {
      registerUICallbacks({
        showToast: (msg, variant) => showToastGlobal(msg, variant),
        setInputText: (text) => {
          setPrefillText(text);
          setPrefillNonce(n => n + 1);
        },
        showPopup: (message, buttons) => {
          return new Promise<string>((resolve) => {
            setStscriptModal({ type: buttons ? 'buttons' : 'popup', message, buttons, resolve });
          });
        },
        showInputPrompt: (message, defaultValue) => {
          return new Promise<string | null>((resolve) => {
            setStscriptModal({ type: 'input', message, defaultValue, resolve: (v) => resolve(v || null) });
          });
        },
        navigate: (path) => routerNavigate(path),
      });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Phase 9.1: auto-navigate to first match when query changes
  useEffect(() => {
    setSearchMatchIndex(0);
    if (searchMatchIds.length > 0) {
      const messageId = searchMatchIds[0];
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightedMessageId(messageId);
      highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1200);
      // Delay scroll slightly to allow filtered list to render
      setTimeout(() => {
        messageRefsMap.current.get(messageId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 60);
    } else {
      setHighlightedMessageId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const navigateToMatch = useCallback(
    (direction: 1 | -1) => {
      if (searchMatchIds.length === 0) return;
      const nextIdx = (searchMatchIndex + direction + searchMatchIds.length) % searchMatchIds.length;
      setSearchMatchIndex(nextIdx);
      const messageId = searchMatchIds[nextIdx];
      messageRefsMap.current.get(messageId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightedMessageId(messageId);
      highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1200);
    },
    [searchMatchIds, searchMatchIndex]
  );

  const openSearch = useCallback(() => setIsSearchOpen(true), []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setSearchMatchIndex(0);
    setHighlightedMessageId(null);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
  }, []);

  // Phase 6.4: sync VN bg and costume when character changes
  useEffect(() => {
    if (selectedCharacter) {
      setVnBgState(getVnBgForCharacter(selectedCharacter.avatar) ?? getVnBgGlobal());
      setActiveCostumeState(getCostume(selectedCharacter.avatar));
    } else {
      setVnBgState(getVnBgGlobal());
      setActiveCostumeState(null);
    }
  }, [selectedCharacter?.avatar]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-load the linked generation preset. Chat-session link wins over the
  // character link (Option B); the CHAT_STYLE_NONE sentinel forces global
  // settings even when the character has a link; with neither, restore the
  // user's default. All loads are transient — on unmount or switch-away the
  // default is restored.
  useEffect(() => {
    const avatar = selectedCharacter?.avatar;
    const gen = useGenerationStore.getState();
    const chatLink = currentChatFile ? gen.linkedPresetByChatFile[currentChatFile] : undefined;
    const linked =
      chatLink === CHAT_STYLE_NONE
        ? undefined
        : chatLink ?? (avatar ? gen.linkedPresetByAvatar[avatar] : undefined);
    if (linked) {
      gen.loadPresetTransient(linked);
    } else {
      gen.restoreDefault();
    }
    return () => {
      useGenerationStore.getState().restoreDefault();
    };
  }, [selectedCharacter?.avatar, currentChatFile, chatLinkedPresetId]);

  // Auto-load the linked HYPERCODE/prompt template, chat-session link first,
  // with the same CHAT_STYLE_NONE escape hatch. Only the mainPrompt is
  // swapped — the user's other generation settings are preserved. On exit,
  // the original mainPrompt is restored.
  useEffect(() => {
    const avatar = selectedCharacter?.avatar;
    const tpl = usePromptTemplateStore.getState();
    const chatLink = currentChatFile ? tpl.linkedTemplateByChatFile[currentChatFile] : undefined;
    const linked =
      chatLink === CHAT_STYLE_NONE
        ? undefined
        : chatLink ?? (avatar ? tpl.linkedTemplateByAvatar[avatar] : undefined);
    if (linked) {
      tpl.loadTemplateMainPromptTransient(linked);
    } else {
      tpl.restoreDefaultMainPrompt();
    }
    return () => {
      usePromptTemplateStore.getState().restoreDefaultMainPrompt();
    };
  }, [selectedCharacter?.avatar, currentChatFile, chatLinkedTemplateId]);

  // Phase 6.4: track the last 3 distinct AI speakers for VN group sprite layout
  const recentSpeakers = useMemo<string[]>(() => {
    if (!isGroupChatMode) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (let i = messages.length - 1; i >= 0 && result.length < 3; i--) {
      const m = messages[i];
      if (!m.isUser && !m.isSystem && m.characterAvatar && !seen.has(m.characterAvatar)) {
        seen.add(m.characterAvatar);
        result.push(m.characterAvatar);
      }
    }
    return result; // result[0] = most recent speaker
  }, [messages, isGroupChatMode]);

  // Tier 3: notify sandboxed extension iframes whenever the active chat changes.
  useEffect(() => {
    fireSandboxLifecycleEvent('chatChanged', [currentChatFile]);
  }, [currentChatFile]);

  useEffect(() => {
    if (!selectedCharacter) return;
    const sameChar = lastCharacterRef.current === selectedCharacter.avatar;
    const sameMode = lastGroupModeRef.current === isGroupChatMode;
    if (sameChar && sameMode) return;

    clearChat();
    lastCharacterRef.current = selectedCharacter.avatar;
    lastGroupModeRef.current = isGroupChatMode;
    setFailedExpressions(new Set());
    fetchChatFiles(selectedCharacter.avatar);
  }, [selectedCharacter, isGroupChatMode, fetchChatFiles, clearChat]);

  useEffect(() => {
    if (!selectedCharacter) return;
    if (lastCharacterRef.current !== selectedCharacter.avatar) return;

    // The Works panel can request a specific chat while switching
    // characters; honor that over the latest-chat default.
    const pendingChat = useProjectStore
      .getState()
      .consumePendingChat(selectedCharacter.avatar);
    if (pendingChat) {
      loadChat(selectedCharacter.avatar, pendingChat);
    } else if (chatFiles.length > 0) {
      loadChat(selectedCharacter.avatar, chatFiles[0].fileName);
    } else if (messages.length === 0) {
      startNewChat(selectedCharacter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatFiles]);

  // Phase 8.6: reload branches whenever the active chat file changes.
  useEffect(() => {
    if (currentChatFile) loadBranchesForChat(currentChatFile);
  }, [currentChatFile, loadBranchesForChat]);

  // Track scroll position to decide whether auto-scroll should fire.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 150;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll: always scroll on new user messages or when streaming starts,
  // but during ongoing streaming only scroll if the user hasn't scrolled up.
  // Suppressed while search is open (navigation controls scroll instead).
  useEffect(() => {
    if (isSearchOpen) return;
    if (!isNearBottomRef.current && isStreaming) return;
    messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
  }, [messages, isStreaming, isSearchOpen]);

  // Switching chats starts a fresh window at the most recent messages.
  useEffect(() => {
    setHiddenOlderCount(null);
  }, [currentChatFile]);

  // Reveal older messages. Both handlers snapshot the scroll metrics first so
  // the layout effect below can keep the user's current message under the
  // cursor instead of letting the prepended history shove it down the page.
  const captureScrollAnchor = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) {
      pendingScrollAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    }
  }, []);

  const loadOlderMessages = useCallback(() => {
    captureScrollAnchor();
    setHiddenOlderCount(Math.max(0, hiddenCount - MESSAGE_PAGE_SIZE));
  }, [captureScrollAnchor, hiddenCount]);

  const loadAllMessages = useCallback(() => {
    captureScrollAnchor();
    setHiddenOlderCount(0);
  }, [captureScrollAnchor]);

  // Pin scroll position across a window expansion: restore the previous offset
  // plus however much taller the list got. Runs before paint, so there's no
  // visible jump. Late-loading avatars can still shift things slightly.
  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (!anchor) return;
    pendingScrollAnchorRef.current = null;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [displayedMessages]);

  // Phase 6.3: Auto-read — speak the last AI message when streaming completes.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      return;
    }
    // Streaming just ended
    if (wasStreamingRef.current) {
      wasStreamingRef.current = false;
      if (!getTtsAutoRead()) return;
      const lastAi = [...messages].reverse().find((m) => !m.isUser && !m.isSystem);
      if (lastAi && lastAi.content) {
        speakText(lastAi.content);
      }
    }
  }, [isStreaming, messages]);

  // Phase 7.5: Auto-summarize — trigger after AI response if enabled and threshold reached.
  const wasSendingRef = useRef(false);
  useEffect(() => {
    if (isSending) {
      wasSendingRef.current = true;
      return;
    }
    if (!wasSendingRef.current) return;
    wasSendingRef.current = false;

    const sumStore = useSummarizeStore.getState();
    const memStore = useAutoMemoryStore.getState();
    if (!currentChatFile || !selectedCharacter) return;

    // #414: exclude hidden to stay in lockstep with the summary/memory
    // watermarks (summarizeStore messageCount, autoMemoryStore total), which
    // now also exclude hidden — otherwise the trigger cadence and the summary
    // compaction offset drift by the hidden count.
    const nonSystemCount = messages.filter((m) => !m.isSystem && !m.hidden).length;

    if (sumStore.autoSummarize) {
      const existing = sumStore.getSummary(currentChatFile);
      const lastCount = existing?.messageCount ?? 0;
      if (nonSystemCount - lastCount >= sumStore.autoTriggerEvery) {
        sumStore.generateSummary(messages, currentChatFile, selectedCharacter.name);
      }
    }

    if (memStore.shouldTrigger(currentChatFile, nonSystemCount)) {
      void memStore.extractFacts(
        currentChatFile,
        selectedCharacter,
        messages.map((m) => ({
          name: m.name,
          isUser: m.isUser,
          isSystem: m.isSystem,
          content: m.content,
          hidden: m.hidden, // #414: so extractFacts can skip hidden messages
        }))
      );
    }
  }, [isSending, messages, currentChatFile, selectedCharacter]);

  // Phase 7.1/7.5: extension-gated features
  const imageGenEnabled = useExtensionStore((s) => s.enabled.imageGen);
  const summarizeEnabled = useExtensionStore((s) => s.enabled.summarize);
  const summaryHasContent = useSummarizeStore((s) =>
    currentChatFile ? !!(s.summaries[currentChatFile]?.text) : false
  );

  // Phase 6.4: background image picker
  const handleBgFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (selectedCharacter) {
        setVnBgForCharacter(selectedCharacter.avatar, dataUrl);
      } else {
        setVnBgGlobal(dataUrl);
      }
      setVnBgState(dataUrl);
      // Auto-enable VN mode so the user immediately sees the background they
      // just chose. Without this, the upload would silently store the image
      // but render nothing because the bg <img> is gated on isVnMode.
      if (!isVnMode) {
        storeSetVnMode(true);
      }
    };
    reader.readAsDataURL(file);
    // Reset so the same file can be re-selected later
    e.target.value = '';
  }, [selectedCharacter, isVnMode]);

  const handleClearBg = useCallback(() => {
    if (selectedCharacter) {
      clearVnBgForCharacter(selectedCharacter.avatar);
      setVnBgState(getVnBgGlobal());
    } else {
      clearVnBgGlobal();
      setVnBgState(null);
    }
  }, [selectedCharacter]);

  // Phase 6.4: costume setter (called from VN header input)
  const handleSetCostume = useCallback((name: string) => {
    if (!selectedCharacter) return;
    if (name.trim()) {
      storeSetCostume(selectedCharacter.avatar, name.trim());
      setActiveCostumeState(name.trim());
    } else {
      storeClearCostume(selectedCharacter.avatar);
      setActiveCostumeState(null);
    }
  }, [selectedCharacter]);

  // Quick in-chat toggle for VN/background mode — lets mobile users send the
  // character art behind the chat without a trip to Settings, and back out
  // again (the only other entry point auto-enables it on background upload).
  const handleEnableBackgroundMode = useCallback(() => {
    storeSetVnMode(true);
  }, []);

  const handleDisableBackgroundMode = useCallback(() => {
    storeSetVnMode(false);
  }, []);

  const handleSend = (content: string, images?: string[]) => {
    if (isGroupChatMode && groupChatCharacters.length >= 2) {
      sendGroupMessage(content, groupChatCharacters, images);
    } else if (selectedCharacter) {
      sendMessage(content, selectedCharacter, availableEmotions, images);
    }
  };

  // Phase 6.1: drag-and-drop image staging. Only `image/*` files are
  // accepted — everything else falls through to the browser. Nested
  // drag-enter/leave events use a counter so the overlay doesn't flicker
  // when dragging over child elements.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
      (ACCEPTED_IMAGE_MIMES as readonly string[]).includes(f.type)
    );
    if (files.length === 0) return;

    const { dataUrls } = await compressImageFiles(files);
    if (dataUrls.length > 0) {
      setDroppedImages(dataUrls);
      setDroppedImagesNonce((n) => n + 1);
    }
  }, []);

  const handleRegenerate = () => {
    if (selectedCharacter && !isGroupChatMode) {
      regenerateMessage(selectedCharacter, availableEmotions);
    }
  };

  const handleContinue = () => {
    if (selectedCharacter && !isGroupChatMode) {
      continueMessage(selectedCharacter, availableEmotions);
    }
  };

  // Phase 8.6: open the checkpoint naming dialog for a given message.
  const handleCheckpoint = useCallback((messageId: string) => {
    setCheckpointMessageId(messageId);
    setCheckpointName('');
    // Focus input after render
    setTimeout(() => checkpointInputRef.current?.focus(), 60);
  }, []);

  const commitCheckpoint = useCallback(() => {
    if (!checkpointMessageId || !currentChatFile) return;
    createBranch({
      chatFile: currentChatFile,
      messageId: checkpointMessageId,
      name: checkpointName,
      messages,
    });
    setCheckpointMessageId(null);
  }, [checkpointMessageId, currentChatFile, checkpointName, messages, createBranch]);

  const handleImpersonate = async () => {
    if (!selectedCharacter || isGroupChatMode) return;
    const text = await impersonate(selectedCharacter, availableEmotions);
    if (text) {
      setPrefillText(text);
      setPrefillNonce((n) => n + 1);
    }
  };

  const handleSwipeLeft = (messageId: string) => {
    swipeLeft(messageId);
  };

  const handleSwipeRight = (messageId: string) => {
    if (selectedCharacter && !isGroupChatMode) {
      swipeRight(messageId, selectedCharacter, availableEmotions);
    }
  };

  if (!selectedCharacter && !isGroupChatMode) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8">
        <MessageSquare size={64} className="text-[var(--color-text-secondary)] mb-4" />
        <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-2">
          Select a Character
        </h2>
        <p className="text-[var(--color-text-secondary)] max-w-md">
          Choose a character from the sidebar to start chatting. You can search for
          characters or create a new one.
        </p>
      </div>
    );
  }

  // ChatLorePanel's characterAvatars: solo chat is the one selected
  // character; group chat is every member. Derived from state ChatView
  // already subscribes to above — no new store subscription.
  const chatLoreCharacterAvatars = isGroupChatMode
    ? groupChatCharacters.map((c) => c.avatar)
    : selectedCharacter
      ? [selectedCharacter.avatar]
      : [];

  const membersLabel = groupChatCharacters.map((c) => c.name).join(', ');
  const groupTitle =
    groupChatRecord?.title && groupChatRecord.title.trim().length > 0
      ? groupChatRecord.title
      : membersLabel;
  const displayName = isGroupChatMode
    ? groupTitle
    : selectedCharacter?.name ?? '';

  const commitTitle = () => {
    if (!currentChatFile) {
      setIsEditingTitle(false);
      return;
    }
    setGroupTitle(currentChatFile, titleDraft);
    setIsEditingTitle(false);
  };
  const cancelTitleEdit = () => setIsEditingTitle(false);

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Phase 6.4: VN background image (z-0, behind sprite and content) */}
      {isVnMode && vnBg && (
        <img
          src={vnBg}
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ zIndex: 0 }}
        />
      )}

      {/* Phase 6.4: VN sprite layer — single character (z-1).
          Skip when a background image is set AND no real sprite resolves
          for the current emotion — otherwise the opaque default-avatar
          fallback would full-screen-cover the background image. Real
          (transparent-PNG) expression sprites render normally and let the
          background show through. */}
      {isVnMode && !isGroupChatMode && selectedCharacter && (resolvedMotionMode !== 'none') && (!vnBg || hasLivePortrait || (expressionsActive && hasRealSpriteForLatest)) && (
        hasLivePortrait ? (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 1 }}
          >
            <LivePortraitVideo
              clips={livePortraitClips!}
              emotion={latestEmotion}
              fill
              shape="square"
            />
          </div>
        ) : (
          <img
            key={`vn-sprite-${selectedCharacter.avatar}-${portraitEmotion ?? 'neutral'}`}
            src={getFullImageUrl(selectedCharacter.avatar, portraitEmotion)}
            alt=""
            aria-hidden
            className="absolute inset-0 w-full h-full object-contain object-bottom pointer-events-none"
            style={{ zIndex: 1 }}
            onError={() => {
              if (latestEmotion) {
                const key = `${selectedCharacter.avatar}-${latestEmotion}`;
                setFailedExpressions((prev) => new Set(prev).add(key));
              }
            }}
          />
        )
      )}

      {/* Phase 6.4: VN sprite layer — group chat, last 3 speakers side-by-side */}
      {isVnMode && isGroupChatMode && recentSpeakers.map((avatar, idx) => {
        const total = recentSpeakers.length;
        // Positioning: most recent (idx 0) is front/center, others are dimmed on sides.
        const spritePositions: Record<number, Array<CSSProperties>> = {
          1: [{ inset: 0 }],
          2: [
            { top: 0, bottom: 0, right: '5%', width: '45%' },     // most recent → right
            { top: 0, bottom: 0, left: '5%', width: '45%' },      // older → left
          ],
          3: [
            { top: 0, bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '38%' }, // center
            { top: 0, bottom: 0, right: '2%', width: '35%' },     // right
            { top: 0, bottom: 0, left: '2%', width: '35%' },      // left
          ],
        };
        const positions = spritePositions[total] ?? spritePositions[1];
        const pos = positions[idx] ?? { inset: 0 };
        const opacity = idx === 0 ? 1 : 0.5;
        const zIndex = 1 + (recentSpeakers.length - idx); // most recent on top
        return (
          <img
            key={`vn-group-${avatar}`}
            src={getDefaultAvatarUrl(avatar)}
            alt=""
            aria-hidden
            className="absolute object-contain object-bottom pointer-events-none"
            style={{ opacity, zIndex, ...pos }}
          />
        );
      })}

      {/* All chat content — raised above VN sprite layers.
          Single-char sprite = z-1; group sprites = z-(2..4) for up to 3 speakers,
          so content needs to sit at z-10 to always be on top regardless of group size. */}
      <div className={`flex flex-col flex-1 min-h-0 ${isVnMode ? 'relative' : ''}`} style={isVnMode ? { zIndex: 10 } : undefined}>
      {/* Group Chat Header (always visible when in group mode) */}
      {isGroupChatMode ? (
        <>
          <div className={`h-20 relative overflow-hidden px-4 py-3 ${isVnMode ? 'bg-black/30 backdrop-blur-sm' : 'bg-gradient-to-b from-[var(--color-bg-tertiary)] to-[var(--color-bg-primary)]'}`}>
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isVnMode ? 'bg-white/10' : 'bg-[var(--color-primary)]/20'}`}>
                <Users size={24} className={isVnMode ? 'text-white/80' : 'text-[var(--color-primary)]'} />
              </div>
              <div className="flex-1 min-w-0">
                {isEditingTitle ? (
                  <input
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitTitle();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelTitleEdit();
                      }
                    }}
                    placeholder={membersLabel}
                    className={`w-full bg-transparent text-lg font-semibold border-b focus:outline-none ${isVnMode ? 'text-white border-white/50' : 'text-[var(--color-text-primary)] border-[var(--color-primary)]'}`}
                    autoFocus
                    aria-label="Edit group chat title"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setTitleDraft(groupChatRecord?.title ?? '');
                      setIsEditingTitle(true);
                    }}
                    className="flex items-center gap-1.5 group max-w-full"
                    title="Edit title"
                  >
                    <h2 className={`text-lg font-semibold truncate ${isVnMode ? 'text-white drop-shadow-lg' : 'text-[var(--color-text-primary)]'}`}>
                      {groupTitle || 'Group Chat'}
                    </h2>
                    <Pencil
                      size={12}
                      className={`opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity ${isVnMode ? 'text-white/70' : 'text-[var(--color-text-secondary)]'}`}
                    />
                  </button>
                )}
                <p className={`text-xs truncate ${isVnMode ? 'text-white/60' : 'text-[var(--color-text-secondary)]'}`}>
                  {membersLabel}
                </p>
              </div>
              <button
                onClick={openSearch}
                className={`p-1.5 rounded-full transition-colors ${isVnMode ? 'text-white/80 hover:bg-white/10' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'}`}
                aria-label="Search messages"
                title="Search messages"
              >
                <Search size={18} />
              </button>
              <button
                onClick={() => setShowGroupControls((v) => !v)}
                className={`p-1.5 rounded-full transition-colors ${
                  showGroupControls
                    ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary)]'
                    : isVnMode
                      ? 'text-white/80 hover:bg-white/10'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                }`}
                aria-label="Group chat settings"
                aria-expanded={showGroupControls}
                title="Activation strategy & mute"
              >
                <Settings2 size={18} />
              </button>
              {isVnMode && (
                <>
                  <button
                    onClick={() => bgInputRef.current?.click()}
                    className="text-xs px-2 py-1 rounded bg-black/30 text-white/70 hover:bg-black/50 transition-colors"
                    title="Set VN background image"
                  >
                    Set BG
                  </button>
                  {vnBg && (
                    <button
                      onClick={handleClearBg}
                      className="text-xs px-2 py-1 rounded bg-black/30 text-white/60 hover:bg-black/50 transition-colors"
                      title="Clear background"
                    >
                      ✕ BG
                    </button>
                  )}
                </>
              )}
              <button
                onClick={exitGroupChat}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors ${isVnMode ? 'bg-black/30 text-white/70 hover:bg-black/50' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]'}`}
              >
                Exit
              </button>
            </div>
          </div>
          {showGroupControls && currentChatFile && (
            <GroupChatControls
              fileName={currentChatFile}
              characters={groupChatCharacters}
              isSending={isSending}
            />
          )}
          {/* Hidden file input for VN background picker (group mode) */}
          <input
            ref={bgInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleBgFileChange}
          />
        </>
      ) : selectedCharacter ? (
        <>
          {/* Mobile: character portrait (hidden in VN mode and mobile landscape).
              CSS-hidden rather than unmounted when collapsed — not conditionally
              rendered — so LivePortraitVideo keeps its decoded frame/playback
              position across collapse/expand instead of restarting from scratch. */}
          {!isVnMode && !isMobileLandscape && (
            <>
              <div
                ref={portraitDragRef}
                onPointerDown={handlePortraitPointerDown}
                onPointerMove={handlePortraitPointerMove}
                onPointerUp={handlePortraitPointerUp}
                onPointerCancel={handlePortraitPointerUp}
                className={`lg:hidden relative bg-gradient-to-b from-[var(--color-bg-tertiary)] to-[var(--color-bg-primary)] overflow-hidden cursor-grab active:cursor-grabbing ${isPortraitCollapsed ? 'hidden' : ''}`}
                style={{ height: `${portraitHeight * 100}vh`, touchAction: 'none' }}
              >
                {hasLivePortrait ? (
                  <LivePortraitVideo
                    clips={livePortraitClips!}
                    emotion={latestEmotion}
                    fill
                    shape="square"
                    objectPosition={`${livePortraitPos.x}% ${livePortraitPos.y}%`}
                  />
                ) : (
                  <img
                    key={`${selectedCharacter.avatar}-${portraitEmotion ?? 'neutral'}`}
                    src={getFullImageUrl(selectedCharacter.avatar, portraitEmotion)}
                    alt={selectedCharacter.name}
                    draggable={false}
                    className="w-full h-full object-cover transition-opacity duration-300 select-none pointer-events-none"
                    style={{ objectPosition: `${livePortraitPos.x}% ${livePortraitPos.y}%` }}
                    onError={() => {
                      if (latestEmotion) {
                        const expressionKey = `${selectedCharacter.avatar}-${latestEmotion}`;
                        setFailedExpressions((prev) => new Set(prev).add(expressionKey));
                      }
                    }}
                  />
                )}
                {livePortraitLoading && !hasLivePortrait && (
                  <div className="absolute top-2 right-2 rounded-full bg-black/40 p-1.5 backdrop-blur-sm">
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[var(--color-bg-primary)] to-transparent" />
                <div className="absolute bottom-2 left-4 right-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-[var(--color-text-primary)] drop-shadow-lg truncate min-w-0 flex-1">
                      {selectedCharacter.name}
                    </h2>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {latestEmotion && (
                        <span className="text-xs px-2 py-1 rounded-full bg-black/30 text-white/80 backdrop-blur-sm capitalize">
                          {latestEmotion}
                        </span>
                      )}
                      <PortraitHeaderActions
                        variant="expanded"
                        onSearch={openSearch}
                        onBackground={handleEnableBackgroundMode}
                        onToggleCollapse={handleTogglePortraitCollapsed}
                      />
                    </div>
                  </div>
                  <MotionModePicker
                    avatar={selectedCharacter.avatar}
                    hasLivePortraitClips={hasLivePortraitClips}
                    hasExpressionSprites={hasExpressionSprites}
                    variant="overlay"
                  />
                </div>
              </div>
              {!isPortraitCollapsed && (
                <div
                  onPointerDown={handlePortraitResize}
                  onKeyDown={handlePortraitResizeKey}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize character portrait"
                  aria-valuenow={Math.round(portraitHeight * 100)}
                  aria-valuemin={Math.round(MIN_PORTRAIT_HEIGHT * 100)}
                  aria-valuemax={Math.round(MAX_PORTRAIT_HEIGHT * 100)}
                  tabIndex={0}
                  className="lg:hidden flex items-center justify-center h-3 bg-[var(--color-bg-primary)] cursor-ns-resize touch-none select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                >
                  <div className="h-1 w-10 rounded-full bg-[var(--color-border)]" />
                </div>
              )}
              {isPortraitCollapsed && (
                <div className="lg:hidden flex items-center gap-2 px-3 py-2 bg-gradient-to-b from-[var(--color-bg-tertiary)] to-[var(--color-bg-primary)] flex-shrink-0">
                  <h2 className="text-sm font-semibold text-[var(--color-text-primary)] truncate min-w-0 flex-1">
                    {selectedCharacter.name}
                  </h2>
                  {latestEmotion && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] capitalize">
                      {latestEmotion}
                    </span>
                  )}
                  <PortraitHeaderActions
                    variant="collapsed"
                    onSearch={openSearch}
                    onBackground={handleEnableBackgroundMode}
                    onToggleCollapse={handleTogglePortraitCollapsed}
                  />
                </div>
              )}
            </>
          )}

          {/* Phase 6.4: VN mode compact header — shown on mobile instead of the 30vh panel */}
          {isVnMode && (
            <div className="lg:hidden bg-black/30 backdrop-blur-sm flex-shrink-0">
              <div className="flex items-center gap-2 px-3 py-2">
                <h2 className="text-sm font-semibold text-white truncate min-w-0 flex-1">
                  {selectedCharacter.name}
                </h2>
                {latestEmotion && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/30 text-white/70 capitalize">
                    {latestEmotion}
                  </span>
                )}
                <button
                  onClick={() => { setCostumeDraft(activeCostume ?? ''); setCostumeInputVisible((v) => !v); }}
                  className="text-xs px-2 py-1 rounded bg-black/30 text-white/70 hover:bg-black/50 transition-colors"
                  title="Change sprite costume"
                >
                  {activeCostume ? `✦ ${activeCostume}` : 'Costume'}
                </button>
                <button
                  onClick={openSearch}
                  className="p-1.5 rounded-full text-white/80 hover:bg-black/30 transition-colors"
                  aria-label="Search messages"
                  title="Search messages"
                >
                  <Search size={15} />
                </button>
                <button
                  onClick={handleDisableBackgroundMode}
                  className="p-1.5 rounded-full text-white/80 hover:bg-black/30 transition-colors"
                  aria-label="Exit background mode"
                  title="Exit background mode"
                >
                  <PanelTopOpen size={15} />
                </button>
                <button
                  onClick={() => bgInputRef.current?.click()}
                  className="text-xs px-2 py-1 rounded bg-black/30 text-white/70 hover:bg-black/50 transition-colors"
                  title="Set VN background image"
                >
                  Set BG
                </button>
                {vnBg && (
                  <button
                    onClick={handleClearBg}
                    className="text-xs px-2 py-1 rounded bg-black/30 text-white/60 hover:bg-black/50 transition-colors"
                    title="Clear background"
                  >
                    ✕ BG
                  </button>
                )}
              </div>
              {costumeInputVisible && (
                <div className="flex items-center gap-2 px-3 pb-2">
                  <input
                    type="text"
                    value={costumeDraft}
                    onChange={(e) => setCostumeDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { handleSetCostume(costumeDraft); setCostumeInputVisible(false); }
                      else if (e.key === 'Escape') setCostumeInputVisible(false);
                    }}
                    placeholder="Costume folder name (e.g. Alice_swimsuit)"
                    className="flex-1 text-xs bg-black/40 border border-white/20 rounded px-2 py-1 text-white placeholder:text-white/40 focus:outline-none focus:border-white/40"
                    autoFocus
                  />
                  <button
                    onClick={() => { handleSetCostume(costumeDraft); setCostumeInputVisible(false); }}
                    className="text-xs px-2 py-1 rounded bg-white/20 text-white hover:bg-white/30 transition-colors"
                  >
                    Apply
                  </button>
                  {activeCostume && (
                    <button
                      onClick={() => { handleSetCostume(''); setCostumeInputVisible(false); }}
                      className="text-xs px-2 py-1 rounded bg-black/30 text-white/60 hover:bg-black/50 transition-colors"
                    >
                      Reset
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Desktop: compact header bar */}
          <div className={`hidden lg:flex flex-wrap items-center gap-2 px-4 h-auto min-h-12 border-b border-[var(--color-border)] flex-shrink-0 py-1 ${isVnMode ? 'bg-black/30 backdrop-blur-sm' : 'bg-[var(--color-bg-secondary)]'}`}>
            <h2 className={`text-sm font-semibold flex-1 truncate ${isVnMode ? 'text-white' : 'text-[var(--color-text-primary)]'}`}>
              {selectedCharacter.name}
            </h2>
            {isVnMode && (
              <>
                {latestEmotion && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-black/30 text-white/70 capitalize">
                    {latestEmotion}
                  </span>
                )}
                <button
                  onClick={() => { setCostumeDraft(activeCostume ?? ''); setCostumeInputVisible((v) => !v); }}
                  className="text-xs px-2 py-1 rounded bg-black/30 text-white/70 hover:bg-black/50 transition-colors"
                  title="Change sprite costume"
                >
                  {activeCostume ? `✦ ${activeCostume}` : 'Costume'}
                </button>
                {costumeInputVisible && (
                  <>
                    <input
                      type="text"
                      value={costumeDraft}
                      onChange={(e) => setCostumeDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { handleSetCostume(costumeDraft); setCostumeInputVisible(false); }
                        else if (e.key === 'Escape') setCostumeInputVisible(false);
                      }}
                      placeholder="Costume folder (e.g. Alice_swimsuit)"
                      className="text-xs bg-black/40 border border-white/20 rounded px-2 py-1 text-white placeholder:text-white/40 focus:outline-none focus:border-white/40 w-48"
                      autoFocus
                    />
                    <button
                      onClick={() => { handleSetCostume(costumeDraft); setCostumeInputVisible(false); }}
                      className="text-xs px-2 py-1 rounded bg-white/20 text-white hover:bg-white/30 transition-colors"
                    >
                      Apply
                    </button>
                    {activeCostume && (
                      <button
                        onClick={() => { handleSetCostume(''); setCostumeInputVisible(false); }}
                        className="text-xs px-2 py-1 rounded bg-black/30 text-white/60 hover:bg-black/50 transition-colors"
                      >
                        Reset
                      </button>
                    )}
                  </>
                )}
                <button
                  onClick={() => bgInputRef.current?.click()}
                  className="text-xs px-2 py-1 rounded bg-black/30 text-white/70 hover:bg-black/50 transition-colors"
                  title="Set VN background image"
                >
                  Set BG
                </button>
                {vnBg && (
                  <button
                    onClick={handleClearBg}
                    className="text-xs px-2 py-1 rounded bg-black/30 text-white/60 hover:bg-black/50 transition-colors"
                    title="Clear background"
                  >
                    ✕ BG
                  </button>
                )}
              </>
            )}
            <button
              onClick={openSearch}
              className={`p-1.5 rounded-md transition-colors ${isVnMode ? 'text-white/80 hover:bg-black/30' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'}`}
              aria-label="Search messages"
              title="Search messages"
            >
              <Search size={18} />
            </button>
          </div>

          {/* Hidden file input for VN background picker */}
          <input
            ref={bgInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleBgFileChange}
          />
        </>
      ) : null}

      {/* Phase 9.1: Search bar — slides in below the header */}
      <div
        className={`overflow-hidden transition-[max-height] duration-200 ease-in-out flex-shrink-0 ${
          isSearchOpen ? 'max-h-14' : 'max-h-0'
        }`}
      >
        <div className="flex items-center gap-1.5 px-3 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
          <Search size={15} className="text-[var(--color-text-secondary)] flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
              else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                navigateToMatch(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                navigateToMatch(-1);
              }
            }}
            placeholder="Search messages…"
            className="flex-1 min-w-0 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:outline-none"
          />
          {searchQuery.trim() && (
            <span className="text-xs text-[var(--color-text-secondary)] whitespace-nowrap flex-shrink-0">
              {searchMatchIds.length > 0
                ? `${searchMatchIndex + 1} of ${searchMatchIds.length}`
                : 'No results'}
            </span>
          )}
          <button
            onClick={() => navigateToMatch(-1)}
            disabled={searchMatchIds.length === 0}
            className="p-1 text-[var(--color-text-secondary)] disabled:opacity-30 hover:text-[var(--color-text-primary)] transition-colors"
            aria-label="Previous match"
          >
            <ChevronUp size={16} />
          </button>
          <button
            onClick={() => navigateToMatch(1)}
            disabled={searchMatchIds.length === 0}
            className="p-1 text-[var(--color-text-secondary)] disabled:opacity-30 hover:text-[var(--color-text-primary)] transition-colors"
            aria-label="Next match"
          >
            <ChevronDown size={16} />
          </button>
          <button
            onClick={closeSearch}
            className="p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
            aria-label="Close search"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Messages Area */}
      <div
        ref={scrollContainerRef}
        className={`flex-1 min-h-0 overflow-y-auto relative ${
          isDragOver ? 'ring-2 ring-[var(--color-primary)] ring-inset' : ''
        } ${isVnMode ? 'bg-black/40 backdrop-blur-[2px]' : ''}`}
        style={keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : undefined}
        onScroll={handleScroll}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag-drop overlay — non-interactive, just a visual cue. */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center bg-[var(--color-primary)]/10 backdrop-blur-sm">
            <div className="px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-primary)] text-sm text-[var(--color-text-primary)] shadow-lg">
              Drop images to attach
            </div>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8">
            <div className="w-20 h-20 rounded-full bg-[var(--color-bg-tertiary)] flex items-center justify-center mb-4">
              {isGroupChatMode ? (
                <Users size={32} className="text-[var(--color-text-secondary)]" />
              ) : (
                <MessageSquare size={32} className="text-[var(--color-text-secondary)]" />
              )}
            </div>
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mb-2">
              Start a conversation
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] max-w-sm">
              {isGroupChatMode
                ? `Send a message to chat with ${displayName}`
                : `Send a message to begin chatting with ${displayName}`}
            </p>
          </div>
        ) : (
          <div className="py-4">
            {hiddenCount > 0 && (
              <div className="flex items-center justify-center gap-2 px-4 pb-4">
                <button
                  onClick={loadOlderMessages}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                >
                  Load {Math.min(MESSAGE_PAGE_SIZE, hiddenCount)} older
                </button>
                <button
                  onClick={loadAllMessages}
                  className="px-3 py-1.5 rounded-full text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  Load all {hiddenCount}
                </button>
              </div>
            )}
            {displayedMessages.map((message) => {
              const charAvatar = isGroupChatMode && message.characterAvatar
                ? message.characterAvatar
                : selectedCharacter?.avatar;
              const useEmotionForThisMsg =
                charAvatar === selectedCharacter?.avatar ? expressionsActive : true;
              const messageAvatar = message.isUser
                ? displayPersona?.avatarDataUrl
                : charAvatar
                  ? getAvatarUrl(charAvatar, useEmotionForThisMsg ? message.emotion : null)
                  : undefined;
              // Fallback: default avatar thumbnail (no expression) when sprite 404s
              const fallbackAvatar = !message.isUser && charAvatar
                ? getExpressionThumbnailUrl(charAvatar, null)
                : undefined;

              const isLastAiMessage = message.id === lastAiMessageId;
              const isAiMessage = !message.isUser && !message.isSystem;
              // Show swipe controls on the last AI message always, and on any AI
              // message that already has multiple swipes (e.g. alternate greetings).
              const showSwipeControl =
                !isGroupChatMode && isAiMessage &&
                (isLastAiMessage || message.swipes.length > 1);

              return (
                <div
                  key={message.id}
                  ref={(el) => {
                    if (el) messageRefsMap.current.set(message.id, el);
                    else messageRefsMap.current.delete(message.id);
                  }}
                  className={`transition-colors duration-500 ${
                    message.id === highlightedMessageId
                      ? 'bg-[var(--color-primary)]/10'
                      : ''
                  }`}
                >
                  <ChatMessage
                    messageId={message.id}
                    name={message.name}
                    content={processMacros(message.content, displayMacroCtx)}
                    isUser={message.isUser}
                    isSystem={message.isSystem}
                    hidden={message.hidden}
                    avatar={messageAvatar}
                    avatarFallback={fallbackAvatar}
                    onAvatarError={
                      message.emotion && !message.isUser && charAvatar
                        ? () => {
                            const key = `${charAvatar}-${message.emotion}`;
                            setFailedExpressions(prev => new Set(prev).add(key));
                          }
                        : undefined
                    }
                    timestamp={message.timestamp}
                    disabled={isSending}
                    images={message.images}
                    videos={message.videos}
                    characterAvatar={message.isUser ? selectedCharacter?.avatar : (message.characterAvatar || selectedCharacter?.avatar)}
                    isStreaming={isLastAiMessage && isStreaming}
                    isLastMessage={isLastAiMessage}
                    layoutMode={chatLayoutMode}
                    avatarShape={avatarShapePref}
                    fontSize={chatFontSize}
                    chatMaxWidth={chatMaxWidth}
                    swipes={message.swipes}
                    swipeId={message.swipeId}
                    usage={message.usage}
                    showSwipeControl={showSwipeControl}
                    canGenerateSwipe={isLastAiMessage}
                    onSwipeLeft={() => handleSwipeLeft(message.id)}
                    onSwipeRight={() => handleSwipeRight(message.id)}
                    onEdit={(newContent) => editMessage(message.id, newContent)}
                    onEditAndRegenerate={
                      message.isUser && selectedCharacter && !isGroupChatMode
                        ? (newContent) =>
                            editMessageAndRegenerate(
                              message.id,
                              newContent,
                              selectedCharacter,
                              availableEmotions
                            )
                        : undefined
                    }
                    onDelete={() => deleteMessage(message.id)}
                    onToggleHide={() => toggleMessageHidden(message.id)}
                    onRegenerate={
                      isLastAiMessage && !isGroupChatMode ? handleRegenerate : undefined
                    }
                    onCheckpoint={currentChatFile ? () => handleCheckpoint(message.id) : undefined}
                    onGenerateScene={
                      canGenerateScene &&
                      isAiMessage &&
                      !isGroupChatMode &&
                      selectedCharacter &&
                      message.content.trim().length > 0
                        ? () => handleGenerateScene(message.id, message.content)
                        : undefined
                    }
                    onTakeSelfie={
                      isAiMessage && baseSelfieEligible().eligible ? handleTakeSelfie : undefined
                    }
                    triggerEditNonce={message.id === lastUserMessageId ? editLastNonce : undefined}
                  />
                </div>
              );
            })}

            {error && (
              <div className="mx-4 my-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Typing indicator — shown while waiting for the first token. */}
            {isSending && !isStreaming && (
              <TypingIndicator
                speakerName={isGroupChatMode ? currentSpeakerName : null}
              />
            )}

            {/* Selfie indicator — shown while a [selfie: …] is rendering. */}
            {selfieGeneratingFor && (
              <div className="flex gap-3 px-4 py-3 items-center">
                <div className="w-10 h-10 rounded-full bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0 text-lg">
                  📸
                </div>
                <span className="text-sm text-[var(--color-text-secondary)] italic truncate">
                  {selfieGeneratingFor} is taking a selfie&hellip;
                </span>
              </div>
            )}

            {/* Lorebook v2 Phase 4: Auto Memory conflict awareness pill. */}
            {currentChatFile && (
              <LoreConflictChip
                chatFile={currentChatFile}
                onReview={() => setConflictSheetOpen(true)}
              />
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Stop button — shown during generation for both solo and group chat */}
      {isSending ? (
        <div className="flex items-center justify-center gap-2 px-4 py-2 border-t border-[var(--color-border)]">
          <button
            onClick={stopGeneration}
            className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/20 transition-colors"
          >
            <Square size={14} fill="currentColor" />
            <span>Stop</span>
          </button>
        </div>
      ) : null}

      {/* Panels — controlled from ChatOptionsMenu icon strip */}
      {currentChatFile && (
        <AuthorNote
          fileName={currentChatFile}
          isOpen={authorNoteOpen}
          onToggle={() => setAuthorNoteOpen((v) => !v)}
        />
      )}
      {summarizeEnabled && currentChatFile && selectedCharacter && (
        <SummaryPanel
          chatFile={currentChatFile}
          characterName={selectedCharacter.name}
          isOpen={summaryOpen}
          onToggle={() => setSummaryOpen((v) => !v)}
        />
      )}
      {currentChatFile && (
        <BranchPanel
          chatFile={currentChatFile}
          isOpen={branchOpen}
          onToggle={() => setBranchOpen((v) => !v)}
        />
      )}

      {/* Phase 8.6: Checkpoint naming dialog — slides in above the input */}
      {checkpointMessageId && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 flex items-center gap-2">
          <span className="text-sm text-[var(--color-text-secondary)] whitespace-nowrap">
            Checkpoint name:
          </span>
          <input
            ref={checkpointInputRef}
            type="text"
            value={checkpointName}
            onChange={(e) => setCheckpointName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCheckpoint();
              else if (e.key === 'Escape') setCheckpointMessageId(null);
            }}
            placeholder="e.g. Before the battle"
            className="flex-1 min-w-0 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-primary)]"
          />
          <button
            onClick={commitCheckpoint}
            className="p-1.5 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary)]/90 transition-colors"
            title="Save checkpoint"
          >
            <Check size={16} />
          </button>
          <button
            onClick={() => setCheckpointMessageId(null)}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title="Cancel"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Scene-video: non-blocking progress while the backend renders segments */}
      {sceneGenProgress !== null && (
        <div className="mx-4 mb-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <Clapperboard size={14} className="text-[var(--color-primary)] animate-pulse flex-shrink-0" />
          <span className="text-xs text-[var(--color-text-secondary)]">
            Generating scene video… {Math.round(sceneGenProgress * 100)}% — takes a few minutes, you can keep chatting
          </span>
        </div>
      )}

      {/* Phase 10.2: Quick Reply Bar */}
      <QuickReplyBar
        onPrefill={(text) => { setPrefillText(text); setPrefillNonce((n) => n + 1); }}
        onSend={handleSend}
        disabled={isSending}
      />

      {/* Always-present token fuel gauge */}
      <UsageGauge />

      {/* Input Area */}
      <ChatInput
        onSend={handleSend}
        disabled={isSending}
        placeholder={isGroupChatMode ? `Message the group...` : `Message ${displayName}...`}
        prefillText={prefillText}
        prefillNonce={prefillNonce}
        droppedImages={droppedImages}
        droppedImagesNonce={droppedImagesNonce}
        onEditLast={lastUserMessageId && !isSending ? () => setEditLastNonce((n) => n + 1) : undefined}
        onImageGen={imageGenEnabled && !isGroupChatMode && selectedCharacter ? () => setIsImageGenOpen(true) : undefined}
        onOpenChatMenu={selectedCharacter ? (anchor) => { setChatMenuAnchor(anchor); setIsChatMenuOpen((v) => !v); } : undefined}
      />

      {/* Phase 7.1: Image generation modal */}
      {selectedCharacter && (
        <ImageGenModal
          isOpen={isImageGenOpen}
          onClose={() => setIsImageGenOpen(false)}
          initialPrompt={selectedCharacter.name}
          messages={messages}
          characterName={selectedCharacter.name}
          onInsert={async (dataUrl, prompt) => {
            await insertImageMessage(
              dataUrl,
              prompt,
              selectedCharacter.name,
              selectedCharacter.avatar,
              selectedCharacter
            );
          }}
        />
      )}

      {/* Manual-strategy hint: auto-pick is disabled, so user has to force-talk. */}
      {isGroupChatMode &&
        groupChatRecord?.activationStrategy === 'manual' &&
        !isSending && (
          <div className="px-4 pb-2 text-xs text-[var(--color-text-secondary)] italic border-t border-[var(--color-border)]/30 pt-2">
            Manual mode: open settings{' '}
            <Settings2 size={10} className="inline -mt-0.5" /> and tap a talk icon to choose who speaks next.
          </div>
        )}
      {/* Phase 8.7: STscript popup/input/buttons modal */}
      {stscriptModal && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => { stscriptModal.resolve(''); setStscriptModal(null); }}>
          <div className="bg-[var(--color-bg-primary)] rounded-lg shadow-xl max-w-md w-full p-4" onClick={(e) => e.stopPropagation()}>
            <pre className="whitespace-pre-wrap text-sm text-[var(--color-text-primary)] mb-4 max-h-60 overflow-y-auto">{stscriptModal.message}</pre>
            {stscriptModal.type === 'input' && (
              <input
                autoFocus
                className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] mb-3"
                defaultValue={stscriptModal.defaultValue || ''}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    stscriptModal.resolve((e.target as HTMLInputElement).value);
                    setStscriptModal(null);
                  }
                }}
                id="stscript-input"
              />
            )}
            <div className="flex gap-2 justify-end">
              {stscriptModal.type === 'buttons' && stscriptModal.buttons ? (
                stscriptModal.buttons.map((label) => (
                  <button key={label} className="px-4 py-2 rounded bg-[var(--color-primary)] text-white text-sm" onClick={() => { stscriptModal.resolve(label); setStscriptModal(null); }}>
                    {label}
                  </button>
                ))
              ) : stscriptModal.type === 'input' ? (
                <>
                  <button className="px-4 py-2 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] text-sm" onClick={() => { stscriptModal.resolve(''); setStscriptModal(null); }}>Cancel</button>
                  <button className="px-4 py-2 rounded bg-[var(--color-primary)] text-white text-sm" onClick={() => {
                    const input = document.getElementById('stscript-input') as HTMLInputElement | null;
                    stscriptModal.resolve(input?.value || '');
                    setStscriptModal(null);
                  }}>OK</button>
                </>
              ) : (
                <button className="px-4 py-2 rounded bg-[var(--color-primary)] text-white text-sm" onClick={() => { stscriptModal.resolve('ok'); setStscriptModal(null); }}>OK</button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Chat Options Menu */}
      {selectedCharacter && (
        <ChatOptionsMenu
          isOpen={isChatMenuOpen}
          onClose={() => setIsChatMenuOpen(false)}
          anchor={chatMenuAnchor}
          authorNote={{
            isOpen: authorNoteOpen,
            hasContent: authorNoteContent.length > 0,
            onToggle: () => setAuthorNoteOpen((v) => !v),
          }}
          summary={{
            isOpen: summaryOpen,
            hasContent: summaryHasContent,
            enabled: summarizeEnabled,
            onToggle: () => setSummaryOpen((v) => !v),
          }}
          branches={{
            isOpen: branchOpen,
            hasContent: branchCount > 0,
            count: branchCount,
            onToggle: () => setBranchOpen((v) => !v),
          }}
          lorebook={{
            isOpen: chatLorebookOpen,
            hasContent: chatLorebookCount > 0,
            count: chatLorebookCount,
            conflictCount: chatConflictCount,
            onToggle: () => setChatLorebookOpen((v) => !v),
          }}
          onStartNewChat={() => startNewChat(selectedCharacter)}
          onManageChatFiles={() => setIsHistoryPanelOpen(true)}
          onChatStyle={currentChatFile ? () => setChatStyleOpen(true) : undefined}
          chatStyleActive={!!(chatLinkedPresetId || chatLinkedTemplateId)}
          onSaveCheckpoint={currentChatFile && lastAiMessageId ? () => handleCheckpoint(lastAiMessageId) : undefined}
          onDeleteMessages={() => startNewChat(selectedCharacter)}
          onConvertToGroup={!isGroupChatMode && selectedCharacter ? () => { setConvertGroupSelected([]); setIsConvertToGroupOpen(true); } : undefined}
          onGenerateLorebook={nonSystemMessageCount >= 6 ? () => setIsGenLorebookOpen(true) : undefined}
          onRegenerate={hasAiMessage && !isGroupChatMode ? handleRegenerate : undefined}
          onContinue={hasAiMessage && !isGroupChatMode ? handleContinue : undefined}
          onImpersonate={!isGroupChatMode ? handleImpersonate : undefined}
          onSetBackground={() => bgInputRef.current?.click()}
          onClearBackground={handleClearBg}
          hasBackground={!!vnBg}
          isGroupChat={isGroupChatMode}
        />
      )}

      {/* Create lorebook from chat transcript */}
      {selectedCharacter && (
        <GenerateLorebookModal
          isOpen={isGenLorebookOpen}
          onClose={() => setIsGenLorebookOpen(false)}
          messages={messages}
          characterName={selectedCharacter.name}
          defaultBookName={`${selectedCharacter.name} — Lore`}
          characterAvatar={selectedCharacter.avatar}
        />
      )}

      {/* Scene-video: summarize transcript → editable prompt → paid render */}
      {selectedCharacter && (
        <GenerateSceneModal
          isOpen={sceneModal !== null}
          onClose={() => setSceneModal(null)}
          messages={sceneModal?.transcript ?? []}
          characterName={selectedCharacter.name}
          characterDescription={displayMacroCtx.characterDescription}
          fallbackPrompt={sceneModal?.fallbackPrompt ?? ''}
          onGenerate={(p, b, d) => {
            setSceneModal(null);
            void startSceneRender(p, b, d);
          }}
        />
      )}

      {/* Manual character-selfie trigger */}
      {selectedCharacter && (
        <TakeSelfieModal
          isOpen={selfieModalOpen}
          onClose={() => setSelfieModalOpen(false)}
          characterName={selectedCharacter.name}
          canNsfw={canSelfieNsfw}
          onGenerate={handleSelfieGenerate}
        />
      )}

      {/* Convert to Group — character picker sheet */}
      <BottomSheet
        isOpen={isConvertToGroupOpen}
        onClose={() => setIsConvertToGroupOpen(false)}
        title="Add characters to group"
      >
        <div className="px-4 pb-4">
          <p className="text-xs text-[var(--color-text-secondary)] mb-3">
            Select characters to add alongside <strong>{selectedCharacter?.name}</strong>.
          </p>
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {allCharacters
              .filter((c) => c.avatar !== selectedCharacter?.avatar)
              .map((c) => {
                const selected = convertGroupSelected.includes(c.avatar);
                return (
                  <button
                    key={c.avatar}
                    type="button"
                    onClick={() =>
                      setConvertGroupSelected((prev) =>
                        selected ? prev.filter((a) => a !== c.avatar) : [...prev, c.avatar]
                      )
                    }
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors border
                      ${selected
                        ? 'bg-[var(--color-primary)]/15 border-[var(--color-primary)]/40 text-[var(--color-primary)]'
                        : 'border-transparent text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
                      }`}
                  >
                    <img
                      src={`/api/avatar/${c.avatar}`}
                      alt={c.name}
                      className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                    {selected && <Check size={14} className="flex-shrink-0" />}
                  </button>
                );
              })}
          </div>
          <button
            type="button"
            disabled={convertGroupSelected.length === 0}
            onClick={async () => {
              if (!selectedCharacter) return;
              const additional = allCharacters.filter((c) => convertGroupSelected.includes(c.avatar));
              setIsConvertToGroupOpen(false);
              await convertCurrentToGroup(selectedCharacter, additional);
            }}
            className="mt-4 w-full py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium
              disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            {convertGroupSelected.length === 0
              ? 'Select at least 1 character'
              : `Convert to group (${convertGroupSelected.length + 1} characters)`}
          </button>
        </div>
      </BottomSheet>

      {/* Chat History Panel (also opened from chat options menu) */}
      <ChatHistoryPanel
        isOpen={isHistoryPanelOpen}
        onClose={() => setIsHistoryPanelOpen(false)}
      />

      {/* Chat Lore panel (opened from chat options menu) */}
      {currentChatFile && (
        <ChatLorePanel
          isOpen={chatLorebookOpen}
          onClose={() => setChatLorebookOpen(false)}
          chatFile={currentChatFile}
          characterAvatars={chatLoreCharacterAvatars}
        />
      )}

      {/* Lorebook v2 Phase 4: Auto Memory conflict resolution sheet (opened
          from the LoreConflictChip's Review button). */}
      {currentChatFile && (
        <ConflictResolutionSheet
          isOpen={conflictSheetOpen}
          onClose={() => setConflictSheetOpen(false)}
          scope={{ kind: 'chat', chatFile: currentChatFile }}
        />
      )}

      {/* Chat Style modal (opened from chat options menu) */}
      {currentChatFile && (
        <ChatStyleModal
          isOpen={chatStyleOpen}
          onClose={() => setChatStyleOpen(false)}
          chatFile={currentChatFile}
          characterAvatar={selectedCharacter?.avatar}
        />
      )}

      </div>{/* end VN content wrapper */}
    </div>
  );
}
