import { describe, it, expect } from 'vitest';
import {
  exportBlockers,
  blockerMessage,
  renderMarkdown,
  type ExportUnit,
} from './exportMarkdown';
import type { RenderingHintsSection } from '../../types/storyBible';

const RANGE = [
  { id: 's1', sequence: 0 },
  { id: 's2', sequence: 1 },
  { id: 's3', sequence: 2 },
];

const TITLES = new Map([
  ['s1', 'The sealed north wing'],
  ['s2', 'The ledger says otherwise'],
  ['s3', 'The journey she never took'],
]);

function unit(over: Partial<ExportUnit> & { sceneId: string; sequence: number }): ExportUnit {
  return {
    prose: `Prose for ${over.sceneId}.`,
    status: 'complete',
    isStale: false,
    isOrphaned: false,
    ...over,
  };
}

const COMPLETE = [
  unit({ sceneId: 's1', sequence: 0 }),
  unit({ sceneId: 's2', sequence: 1 }),
  unit({ sceneId: 's3', sequence: 2 }),
];

function hints(over: Partial<RenderingHintsSection['novel']>): RenderingHintsSection['novel'] {
  return {
    pov: null,
    pov_character: null,
    tense: null,
    chapter_breaks: [],
    chapter_titles: [],
    compression_level: 'balanced',
    target_word_count: null,
    style_anchors: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The gate (Decision 1)
// ---------------------------------------------------------------------------

describe('exportBlockers', () => {
  it('passes a run whose every unit is complete', () => {
    const units = COMPLETE.map((u) => ({ sceneId: u.sceneId, status: u.status }));
    expect(exportBlockers(RANGE, units, TITLES)).toEqual([]);
  });

  it.each(['truncated', 'error', 'pending'] as const)('blocks on %s', (status) => {
    const units = [
      { sceneId: 's1', status: 'complete' as const },
      { sceneId: 's2', status },
      { sceneId: 's3', status: 'complete' as const },
    ];
    const blockers = exportBlockers(RANGE, units, TITLES);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ sceneId: 's2', sequence: 1, reason: status });
  });

  it('blocks on a scene with no unit row at all', () => {
    // A paused run. Exporting what exists would turn a three-chapter story
    // into a one-chapter book that reads as finished.
    const blockers = exportBlockers(RANGE, [{ sceneId: 's1', status: 'complete' }], TITLES);
    expect(blockers.map((b) => [b.sceneId, b.reason])).toEqual([
      ['s2', 'missing'],
      ['s3', 'missing'],
    ]);
  });

  it('names EVERY offending chapter, not just the first', () => {
    // The refusal is the user's whole picture of what to fix. Reporting one
    // at a time turns one re-render into a guessing loop.
    const units = [
      { sceneId: 's1', status: 'truncated' as const },
      { sceneId: 's2', status: 'error' as const },
      { sceneId: 's3', status: 'complete' as const },
    ];
    expect(exportBlockers(RANGE, units, TITLES)).toHaveLength(2);
  });

  it('reports blockers in reading order', () => {
    const units = [
      { sceneId: 's3', status: 'error' as const },
      { sceneId: 's1', status: 'truncated' as const },
      { sceneId: 's2', status: 'complete' as const },
    ];
    expect(exportBlockers(RANGE, units, TITLES).map((b) => b.sequence)).toEqual([0, 2]);
  });

  it('ignores units outside the run’s own range', () => {
    // A run owns the scenes it was created with. A scene added to the bible
    // afterwards is not a hole in this book.
    const units = [
      ...COMPLETE.map((u) => ({ sceneId: u.sceneId, status: u.status })),
      { sceneId: 's99', status: 'error' as const },
    ];
    expect(exportBlockers(RANGE, units, TITLES)).toEqual([]);
  });

  it('falls back to a positional label when the scene has no title', () => {
    const blockers = exportBlockers(
      RANGE,
      [{ sceneId: 's1', status: 'truncated' }],
      new Map()
    );
    expect(blockers[0].title).toBe('Chapter 1');
  });

  it('gives every reason a message', () => {
    for (const r of ['truncated', 'error', 'pending', 'missing'] as const) {
      expect(blockerMessage(r)).toMatch(/\S/);
    }
  });
});

// ---------------------------------------------------------------------------
// Grouping and titles (Decision 3)
// ---------------------------------------------------------------------------

