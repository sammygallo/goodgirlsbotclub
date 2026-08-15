/**
 * @vitest-environment jsdom
 *
 * Render reader suite (story-state step 3, phase 5).
 *
 * Both rules here were found by the phase-5 adversarial review, and both are
 * about a SECOND request arriving after the world moved. Neither is visible
 * without a DOM, because both are properties of how the component's fetches
 * interleave with its own state resets.
 *
 *   - A prose page belonging to a superseded render must not merge into the
 *     current one. Two renders of the same story carry the SAME scene ids, so
 *     a stale merge does not add rows that look wrong — it silently replaces
 *     one run's prose with another's, and moves the cursor into the wrong
 *     run's sequence.
 *   - A failed prose page must not destroy a chapter list that loaded fine.
 *     The summaries and the first prose page used to share one try, so a
 *     transient failure on the second request blanked the whole reader with a
 *     fatal error whose promised retry did not exist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StorySceneOut } from '../../api/client';

const listRenderUnits = vi.fn();
const readRenderProse = vi.fn();

vi.mock('../../api/client', () => ({
  storyApi: {
    listRenderUnits: (...a: unknown[]) => listRenderUnits(...a),
    readRenderProse: (...a: unknown[]) => readRenderProse(...a),
  },
}));

const showToastGlobal = vi.fn();
vi.mock('../ui/Toast', () => ({
  showToastGlobal: (...a: unknown[]) => showToastGlobal(...a),
}));

// The continuity panel (phase 6) is a sibling with its OWN exhaustive read
// of the same endpoint. Every test here pins how the READER's fetches
// interleave, using `mockResolvedValueOnce` chains and call counts, so a
// second component drawing from the same queue would rewrite what each
// assertion is measuring. Its own behaviour is pinned in its own suite.
// Stubbed to a single button so a test can drive `onOpenChapter` without
// the panel's own exhaustive read landing in these `mockResolvedValueOnce`
// chains. Its own behaviour is pinned in its own suite.
let openTarget = 's1';
vi.mock('./RenderContinuityPanel', () => ({
  RenderContinuityPanel: ({ onOpenChapter }: { onOpenChapter: (id: string) => void }) => (
    <button type="button" onClick={() => onOpenChapter(openTarget)}>
      panel: open chapter
    </button>
  ),
}));

/**
 * A store mock that behaves like the real one in the ONE way that matters
 * here: `sections` is updated only when the write RESOLVES. That delay is
 * what made two quick chapter-break ticks clobber each other, so a mock
 * that updated synchronously would pin nothing.
 */
let novelHints: Record<string, unknown> = { chapter_breaks: [], chapter_titles: [] };
/** Set true to hold the NEXT write open, so a second edit is issued while
 *  the first is still in flight — the window the defect lived in. */
let blockNextSave = false;
let releaseHeld: (() => void) | null = null;
const saveNovelHints = vi.fn(async (patch: Record<string, unknown>) => {
  if (blockNextSave) {
    blockNextSave = false;
    await new Promise<void>((r) => {
      releaseHeld = r;
    });
  }
  novelHints = { ...novelHints, ...patch };
  return true;
});
function storeState() {
  return {
    sections: { rendering_hints: { data: { novel: novelHints }, server_ts: 1 } },
    saveNovelHints,
  };
}
vi.mock('../../stores/storyStore', () => ({
  useStoryStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = storeState();
      return selector ? selector(state) : state;
    },
    { getState: () => storeState() }
  ),
}));

const { RenderReader } = await import('./RenderReader');

// ---------------------------------------------------------------------------

function sceneRow(id: string, sequence: number): StorySceneOut {
  return {
    id,
    sequence,
    server_ts: 5,
    created_at: 'x',
    updated_at: 'x',
    data: { id, sequence, title: `Scene ${sequence + 1}` },
  } as unknown as StorySceneOut;
}

const SCENES = [sceneRow('s1', 0), sceneRow('s2', 1)];

function summary(sceneId: string, sequence: number, over: Record<string, unknown> = {}) {
  return {
    scene_id: sceneId,
    sequence,
    status: 'complete',
    source_scene_ts: 5,
    prose_bytes: 120,
    has_continuity: true,
    is_stale: false,
    is_orphaned: false,
    server_ts: 1,
    created_at: 'x',
    updated_at: 'x',
    ...over,
  };
}

function unit(sceneId: string, sequence: number, prose: string) {
  return {
    scene_id: sceneId,
    sequence,
    prose,
    status: 'complete',
    source_scene_ts: 5,
    continuity: { unreadable: false, verdicts: [] },
    server_ts: 1,
    created_at: 'x',
    updated_at: 'x',
  };
}

const page = (items: unknown[], next: { sequence: number; sceneId: string } | null) => ({
  items,
  next_after_sequence: next?.sequence ?? null,
  next_after_scene_id: next?.sceneId ?? null,
  has_more: next !== null,
});

const props = (over: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  renderId: 'r1',
  scenes: SCENES,
  canManage: true,
  disabled: false,
  onRerender: vi.fn(),
  reloadToken: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listRenderUnits.mockResolvedValue(page([summary('s1', 0), summary('s2', 1)], null));
});
afterEach(cleanup);

