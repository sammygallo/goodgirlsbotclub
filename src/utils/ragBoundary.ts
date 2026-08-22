/**
 * computeRagBoundary — Phase 2 client cutover (memory-consolidation plan).
 *
 * The server-side /retrieval/messages endpoint needs to know where the
 * client's raw-history window starts, so it can exclude everything at/after
 * that point (recall must never surface something already in the prompt).
 * The naive frame — messages.filter(!hidden).filter(!isSystem) with no
 * further trim — is a feature-killing bug: in this app's default config
 * (tokenAware: true, autoSummarize: false, so compaction never applies), the
 * pre-trim pool IS the whole history, and the only thing that actually bounds
 * what reaches the prompt is trimHistoryToBudget, run later inside
 * buildConversationContext. Computing the boundary from the pre-trim frame
 * would make the boundary the chat's oldest message ALWAYS, excluding
 * everything and returning zero chunks permanently for exactly the long-chat
 * users this feature serves.
 *
 * So this reproduces the POST-TRIM kept set instead — see the two branches
 * below. It runs standalone, before buildConversationContext/the WI scan
 * (resolveRagContext is called before the builder at every call site), so it
 * can't know which messages the real trim would additionally pin via
 * critical-at-depth WI entries. That's fine: the real trim's `pinned` set
 * only protects (a) the newest turn, which the plain iteration order already
 * keeps first regardless of pinning (see trimHistoryToBudget: the very first
 * message considered — the newest — is always kept, since the
 * `keptCount > 0 && cost > remaining` break condition can't fire until
 * something has already been kept), and (b) critical-at-depth WI messages,
 * which are irrelevant here since no WI scan has run yet. Omitting `pinned`
 * costs nothing.
 *
 * Zero system-cost (passing an empty systemPrompts array — trimHistoryToBudget
 * has no separate systemCost parameter; systemCost is derived by summing
 * systemPrompts) makes the simulated trim keep MORE history than the real
 * one (which reserves budget for the actual system block, ~2-3K tokens'
 * worth of messages). So the boundary this computes errs OLDER than the real
 * one — a bounded over-exclusion, in the safe direction: retrieval still
 * reaches everything genuinely outside the prompt, it just also stays quiet
 * on a small band of messages that ARE technically already excluded from the
 * real prompt too. In short chats where everything fits, the boundary is the
 * oldest message and zero chunks come back — correct: nothing has left the
 * prompt, so there's nothing to recall.
 *
 * Known gap, not fixed here: buildConversationContext's solo branch also has
 * a `pureChatMode` path that shifts the summary-compaction offset by
 * `pureChatRemoved` (the count of leading non-user messages dropped before
 * the first user turn). This helper doesn't replicate that — pureChatMode
 * chats may see a very slightly newer real trim boundary than this computes,
 * which (per the direction analysis above) skews further into the "over-
 * exclusion, safe" side, not the unsafe one. Revisit only if pureChatMode
 * chats show materially worse recall than plain ones.
 *
 * A cleaner long-term shape is to thread the actual kept-history boundary
 * out of buildConversationContext itself; this helper is the pragmatic v1.
 */

import type { ChatMessage } from '../stores/chatStore';
import type { ContextConfig } from '../stores/generationStore';
import { trimHistoryToBudget } from './tokenizer';

/** The subset of summarizeStore state this helper needs — passed in rather
 * than read from the store directly, so this stays a pure, easily-testable
 * function. `summary` is the resolved ChatSummary for THIS chat (or null),
 * matching `useSummarizeStore.getState().getSummary(chatFile)`. */
export interface RagBoundarySummaryState {
  summary: { messageCount: number } | null;
  compactWhenSummarized: boolean;
}

// Mirrors buildConversationContext's own MIN_RAW_TAIL (chatStore.ts) — never
// compact away the newest few raw messages regardless of summary coverage.
const MIN_RAW_TAIL = 6;

// Mirrors the group builder's fixed window (chatStore.ts:2001) — no
// token-aware trim, no compaction on that path at all.
const GROUP_WINDOW = 30;

interface BoundaryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

function toBoundaryMessage(m: ChatMessage): BoundaryMessage {
  return { id: m.id, role: m.isUser ? 'user' : 'assistant', content: m.content };
}

/**
 * Returns the `ggbc_id` (ChatMessage.id) of the oldest message this chat's
 * REAL prompt-assembly would keep, or `null` if the pool is empty (an empty
 * chat, or — see module docstring — a pathologically tiny token budget that
 * would trim away literally everything; the server's own boundary-not-found
 * fallback handles that conservatively).
 */
export function computeRagBoundary(
  messages: ChatMessage[],
  ctxConfig: ContextConfig,
  summaryState: RagBoundarySummaryState,
  isGroup: boolean
): string | null {
  const visible = messages.filter((m) => !m.hidden);

  if (isGroup) {
    const windowed = visible.slice(-GROUP_WINDOW).filter((m) => !m.isSystem);
    return windowed.length > 0 ? windowed[0].id : null;
  }

  const nonSystem = visible.filter((m) => !m.isSystem);
  const historyPool = ctxConfig.tokenAware
    ? nonSystem
    : visible.slice(-ctxConfig.messageCount).filter((m) => !m.isSystem);
  const windowSkew = nonSystem.length - historyPool.length;

  const { summary, compactWhenSummarized } = summaryState;
  const summarySliceOffset = summary ? Math.max(0, summary.messageCount - windowSkew) : 0;
  const cappedOffset =
    historyPool.length > 0
      ? Math.min(summarySliceOffset, Math.max(historyPool.length - MIN_RAW_TAIL, 0))
      : 0;
  const compactedHistory =
    compactWhenSummarized && summary && summary.messageCount > 0
      ? historyPool.slice(cappedOffset)
      : historyPool;

  let kept: BoundaryMessage[];
  if (ctxConfig.tokenAware) {
    const trimmed = trimHistoryToBudget<BoundaryMessage>(
      [],
      compactedHistory.map(toBoundaryMessage),
      ctxConfig.responseReserve,
      ctxConfig.maxTokens
    );
    kept = trimmed.kept;
  } else {
    kept = compactedHistory.map(toBoundaryMessage);
  }

  return kept.length > 0 ? kept[0].id : null;
}
