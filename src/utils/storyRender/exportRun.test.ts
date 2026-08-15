import { describe, it, expect, vi, beforeEach } from 'vitest';

const listRenderUnits = vi.fn();
const readRenderProse = vi.fn();

vi.mock('../../api/client', () => ({
  storyApi: {
    listRenderUnits: (...a: unknown[]) => listRenderUnits(...a),
    readRenderProse: (...a: unknown[]) => readRenderProse(...a),
  },
}));

const { collectRunForExport, filenameFor } = await import('./exportRun');

const RUN = {
  projectId: 'p1',
  renderId: 'r1',
  sceneIdStart: 's1',
  sceneIdEnd: 's3',
};

const SCENES = [
  { id: 's1', sequence: 0, data: { title: 'One' }, server_ts: 1, updated_at: 'x' },
  { id: 's2', sequence: 1, data: { title: 'Two' }, server_ts: 1, updated_at: 'x' },
  { id: 's3', sequence: 2, data: { title: 'Three' }, server_ts: 1, updated_at: 'x' },
];

function summary(id: string, sequence: number, over: Record<string, unknown> = {}) {
  return {
    scene_id: id,
    sequence,
    status: 'complete',
    source_scene_ts: 1,
    prose_bytes: 10,
    has_continuity: true,
    is_stale: false,
    is_orphaned: false,
    ...over,
  };
}

function body(id: string, sequence: number, prose = `Prose ${id}.`) {
  return {
    scene_id: id,
    sequence,
    prose,
    status: 'complete',
    source_scene_ts: 1,
    continuity: null,
    server_ts: 1,
    created_at: 'x',
    updated_at: 'x',
  };
}

const onePage = (items: unknown[]) => ({
  items,
  next_after_sequence: null,
  next_after_scene_id: null,
  has_more: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  listRenderUnits.mockResolvedValue(
    onePage([summary('s1', 0), summary('s2', 1), summary('s3', 2)])
  );
  readRenderProse.mockResolvedValue(
    onePage([body('s1', 0), body('s2', 1), body('s3', 2)])
  );
});

