import { describe, it, expect } from 'vitest';
import { computeRagBoundary, type RagBoundarySummaryState } from './ragBoundary';
import type { ChatMessage } from '../stores/chatStore';
import { DEFAULT_CONTEXT_CONFIG, type ContextConfig } from '../stores/generationStore';

let msgId = 0;
function mkMsg(content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  msgId += 1;
  return {
    id: `m${msgId}`,
    name: 'User',
    isUser: true,
    isSystem: false,
    hidden: false,
    content,
    timestamp: 0,
    swipes: [content],
    swipeId: 0,
    ...over,
  } as ChatMessage;
}

const NO_SUMMARY: RagBoundarySummaryState = { summary: null, compactWhenSummarized: true };

describe('computeRagBoundary — solo, default config (tokenAware, no summary)', () => {
  it('returns the oldest message id when everything fits the budget', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      mkMsg(`short turn ${i}`, { isUser: i % 2 === 0 })
    );
    const boundary = computeRagBoundary(messages, DEFAULT_CONTEXT_CONFIG, NO_SUMMARY, false);
    expect(boundary).toBe(messages[0].id);
  });

  it('returns a mid-chat boundary — not the oldest, not null — on a long chat', () => {
    // 300 messages of ~200 chars each (~57 tokens/msg at the 3.8 chars/token
    // 'generic' default) comfortably exceeds DEFAULT_CONTEXT_CONFIG's budget
    // (maxTokens 8192 - responseReserve 2048 = 6144 tokens).
    const longText = 'x'.repeat(200);
    const messages = Array.from({ length: 300 }, (_, i) =>
      mkMsg(`${longText} ${i}`, { isUser: i % 2 === 0 })
    );
    const boundary = computeRagBoundary(messages, DEFAULT_CONTEXT_CONFIG, NO_SUMMARY, false);
    expect(boundary).not.toBeNull();
    expect(boundary).not.toBe(messages[0].id);
    expect(boundary).not.toBe(messages[messages.length - 1].id);
  });

  it('excludes hidden and system messages from consideration entirely', () => {
    const hidden = mkMsg('hidden turn', { hidden: true });
    const system = mkMsg('system turn', { isSystem: true });
    const kept = mkMsg('kept turn');
    const boundary = computeRagBoundary(
      [hidden, system, kept],
      DEFAULT_CONTEXT_CONFIG,
      NO_SUMMARY,
      false
    );
    // Only `kept` is eligible at all — it must be the boundary even though
    // it's the last (newest) of the three by array position.
    expect(boundary).toBe(kept.id);
  });

  it('returns null for a chat with no eligible messages', () => {
    const boundary = computeRagBoundary([], DEFAULT_CONTEXT_CONFIG, NO_SUMMARY, false);
    expect(boundary).toBeNull();
  });
});

describe('computeRagBoundary — solo, compaction config', () => {
  it('shifts the boundary newer when a summary covers the early turns', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      mkMsg(`turn ${i}`, { isUser: i % 2 === 0 })
    ); // short — everything fits the budget regardless of trim
    const withoutSummary = computeRagBoundary(
      messages,
      DEFAULT_CONTEXT_CONFIG,
      NO_SUMMARY,
      false
    );
    expect(withoutSummary).toBe(messages[0].id);

    const summaryState: RagBoundarySummaryState = {
      summary: { messageCount: 10 },
      compactWhenSummarized: true,
    };
    const withSummary = computeRagBoundary(
      messages,
      DEFAULT_CONTEXT_CONFIG,
      summaryState,
      false
    );
    // cappedOffset = min(max(0, 10-0), max(20-MIN_RAW_TAIL(6), 0)) = min(10, 14) = 10
    expect(withSummary).toBe(messages[10].id);
  });

  it('never compacts away the last MIN_RAW_TAIL(6) messages, even with full summary coverage', () => {
    const messages = Array.from({ length: 20 }, (_, i) => mkMsg(`turn ${i}`));
    const summaryState: RagBoundarySummaryState = {
      summary: { messageCount: 19 }, // covers all but the newest turn
      compactWhenSummarized: true,
    };
    const boundary = computeRagBoundary(messages, DEFAULT_CONTEXT_CONFIG, summaryState, false);
    // cappedOffset = min(19, max(20-6,0)=14) = 14 -> boundary is messages[14]
    expect(boundary).toBe(messages[14].id);
  });

  it('does not compact when compactWhenSummarized is false, even with a summary present', () => {
    const messages = Array.from({ length: 20 }, (_, i) => mkMsg(`turn ${i}`));
    const summaryState: RagBoundarySummaryState = {
      summary: { messageCount: 10 },
      compactWhenSummarized: false,
    };
    const boundary = computeRagBoundary(messages, DEFAULT_CONTEXT_CONFIG, summaryState, false);
    expect(boundary).toBe(messages[0].id);
  });
});

describe('computeRagBoundary — solo, tokenAware: false (fixed message-count fallback)', () => {
  it('only considers the newest messageCount visible messages as the pool', () => {
    const fixedConfig: ContextConfig = { ...DEFAULT_CONTEXT_CONFIG, tokenAware: false, messageCount: 5 };
    const messages = Array.from({ length: 20 }, (_, i) => mkMsg(`turn ${i}`));
    const boundary = computeRagBoundary(messages, fixedConfig, NO_SUMMARY, false);
    // The pool is only the last 5 messages (indices 15..19); the oldest of
    // those (index 15) is the boundary since they all fit the budget.
    expect(boundary).toBe(messages[15].id);
  });
});

describe('computeRagBoundary — group chats', () => {
  it('uses the last-30-visible-non-system window with no trim or compaction', () => {
    const messages = Array.from({ length: 40 }, (_, i) => mkMsg(`turn ${i}`));
    const boundary = computeRagBoundary(messages, DEFAULT_CONTEXT_CONFIG, NO_SUMMARY, true);
    // slice(-30) keeps indices 10..39; oldest of those is index 10.
    expect(boundary).toBe(messages[10].id);
  });

  it('filters hidden before slicing so a hidden message never consumes a window slot', () => {
    const messages = [
      mkMsg('will be excluded from the window by hidden, not by slicing', { hidden: true }),
      ...Array.from({ length: 30 }, (_, i) => mkMsg(`turn ${i}`)),
    ];
    const boundary = computeRagBoundary(messages, DEFAULT_CONTEXT_CONFIG, NO_SUMMARY, true);
    // visible = the 30 non-hidden turns (hidden filtered first); slice(-30)
    // keeps all 30 of them, so the boundary is the oldest of the 30 turns —
    // NOT the hidden message, and not shifted by one due to the hidden slot.
    expect(boundary).toBe(messages[1].id);
  });

  it('ignores tokenAware/summary config entirely on the group path', () => {
    const messages = Array.from({ length: 40 }, () => mkMsg('x'.repeat(500)));
    const withSummary: RagBoundarySummaryState = {
      summary: { messageCount: 39 },
      compactWhenSummarized: true,
    };
    const boundary = computeRagBoundary(messages, DEFAULT_CONTEXT_CONFIG, withSummary, true);
    // Even with a huge summary and content that would blow any token budget,
    // the group branch still just takes the last 30 — no trim, no compaction.
    expect(boundary).toBe(messages[10].id);
  });
});
