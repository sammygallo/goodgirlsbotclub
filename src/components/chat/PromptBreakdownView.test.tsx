/**
 * @vitest-environment jsdom
 *
 * E2-S2 task 6 — the presentation layer. `computeBreakdownView` (task 3) is
 * proven correct on its own terms in breakdownBuckets.test.ts; this file's
 * job is the UI contract: the exact badge/label strings a user reads, the
 * sheet's ownership decision, and that a bucket row actually expands on tap.
 * Uses GenerateSceneModal.test.tsx's conventions — no jest-dom, assert on
 * plain DOM/query presence.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import { PromptBreakdownView } from './PromptBreakdownView';
import { PromptBreakdownSheet } from './PromptBreakdownSheet';
import { useGenerationStore } from '../../stores/generationStore';
import { computeBreakdownView } from '../../utils/breakdownBuckets';
import {
  addSlice,
  createPromptBreakdown,
  recordAttachments,
  type PromptBreakdown,
} from '../../utils/promptBreakdown';

afterEach(() => {
  cleanup();
  useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownMessageId: null });
});

// ---------------------------------------------------------------------------
// Hand-built breakdowns — same collector API the real builders use
// (createPromptBreakdown / addSlice), so computeBreakdownView is exercised
// for real. Correctness of the numbers is breakdownBuckets.test.ts's job;
// this file only needs shapes rich enough to drive the UI states below.
// ---------------------------------------------------------------------------

/**
 * m1 (user) becomes the sole `your_message` row; m2 (assistant) becomes the
 * sole `chat_history` row — computeBreakdownView's newest-user-turn split
 * (breakdownBuckets.test.ts covers the selection logic itself; here it just
 * needs to hold so each bucket has exactly one drill-down row to assert on).
 */
function soloWithStageC(): PromptBreakdown {
  const b = createPromptBreakdown('solo');
  const perMessage = b.messageOverheadPerMessage; // 4
  addSlice(b, { stage: 'A', id: 'main_prompt' }, 20, 80);
  addSlice(b, { stage: 'B', cls: 'history', messageId: 'm1', role: 'user' }, 14, 40);
  addSlice(b, { stage: 'B', cls: 'history', messageId: 'm2', role: 'assistant' }, 14, 40);
  addSlice(b, { stage: 'C', id: 'char_phi' }, 10, 20);
  b.stageAMessageOverhead = 4;
  b.conversationPriming = 2;
  b.totals.stageA = 20;
  b.totals.stageB = 28;
  b.totals.stageC = (10 - perMessage) + perMessage; // content + its own after-history overhead
  const nB = 2;
  const bucketsTotal = 20 /* instructions */ + (14 - perMessage) /* your_message */ + (14 - perMessage) /* chat_history */;
  const overhead = b.stageAJoinResidual + b.stageAMessageOverhead + perMessage * nB + b.conversationPriming;
  b.totals.trimTotal = bucketsTotal + overhead;
  b.totals.assembledTotal = b.totals.trimTotal + b.totals.stageC;
  b.flags.historyTrimmed = true;
  b.flags.overBudget = false;
  b.wi.emittedTokens = 12;
  b.wi.rawTokens = 9;
  b.wi.budget = 40;
  b.wi.droppedIds = ['ev1'];
  return b;
}

function groupBasic(): PromptBreakdown {
  const b = createPromptBreakdown('group');
  addSlice(b, { stage: 'A', id: 'group_system_chrome' }, 30, 100);
  addSlice(b, { stage: 'B', cls: 'history', messageId: 'g1', role: 'user' }, 14, 40);
  b.stageAMessageOverhead = 4;
  b.totals.stageA = 30;
  b.totals.stageB = 14;
  b.totals.assembledTotal = 30 + 4 + (14 - 4) + 2;
  b.conversationPriming = 2;
  b.flags.historyTrimmed = false;
  return b;
}

function soloServerPathWi(): PromptBreakdown {
  const b = createPromptBreakdown('solo');
  addSlice(b, { stage: 'A', id: 'main_prompt' }, 10, 40);
  b.totals.stageA = 10;
  b.stageAMessageOverhead = 4;
  b.totals.trimTotal = 10 + 4 + 2;
  b.totals.assembledTotal = b.totals.trimTotal;
  b.conversationPriming = 2;
  b.wi.emittedTokens = 5;
  b.wi.rawTokens = 3;
  b.wi.activationSource = 'server';
  return b;
}

