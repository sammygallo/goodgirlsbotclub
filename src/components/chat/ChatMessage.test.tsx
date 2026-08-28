/**
 * @vitest-environment jsdom
 *
 * ChatMessage's READ half of the swipe-ownership wire (E2-S2 review round 2,
 * R2-B/F2/F4/F9). Round 1's M3/F6 fix has two halves: the store WRITES
 * `{messageId, swipeIndex}` at each generation call site
 * (chatStore.breakdownTag.callSites.test.ts), and `PromptBreakdownSheet`
 * COMPARES that tag against a `swipeIndex` prop
 * (PromptBreakdownView.test.tsx passes that prop directly). Neither test
 * exercises `ChatMessage.tsx`, which is the ONLY code that supplies the
 * comparison's other half — `swipeIndex={swipeId ?? 0}`, read off the
 * message's CURRENTLY RENDERED swipe. Before this file, nothing rendered
 * `ChatMessage` at all, so a hardcoded `swipeIndex={0}` (or `swipes.length -
 * 1`, or any wire that isn't the live `swipeId`) left the full suite green
 * while silently reopening the exact defect M3/F6 was filed to close.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import { ChatMessage } from './ChatMessage';
import { useGenerationStore } from '../../stores/generationStore';
import { addSlice, createPromptBreakdown, type PromptBreakdown } from '../../utils/promptBreakdown';
import type { TokenUsage } from '../../stores/chatStore';

// jsdom (this repo's chosen DOM env — see vitest.config.ts) doesn't implement
// matchMedia; ChatMessage calls useIsMobile() unconditionally, which calls
// window.matchMedia in an effect. Minimal stub, no vi.fn() spying needed —
// no test here asserts on mobile/desktop layout.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
});

function soloBreakdown(): PromptBreakdown {
  const b = createPromptBreakdown('solo');
  addSlice(b, { stage: 'A', id: 'main_prompt' }, 10, 40);
  b.totals.stageA = 10;
  b.stageAMessageOverhead = 4;
  b.totals.trimTotal = 16;
  b.totals.assembledTotal = 16;
  b.conversationPriming = 2;
  b.flags.historyTrimmed = true;
  b.flags.overBudget = false;
  return b;
}

const USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 10,
  source: 'estimated',
  provider: 'openai',
  model: 'gpt-4',
};

/** An AI message with two swipes, rendered at `swipeId` — the same shape
 *  ChatView hands ChatMessage (`swipeId={message.swipeId}`). */
function renderAiMessage(swipeId: number) {
  render(
    <ChatMessage
      messageId="m1"
      name="Ivy"
      content="Hello again."
      isUser={false}
      usage={USAGE}
      swipes={['Hi there.', 'Hello again.']}
      swipeId={swipeId}
    />
  );
}

function openChip() {
  fireEvent.click(screen.getByLabelText('Token breakdown for this turn'));
}

describe('ChatMessage — the read half of the swipe-ownership wire (review round 2)', () => {
  it('renders OWNED content when the message is displayed at the swipe the tag names', () => {
    // KILLS a hardcoded `swipeIndex={0}`: this row renders at swipe 1 (which
    // matches the tag), so correct code (`swipeId ?? 0` = 1) reports owned
    // while the {0} mutant reports not-owned — the two implementations
    // disagree here. (Review round 3, R3-F/F3: verified by mutation that
    // this is one of the two rows that actually catches {0}; the row below
    // does not — see its comment.)
    useGenerationStore.setState({
      lastPromptBreakdown: soloBreakdown(),
      lastPromptBreakdownTag: { messageId: 'm1', swipeIndex: 1 },
    });
    renderAiMessage(1);
    openChip();
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(screen.getByText('Within budget')).toBeTruthy();
  });

  it('renders NOT-OWNED copy when the message is displayed at a DIFFERENT swipe than the tag names', () => {
    // KILLS `swipeIndex={swipes.length - 1}` (a wire that reads the LAST
    // swipe rather than the CURRENT one): swipes.length-1 here is 1, which
    // matches the tag and would wrongly report owned, while correct code
    // (swipeId 0) correctly reports not-owned.
    //
    // Does NOT kill a hardcoded `swipeIndex={0}` (review round 3, R3-F/F3 —
    // mutation-verified: this row stays green under that mutant). This row
    // renders at swipe 0 and expects not-owned; a {0} mutant ALSO reports
    // swipeIndex 0 here, so both correct code and the mutant produce the
    // same (not-owned) outcome and this row cannot tell them apart. The rows
    // immediately above and below this one are what actually kill {0}.
    useGenerationStore.setState({
      lastPromptBreakdown: soloBreakdown(),
      lastPromptBreakdownTag: { messageId: 'm1', swipeIndex: 1 },
    });
    renderAiMessage(0);
    openChip();
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    expect(screen.queryByText('Within budget')).toBeNull();
  });

  it('the SAME message swings from not-owned to owned purely by which swipe is on screen', () => {
    // KILLS a hardcoded `swipeIndex={0}` (review round 3, R3-F/F3 — the
    // second of the two rows that actually catch it, per the note on the row
    // above): the rerender below moves to swipe 1, which matches the tag —
    // correct code reports owned, the {0} mutant still reports not-owned.
    //
    // The inverse framing of the two rows above, in one test: proves the
    // wire tracks the CURRENT swipe rather than being permanently
    // right/wrong for a given message id. Re-renders at swipe 1 (matching
    // the tag) after having rendered at swipe 0 (not matching).
    useGenerationStore.setState({
      lastPromptBreakdown: soloBreakdown(),
      lastPromptBreakdownTag: { messageId: 'm1', swipeIndex: 1 },
    });
    const { rerender } = render(
      <ChatMessage messageId="m1" name="Ivy" content="Hi there." isUser={false} usage={USAGE} swipes={['Hi there.', 'Hello again.']} swipeId={0} />
    );
    openChip();
    expect(screen.getByText(/no longer available/)).toBeTruthy();

    rerender(
      <ChatMessage messageId="m1" name="Ivy" content="Hello again." isUser={false} usage={USAGE} swipes={['Hi there.', 'Hello again.']} swipeId={1} />
    );
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(screen.getByText('Within budget')).toBeTruthy();
  });
});
