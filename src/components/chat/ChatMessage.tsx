import { useState, useRef, useEffect, useMemo } from 'react';
import { MoreHorizontal, Check, X, Volume2, Square, Globe, EyeOff } from 'lucide-react';
import { Avatar } from '../ui';
import { BottomSheet } from '../ui/BottomSheet';
import { MessageActionMenu } from './MessageActionMenu';
import { useIsMobile } from '../../hooks/useIsMobile';
import { haptic } from '../../utils/haptics';
import { SwipeControl } from './SwipeControl';
import { stripEmotionTag } from '../../utils/emotions';
import { MarkdownContent } from './MarkdownContent';
import { useSpeechSynthesis } from '../../hooks/useSpeechSynthesis';
import type { ChatLayoutMode, AvatarShape, AvatarSize } from '../../hooks/displayPreferences';
import type { TokenUsage } from '../../stores/chatStore';
import { formatTokens } from '../../stores/usageStore';
import { estimateTokens, profileForProvider } from '../../utils/tokenizer';
import { useRegexScriptStore } from '../../stores/regexScriptStore';
import { useLovenseStore } from '../../stores/lovenseStore';
import { stripLovenseTags } from '../../utils/lovense';
import { stripSelfieTags } from '../../utils/selfie';
import { applyRegexScripts, getActiveScripts } from '../../utils/regexScripts';
import { useTranslateStore } from '../../stores/translateStore';
import { useExtensionStore } from '../../stores/extensionStore';
import { useSlotItems, invokeSlotItem } from '../../extensions/sandbox/sandboxSlotRegistry';

interface ChatMessageProps {
  /** Unique message id — used as TTS tracking key. */
  messageId: string;
  name: string;
  content: string;
  isUser: boolean;
  isSystem?: boolean;
  /** #414: message is hidden from the AI — rendered dimmed + badged, still visible. */
  hidden?: boolean;
  avatar?: string;
  /** Fallback avatar URL when the primary (expression) avatar fails to load. */
  avatarFallback?: string;
  /** Called when the primary avatar fails, e.g. to track failed expression sprites. */
  onAvatarError?: () => void;
  timestamp?: number;
  disabled?: boolean;
  /** Phase 6.1: attached image data URLs shown as a grid above content. */
  images?: string[];
  /** Scene-video: generated MP4 URLs shown as inline players above content. */
  videos?: string[];
  /** Phase 8.2: raw character avatar string for display-only regex scoping. */
  characterAvatar?: string;
  /** Phase 7.2: true while this message is actively being streamed. */
  isStreaming?: boolean;
  /**
   * True when this is the latest message in the chat — gates expensive
   * per-message effects like the LivePortrait animator so we only run it
   * for the visible/current speaker rather than every AI message in history.
   */
  isLastMessage?: boolean;
  /** Phase 7.3: display style settings. */
  layoutMode?: ChatLayoutMode;
  avatarShape?: AvatarShape;
  avatarSize?: AvatarSize;
  fontSize?: number;
  chatMaxWidth?: number;
  /** Estimated per-turn token usage (AI messages only); renders a cost chip. */
  usage?: TokenUsage;
  // Swipe support (only for AI messages)
  swipes?: string[];
  swipeId?: number;
  showSwipeControl?: boolean;
  canGenerateSwipe?: boolean;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  // Actions
  onEdit?: (newContent: string) => void;
  onEditAndRegenerate?: (newContent: string) => void;
  onDelete?: () => void;
  /** #414: flip this message's hidden-from-AI state. */
  onToggleHide?: () => void;
  onRegenerate?: () => void;
  /** Phase 8.6: create a checkpoint at this message. */
  onCheckpoint?: () => void;
  /** Scene-video: render this message as a ~30s video via Replicate. */
  onGenerateScene?: () => void;
  /** Manual character-selfie trigger (opens TakeSelfieModal). */
  onTakeSelfie?: () => void;
  /** Increment this to programmatically trigger edit mode (e.g. up-arrow shortcut). */
  triggerEditNonce?: number;
}