// ---------------------------------------------------------------------------
// Badges and section text, verbatim
// ---------------------------------------------------------------------------

describe('PromptBreakdownView — badge and label text', () => {
  it('shows the Stage-C "not counted by the trim" badge and the reconciliation split', () => {
    render(<PromptBreakdownView view={computeBreakdownView(soloWithStageC())} />);
    // char_phi (Stage C) buckets under Instructions — its "not counted by the
    // trim" badge lives in that bucket's drill-down, same as any other slice.
    fireEvent.click(screen.getByText('Instructions'));
    expect(screen.getByText(/not counted by the trim — sent after the history/)).toBeTruthy();
    expect(screen.getByText('Within budget')).toBeTruthy();
  });

  it('shows "not counted anywhere" on attachments and never folds them into a total', () => {
    const b = soloWithStageC();
    recordAttachments(b, [{ base64: 'QUJD' }]);
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.getByText(/not counted anywhere/)).toBeTruthy();
  });

  it('group: history badged "not trimmed", labeled with the fixed window', () => {
    render(<PromptBreakdownView view={computeBreakdownView(groupBasic())} />);
    expect(screen.getByText('History not trimmed (fixed 30-message window)')).toBeTruthy();
  });

  it('solo + Message Count mode: "Trim disabled", never "within budget"', () => {
    const b = createPromptBreakdown('solo');
    addSlice(b, { stage: 'A', id: 'main_prompt' }, 10, 40);
    b.totals.stageA = 10;
    b.stageAMessageOverhead = 4;
    b.totals.trimTotal = 16;
    b.totals.assembledTotal = 16;
    b.conversationPriming = 2;
    b.flags.historyTrimmed = false;
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.getByText('Trim disabled (Message Count mode)')).toBeTruthy();
    expect(screen.queryByText(/within budget/i)).toBeNull();
  });

  it('server-path WI turn shows the unavailable note and suppresses budget/evicted', () => {
    render(<PromptBreakdownView view={computeBreakdownView(soloServerPathWi())} />);
    expect(screen.getByText('Activation details unavailable (server-path turn)')).toBeTruthy();
    expect(screen.queryByText(/evicted/)).toBeNull();
  });

  it('client-path WI turn shows budget and evicted count instead', () => {
    render(<PromptBreakdownView view={computeBreakdownView(soloWithStageC())} />);
    expect(screen.queryByText(/Activation details unavailable/)).toBeNull();
    expect(screen.getByText(/1 evicted/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Drill-down interaction
// ---------------------------------------------------------------------------

describe('PromptBreakdownView — drill-down', () => {
  it('expands a bucket row to show its per-slice rows on tap, and collapses on a second tap', () => {
    render(<PromptBreakdownView view={computeBreakdownView(soloWithStageC())} />);
    // "Your message" holds m1 (the sole role:'user' history slice) — its one
    // drill-down row is labeled by role, "User".
    const row = screen.getByText('Your message');
    expect(screen.queryByText('User')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText('User')).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByText('User')).toBeNull();
  });

  it('a different bucket expands independently and shows its own row', () => {
    render(<PromptBreakdownView view={computeBreakdownView(soloWithStageC())} />);
    fireEvent.click(screen.getByText('Chat history'));
    expect(screen.getByText('Assistant')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Sheet ownership
// ---------------------------------------------------------------------------

describe('PromptBreakdownSheet — ownership', () => {
  it('owned: lastPromptBreakdown is set and tagged with this messageId', () => {
    const b = soloWithStageC();
    useGenerationStore.setState({ lastPromptBreakdown: b, lastPromptBreakdownMessageId: 'msg-1' });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" />);
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(screen.getByText('Within budget')).toBeTruthy();
  });

  it('not owned: a different message is tagged (slot moved on)', () => {
    const b = soloWithStageC();
    useGenerationStore.setState({ lastPromptBreakdown: b, lastPromptBreakdownMessageId: 'msg-2' });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" />);
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    expect(screen.queryByText('Within budget')).toBeNull();
  });

  it('null slot: nothing has ever been published this session', () => {
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownMessageId: null });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" />);
    expect(screen.getByText(/no longer available/)).toBeTruthy();
  });
});
