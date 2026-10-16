import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CharacterInfo } from '../../../api/client';
import { useChatStore } from '../../../stores/chatStore';
import { getDefaultAvatarUrl } from '../../../utils/emotions';
import { GroupThumbnailStrip } from './GroupThumbnailStrip';
import { latestEmotionFor } from './groupFocus';
import { PanelToolbar } from './PanelToolbar';
import { PortraitMedia } from './PortraitMedia';
import { findPreviousValidSpritePath, resolvePortraitImageUrl } from './portraitSource';
import { useDesktopFraming } from './useDesktopFraming';
import { useGroupFocus } from './useGroupFocus';
import { usePanelSource } from './usePanelSource';

export const AVATAR_PANEL_ID = 'chat-avatar-panel';

const NO_MEMBERS: readonly string[] = [];

interface DesktopAvatarPanelProps {
  kind: 'solo' | 'group';
  /** Solo: the chat's character. */
  character?: CharacterInfo | null;
  /** Group: the roster, in roster order. */
  members?: readonly CharacterInfo[];
  /** Solo sprite costume (group chats use each member's own folder). */
  costume?: string | null;
  /** ChatView's failed sprite keys, shared so a 404 falls back everywhere at once. */
  failedExpressions: ReadonlySet<string>;
  onExpressionFailed: (key: string) => void;
  onHide: () => void;
  /** Move focus to "Hide portrait" on mount — set when "Show portrait" opened the panel. */
  focusHideOnMount?: boolean;
}

/**
 * The desktop chat's avatar panel (§5, D-C1–D-C14): a full-bleed 1/3 column
 * beside the chat showing the character — or, in a group chat, the focused
 * member — through Live Portrait, a sprite or the static avatar.
 *
 * It only reads chat state. It never writes to or derives chat identity
 * (#458).
 */
