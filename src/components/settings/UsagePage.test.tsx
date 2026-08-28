/**
 * @vitest-environment jsdom
 *
 * UsagePage's "Last prompt breakdown" section (E2-S2 task 6) — the OTHER
 * `PromptBreakdownView` consumer besides the per-message sheet, with zero
 * prior coverage (review round 4, R4-F/F8). Mutation-verified: deleting the
 * `lastPromptBreakdown ?` null guard and rendering
 * `computeBreakdownView(lastPromptBreakdown!)` unconditionally typechecks
 * (the non-null assertion satisfies `tsc`) and leaves the full suite AND
 * `npm run build` green — `lastPromptBreakdown` is deliberately not
 * persisted (generationStore.ts), so it is null on every fresh-session visit
 * to Settings → Usage, and the deleted guard would throw a TypeError inside
 * `computeBreakdownView` and blank the settings pane.
 *
 * No special mock prelude needed — same reasoning as
 * PromptBreakdownView.test.tsx: jsdom provides a real `localStorage`, so
 * generationStore's and usageStore's module-level reads succeed without
 * stubbing, and neither store's `serverSettings` import throws until
 * something actually calls it (nothing here does).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { UsagePage } from './UsagePage';
import { useGenerationStore } from '../../stores/generationStore';
import { addSlice, createPromptBreakdown, type PromptBreakdown } from '../../utils/promptBreakdown';

afterEach(() => {
  cleanup();
  useGenerationStore.setState({ lastPromptBreakdown: null, lastPromptBreakdownTag: null });
});

function soloWithStageC(): PromptBreakdown {
  const b = createPromptBreakdown('solo');
  const perMessage = b.messageOverheadPerMessage;
  addSlice(b, { stage: 'A', id: 'main_prompt' }, 20, 80);
  addSlice(b, { stage: 'B', cls: 'history', messageId: 'm1', role: 'user' }, 14, 40);
  addSlice(b, { stage: 'C', id: 'char_phi' }, 10, 20);
  b.stageAMessageOverhead = 4;
  b.conversationPriming = 2;
  b.totals.stageA = 20;
  b.totals.stageB = 14;
  b.totals.stageC = (10 - perMessage) + perMessage;
  const nB = 1;
  const bucketsTotal = 20 + (14 - perMessage);
  const overhead = b.stageAJoinResidual + b.stageAMessageOverhead + perMessage * nB + b.conversationPriming;
  b.totals.trimTotal = bucketsTotal + overhead;
  b.totals.assembledTotal = b.totals.trimTotal + b.totals.stageC;
  b.flags.historyTrimmed = true;
  b.flags.overBudget = false;
  return b;
}

describe('UsagePage — Last prompt breakdown section (review round 4, R4-F/F8)', () => {
  it('null slot: renders the exact null-state copy, and no reconciliation row', () => {
    // KILLS: deleting the `lastPromptBreakdown ?` guard (a `!`-asserted
    // unconditional call typechecks and passes the suite + build otherwise
    // untested).
    useGenerationStore.setState({ lastPromptBreakdown: null });
    render(<UsagePage />);
    expect(
      screen.getByText('No prompt assembled yet this session — send a message to see its breakdown.')
    ).toBeTruthy();
    expect(screen.queryByText('Full assembled prompt')).toBeNull();
    expect(screen.queryByText('Counted by the trim')).toBeNull();
  });

  it('populated store: renders the full breakdown (provenanceVariant="full") — "Full assembled prompt" present, null copy absent', () => {
    useGenerationStore.setState({ lastPromptBreakdown: soloWithStageC() });
    render(<UsagePage />);
    expect(screen.queryByText(/no prompt assembled yet this session/i)).toBeNull();
    expect(screen.getByText('Full assembled prompt')).toBeTruthy();
    // Sanity: the page itself mounted around the section (heading + a stat
    // from an unrelated section), so this isn't just the bare component.
    expect(screen.getByText('Usage')).toBeTruthy();
    expect(screen.getByText('Last prompt breakdown')).toBeTruthy();
  });
});