export function ChatMessage({
  messageId,
  name,
  content,
  isUser,
  isSystem,
  hidden,
  avatar,
  avatarFallback,
  onAvatarError,
  timestamp,
  disabled,
  images,
  videos,
  characterAvatar,
  usage,
  swipes,
  swipeId,
  showSwipeControl,
  canGenerateSwipe,
  onSwipeLeft,
  onSwipeRight,
  isStreaming: isStreamingMsg,
  layoutMode = 'bubbles',
  avatarShape = 'circle',
  avatarSize = 'default',
  fontSize,
  chatMaxWidth = 80,
  onEdit,
  onEditAndRegenerate,
  onDelete,
  onToggleHide,
  onRegenerate,
  onCheckpoint,
  onGenerateScene,
  onTakeSelfie,
  triggerEditNonce,
}: ChatMessageProps) {
  const isMobile = useIsMobile();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [showMenu, setShowMenu] = useState(false);
  const [showEditOptions, setShowEditOptions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Phase 8.2: apply display-only regex scripts for rendering.
  // Only display-only scripts run at render time; permanent scripts run at
  // finalization in the store so stored content already reflects them.
  // For AI messages, also strip emotion tags and [Name]: prefixes that the
  // model echoes from group-chat history formatting.
  const regexScripts = useRegexScriptStore((s) => s.scripts);
  // Hide Lovense control tags (e.g. "[lovense: vibrate 15]") from the rendered
  // message when the extension is enabled and tag-hiding is on. The raw content
  // (tags intact) stays in the store so the reaction parser still sees them.
  const lovenseEnabled = useExtensionStore((s) => s.enabled.lovense);
  const hideLovenseTags = useLovenseStore((s) => s.hideTagsInChat);
  const displayContent = useMemo(() => {
    const scope = isUser ? 'user_input' : 'ai_output';
    let text = content;
    if (!isUser) {
      text = stripEmotionTag(text)
        .replace(new RegExp(`^\\[${name}\\]:\\s*`, 'i'), '')
        .trim();
      // Truncate at first [OtherCharacter]: mid-response marker
      const otherTurn = text.match(/\n\[[^\]]+\]:\s*/);
      if (otherTurn?.index !== undefined) text = text.slice(0, otherTurn.index).trim();
      if (lovenseEnabled && hideLovenseTags) text = stripLovenseTags(text).trim();
      // Always hide [selfie: …] tags — the tag is a generation request meant to
      // be replaced by an image bubble, never shown as literal text. The raw tag
      // stays in the store so the finish-edge dispatcher (selfieDispatch) sees it.
      text = stripSelfieTags(text).trim();
    }
    const scripts = getActiveScripts(regexScripts, characterAvatar, scope).filter(s => s.displayOnly);
    return scripts.length > 0 ? applyRegexScripts(text, scripts) : text;
  }, [content, name, regexScripts, characterAvatar, isUser, lovenseEnabled, hideLovenseTags]);

  // Phase 7.1: Extension gates
  const ttsEnabled = useExtensionStore((s) => s.enabled.tts);
  const translateEnabled = useExtensionStore((s) => s.enabled.translate);

  // Sandbox extension-contributed message action buttons
  const messageActionSlotItems = useSlotItems('messageActions');
  const messageActionExtras = useMemo(
    () =>
      messageActionSlotItems.map((item) => ({
        key: `${item.frameId}:${item.itemId}`,
        label: item.label,
        tooltip: item.tooltip,
        onClick: () => {
          invokeSlotItem(item.frameId, item.itemId, {
            messageId,
            name,
            isUser,
            content,
            swipeId,
          });
        },
      })),
    [messageActionSlotItems, messageId, name, isUser, content, swipeId],
  );

  // Phase 6.3: TTS — only wired for non-user, non-system messages.
  const { isSupported: ttsSupported, isSpeaking, speak, stop } = useSpeechSynthesis();
  const showTtsButton = ttsEnabled && ttsSupported && !isUser && !isSystem && content.length > 0;

  // Phase 7.2: Translation
  const showTranslateButton = translateEnabled && !isUser && !isSystem && content.length > 0;
  const translatedText = useTranslateStore((s) => s.cache.get(messageId));
  const isTranslating = useTranslateStore((s) => s.pending.has(messageId));
  const showTranslation = useTranslateStore((s) => s.visible.has(messageId));
  const targetLang = useTranslateStore((s) => s.targetLang);
  const toggleTranslation = useTranslateStore((s) => s.toggleTranslation);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  // Programmatic edit trigger (e.g. up-arrow shortcut from ChatInput)
  useEffect(() => {
    if (triggerEditNonce && onEdit) {
      setEditContent(content);
      setIsEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerEditNonce]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [editContent, isEditing]);

  const handleStartEdit = () => {
    setEditContent(content);
    setIsEditing(true);
    setShowEditOptions(false);
  };

  const handleCancelEdit = () => {
    setEditContent(content);
    setIsEditing(false);
    setShowEditOptions(false);
  };

  const handleSaveOnly = () => {
    if (editContent.trim() && editContent !== content) {
      onEdit?.(editContent.trim());
    }
    setIsEditing(false);
    setShowEditOptions(false);
  };

  const handleSaveAndRegenerate = () => {
    if (editContent.trim() && onEditAndRegenerate) {
      onEditAndRegenerate(editContent.trim());
    }
    setIsEditing(false);
    setShowEditOptions(false);
  };

  const handleCopy = () => {
    navigator.clipboard?.writeText(content).catch(() => {});
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancelEdit();
    } else if (e.key === 'Enter' && !e.shiftKey && !isUser) {
      e.preventDefault();
      handleSaveOnly();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (isUser && onEditAndRegenerate) {
        handleSaveAndRegenerate();
      } else {
        handleSaveOnly();
      }
    }
  };

  // Font size style applied to content containers
  const fontStyle = fontSize && fontSize !== 14 ? { fontSize: `${fontSize}px` } : undefined;

  // ---- System messages: identical in all modes ----
  if (isSystem) {
    return (
      <div className="flex justify-center my-4">
        <div className="px-4 py-2 bg-[var(--color-bg-tertiary)] rounded-full text-xs text-[var(--color-text-secondary)]">
          {content}
        </div>
      </div>
    );
  }

  // ---- Shared UI fragments ----

  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  // Per-turn token cost chip (AI messages only). Output is recomputed from the
  // currently displayed text so it stays accurate when navigating between
  // swipes; the prompt (input) is shared across a turn's swipes, so the stored
  // value is reused. Estimated — the leading "~" and tooltip make that clear.
  const usageOutTokens =
    !isUser && usage
      ? estimateTokens(displayContent, profileForProvider(usage.provider || ''))
      : 0;
  const usageChip =
    !isUser && usage && (usage.inputTokens > 0 || usageOutTokens > 0) ? (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] tabular-nums whitespace-nowrap"
        title={`Estimated this turn: ~${usage.inputTokens.toLocaleString()} input + ~${usageOutTokens.toLocaleString()} output tokens`}
      >
        ~{formatTokens(usage.inputTokens + usageOutTokens)} tok
      </span>
    ) : null;

  // #414: badge shown on a hidden message. Lives in the header row (outside the
  // dimmed content) so it stays fully legible while the message body is faded.
  const hiddenBadge = hidden ? (
    <span
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]"
      title="Hidden from the AI — this message is not sent in the prompt or summaries"
    >
      <EyeOff size={11} /> Hidden from AI
    </span>
  ) : null;

  const actionButtons = !isEditing && (onEdit || onDelete) ? (
    <div className="relative flex flex-col gap-0.5">
      <button
        onClick={() => { setShowMenu(!showMenu); haptic(); }}
        disabled={disabled}
        className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-50"
        aria-label="Message actions"
      >
        <MoreHorizontal size={16} />
      </button>
      {/* Desktop: dropdown menu. Mobile: bottom sheet. */}
      {isMobile ? (
        <BottomSheet isOpen={showMenu} onClose={() => setShowMenu(false)} title="Message Actions">
          <div className="space-y-1">
            {[
              { key: 'edit',   label: 'Edit',   onClick: handleStartEdit },
              { key: 'copy',   label: 'Copy',   onClick: handleCopy },
              ...(onCheckpoint ? [{ key: 'checkpoint', label: 'Checkpoint', onClick: onCheckpoint }] : []),
              ...(!isUser && onRegenerate ? [{ key: 'regen', label: 'Regenerate', onClick: onRegenerate }] : []),
              ...(onGenerateScene ? [{ key: 'scene', label: 'Generate scene', onClick: onGenerateScene }] : []),
              ...(onTakeSelfie ? [{ key: 'selfie', label: 'Take selfie', onClick: onTakeSelfie }] : []),
              ...messageActionExtras.map((e) => ({ key: `ext_${e.key}`, label: e.label, onClick: e.onClick })),
              ...(onToggleHide ? [{ key: 'hide', label: hidden ? 'Unhide from AI' : 'Hide from AI', onClick: () => onToggleHide?.() }] : []),
              { key: 'delete', label: 'Delete', onClick: () => onDelete?.(), danger: true },
            ].map((action) => {
              const isDanger = 'danger' in action && action.danger;
              return (
                <button
                  key={action.key}
                  onClick={() => { action.onClick(); setShowMenu(false); }}
                  className={`w-full text-left px-3 py-3 rounded-lg text-sm transition-colors hover:bg-[var(--color-bg-tertiary)] ${
                    isDanger ? 'text-red-400' : 'text-[var(--color-text-primary)]'
                  }`}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        </BottomSheet>
      ) : (
        <MessageActionMenu
          isOpen={showMenu}
          onClose={() => setShowMenu(false)}
          onEdit={handleStartEdit}
          onCopy={handleCopy}
          onDelete={() => onDelete?.()}
          onToggleHide={onToggleHide ? () => onToggleHide() : undefined}
          hidden={hidden}
          onRegenerate={onRegenerate}
          showRegenerate={!isUser && !!onRegenerate}
          onCheckpoint={onCheckpoint}
          onGenerateScene={onGenerateScene}
          onTakeSelfie={onTakeSelfie}
          extras={messageActionExtras}
          anchorRight={layoutMode === 'bubbles' && isUser}
        />
      )}
      {showTtsButton && (
        <button
          onClick={() => isSpeaking ? stop() : speak(content, messageId)}
          className={`p-1.5 rounded-lg transition-all ${
            isSpeaking
              ? 'text-[var(--color-primary)] bg-[var(--color-primary)]/10 opacity-100'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100'
          }`}
          aria-label={isSpeaking ? 'Stop speaking' : 'Read aloud'}
          title={isSpeaking ? 'Stop' : 'Read aloud'}
        >
          {isSpeaking ? <Square size={14} /> : <Volume2 size={14} />}
        </button>
      )}
      {showTranslateButton && (
        <button
          onClick={() => toggleTranslation(messageId, content)}
          className={`p-1.5 rounded-lg transition-all ${
            showTranslation
              ? 'text-[var(--color-primary)] bg-[var(--color-primary)]/10 opacity-100'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
          aria-label={showTranslation ? 'Hide translation' : 'Translate'}
          title={showTranslation ? 'Hide translation' : 'Translate'}
        >
          <Globe size={14} />
        </button>
      )}
    </div>
  ) : null;

  const translationPanel = showTranslation && !isEditing ? (
    <div className="mt-2 pt-2 border-t border-[var(--color-border)]/30">
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)] mb-0.5 select-none">
        Translated · {targetLang}
      </p>
      {isTranslating ? (
        <p className="text-sm italic text-[var(--color-text-secondary)] animate-pulse">
          Translating…
        </p>
      ) : (
        <p className="text-sm italic text-[var(--color-text-secondary)] break-words whitespace-pre-wrap">
          {translatedText}
        </p>
      )}
    </div>
  ) : null;

  const imageGrid = !isEditing && images && images.length > 0 ? (
    <div
      className={`grid gap-1 ${content.length > 0 ? 'mb-2' : ''} ${
        images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
      }`}
    >
      {images.map((src, idx) => (
        <a
          key={idx}
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg overflow-hidden"
          aria-label={`View attachment ${idx + 1}`}
        >
          <img
            src={src}
            alt={`Attachment ${idx + 1}`}
            className="w-full h-auto max-h-60 object-cover block"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  ) : null;

  const videoBlock = !isEditing && videos && videos.length > 0 ? (
    <div className={`flex flex-col gap-1 ${content.length > 0 ? 'mb-2' : ''}`}>
      {videos.map((src, idx) => (
        <video
          key={idx}
          src={src}
          controls
          loop
          playsInline
          preload="metadata"
          className="w-full max-h-80 rounded-lg bg-black"
          aria-label={`Scene video ${idx + 1}`}
        />
      ))}
    </div>
  ) : null;

  const editingUI = isEditing ? (
    <div className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        onKeyDown={handleKeyDown}
        className={`w-full bg-transparent text-sm resize-none outline-none min-h-[60px] ${
          isUser && layoutMode === 'bubbles' ? 'text-white' : 'text-[var(--color-text-primary)]'
        }`}
        style={fontStyle}
        placeholder="Enter message..."
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={handleCancelEdit}
          className={`p-1.5 rounded-lg transition-colors ${
            isUser && layoutMode === 'bubbles'
              ? 'bg-white/20 hover:bg-white/30'
              : 'bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-primary)]'
          }`}
          title="Cancel (Esc)"
        >
          <X size={14} />
        </button>
        {isUser && onEditAndRegenerate ? (
          <div className="relative">
            <button
              onClick={() => setShowEditOptions(!showEditOptions)}
              className={`p-1.5 rounded-lg transition-colors ${
                isUser && layoutMode === 'bubbles'
                  ? 'bg-white/20 hover:bg-white/30'
                  : 'bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-primary)]'
              }`}
              title="Save options"
            >
              <Check size={14} />
            </button>
            {showEditOptions && (
              <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden">
                <button
                  onClick={handleSaveOnly}
                  className="w-full px-3 py-2 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                >
                  Save only
                </button>
                <button
                  onClick={handleSaveAndRegenerate}
                  className="w-full px-3 py-2 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                >
                  Save &amp; regenerate
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={handleSaveOnly}
            className={`p-1.5 rounded-lg transition-colors ${
              isUser && layoutMode === 'bubbles'
                ? 'bg-white/20 hover:bg-white/30'
                : 'bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-primary)]'
            }`}
            title="Save (Enter)"
          >
            <Check size={14} />
          </button>
        )}
      </div>
    </div>
  ) : null;

  const messageContent = !isEditing && content.length > 0 ? (
    <div className={`break-words${isUser ? ' whitespace-pre-wrap' : ''}`} style={fontStyle}>
      <MarkdownContent content={isUser ? content : displayContent} isUser={isUser} isStreaming={isStreamingMsg} />
    </div>
  ) : null;

  const swipeControl = showSwipeControl && !isEditing && swipes && swipeId !== undefined && onSwipeLeft && onSwipeRight && swipes.length >= 1 ? (
    <SwipeControl
      swipeId={swipeId}
      swipesCount={swipes.length}
      onSwipeLeft={onSwipeLeft}
      onSwipeRight={onSwipeRight}
      disabled={disabled}
      canGenerate={canGenerateSwipe}
    />
  ) : null;


  // ==================================================================
  // Bubbles layout (default — original behavior)
  // ==================================================================
  if (layoutMode === 'bubbles') {
    return (
      <div className={`flex gap-3 px-4 py-3 group ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
        <Avatar
          src={avatar}
          fallbackSrc={avatarFallback}
          onFallback={onAvatarError}
          alt={name}
          size={avatarSize === 'default' ? 'md' : avatarSize}
          shape={avatarShape}
          className="flex-shrink-0"
        />

        <div
          className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} ${isEditing ? 'w-full' : ''}`}
          style={{ maxWidth: `${chatMaxWidth}%` }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">{name}</span>
            {timeStr && <span className="text-xs text-zinc-500">{timeStr}</span>}
            {usageChip}
            {hiddenBadge}
          </div>

          <div className={`flex items-start gap-2 relative ${isEditing ? 'w-full' : ''}`}>
            {actionButtons}
            <div
              className={`
                px-4 py-2 rounded-2xl
                ${isUser
                  ? 'bg-[var(--color-primary)] text-white rounded-br-md cyberpunk-user-bubble'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] rounded-bl-md'}
                ${isEditing ? 'w-full' : ''}
                ${hidden ? 'opacity-50' : ''}
                ${!isEditing && onEdit ? 'cursor-text select-text' : ''}
              `}
              onDoubleClick={!isEditing && onEdit ? handleStartEdit : undefined}
            >
              {imageGrid}
              {videoBlock}
              {editingUI}
              {messageContent}
              {translationPanel}
            </div>
          </div>

          {swipeControl}
        </div>
      </div>
    );
  }

  // ==================================================================
  // Flat layout — full-width, dividers, no bubble background
  // ==================================================================
  if (layoutMode === 'flat') {
    return (
      <div
        className={`px-4 py-3 group border-b border-[var(--color-border)]/20 ${
          isUser ? 'border-l-2 border-l-[var(--color-primary)]' : ''
        }`}
      >
        {/* Header row: avatar + name + time + actions */}
        <div className="flex items-center gap-2 mb-1.5">
          <Avatar
            src={avatar}
            fallbackSrc={avatarFallback}
            onFallback={onAvatarError}
            alt={name}
            size={avatarSize === 'default' ? 'sm' : avatarSize}
            shape={avatarShape}
            className="flex-shrink-0"
          />
          <span className={`text-xs font-semibold ${
            isUser ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]'
          }`}>
            {name}
          </span>
          {timeStr && <span className="text-xs text-zinc-500">{timeStr}</span>}
          {usageChip}
          {hiddenBadge}
          <div className="ml-auto">{actionButtons}</div>
        </div>

        {/* Content area */}
        <div
          className={`text-[var(--color-text-primary)] ${hidden ? 'opacity-50' : ''}`}
          onDoubleClick={!isEditing && onEdit ? handleStartEdit : undefined}
        >
          {imageGrid}
          {videoBlock}
          {isEditing ? (
            <div className="p-2 rounded-lg bg-[var(--color-bg-tertiary)]">
              {editingUI}
            </div>
          ) : messageContent}
        </div>
        {translationPanel}

        {swipeControl}
      </div>
    );
  }

  // ==================================================================
  // Document layout — compact, inline names, no avatars
  // ==================================================================
  return (
    <div className="px-4 py-1.5 group">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 text-[var(--color-text-primary)]">
          {/* Inline name + timestamp */}
          <span className={`font-bold text-sm ${
            isUser ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]'
          }`}>
            {name}
          </span>
          {timeStr && <span className="text-xs text-zinc-500 ml-2">{timeStr}</span>}
          {usageChip}
          {hidden && <span className="ml-2 inline-flex">{hiddenBadge}</span>}

          {imageGrid && <div className={`mt-1 ${hidden ? 'opacity-50' : ''}`}>{imageGrid}</div>}
          {videoBlock && <div className={`mt-1 ${hidden ? 'opacity-50' : ''}`}>{videoBlock}</div>}

          {isEditing ? (
            <div className="mt-1 p-2 rounded-lg bg-[var(--color-bg-tertiary)]">
              {editingUI}
            </div>
          ) : messageContent ? (
            <div
              className={`mt-0.5 ${hidden ? 'opacity-50' : ''}`}
              onDoubleClick={!isEditing && onEdit ? handleStartEdit : undefined}
            >
              {messageContent}
            </div>
          ) : null}
          {translationPanel}
        </div>

        {actionButtons}
      </div>

      {swipeControl}
    </div>
  );
}
