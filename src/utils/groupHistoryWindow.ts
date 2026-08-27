/**
 * The group builder's raw-history window — the ONE definition.
 *
 * Group chat has no token-aware trim and no summary compaction: the whole of
 * what reaches the model as raw history is this fixed window, so unlike solo
 * (where the boundary is only knowable after `trimHistoryToBudget` runs) it is
 * computable up front, from the message list alone.
 *
 * It lives here because TWO places need the same answer — the builder, which
 * emits the window as history, and the chat-history recall path, which must
 * exclude exactly what the builder emitted or the server hands back chunks the
 * prompt already contains. Before E2-S2 task 1b those were two hand-synced
 * copies of the expression in two files (`chatStore.ts`'s `recentMessages` and
 * `ragBoundary.ts`'s `GROUP_WINDOW`), and the copy in `ragBoundary.ts` still
 * carried a stale line-number anchor pointing 270 lines away from the real
 * one. One function, imported by both, is the only shape in which they cannot
 * drift again.
 *
 * ORDER IS LOAD-BEARING: hidden is filtered BEFORE the slice (so a hidden
 * message never consumes one of the 30 slots — #414), and isSystem AFTER it
 * (so a window holding system turns emits fewer than 30). Swapping either is
 * a silent behaviour change; `groupHistoryWindow.test.ts` pins both.
 */

import type { ChatMessage } from '../stores/chatStore';

/** How many visible messages the group builder looks back over. No token
 *  budget is consulted on that path — this count IS the bound. */
export const GROUP_HISTORY_WINDOW = 30;

/** The messages the group builder will emit as raw history, oldest first. */
export function groupHistoryWindow(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.hidden)
    .slice(-GROUP_HISTORY_WINDOW)
    .filter((m) => !m.isSystem);
}
