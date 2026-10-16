import type { ChatMessage } from '../../../stores/chatStore';

/**
 * Pure reads of the open transcript for the desktop avatar panel (D-C7).
 *
 * A group member is identified by `characterAvatar` only — never by `name`
 * (two members of a roster can share one) and never by `currentSpeakerName`
 * (K14). These functions read; nothing here writes to or derives chat
 * identity (#458).
 */

function isAiMessage(m: ChatMessage): boolean {
  return !m.isUser && !m.isSystem;
}

/**
 * Which member the group panel shows, in order:
 *  1. the in-flight streaming message's `characterAvatar` (the group send
 *     path writes it on the placeholder, chatStore `sendGroupMessage`);
 *  2. the newest AI message's `characterAvatar`;
 *  3. roster slot 0.
 * A `characterAvatar` that is not in the roster is skipped at every step.
 */
export function resolveGroupFocusAvatar(
  messages: readonly ChatMessage[],
  rosterAvatars: readonly string[],
  isStreaming: boolean,
): string | null {
  const inRoster = (avatar: string | undefined): avatar is string =>
    !!avatar && rosterAvatars.includes(avatar);

  if (isStreaming) {
    const streaming = messages[messages.length - 1];
    if (streaming && isAiMessage(streaming) && inRoster(streaming.characterAvatar)) {
      return streaming.characterAvatar;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isAiMessage(m) && inRoster(m.characterAvatar)) return m.characterAvatar;
  }
  return rosterAvatars[0] ?? null;
}

/**
 * The emotion the panel shows. Solo: the newest AI message's emotion, as
 * ChatView's `latestEmotion`. Group: the emotion of that member's own newest
 * message (matched by `characterAvatar`).
 */
export function latestEmotionFor(
  messages: readonly ChatMessage[],
  isGroup: boolean,
  avatar: string | null,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isAiMessage(m)) continue;
    if (!isGroup) return m.emotion ?? null;
    if (avatar && m.characterAvatar === avatar) return m.emotion ?? null;
  }
  return null;
}

/** The id of the newest AI message, or null. */
export function lastAiMessageId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAiMessage(messages[i])) return messages[i].id;
  }
  return null;
}

/** The ids of every AI message, for pinning (see useGroupFocus). */
export function aiMessageIds(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) if (isAiMessage(m)) ids.add(m.id);
  return ids;
}