describe('collectRunForExport', () => {
  it('serializes a complete run', async () => {
    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy smoke test');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.markdown).toContain('# Ivy smoke test');
    expect(res.markdown).toContain('Prose s1.');
    expect(res.filename).toBe('ivy-smoke-test.md');
  });

  it('refuses BEFORE paging any prose', async () => {
    // The whole reason the gate runs on summaries: a run that cannot be
    // exported should not cost a single chapter body over the wire.
    listRenderUnits.mockResolvedValue(
      onePage([summary('s1', 0), summary('s2', 1, { status: 'truncated' }), summary('s3', 2)])
    );

    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blockers.map((b) => b.reason)).toEqual(['truncated']);
    expect(readRenderProse).not.toHaveBeenCalled();
  });

  it('pages units on has_more, NOT on page length', async () => {
    listRenderUnits
      .mockResolvedValueOnce({
        items: [summary('s1', 0)],
        next_after_sequence: 0,
        next_after_scene_id: 's1',
        has_more: true,
      })
      .mockResolvedValueOnce(onePage([summary('s2', 1), summary('s3', 2)]));

    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy');

    expect(listRenderUnits).toHaveBeenCalledTimes(2);
    // Resumes from the last row INCLUDED.
    expect(listRenderUnits.mock.calls[1][2]).toMatchObject({
      afterSequence: 0,
      afterSceneId: 's1',
    });
    // A short first page must not have been read as the last page — if it
    // had, s2 and s3 would be reported missing and this would refuse.
    expect(res.ok).toBe(true);
  });

  it('pages prose on has_more, NOT on page length', async () => {
    readRenderProse
      .mockResolvedValueOnce({
        items: [body('s1', 0)],
        next_after_sequence: 0,
        next_after_scene_id: 's1',
        has_more: true,
      })
      .mockResolvedValueOnce(onePage([body('s2', 1), body('s3', 2)]));

    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy');

    expect(readRenderProse).toHaveBeenCalledTimes(2);
    expect(readRenderProse.mock.calls[1][2]).toMatchObject({
      afterSequence: 0,
      afterSceneId: 's1',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The book is whole. Stopping on the short page would have dropped two
    // chapters and still produced a file that reads as finished.
    expect(res.markdown).toContain('Prose s2.');
    expect(res.markdown).toContain('Prose s3.');
  });

  it('catches a scene the run never reached', async () => {
    listRenderUnits.mockResolvedValue(onePage([summary('s1', 0)]));

    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blockers.map((b) => [b.sceneId, b.reason])).toEqual([
      ['s2', 'missing'],
      ['s3', 'missing'],
    ]);
  });

  it('carries staleness from the summaries onto the prose', async () => {
    listRenderUnits.mockResolvedValue(
      onePage([
        summary('s1', 0, { is_stale: true }),
        summary('s2', 1),
        summary('s3', 2),
      ])
    );

    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.markdown.startsWith('<!--')).toBe(true);
    expect(res.markdown).toContain('One');
  });

  it('exports, and says so, when the range anchors are gone', async () => {
    // Every scene deleted: the units are orphaned but the prose is still
    // the user's. Decision 2 says it exports; the completeness check
    // cannot run, so the file says that rather than implying it passed.
    listRenderUnits.mockResolvedValue(
      onePage([
        summary('s1', 0, { is_orphaned: true, is_stale: true }),
        summary('s2', 1, { is_orphaned: true, is_stale: true }),
        summary('s3', 2, { is_orphaned: true, is_stale: true }),
      ])
    );

    const res = await collectRunForExport(RUN, [], null, 'Ivy');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.markdown).toMatch(/could not/i);
    expect(res.markdown).toContain('Prose s1.');
  });

  it('still blocks on a bad status when the anchors are gone', async () => {
    // Losing the completeness check must not lose the status gate too.
    listRenderUnits.mockResolvedValue(
      onePage([summary('s1', 0, { status: 'error', is_orphaned: true })])
    );

    const res = await collectRunForExport(RUN, [], null, 'Ivy');
    expect(res.ok).toBe(false);
  });

  it('blocks a truncated chapter whose scene was deleted mid-run', async () => {
    // End to end for the review's HIGH: s2 merged away, so it leaves the
    // range but keeps its unit row and its prose. Before the union pass
    // this exported a chapter cut mid-sentence inside a finished-looking
    // file, with no way to re-render it.
    const scenesAfterMerge = [SCENES[0], SCENES[2]];
    listRenderUnits.mockResolvedValue(
      onePage([
        summary('s1', 0),
        summary('s2', 1, { status: 'truncated', is_orphaned: true, is_stale: true }),
        summary('s3', 2),
      ])
    );

    const res = await collectRunForExport(RUN, scenesAfterMerge, null, 'Ivy');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.blockers.map((b) => [b.sceneId, b.reason])).toEqual([['s2', 'truncated']]);
  });

  it('refuses a run holding no chapters instead of downloading an empty file', async () => {
    listRenderUnits.mockResolvedValue(onePage([]));
    readRenderProse.mockResolvedValue(onePage([]));

    const res = await collectRunForExport(RUN, [], null, 'Ivy');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.emptyRun).toBe(true);
  });

  it('re-checks status on the rows that actually ship', async () => {
    // The gate read summaries at t0; these bodies are t1. A unit that went
    // bad in between must not slip through on the strength of a stale
    // summary — the file is built from the bodies, so the bodies gate.
    listRenderUnits.mockResolvedValue(
      onePage([summary('s1', 0), summary('s2', 1), summary('s3', 2)])
    );
    readRenderProse.mockResolvedValue(
      onePage([
        body('s1', 0),
        { ...body('s2', 1), status: 'error' },
        body('s3', 2),
      ])
    );

    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy');
    expect(res.ok).toBe(false);
  });

  it('treats a body with no summary as stale rather than fresh', async () => {
    // Same direction as `unitNotes`: false-stale is cheap, false-fresh is not.
    listRenderUnits.mockResolvedValue(
      onePage([summary('s1', 0), summary('s2', 1), summary('s3', 2)])
    );
    readRenderProse.mockResolvedValue(
      onePage([body('s1', 0), body('s2', 1), body('s3', 2), body('s9', 3)])
    );

    const res = await collectRunForExport(RUN, SCENES, null, 'Ivy');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.markdown.startsWith('<!--')).toBe(true);
  });
});

describe('filenameFor', () => {
  it.each([
    ['Ivy smoke test', 'ivy-smoke-test.md'],
    ['  Spaces  ', 'spaces.md'],
    ['Ivy: the "sealed" wing!', 'ivy-the-sealed-wing.md'],
    ['???', 'story.md'],
    ['', 'story.md'],
  ])('%s → %s', (input, expected) => {
    expect(filenameFor(input)).toBe(expected);
  });

  it('clamps a very long name', () => {
    expect(filenameFor('a'.repeat(200)).length).toBeLessThanOrEqual(63);
  });
});
