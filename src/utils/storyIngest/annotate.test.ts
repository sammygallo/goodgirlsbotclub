import { describe, it, expect, vi } from 'vitest';
import {
  annotateScene,
  applyAnnotation,
  detectStructure,
  mergeNarrativeStructure,
  needsAnnotation,
  parseAnnotation,
  parseStructure,
} from './annotate';
import type { Scene, SceneFunction, SceneTransformations } from '../../types/storyBible';

const MREF = (id: string) => ({
  msg_id: id,
  swipe_idx: 0,
  fingerprint: { sha: 'x', hash_alg: 'djb2' as const, send_date: 0 },
});

const FUNCTION: SceneFunction = {
  beat: 'rising',
  tension: 5,
  mood: '',
  stakes: '',
};
const TRANSFORMATIONS: SceneTransformations = {
  compression_recommendation: 'preserve',
  compression_ratio_target: 1,
  pacing_notes: '',
  dialogue_density: 0.5,
};

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 'sc1',
    sequence: 0,
    title: 'Arrival',
    summary: 'They arrive.',
    detailed_summary: 'They arrive after dark.',
    setting: { location_ref: null, time_ref: null, atmosphere: '' },
    participants: [],
    pov_character: null,
    function: null,
    source: {
      message_range: { start: MREF('m0'), end: MREF('m3') },
      total_messages: 4,
      swipe_resolutions: [],
      excluded_segments: [],
    },
    continuity_facts_established: [],
    transformations: null,
    annotations: {
      user_notes: '',
      author_intent: '',
      flagged_issues: [],
      stale_source: false,
    },
    ...over,
  };
}

describe('needsAnnotation', () => {
  it('is true for an unannotated scene and false once both groups are set', () => {
    expect(needsAnnotation(scene())).toBe(true);
    expect(
      needsAnnotation(scene({ function: FUNCTION, transformations: TRANSFORMATIONS }))
    ).toBe(false);
  });

  it('is true for a half-annotated scene', () => {
    expect(needsAnnotation(scene({ function: FUNCTION }))).toBe(true);
    expect(needsAnnotation(scene({ transformations: TRANSFORMATIONS }))).toBe(true);
  });

  it('is true for an annotated scene the walk marked stale', () => {
    // The self-healing half: a re-emitted scene keeps its annotation under
    // a marker, and this is what brings the pass back to it.
    const marked = scene({
      function: FUNCTION,
      transformations: TRANSFORMATIONS,
      annotations: {
        user_notes: '',
        author_intent: '',
        flagged_issues: ['annotation_stale'],
        stale_source: false,
      },
    });
    expect(needsAnnotation(marked)).toBe(true);
  });
});

describe('parseAnnotation', () => {
  it('normalizes a well-formed response', () => {
    const out = parseAnnotation({
      beat: 'Crisis',
      tension: 9,
      mood: 'tight',
      stakes: 'everything',
      compression_recommendation: 'COMPRESS',
      compression_ratio_target: 0.4,
      pacing_notes: 'move',
      dialogue_density: 0.8,
    });
    expect(out).toEqual({
      function: { beat: 'crisis', tension: 9, mood: 'tight', stakes: 'everything' },
      transformations: {
        compression_recommendation: 'compress',
        compression_ratio_target: 0.4,
        pacing_notes: 'move',
        dialogue_density: 0.8,
      },
    });
  });

  it('rejects an object with neither a beat nor a tension', () => {
    // An empty {} would otherwise normalize into a confident
    // "rising / 5 / preserve" indistinguishable from a real reading.
    expect(parseAnnotation({})).toBeNull();
    expect(parseAnnotation({ mood: 'tense', pacing_notes: 'x' })).toBeNull();
    expect(parseAnnotation(null)).toBeNull();
  });

  it('clamps out-of-range numbers rather than dropping the reading', () => {
    const out = parseAnnotation({ beat: 'rising', tension: 40, dialogue_density: 9 })!;
    expect(out.function.tension).toBe(10);
    expect(out.transformations.dialogue_density).toBe(1);
    const low = parseAnnotation({ beat: 'rising', tension: 0 })!;
    expect(low.function.tension).toBe(1);
  });

  it('drops non-finite numbers instead of passing a 422 to the server', () => {
    const out = parseAnnotation({
      beat: 'rising',
      tension: 5,
      compression_ratio_target: Number.NaN,
      dialogue_density: Number.POSITIVE_INFINITY,
    })!;
    expect(Number.isFinite(out.transformations.compression_ratio_target)).toBe(true);
    expect(Number.isFinite(out.transformations.dialogue_density)).toBe(true);
  });

  it('never defaults the ratio to 0 — that would tell the renderer to keep nothing', () => {
    const cut = parseAnnotation({ beat: 'interlude', compression_recommendation: 'cut' })!;
    expect(cut.transformations.compression_ratio_target).toBeGreaterThan(0);
    const preserve = parseAnnotation({ beat: 'climax', tension: 10 })!;
    expect(preserve.transformations.compression_ratio_target).toBe(1);
  });
});

describe('applyAnnotation', () => {
  it('writes both groups and clears only the stale marker', () => {
    const before = scene({
      annotations: {
        user_notes: 'mine',
        author_intent: 'a',
        flagged_issues: ['annotation_stale', 'user flag'],
        stale_source: true,
      },
    });
    const after = applyAnnotation(before, {
      function: FUNCTION,
      transformations: TRANSFORMATIONS,
    });
    expect(after.function).toEqual(FUNCTION);
    expect(after.transformations).toEqual(TRANSFORMATIONS);
    expect(after.annotations.flagged_issues).toEqual(['user flag']);
    expect(after.annotations.user_notes).toBe('mine');
    expect(after.annotations.stale_source).toBe(true);
  });
});