describe('a superseded prose page', () => {
  it('does not merge one render’s prose into another’s chapters', async () => {
    // r1's first page has more; the "Load more" request is left in flight
    // while the reader is pointed at a different render.
    let releaseStale: (v: unknown) => void = () => {};
    readRenderProse
      // r1, first page
      .mockResolvedValueOnce(page([unit('s1', 0, 'OLD RUN chapter one')], { sequence: 0, sceneId: 's1' }))
      // r1, "Load more" — held open
      .mockImplementationOnce(() => new Promise((r) => { releaseStale = r; }))
      // r2, first page
      .mockResolvedValueOnce(page([unit('s1', 0, 'NEW RUN chapter one')], null));

    const { rerender } = render(<RenderReader {...props()} />);
    await screen.findByRole('button', { name: /load more chapters/i });

    await userEvent.click(screen.getByRole('button', { name: /load more chapters/i }));

    // The user switches to a different render while that page is in flight.
    rerender(<RenderReader {...props({ renderId: 'r2' })} />);
    await waitFor(() => expect(readRenderProse).toHaveBeenCalledTimes(3));

    // r1's page finally lands. Same scene id, different prose.
    releaseStale(page([unit('s1', 0, 'OLD RUN chapter one')], null));
    await waitFor(() => expect(showToastGlobal).not.toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /1\. Scene 1/i }));
    expect(screen.getByText(/NEW RUN chapter one/)).toBeTruthy();
    expect(screen.queryByText(/OLD RUN chapter one/)).toBeNull();
  });
});

describe('a failed prose page', () => {
  it('keeps the chapter list and leaves a real retry', async () => {
    // The summaries read fine. Only the prose request failed, and a
    // transient failure there must not read as "this render is unreadable".
    readRenderProse.mockRejectedValueOnce(new Error('502'));

    render(<RenderReader {...props()} />);

    // The list survives...
    expect(await screen.findByText(/1\. Scene 1/)).toBeTruthy();
    expect(screen.getByText(/2\. Scene 2/)).toBeTruthy();
    expect(screen.queryByText(/couldn't read this render/i)).toBeNull();

    // ...and "Load more chapters" is still offered, which re-issues exactly
    // the page that failed. That is the retry the old fatal branch only
    // claimed to provide.
    readRenderProse.mockResolvedValueOnce(page([unit('s1', 0, 'Recovered.')], null));
    await userEvent.click(await screen.findByRole('button', { name: /load more chapters/i }));

    await userEvent.click(await screen.findByRole('button', { name: /1\. Scene 1/i }));
    expect(await screen.findByText(/Recovered\./)).toBeTruthy();
  });

  it('IS fatal when the chapter list itself cannot be read', async () => {
    // The distinction the fix rests on: with no summaries there is nothing to
    // show, and "no chapters" must not be confused with "we could not ask".
    listRenderUnits.mockRejectedValue(new Error('502'));

    render(<RenderReader {...props()} />);

    expect(await screen.findByText(/couldn't read this render/i)).toBeTruthy();
  });
});

describe('chapter-break editing (phase 6)', () => {
  beforeEach(() => {
    novelHints = { chapter_breaks: [], chapter_titles: [] };
    blockNextSave = false;
    releaseHeld = null;
    readRenderProse.mockResolvedValue(
      page([unit('s1', 0, 'one'), unit('s2', 1, 'two')], null)
    );
  });

  it('two ticks inside one round trip keep BOTH breaks', async () => {
    // The phase-6 review's HIGH. Each handler used to derive the whole
    // `chapter_breaks` array from a memo over the store, and the store
    // updates only when the PUT resolves — so the second tick read the
    // same empty set, sent ['s2'], and deleted the first break. The user
    // set two, saw one, and was told another device had merged it.
    render(<RenderReader {...props()} />);
    await screen.findByText(/1\. Scene 1/);

    await userEvent.click(screen.getByRole('button', { name: /1\. Scene 1/i }));
    await userEvent.click(screen.getByRole('button', { name: /2\. Scene 2/i }));

    const boxes = screen.getAllByRole('checkbox');
    // Hold the first write open so the second is issued while it is in
    // flight — the exact window the defect lived in.
    blockNextSave = true;
    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[1]);
    await waitFor(() => expect(releaseHeld).not.toBeNull());
    releaseHeld?.();

    await waitFor(() =>
      expect(novelHints.chapter_breaks).toEqual(expect.arrayContaining(['s1', 's2']))
    );
    expect((novelHints.chapter_breaks as string[]).length).toBe(2);
  });

  it('an emptied title removes its entry rather than storing a blank', async () => {
    novelHints = {
      chapter_breaks: [],
      chapter_titles: [{ scene_id: 's1', title: 'Kept' }],
    };
    render(<RenderReader {...props()} />);
    await screen.findByText(/1\. Scene 1/);
    await userEvent.click(screen.getByRole('button', { name: /1\. Scene 1/i }));

    const field = screen.getByDisplayValue('Kept');
    await userEvent.clear(field);
    await userEvent.tab();

    await waitFor(() => expect(novelHints.chapter_titles).toEqual([]));
  });
});

describe('opening a flagged chapter from the continuity panel', () => {
  it('pages the chapter in rather than showing an empty row', async () => {
    // The panel reads EVERY chapter, so it can flag one the reader has not
    // paged in. Expanding it used to land on "This chapter hasn't been
    // loaded yet" — a dead end pointing at a button the user would have to
    // press an unknown number of times.
    openTarget = 's2';
    readRenderProse
      .mockResolvedValueOnce(page([unit('s1', 0, 'one')], { sequence: 0, sceneId: 's1' }))
      .mockResolvedValueOnce(page([unit('s2', 1, 'CHAPTER TWO PROSE')], null));

    render(<RenderReader {...props()} />);
    await screen.findByText(/2\. Scene 2/);

    await userEvent.click(screen.getByRole('button', { name: /panel: open chapter/i }));

    await waitFor(() => expect(screen.getByText(/CHAPTER TWO PROSE/)).toBeTruthy());
    expect(screen.queryByText(/hasn't been loaded yet/)).toBeNull();
  });
});