describe('renderMarkdown — chapters', () => {
  it('gives every scene its own chapter when no breaks are set', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: COMPLETE,
      sceneTitles: TITLES,
      hints: null,
    });
    expect(md.match(/^## /gm)).toHaveLength(3);
    expect(md).toContain('## The sealed north wing');
  });

  it('groups the scenes between breaks into one chapter', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: COMPLETE,
      sceneTitles: TITLES,
      hints: hints({ chapter_breaks: ['s3'] }),
    });
    // s1+s2 in the first chapter, s3 opening the second.
    expect(md.match(/^## /gm)).toHaveLength(2);
    const [first, second] = md.split(/^## /m).slice(1);
    expect(first).toContain('Prose for s1.');
    expect(first).toContain('Prose for s2.');
    expect(second).toContain('Prose for s3.');
  });

  it('a break on the first scene does not produce an empty leading chapter', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: COMPLETE,
      sceneTitles: TITLES,
      hints: hints({ chapter_breaks: ['s1', 's3'] }),
    });
    expect(md.match(/^## /gm)).toHaveLength(2);
    expect(md).not.toMatch(/## [^\n]*\n\n## /);
  });

  it('ignores a break naming a scene outside the run', () => {
    // Hints are bible-wide and long-lived; a run over scenes 10-20 will
    // routinely carry breaks belonging to scenes 1-9.
    const md = renderMarkdown({
      title: 'Ivy',
      units: COMPLETE,
      sceneTitles: TITLES,
      hints: hints({ chapter_breaks: ['s99'] }),
    });
    expect(md.match(/^## /gm)).toHaveLength(1);
  });

  it('an explicit chapter title wins over the scene title', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: COMPLETE,
      sceneTitles: TITLES,
      hints: hints({ chapter_titles: [{ scene_id: 's1', title: 'What she keeps' }] }),
    });
    expect(md).toContain('## What she keeps');
    expect(md).not.toContain('## The sealed north wing');
  });

  it('a blank explicit title falls back instead of emitting an empty heading', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: COMPLETE,
      sceneTitles: TITLES,
      hints: hints({ chapter_titles: [{ scene_id: 's1', title: '   ' }] }),
    });
    expect(md).toContain('## The sealed north wing');
    expect(md).not.toMatch(/^## *$/m);
  });

  it('falls back to a positional label when nothing names the chapter', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: [unit({ sceneId: 's2', sequence: 1 })],
      sceneTitles: new Map(),
      hints: null,
    });
    expect(md).toContain('## Chapter 2');
  });

  it('sorts by sequence regardless of input order', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: [COMPLETE[2], COMPLETE[0], COMPLETE[1]],
      sceneTitles: TITLES,
      hints: null,
    });
    expect(md.indexOf('Prose for s1.')).toBeLessThan(md.indexOf('Prose for s2.'));
    expect(md.indexOf('Prose for s2.')).toBeLessThan(md.indexOf('Prose for s3.'));
  });

  it('emits the prose verbatim', () => {
    // The model's own paragraphing is the output the user paid for;
    // reflowing it here would silently rewrite it.
    const prose = 'One.\n\nTwo — with an em dash.\n\n"Three," she said.';
    const md = renderMarkdown({
      title: 'Ivy',
      units: [unit({ sceneId: 's1', sequence: 0, prose })],
      sceneTitles: TITLES,
      hints: null,
    });
    expect(md).toContain(prose);
  });

  it('returns empty string for no units rather than a bare heading', () => {
    expect(renderMarkdown({ title: 'Ivy', units: [], sceneTitles: TITLES, hints: null })).toBe('');
  });

  it('ends with exactly one newline', () => {
    const md = renderMarkdown({ title: 'Ivy', units: COMPLETE, sceneTitles: TITLES, hints: null });
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('falls back to a title when the work has none', () => {
    const md = renderMarkdown({ title: '  ', units: COMPLETE, sceneTitles: TITLES, hints: null });
    expect(md).toContain('# Untitled');
  });
});

// ---------------------------------------------------------------------------
// The stale/orphan notice (Decision 2)
// ---------------------------------------------------------------------------

describe('renderMarkdown — the notice', () => {
  it('says nothing when every chapter is fresh', () => {
    const md = renderMarkdown({ title: 'Ivy', units: COMPLETE, sceneTitles: TITLES, hints: null });
    expect(md).not.toContain('<!--');
    expect(md.startsWith('# Ivy')).toBe(true);
  });

  it('exports stale chapters and names them in a comment block', () => {
    // Decision 2: the prose is complete and was paid for. A scene retitle
    // marks everything downstream stale, so refusing would make a routine
    // edit an export outage.
    const md = renderMarkdown({
      title: 'Ivy',
      units: [
        unit({ sceneId: 's1', sequence: 0, isStale: true }),
        unit({ sceneId: 's2', sequence: 1 }),
        unit({ sceneId: 's3', sequence: 2 }),
      ],
      sceneTitles: TITLES,
      hints: null,
    });
    expect(md.startsWith('<!--')).toBe(true);
    expect(md).toContain('The sealed north wing');
    expect(md).toContain('Prose for s1.');
  });

  it('names orphaned chapters separately and says they cannot be re-rendered', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: [
        unit({ sceneId: 's1', sequence: 0, isOrphaned: true, isStale: true }),
        unit({ sceneId: 's2', sequence: 1 }),
        unit({ sceneId: 's3', sequence: 2 }),
      ],
      sceneTitles: TITLES,
      hints: null,
    });
    expect(md).toMatch(/no longer exist/);
    expect(md).toMatch(/cannot be re-rendered/);
    // Orphaned implies stale server-side; it must not be reported twice.
    const notice = md.slice(0, md.indexOf('-->'));
    expect(notice.match(/The sealed north wing/g)).toHaveLength(1);
  });

  it('keeps the notice out of the prose body', () => {
    const md = renderMarkdown({
      title: 'Ivy',
      units: [unit({ sceneId: 's1', sequence: 0, isStale: true })],
      sceneTitles: TITLES,
      hints: null,
    });
    const body = md.slice(md.indexOf('-->') + 3);
    expect(body).not.toContain('Re-render them');
  });
});