describe('annotateScene', () => {
  const base = {
    scene: scene(),
    position: 1,
    totalScenes: 3,
    previousSummary: '',
    factTexts: ['Ivy carries a key.'],
  };

  it('returns the parsed annotation from one call', async () => {
    const llm = vi.fn(async () => JSON.stringify({ beat: 'rising', tension: 4 }));
    const out = await annotateScene({ ...base, llm });
    expect(out.llmCalls).toBe(1);
    expect(out.parseFailed).toBe(false);
    expect(out.annotation!.function.tension).toBe(4);
  });

  it('retries once with a repair instruction, then gives up rather than inventing one', async () => {
    const llm = vi.fn(async () => 'I think this scene is quite tense, honestly.');
    const out = await annotateScene({ ...base, llm });
    expect(out.llmCalls).toBe(2);
    expect(out.parseFailed).toBe(true);
    expect(out.annotation).toBeNull();
  });

  it('recovers on the repair retry', async () => {
    let call = 0;
    const llm = vi.fn(async () =>
      ++call === 1 ? 'no json here' : JSON.stringify({ beat: 'climax', tension: 10 })
    );
    const out = await annotateScene({ ...base, llm });
    expect(out.annotation!.function.beat).toBe('climax');
  });
});

describe('parseStructure', () => {
  const scenes = [
    { id: 'a', title: 'A', beat: null, tension: null },
    { id: 'b', title: 'B', beat: null, tension: null },
    { id: 'c', title: 'C', beat: null, tension: null },
  ];

  it('resolves 1-based act ranges onto real scene ids', () => {
    const out = parseStructure(
      {
        detected_type: 'three_act',
        detection_confidence: 0.7,
        acts: [
          { label: 'Setup', first_scene: 1, last_scene: 2, beat_function: 'opens' },
          { label: 'Close', first_scene: 3, last_scene: 3 },
        ],
      },
      scenes
    )!;
    expect(out.detected_type).toBe('three_act');
    expect(out.acts).toHaveLength(2);
    expect(out.acts[0].scene_range).toEqual(['a', 'b']);
    expect(out.acts[1].scene_range).toEqual(['c', 'c']);
  });

  it('mints the same act id for the same range twice — reruns are idempotent', () => {
    const body = {
      detected_type: 'three_act',
      acts: [{ label: 'Setup', first_scene: 1, last_scene: 2 }],
    };
    const a = parseStructure({ ...body }, scenes)!;
    const b = parseStructure({ ...body }, scenes)!;
    expect(a.acts[0].id).toBe(b.acts[0].id);
  });

  it('drops out-of-range, inverted and overlapping acts without losing the reading', () => {
    const out = parseStructure(
      {
        detected_type: 'episodic',
        acts: [
          { label: 'ok', first_scene: 1, last_scene: 2 },
          { label: 'overlaps', first_scene: 2, last_scene: 3 },
          { label: 'inverted', first_scene: 3, last_scene: 1 },
          { label: 'past the end', first_scene: 3, last_scene: 9 },
        ],
      },
      scenes
    )!;
    expect(out.detected_type).toBe('episodic');
    expect(out.acts.map((a) => a.label)).toEqual(['ok']);
  });

  it('refuses acts under "none_yet" even when the model supplies them', () => {
    const out = parseStructure(
      { detected_type: 'none_yet', acts: [{ label: 'x', first_scene: 1, last_scene: 1 }] },
      scenes
    )!;
    expect(out.acts).toEqual([]);
  });

  it('rejects an unrecognized structure type outright', () => {
    expect(parseStructure({ detected_type: 'heros_journey' }, scenes)).toBeNull();
    expect(parseStructure({}, scenes)).toBeNull();
  });
});

describe('detectStructure', () => {
  it('makes no call at all for a bible with no scenes', async () => {
    const llm = vi.fn(async () => '{}');
    const out = await detectStructure({ scenes: [], llm });
    expect(llm).not.toHaveBeenCalled();
    expect(out.structure).toBeNull();
    expect(out.parseFailed).toBe(false);
  });

  it('retries once and then reports the failure', async () => {
    const llm = vi.fn(async () => 'it feels like a three act story to me');
    const out = await detectStructure({
      scenes: [{ id: 'a', title: 'A', beat: 'rising', tension: 3 }],
      llm,
    });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(out.parseFailed).toBe(true);
  });
});

describe('mergeNarrativeStructure', () => {
  it('replaces only `structure`, carrying every other key through', () => {
    const structure = {
      detected_type: 'episodic' as const,
      detection_confidence: 0.3,
      acts: [],
    };
    const merged = mergeNarrativeStructure(
      {
        structure: { detected_type: 'three_act', detection_confidence: 1, acts: [] },
        themes: [{ theme: 'trust', evidence: [] }],
        motifs: ['keys'],
        unresolved_threads: ['the letter'],
        pov_default: 'first',
        tense_default: 'past',
      },
      structure
    );
    expect(merged.structure).toBe(structure);
    expect(merged.themes).toEqual([{ theme: 'trust', evidence: [] }]);
    expect(merged.motifs).toEqual(['keys']);
    expect(merged.unresolved_threads).toEqual(['the letter']);
    expect(merged.pov_default).toBe('first');
    expect(merged.tense_default).toBe('past');
  });

  it('fills a complete section when nothing is stored yet', () => {
    const merged = mergeNarrativeStructure(null, {
      detected_type: 'none_yet',
      detection_confidence: 0,
      acts: [],
    });
    expect(merged.themes).toEqual([]);
    expect(merged.pov_default).toBeNull();
  });
});