export function DesktopAvatarPanel({
  kind,
  character = null,
  members = [],
  costume = null,
  failedExpressions,
  onExpressionFailed,
  onHide,
  focusHideOnMount = false,
}: DesktopAvatarPanelProps) {
  const isGroup = kind === 'group';
  const rosterAvatars = useMemo(() => members.map((m) => m.avatar), [members]);
  const { focusedAvatar, pinMember } = useGroupFocus(isGroup ? rosterAvatars : NO_MEMBERS);

  const shown = isGroup ? members.find((m) => m.avatar === focusedAvatar) ?? null : character;
  const avatar = shown?.avatar ?? null;
  const name = shown?.name ?? '';

  const source = usePanelSource(avatar, isGroup ? null : costume);
  const latestEmotion = useChatStore((s) => latestEmotionFor(s.messages, isGroup, avatar));
  const previousValidSprite = useChatStore(
    useShallow((s) =>
      source.noFallback && avatar
        ? findPreviousValidSpritePath(s.messages, avatar, isGroup, isGroup ? null : avatar, {
            failedExpressions,
            availableEmotions: source.availableEmotions,
            getSpritePath: source.getSpritePath,
          })
        : null,
    ),
  );

  const [paused, setPaused] = useState(false);
  const framingButtonRef = useRef<HTMLButtonElement>(null);
  const hideButtonRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const instructionId = useId();
  const framing = useDesktopFraming(avatar, () => framingButtonRef.current?.focus());

  useEffect(() => {
    if (focusHideOnMount) hideButtonRef.current?.focus();
  }, [focusHideOnMount]);

  useEffect(() => {
    if (framing.framing) surfaceRef.current?.focus();
  }, [framing.framing]);

  if (!avatar) return null;

  const expressionsActive = source.resolved === 'expressions';
  const livePortraitPlaying = source.resolved === 'liveportrait' && !!source.clips;
  // D-C5: expressions mode shows the sprite for the latest emotion; static
  // (`none`, or a mode without its assets) shows the default avatar.
  const imageUrl = expressionsActive
    ? resolvePortraitImageUrl(avatar, latestEmotion, {
        failedExpressions,
        getSpritePath: source.getSpritePath,
        noFallback: source.noFallback,
        previousValidSpritePath: previousValidSprite?.path ?? null,
      })
    : getDefaultAvatarUrl(avatar);
  // A failure is reported against the emotion whose sprite is on screen: the
  // walk-back's when the latest emotion's own sprite is not the one shown.
  const latestSpriteShown =
    !!latestEmotion &&
    !failedExpressions.has(`${avatar}-${latestEmotion}`) &&
    !!source.getSpritePath(latestEmotion);
  const shownEmotion =
    !latestSpriteShown && previousValidSprite && imageUrl === previousValidSprite.path
      ? previousValidSprite.emotion
      : latestEmotion;
  const expressionKey = shownEmotion ? `${avatar}-${shownEmotion}` : null;
  const failedExpressionKey =
    expressionsActive &&
    expressionKey &&
    !failedExpressions.has(expressionKey) &&
    imageUrl !== getDefaultAvatarUrl(avatar)
      ? expressionKey
      : null;

  const { x, y } = framing.position;
  const showChip = !isGroup && expressionsActive && !!latestEmotion;

  return (
    <aside
      id={AVATAR_PANEL_ID}
      aria-label={isGroup ? `Group portrait: ${name}` : `${name} portrait`}
      className="@container/panel hidden lg:@min-[600px]/main:flex flex-none w-1/3 relative overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg-tertiary)]"
    >
      <div
        ref={surfaceRef}
        {...framing.surfaceHandlers}
        tabIndex={framing.framing ? 0 : undefined}
        role={framing.framing ? 'group' : undefined}
        aria-label={framing.framing ? 'Portrait framing' : undefined}
        aria-describedby={framing.framing ? instructionId : undefined}
        className={`absolute inset-0 ${
          framing.framing
            ? 'cursor-grab active:cursor-grabbing touch-none outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white'
            : ''
        }`}
      >
        <PortraitMedia
          avatar={avatar}
          name={name}
          resolved={source.resolved}
          clips={source.clips}
          emotion={latestEmotion}
          imageUrl={imageUrl}
          failedExpressionKey={failedExpressionKey}
          onExpressionFailed={onExpressionFailed}
          objectPosition={`${x}% ${y}%`}
          paused={paused}
          reducedMotion={source.reducedMotion}
        />
      </div>

      <PanelToolbar
        avatar={avatar}
        hasLivePortraitClips={source.hasClips}
        hasExpressionSprites={source.hasSprites}
        livePortraitPlaying={livePortraitPlaying}
        paused={paused}
        onTogglePaused={() => setPaused((p) => !p)}
        framing={framing.framing}
        onToggleFraming={() => framing.setFraming(!framing.framing)}
        onHide={onHide}
        framingButtonRef={framingButtonRef}
        hideButtonRef={hideButtonRef}
      />

      {framing.framing && (
        <div className="absolute left-3 right-3 top-14 z-10 flex flex-wrap items-center justify-center gap-2">
          <p
            id={instructionId}
            className="rounded-full px-3 py-1.5 text-xs text-[color:var(--on-scrim-text)]"
            style={{ backgroundColor: 'rgb(0 0 0 / .7)' }}
          >
            Drag or use arrow keys to reposition
          </p>
          <button
            type="button"
            onClick={framing.reset}
            className="rounded-full px-3 py-1.5 text-xs font-medium text-[color:var(--on-scrim-text)] hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            style={{ backgroundColor: 'rgb(0 0 0 / .7)' }}
          >
            Reset framing
          </button>
        </div>
      )}

      {(showChip || isGroup) && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end px-3 pb-3 pt-16"
          style={{ backgroundImage: 'var(--scrim-hero)' }}
        >
          {isGroup ? (
            <div className="pointer-events-auto min-w-0 max-w-full">
              <GroupThumbnailStrip members={members} focusedAvatar={avatar} onPin={pinMember} />
            </div>
          ) : (
            // Plain text, not a live region: chat messages are already announced.
            <span className="rounded-full bg-black/40 px-2 py-1 text-xs capitalize text-[color:var(--on-scrim-text)]">
              {latestEmotion}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
