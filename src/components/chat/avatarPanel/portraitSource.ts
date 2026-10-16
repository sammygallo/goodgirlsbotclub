import { resolveMotionMode, type MotionMode, type ResolvedMotionMode } from '../../../stores/motionModeStore';
import type { ChatMessage } from '../../../stores/chatStore';
import { getDefaultAvatarUrl, mapEmotionToAvailable, type Emotion } from '../../../utils/emotions';

/**
 * Pure source resolution for the desktop avatar panel (D-C5, D-C6).
 *
 * The sprite lookups below are deliberate copies of ChatView's
 * `getFullImageUrl` and `findPreviousValidSpritePath`, kept line-for-line so
 * the panel and the mobile portrait pick the same image for the same chat.
 * ChatView is not refactored onto them (E6-S4 keeps ChatView edits to wiring).
 */

/**
 * `resolveMotionMode`, unchanged, with reduced motion applied at the call
 * site (D-C6): under reduced motion `auto` skips Live Portrait and resolves to
 * expressions, then static. An explicit `liveportrait` still plays, because
 * the user opted in.
 */
export function resolvePanelMotionMode(
  mode: MotionMode,
  hasLivePortraitClips: boolean,
  hasExpressionSprites: boolean,
  reducedMotion: boolean,
): ResolvedMotionMode {
  return resolveMotionMode(
    mode,
    reducedMotion && mode === 'auto' ? false : hasLivePortraitClips,
    hasExpressionSprites,
  );
}

export interface SpriteLookup {
  failedExpressions: ReadonlySet<string>;
  availableEmotions: string[];
  getSpritePath: (emotion: string | null) => string | null;
}

/**
 * Mirror of ChatView's `findPreviousValidSpritePath`: with "no fallback" on,
 * walk back through the chat for the newest emotion of `avatar` whose sprite
 * still resolves.
 *
 * `fallbackAvatar` attributes messages that carry no `characterAvatar`: the
 * character in a solo chat. In a group chat pass null, so an unattributed
 * message is attributed to nobody — the panel never derives identity from
 * the current selection (#458).
 */
export function findPreviousValidSpritePath(
  messages: readonly ChatMessage[],
  avatar: string,
  isGroup: boolean,
  fallbackAvatar: string | null,
  { failedExpressions, availableEmotions, getSpritePath }: SpriteLookup,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.isUser || m.isSystem || !m.emotion) continue;
    const msgAvatar = isGroup && m.characterAvatar ? m.characterAvatar : fallbackAvatar;
    if (msgAvatar !== avatar) continue;
    const key = `${avatar}-${m.emotion}`;
    if (failedExpressions.has(key)) continue;
    const mapped = mapEmotionToAvailable(m.emotion, availableEmotions);
    const path = getSpritePath(mapped || m.emotion);
    if (path) return path;
  }
  return null;
}

/**
 * Mirror of ChatView's `getFullImageUrl`: the sprite for `emotion` unless it
 * already failed, else (with "no fallback" on) the walk-back sprite, else the
 * default avatar.
 */
export function resolvePortraitImageUrl(
  avatar: string,
  emotion: Emotion | null | undefined,
  {
    failedExpressions,
    getSpritePath,
    noFallback,
    previousValidSpritePath,
  }: {
    failedExpressions: ReadonlySet<string>;
    getSpritePath: (emotion: string | null) => string | null;
    noFallback: boolean;
    /** The walk-back result for `avatar`, computed by the caller. */
    previousValidSpritePath: string | null;
  },
): string {
  const expressionKey = `${avatar}-${emotion}`;
  if (emotion && !failedExpressions.has(expressionKey)) {
    const spritePath = getSpritePath(emotion);
    if (spritePath) return spritePath;
  }
  if (noFallback && previousValidSpritePath) return previousValidSpritePath;
  return getDefaultAvatarUrl(avatar);
}
