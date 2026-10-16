import { useCallback, useState } from 'react';
import { useChatStore } from '../../../stores/chatStore';
import { aiMessageIds, lastAiMessageId, resolveGroupFocusAvatar } from './groupFocus';

interface Pin {
  avatar: string;
  /** Every AI message id at the moment of pinning. */
  aiIdsAtPin: Set<string>;
  chatFile: string | null;
}

/**
 * Which group member the desktop avatar panel shows (D-C7), with manual pins.
 *
 * Read-only: it subscribes to chatStore and never writes to it or to
 * characterStore, and it never reads `currentSpeakerName` (K14, #458). The
 * selectors return primitives, so a streamed token re-renders the panel only
 * when the focus itself changes.
 *
 * A pin holds until the next AI message is appended — the newest AI id is one
 * the chat did not have at pin time. Tokens streaming into an existing message,
 * a user message, swipes and deletes do not release it. Switching chats or the
 * pinned member leaving the roster drops it.
 */
export function useGroupFocus(rosterAvatars: readonly string[]) {
  const autoAvatar = useChatStore((s) => resolveGroupFocusAvatar(s.messages, rosterAvatars, s.isStreaming));
  const lastAiId = useChatStore((s) => lastAiMessageId(s.messages));
  const chatFile = useChatStore((s) => s.currentChatFile);
  const [pin, setPin] = useState<Pin | null>(null);

  const pinHolds =
    pin !== null &&
    pin.chatFile === chatFile &&
    rosterAvatars.includes(pin.avatar) &&
    (lastAiId === null || pin.aiIdsAtPin.has(lastAiId));
  // Once released a pin stays released, even if the new message is deleted
  // again. Adjusting state during render, so the stale pin never paints.
  if (pin !== null && !pinHolds) setPin(null);

  const pinMember = useCallback((avatar: string) => {
    const { messages, currentChatFile } = useChatStore.getState();
    setPin({ avatar, aiIdsAtPin: aiMessageIds(messages), chatFile: currentChatFile });
  }, []);

  return {
    focusedAvatar: pinHolds ? pin.avatar : autoAvatar,
    pinMember,
  };
}
