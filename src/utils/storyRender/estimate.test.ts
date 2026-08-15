import { describe, it, expect } from 'vitest';
import { estimateRenderRun, resolveSceneRange } from './estimate';
import { CONTINUITY_MAX_TOKENS, PROSE_MAX_TOKENS } from './renderScene';
import { BRIEF_TOKEN_CAP } from './contextAssembler';
import type { StorySceneOut } from '../../api/client';
import type { Scene } from '../../types/storyBible';

/**
 * The preflight estimate (step 3, phase 5).
 *
 * What earns a test here is the set of properties a WRONG estimate would
 * quietly break, all of which are about spend the user authorised:
 *
 *  - it prices the range the run will actually render, not a different one;
 *  - a scene the assembler will refuse costs nothing and is counted as
 *    refused, rather than silently priced as if it would produce a chapter;
 *  - output is a ceiling derived from the real caps, not a guess.
 */

const MREF = (id: string) => ({
  msg_id: id,
  swipe_idx: 0,
  fingerprint: { sha: 'x', hash_alg: 'djb2' as const, send_date: 0 },
});

function scene(id: string, over: Partial<Scene> = {}): Scene {
  return {
    id,
    sequence: 0,
    title: `Scene ${id}`,
    summary: 'They arrive.',
    detailed_summary: 'They arrive at the Reach after dark.',
    setting: { location_ref: null, time_ref: null, atmosphere: 'cold' },
    participants: [],
    pov_character: null,
    function: null,
    source: {
      message_range: { start: MREF('m0'), end: MREF('m1') },
      total_messages: 2,
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

function row(id: string, sequence: number, data: Scene): StorySceneOut {
  return {
    id,
    sequence,
    server_ts: 1,
    created_at: 'x',
    updated_at: 'x',
    data: data as unknown as Record<string, unknown>,
  } as unknown as StorySceneOut;
}

const MESSAGES = [
  { id: 'm0', name: 'You', isUser: true, isSystem: false, content: 'hi', timestamp: 0, swipeIdx: 0, swipesCount: 1 },
  { id: 'm1', name: 'Ivy', isUser: false, isSystem: false, content: 'hello', timestamp: 1, swipeIdx: 0, swipesCount: 1 },
];

function baseInput(scenes: StorySceneOut[]) {
  return {
    scenes,
    factRows: [],
    characters: [],
    worldRules: [],
    userVoice: null,
    hints: null,
    narrative: null,
    messages: MESSAGES,
    wiEntries: [],
  };
}

describe('resolveSceneRange', () => {
  const a = row('a', 0, scene('a'));
  const b = row('b', 1, scene('b'));
  const c = row('c', 2, scene('c'));

  it('returns the inclusive span in sequence order', () => {
    expect(resolveSceneRange([c, a, b], 'a', 'b')?.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('refuses a backwards range rather than silently reversing it', () => {
    // A reversed range would render the story in the wrong order and the
    // run row would record a span it never covered.
    expect(resolveSceneRange([a, b, c], 'c', 'a')).toBeNull();
  });

  it('refuses an anchor that is not in the list', () => {
    expect(resolveSceneRange([a, b], 'a', 'gone')).toBeNull();
  });
});

describe('estimateRenderRun', () => {
  const rows = [row('a', 0, scene('a')), row('b', 1, scene('b')), row('c', 2, scene('c'))];

  it('prices only the chosen range', () => {
    const all = estimateRenderRun({ ...baseInput(rows), sceneIdStart: 'a', sceneIdEnd: 'c' })!;
    const part = estimateRenderRun({ ...baseInput(rows), sceneIdStart: 'a', sceneIdEnd: 'b' })!;

    expect(all.scenes).toBe(3);
    expect(part.scenes).toBe(2);
    expect(part.total).toBeLessThan(all.total);
  });

  it('derives the output ceiling from the real per-call caps', () => {
    // Not a magic number: if either cap moves, this estimate has to move
    // with it or the preflight starts under-quoting the run.
    const est = estimateRenderRun({
      ...baseInput(rows),
      sceneIdStart: 'a',
      sceneIdEnd: 'c',
    })!;
    expect(est.maxOutputTokens).toBe(3 * (PROSE_MAX_TOKENS + CONTINUITY_MAX_TOKENS));
    expect(est.total).toBe(est.inputTokens + est.maxOutputTokens);
  });

  it('counts a scene the assembler will refuse, and charges nothing for it', () => {
    // A scene whose mandatory core alone busts the 24k cap is refused by
    // `assembleRenderBrief`, so the run produces no chapter and spends no
    // tokens on it. Pricing it as a normal scene would over-quote by a
    // whole prose call AND promise output that never arrives.
    const huge = row(
      'big',
      0,
      scene('big', { detailed_summary: 'word '.repeat(BRIEF_TOKEN_CAP * 2) })
    );
    const est = estimateRenderRun({
      ...baseInput([huge]),
      sceneIdStart: 'big',
      sceneIdEnd: 'big',
    })!;

    expect(est.scenes).toBe(1);
    expect(est.refusedScenes).toBe(1);
    expect(est.inputTokens).toBe(0);
    expect(est.maxOutputTokens).toBe(0);
  });

  it('reports scenes whose messages are no longer in the transcript', () => {
    // The scanner sees an empty window, so only constants reach the brief.
    // The run still works; the preflight says so rather than letting the
    // user find out from a continuity note afterwards.
    const orphan = row(
      'gone',
      0,
      scene('gone', {
        source: {
          message_range: { start: MREF('nope'), end: MREF('nope2') },
          total_messages: 2,
          swipe_resolutions: [],
          excluded_segments: [],
        },
      })
    );
    const est = estimateRenderRun({
      ...baseInput([orphan]),
      sceneIdStart: 'gone',
      sceneIdEnd: 'gone',
    })!;
    expect(est.scenesWithoutWindow).toBe(1);
  });

  it('returns null for a range it cannot resolve', () => {
    expect(
      estimateRenderRun({ ...baseInput(rows), sceneIdStart: 'c', sceneIdEnd: 'a' })
    ).toBeNull();
  });
});
