/**
 * @vitest-environment jsdom
 *
 * Continuity panel suite (story-state step 3, phase 6).
 *
 * Two rules earn a DOM test here, and they are the two the plan calls out:
 *
 *   - **The counts are on the collapsed header.** "Does this book
 *     contradict itself" has to be answerable without expanding anything;
 *     a panel that hides its own counts behind a click is a panel nobody
 *     reads.
 *   - **`unreadable` is never folded into the clean total.** A chapter
 *     whose check did not parse has not been checked, and presenting it as
 *     clean is the one failure `unitNotes` was written to prevent — worth
 *     pinning at the aggregate too, where a single wrong `+ 0` would hide
 *     it across a whole book.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const pageProse = vi.fn();
vi.mock('../../utils/storyRender/exportRun', () => ({
  pageProse: (...a: unknown[]) => pageProse(...a),
}));

const { RenderContinuityPanel } = await import('./RenderContinuityPanel');

function body(
  sceneId: string,
  sequence: number,
  continuity: Record<string, unknown> | null
) {
  return {
    scene_id: sceneId,
    sequence,
    prose: 'x',
    status: 'complete',
    source_scene_ts: 1,
    continuity,
    server_ts: 1,
    created_at: 'x',
    updated_at: 'x',
  };
}

const CLEAN = { verdicts: [], unreadable: false, terminal: 'stop' };

const props = {
  projectId: 'p1',
  renderId: 'r1',
  reloadToken: 0,
  titleFor: (id: string) => ({ s1: 'One', s2: 'Two' })[id] ?? '',
  onOpenChapter: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  pageProse.mockResolvedValue([body('s1', 0, CLEAN), body('s2', 1, CLEAN)]);
});
afterEach(cleanup);

describe('RenderContinuityPanel', () => {
  it('reports a clean book on the collapsed header', async () => {
    render(<RenderContinuityPanel {...props} />);
    expect(await screen.findByText(/nothing flagged/)).toBeTruthy();
  });

  it('counts verdicts across chapters without being expanded', async () => {
    pageProse.mockResolvedValue([
      body('s1', 0, {
        ...CLEAN,
        verdicts: [
          { claim: 'She travelled', canon: 'She never leaves', severity: 'major', factId: 'f1' },
          { claim: 'It was dusk', canon: 'It was noon', severity: 'minor', factId: 'f2' },
        ],
      }),
      body('s2', 1, CLEAN),
    ]);

    render(<RenderContinuityPanel {...props} />);

    expect(await screen.findByText(/2 things flagged across 1 chapter/)).toBeTruthy();
  });

  it('never folds an unreadable check into the clean count', async () => {
    // The whole point. `unreadable` means the check could not be READ, and
    // a book reported clean on the strength of checks that never parsed is
    // the failure this panel exists to make impossible to miss.
    pageProse.mockResolvedValue([
      body('s1', 0, CLEAN),
      body('s2', 1, null),
    ]);

    render(<RenderContinuityPanel {...props} />);

    const header = await screen.findByRole('button', { expanded: false });
    expect(header.textContent).toMatch(/1 chapter unverified/);
    expect(header.textContent).not.toMatch(/^Continuity · nothing flagged$/);
  });

  it('lists each verdict with the canon it contradicts once expanded', async () => {
    pageProse.mockResolvedValue([
      body('s1', 0, {
        ...CLEAN,
        verdicts: [
          { claim: 'She travelled', canon: 'She never leaves', severity: 'major', factId: 'f1' },
        ],
      }),
    ]);

    render(<RenderContinuityPanel {...props} />);
    await screen.findByText(/1 thing flagged/);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('She travelled')).toBeTruthy();
    expect(screen.getByText(/against: She never leaves/)).toBeTruthy();
  });

  it('orders major verdicts before minor ones', async () => {
    pageProse.mockResolvedValue([
      body('s1', 0, {
        ...CLEAN,
        verdicts: [
          { claim: 'MINOR ONE', canon: 'c', severity: 'minor', factId: null },
          { claim: 'MAJOR ONE', canon: 'c', severity: 'major', factId: null },
        ],
      }),
    ]);

    render(<RenderContinuityPanel {...props} />);
    await screen.findByText(/2 things flagged/);
    await userEvent.click(screen.getByRole('button', { expanded: false }));

    const text = document.body.textContent ?? '';
    expect(text.indexOf('MAJOR ONE')).toBeLessThan(text.indexOf('MINOR ONE'));
  });

  it('says it could not check rather than reporting clean when the read fails', async () => {
    // Same direction as everything else here: a failure to READ the checks
    // must never render as "nothing flagged".
    pageProse.mockRejectedValue(new Error('boom'));

    render(<RenderContinuityPanel {...props} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn’t read the continuity checks/)).toBeTruthy()
    );
    expect(screen.queryByText(/nothing flagged/)).toBeNull();
  });

  it('re-reads when the run is reloaded', async () => {
    const { rerender } = render(<RenderContinuityPanel {...props} />);
    await screen.findByText(/nothing flagged/);
    rerender(<RenderContinuityPanel {...props} reloadToken={1} />);
    await waitFor(() => expect(pageProse).toHaveBeenCalledTimes(2));
  });
});
