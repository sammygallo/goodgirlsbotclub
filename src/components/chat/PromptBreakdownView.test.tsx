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
  useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
});

/**
 * Reads a rendered "label ... value" row's numeric value, label↔value
 * PAIRED — a swapped binding dies, not just a present-somewhere check.
 * Hoisted to module scope in review round 5 (R5-C/F6) so more than one test
 * can reuse it; introduced in round 3 (R3-C/F8, R3-D/F9) for the
 * reconciliation block, and every row this app renders follows the same
 * `<div><span>label</span><span>value</span></div>` shape.
 */
function cell(label: string): number {
  const row = screen.getByText(label).closest('div');
  expect(row, `no row found for "${label}"`).toBeTruthy();
  return Number(row!.textContent!.slice(label.length).replace(/,/g, ''));
}

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

/**
 * Same shape as `soloWithStageC`, but Message Count mode (no token-aware
 * trim) — review round 3, R3-B/F4. `historyTrimmed` is the only flag
 * `computeBreakdownView` reads to decide row 1's label/note (chatStore.ts
 * sets it from the token-aware toggle, independent of every other field
 * here), so flipping just that flag is enough to model the mode.
 */
function soloMessageCountModeWithStageC(): PromptBreakdown {
  const b = soloWithStageC();
  b.flags.historyTrimmed = false;
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

/**
 * Same shape as `soloWithStageC`, scaled up so `trimTotal`/`assembledTotal`
 * cross 1000 — review round 2 (R2-C/F3/F7/F10): a raw-vs-formatted
 * duplication is invisible below 1000 (both render identically), so the
 * round-1 fixtures could not have caught the residual defect even if a test
 * had looked for it. This one exists specifically so `toLocaleString()`
 * actually changes the string.
 */
function soloWithBigTotals(): PromptBreakdown {
  const b = createPromptBreakdown('solo');
  const perMessage = b.messageOverheadPerMessage; // 4
  addSlice(b, { stage: 'A', id: 'main_prompt' }, 4000, 16000);
  addSlice(b, { stage: 'B', cls: 'history', messageId: 'm1', role: 'user' }, 404, 1600);
  addSlice(b, { stage: 'B', cls: 'history', messageId: 'm2', role: 'assistant' }, 404, 1600);
  addSlice(b, { stage: 'C', id: 'char_phi' }, 110, 400);
  b.stageAMessageOverhead = 4;
  b.conversationPriming = 2;
  b.totals.stageA = 4000;
  b.totals.stageB = 808;
  b.totals.stageC = (110 - perMessage) + perMessage;
  const nB = 2;
  const bucketsTotal = 4000 + (404 - perMessage) + (404 - perMessage);
  const overhead = b.stageAJoinResidual + b.stageAMessageOverhead + perMessage * nB + b.conversationPriming;
  b.totals.trimTotal = bucketsTotal + overhead;
  b.totals.assembledTotal = b.totals.trimTotal + b.totals.stageC;
  b.flags.historyTrimmed = true;
  b.flags.overBudget = false;
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
// World Info emitted-vs-raw disclosure (§4.1 AC) — review round 5, R5-C/F6
// ---------------------------------------------------------------------------

describe('PromptBreakdownView — World Info emitted-vs-raw disclosure renders (review round 5, R5-C/F6)', () => {
  it('renders both labeled numbers, label↔value paired, plus the gap-explanation sentence — deleting any of the three must redden', () => {
    // KILLS: deleting the emitted-cost row, the raw-cost row, or the
    // {wi.gapExplanation} paragraph — the §4.1 AC ("surfaces both the
    // emitted... cost and the raw-content cost... or... explains the gap")
    // had zero assertions anywhere before this test; all three could be
    // deleted with the full suite green. `cell()` pairs label to value, so
    // a swapped binding (emitted shown where raw belongs) dies too.
    const b = soloWithStageC(); // wi.emittedTokens=12, wi.rawTokens=9
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(cell('In the prompt (post-macro, incl. attribution wrappers)')).toBe(12);
    expect(cell('Charged by the WI budget (raw entry text, pre-macro)')).toBe(9);
    expect(
      screen.getByText(/The gap is macro expansion and the attribution wrapper/)
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// "N messages dropped by the trim" warning badge — review round 5, R5-D/F7
// ---------------------------------------------------------------------------

describe('PromptBreakdownView — the trim-drop warning badge renders (review round 5, R5-D/F7)', () => {
  it('nonzero, non-one count: pluralized, and present', () => {
    // KILLS: deleting the `{badges.droppedFromHistory !== undefined && (...)}`
    // block — the panel's only warning-coloured disclosure that the
    // token-aware trim discarded messages. Had zero renderer coverage
    // before this test (badges.droppedFromHistory was pinned only at the
    // view-model layer, breakdownBuckets.test.ts).
    const b = soloWithStageC();
    b.flags.droppedFromHistory = 12;
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.getByText('12 messages dropped by the trim')).toBeTruthy();
  });

  it('singular count: "1 message", not "1 messages" — kills the pluralisation ternary', () => {
    const b = soloWithStageC();
    b.flags.droppedFromHistory = 1;
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.getByText('1 message dropped by the trim')).toBeTruthy();
    expect(screen.queryByText('1 messages dropped by the trim')).toBeNull();
  });

  it('absent when nothing was dropped', () => {
    const b = soloWithStageC(); // badges.droppedFromHistory is undefined by default
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.queryByText(/dropped by the trim/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconciliation row labels — review round 1, F7/F12
// ---------------------------------------------------------------------------

describe('PromptBreakdownView — headline reconciliation rows never duplicate their total', () => {
  it('solo, token-aware (historyTrimmed true): row labels AND notes are prose-only, no digits — and each note NAMES its own row (review round 3, R3-A/F1/F2/F5/F7)', () => {
    // KILLS: deriving the row label via `note.split(' (')[0]` (round 1) —
    // which left the RAW total inside the label while the value cell
    // rendered it formatted. ALSO KILLS a note that still interpolates the
    // raw total on its own (round 2, R2-C/F3/F7/F10) — the round-1 fix only
    // removed the label-side duplicate; the note paragraphs a few lines
    // below kept the raw number, so the total still appeared twice a few
    // lines apart. ALSO KILLS a digit-free note with no row anchor (round 2
    // regression, R3-A/F1/F2/F5/F7): both notes render AFTER the LAST
    // headline row, so a note with no subject reads — by simple positional
    // adjacency — as describing the WRONG row (the trim note would read as
    // describing "Full assembled prompt"). Every total AND every note must
    // name its own row exactly once.
    const b = soloWithStageC();
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    const trimmedLabel = screen.getByText('Counted by the trim');
    const fullLabel = screen.getByText('Full assembled prompt');
    expect(trimmedLabel.textContent, 'the "Counted by the trim" label should carry no digits').not.toMatch(/\d/);
    expect(fullLabel.textContent, 'the "Full assembled prompt" label should carry no digits').not.toMatch(/\d/);
    const trimmedNote = screen.getByText(/what the in-chat meter tracks while token-aware trimming is on/i);
    const fullNote = screen.getByText(/what it tracks when trimming is off/i);
    expect(trimmedNote.textContent, 'no digits').not.toMatch(/\d/);
    expect(fullNote.textContent, 'no digits').not.toMatch(/\d/);
    expect(trimmedNote.textContent, 'the trim note must self-label').toContain('Counted by the trim');
    expect(fullNote.textContent, 'the assembled note must self-label').toContain('Full assembled prompt');
  });

  it('group (no Stage C split): the single reconciliation row is also label-only, no digits', () => {
    const b = groupBasic();
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    const label = screen.getByText('Full assembled prompt');
    expect(label.textContent).not.toMatch(/\d/);
  });

  it('the rendered panel shows each headline total EXACTLY ONCE, formatted — no raw duplicate anywhere in the block (review round 2, R2-C/F3/F7/F10)', () => {
    // The round-1 fixtures (totals under 100) could never have caught this:
    // below 1000, the formatted and raw forms are the SAME string, so
    // reintroducing the raw duplicate would be invisible to a digit-presence
    // check alone. This fixture's totals cross 1000 specifically so
    // toLocaleString() changes the string, and the assertion below checks
    // the WHOLE rendered block, not just the label cells.
    const b = soloWithBigTotals();
    const { container } = render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    const text = container.textContent ?? '';
    expect(text, 'the formatted trim total should appear').toContain('4,814');
    expect(text, 'the formatted assembled total should appear').toContain('4,924');
    // No bare (unformatted, no thousands separator) run of either total
    // anywhere in the rendered block.
    expect(text).not.toMatch(/(?<![\d,])4814(?![\d,])/);
    expect(text).not.toMatch(/(?<![\d,])4924(?![\d,])/);
  });

  it('Message Count mode (historyTrimmed false): no "Counted by the trim" row anywhere, and no trim-anchored note — the assembled row carries the literal-truth note instead (review round 3, R3-B/F4)', () => {
    // KILLS: rendering the trim row/note unconditionally in solo. In Message
    // Count mode no trim ran at all (the badge two rows down says "Trim
    // disabled"), and chatStore sets the in-chat meter from the FULL
    // post-Stage-C context in this mode — so a "Counted by the trim" row
    // both contradicts the badge on the same screen and names the wrong
    // number as the meter's.
    const b = soloMessageCountModeWithStageC();
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.queryByText('Counted by the trim')).toBeNull();
    expect(screen.queryByText(/what the in-chat meter tracks while token-aware trimming is on/i)).toBeNull();
    const preStageCLabel = screen.getByText('Before after-history sections');
    expect(preStageCLabel.textContent).not.toMatch(/\d/);
    const note = screen.getByText(/what the in-chat meter tracks \(token-aware trimming is off\)/i);
    expect(note.textContent, 'the literal-truth note must self-label against the assembled row').toContain(
      'Full assembled prompt'
    );
    expect(note.textContent, 'no digits').not.toMatch(/\d/);
    // Review round 4 (R4-A/F1/F6/F7): round 3's version of this test never
    // expanded a bucket, so the Stage-C drill-down badge (collapsed by
    // default) was never in the DOM when the queries above ran — its own
    // "no Counted by the trim row anywhere" claim was an overclaim. Expand
    // the Instructions bucket (which holds this fixture's char_phi Stage-C
    // slice) and check the badge itself.
    fireEvent.click(screen.getByText('Instructions'));
    expect(
      screen.queryByText(/not counted by the trim/i),
      'Message Count mode has no trim to have excluded this content FROM'
    ).toBeNull();
    // Exact match — the reconciliation bridge row's OWN text ("+ sent after
    // the history (Stage C)") also contains this substring, so a loose regex
    // would match both and throw on multiple elements.
    expect(screen.getByText('sent after the history')).toBeTruthy();
  });

  it('token-aware mode (historyTrimmed true): the trim row and its trim-anchored note ARE present, "Before after-history sections" is not', () => {
    const b = soloWithStageC();
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.getByText('Counted by the trim')).toBeTruthy();
    expect(screen.queryByText('Before after-history sections')).toBeNull();
    expect(screen.getByText(/what the in-chat meter tracks while token-aware trimming is on/i)).toBeTruthy();
    // The positive twin (review round 4, R4-A): expanding the SAME bucket on
    // a token-aware fixture keeps the trim-anchored badge — proves a fix
    // can't satisfy the negative row above by deleting the wording wholesale.
    fireEvent.click(screen.getByText('Instructions'));
    expect(screen.getByText(/not counted by the trim — sent after the history/i)).toBeTruthy();
  });

  it('the reconciliation rows pair the CORRECT label with the CORRECT value, and the whole block reconciles on screen (review round 3, R3-C/F8, R3-D/F9; extended round 4, R4-H/F10)', () => {
    // KILLS (R3-C): swapping the two headline rows' VALUE bindings while
    // leaving the labels in place. The block-level "both totals appear
    // somewhere" check above cannot see this — a swap keeps both formatted
    // strings present, just attached to the wrong label.
    // KILLS (R3-D): deleting either Stage-C bridge row ("+ sent after the
    // history (Stage C)" / "After-history overhead"). Nothing before this
    // test asserted their presence, value, or that they reconcile the trim
    // total to the assembled total — a deleted bridge row would leave the
    // panel showing the trim total immediately followed by the assembled
    // total with the gap between them accounted for by nothing on screen.
    // KILLS (R4-H): deleting the "Separator + rounding" / "Message
    // overhead" / "Conversation priming" rows above the bridge — the AC
    // mandates these be shown as their own line "rather than silently
    // absorbed"; breakdownBuckets.test.ts pins them at the view-model layer
    // only, never that the RENDERER draws them.
    const b = soloWithBigTotals();
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);

    const bucketsValue = cell('Buckets');
    const separatorValue = cell('Separator + rounding');
    const messageOverheadValue = cell('Message overhead');
    const primingValue = cell('Conversation priming');
    const trimValue = cell('Counted by the trim');
    const stageCValue = cell('+ sent after the history (Stage C)');
    const overheadValue = cell('After-history overhead');
    const assembledValue = cell('Full assembled prompt');

    expect(trimValue, '"Counted by the trim" must show the trim total').toBe(4814);
    expect(assembledValue, '"Full assembled prompt" must show the assembled total').toBe(4924);
    expect(stageCValue).toBe(110);
    expect(overheadValue).toBe(4);
    expect(bucketsValue).toBe(4800);
    expect(separatorValue).toBe(0);
    expect(messageOverheadValue).toBe(12);
    expect(primingValue).toBe(2);
    expect(
      bucketsValue + separatorValue + messageOverheadValue + primingValue,
      'Buckets + the three itemized overhead rows should sum to the trim total, on screen'
    ).toBe(trimValue);
    expect(
      trimValue + stageCValue,
      'trimTotal + stageC should equal assembledTotal, reconciled on screen'
    ).toBe(assembledValue);
  });
});

// ---------------------------------------------------------------------------
// Reserved chip — review round 4, R4-D/F4
// ---------------------------------------------------------------------------

describe('PromptBreakdownView — Reserved chip has a visible label, not just a hover tooltip (review round 4, R4-D/F4)', () => {
  it('renders a visible "Reserved" text label next to the value, plus title/aria-label for hover and assistive tech', () => {
    // KILLS: a bare unlabeled number reachable only via `title` — which
    // never fires on touch and is unreachable by keyboard/screen-reader.
    const b = soloWithStageC();
    b.flags.hasReservedSlice = true;
    b.responseReserve = 2048;
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.getByText('Reserved')).toBeTruthy();
    expect(screen.getByLabelText(/reserved for the response/i)).toBeTruthy();
  });

  it('absent when hasReservedSlice is false', () => {
    const b = groupBasic();
    render(<PromptBreakdownView view={computeBreakdownView(b)} />);
    expect(screen.queryByText('Reserved')).toBeNull();
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
  it('owned: lastPromptBreakdown is set and tagged with this messageId at this swipe', () => {
    const b = soloWithStageC();
    useGenerationStore.setState({
      lastPromptBreakdown: b,
      lastPromptBreakdownTag: { messageId: 'msg-1', swipeIndex: 0 },
    });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" swipeIndex={0} />);
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(screen.queryByText(/no prompt assembled/i)).toBeNull();
    expect(screen.getByText('Within budget')).toBeTruthy();
  });

  it('not owned: a different message is tagged (slot moved on)', () => {
    const b = soloWithStageC();
    useGenerationStore.setState({
      lastPromptBreakdown: b,
      lastPromptBreakdownTag: { messageId: 'msg-2', swipeIndex: 0 },
    });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" swipeIndex={0} />);
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    expect(screen.queryByText('Within budget')).toBeNull();
  });

  it('not owned: same message, but tagged at a DIFFERENT swipe than the one on screen (review round 1, M3/F6)', () => {
    // KILLS a fix that only compares messageId: `taggedMessageId === messageId`
    // alone would report this as owned, rendering the swipe-1 build's numbers
    // under whatever text swipe 0 (the one on screen) actually holds — the
    // exact bug the swipe-index field was added to close. The tag here models
    // "swipeRight generated a new swipe 1 and tagged it"; the sheet is opened
    // against swipe 0, i.e. the user swiped back afterward.
    const b = soloWithStageC();
    useGenerationStore.setState({
      lastPromptBreakdown: b,
      lastPromptBreakdownTag: { messageId: 'msg-1', swipeIndex: 1 },
    });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" swipeIndex={0} />);
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    expect(screen.queryByText('Within budget')).toBeNull();
  });

  it('owned again once the swipe on screen matches the tagged swipe (swiping forward again)', () => {
    const b = soloWithStageC();
    useGenerationStore.setState({
      lastPromptBreakdown: b,
      lastPromptBreakdownTag: { messageId: 'msg-1', swipeIndex: 1 },
    });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" swipeIndex={1} />);
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(screen.getByText('Within budget')).toBeTruthy();
  });

  it('null slot: nothing has ever been published this session (F5 — a distinct cause from "moved on")', () => {
    // KILLS a single collapsed copy string: the null-slot case never had
    // "a newer message, swipe, group speaker, or impersonation draft" come
    // after anything — there was simply no breakdown this session (e.g.
    // right after a reload, since lastPromptBreakdown is deliberately not
    // persisted). Wording it as a causal event misdiagnoses the cause,
    // exactly as UsagePage's own null-state copy ("No prompt assembled yet
    // this session…") gets right.
    useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" swipeIndex={0} />);
    expect(screen.getByText(/no prompt assembled yet this session/i)).toBeTruthy();
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(screen.queryByText(/came after it/)).toBeNull();
  });

  it('not-owned copy names all FOUR causes that can leave a turn without the most recent build, as EXAMPLES not an assertion (review round 3, R3-E/F6; reworded round 4, R4-C/F2 + R4-I)', () => {
    // KILLS a copy regression back to the three-cause string, AND a
    // regression back to asserting one of the four definitely happened
    // (round 4: that framing is false whenever the turn was simply never
    // built this session — nothing "replaced" a build that never existed).
    // "usually because" states the fact (this isn't the most recent build)
    // and offers the four as examples, not a claim.
    const b = soloWithStageC();
    useGenerationStore.setState({
      lastPromptBreakdown: b,
      lastPromptBreakdownTag: { messageId: 'msg-2', swipeIndex: 0 },
    });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" swipeIndex={0} />);
    expect(
      screen.getByText(
        /usually because a newer message, swipe, group speaker, or impersonation draft came after it/
      )
    ).toBeTruthy();
  });

  it('the escape hatch no longer claims "the most recent turn\'s chip" — it points at Settings → Usage instead, which is true in every not-owned state (review round 4, R4-C/F2)', () => {
    // KILLS the old chip-pointing instruction, which was FALSE in exactly
    // the case R3-E's copy above names: a null tag (impersonate cleared it)
    // means NO chip anywhere — including the most recent turn's own — can
    // show the current build, so following the old advice was a dead end.
    // UsagePage.tsx reads `lastPromptBreakdown` directly with no tag check,
    // so it is accurate here and in the swipe-back case alike.
    const b = soloWithStageC();
    useGenerationStore.setState({
      lastPromptBreakdown: b,
      lastPromptBreakdownTag: null, // exactly what impersonate leaves behind
    });
    render(<PromptBreakdownSheet isOpen={true} onClose={() => {}} messageId="msg-1" swipeIndex={0} />);
    expect(screen.getByText(/impersonation draft came after it/)).toBeTruthy();
    expect(
      screen.queryByText(/the most recent turn's chip still shows the current build/),
      'with a null tag NO chip owns the build — this instruction is a dead end'
    ).toBeNull();
    expect(screen.getByText(/Settings → Usage/)).toBeTruthy();
    expect(screen.getByText(/Last prompt breakdown/)).toBeTruthy();
  });
});
