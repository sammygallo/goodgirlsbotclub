import { describe, it, expect } from 'vitest';
import { prosePrompt } from './prompts';
import type { RenderBrief } from './types';

/**
 * The compression precedence rule (phase 6 follow-up).
 *
 * The goldens pin the whole prompt, which catches this too — but a golden
 * diff says "something changed", and this says WHICH RULE broke. The rule
 * is worth naming because it was decided against evidence: the user's
 * setting and the scene's annotation used to be unranked siblings, the
 * model picked the scene, and "Compress hard" produced a longer chapter
 * than "Balanced" on a real render.
 */

function brief(over: Record<string, unknown> = {}): RenderBrief {
  return {
    scene: {
      id: 's1',
      title: 'A scene',
      summary: 's',
      detailed_summary: 'd',
      setting: { atmosphere: '' },
      participants: [],
      function: null,
      transformations: null,
      ...(over.scene as Record<string, unknown>),
    },
    position: 1,
    totalScenes: 1,
    precedingSummary: '',
    participants: [],
    userVoice: null,
    facts: { own: [], sceneAttributed: [], unattributed: [] },
    rules: [],
    hints: {
      pov: null,
      povCharacterId: null,
      tense: null,
      compressionLevel: 'tight',
      targetWordCount: null,
      styleAnchors: [],
      ...(over.hints as Record<string, unknown>),
    },
    caveats: { approximate: false, constantsOnly: false, unresolvedRules: 0 },
    drops: [],
    rulesNotActive: 0,
    estimatedTokens: 0,
  } as unknown as RenderBrief;
}

const TRANSFORMATIONS = {
  compression_recommendation: 'preserve',
  compression_ratio_target: 0.9,
  pacing_notes: 'hold the beat',
  dialogue_density: 0.7,
};

describe('prosePrompt — compression precedence', () => {
  it('names the user’s setting as the governing one', () => {
    const p = prosePrompt(brief({ scene: { transformations: TRANSFORMATIONS } }));
    expect(p).toContain('this governs: Compress hard');
  });

  it('never sends the scene’s absolute ratio', () => {
    // "90% of its length" next to "compress hard" is the original
    // contradiction restated. What the annotation knows that the setting
    // cannot is RELATIVE — whether this scene resists trimming.
    const p = prosePrompt(brief({ scene: { transformations: TRANSFORMATIONS } }));
    expect(p).not.toMatch(/90%/);
    expect(p).not.toMatch(/of its length/);
    expect(p).toContain('cut this one last');
  });

  it('keeps the scene’s adjustment inside the same instruction', () => {
    // One bullet. Two made them siblings, which is what let the model rank
    // them for us.
    const p = prosePrompt(brief({ scene: { transformations: TRANSFORMATIONS } }));
    const bullets = p.slice(p.indexOf('Direction:')).split('\n- ');
    const governing = bullets.find((b) => b.includes('this governs'));
    expect(governing).toContain('cut this one last');
  });

  it('carries pacing notes as their own instruction', () => {
    // Orthogonal to length: they say how the scene MOVES. Appending them to
    // the compression sentence is what let a pacing note read as a length
    // instruction.
    const p = prosePrompt(brief({ scene: { transformations: TRANSFORMATIONS } }));
    expect(p).toContain('- Pacing: hold the beat');
  });

  it('says nothing about scene-level compression when there is no annotation', () => {
    const p = prosePrompt(brief());
    expect(p).toContain('this governs: Compress hard');
    expect(p).not.toMatch(/cut this one/);
    expect(p).not.toContain('Pacing:');
  });

  it.each([
    ['compress', 'cut this one first'],
    ['preserve', 'cut this one last'],
    ['expand', 'keep what there is'],
  ])('phrases %s as an ordering, not an absolute', (rec, phrase) => {
    const p = prosePrompt(
      brief({
        scene: { transformations: { ...TRANSFORMATIONS, compression_recommendation: rec } },
      })
    );
    expect(p).toContain(phrase);
  });

  it('no adjustment ever licenses writing MORE', () => {
    // The first version of this fix said `preserve` meant "give it room",
    // and a verification render came back LONGER than the defect it was
    // fixing (455 words vs 322). An adjustment may reorder what gets cut;
    // it may never ask for more prose.
    for (const rec of ['compress', 'preserve', 'expand']) {
      const p = prosePrompt(
        brief({
          scene: { transformations: { ...TRANSFORMATIONS, compression_recommendation: rec } },
        })
      );
      expect(p, rec).not.toMatch(/give it room|take more room|expand where|more room/i);
    }
  });
});
