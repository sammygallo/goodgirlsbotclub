import { describe, it, expect } from 'vitest';
import {
  assembleRenderBrief,
  buildFactSet,
  resolveHints,
  BRIEF_TOKEN_CAP,
} from './contextAssembler';
import { isRefusal, type SelectedRules } from './types';
import type { StoryLogEntry } from '../../api/client';
import type {
  BibleCharacter,
  NarrativeSection,
  RenderingHintsSection,
  Scene,
  UserVoiceSection,
  WorldRule,
} from '../../types/storyBible';

const MREF = (id: string) => ({
  msg_id: id,
  swipe_idx: 0,
  fingerprint: { sha: 'x', hash_alg: 'djb2' as const, send_date: 0 },
});

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 'sc1',
    sequence: 0,
    title: 'Arrival',
    summary: 'They arrive.',
    detailed_summary: 'They arrive at the Reach after dark.',
    setting: { location_ref: null, time_ref: null, atmosphere: 'cold' },
    participants: ['char-ivy'],
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

function character(over: Partial<BibleCharacter> = {}): BibleCharacter {
  return {
    id: 'char-ivy',
    canonical_name: 'Ivy',
    aliases: [],
    role: 'protagonist',
    is_user_persona: false,
    background: 'An archivist.',
    relationships: [],
    arc: { starting_state: '', current_state: '', target_state: null, beats: [] },
    personality: {
      traits: [],
      motivations: [],
      fears: [],
      values: [],
      voice_profile: {
        register: 'casual',
        speech_patterns: 'clipped',
        verbal_tics: [],
        dialogue_examples: [],
        vocabulary_signals: { favored: [], avoided: [] },
      },
    },
    ...over,
  };
}

function factRow(
  id: string,
  text: string,
  establishedIn: string | null,
  extra: Record<string, unknown> = {}
): StoryLogEntry {
  return {
    seq: 1,
    id,
    created_at: 'x',
    data: { id, text, category: 'reveal', established_in: establishedIn, confidence: 'explicit', ...extra },
  };
}

const NO_RULES: SelectedRules = {
  included: [],
  nonFiring: [],
  caveats: { approximate: false, constantsOnly: false, unresolvedRules: 0 },
};

function baseInput(over: Record<string, unknown> = {}) {
  return {
    scene: scene(),
    position: 1,
    totalScenes: 3,
    precedingSummary: '',
    characters: [character()],
    userVoice: null,
    factRows: [],
    rules: NO_RULES,
    hints: null,
    narrative: null,
    ...over,
  } as Parameters<typeof assembleRenderBrief>[0];
}

describe('buildFactSet', () => {
  it('is a THREE-way union including the unattributed tail', () => {
    // The third member is the point: the first two exclude
    // null-attributed facts by construction, and that tail is
    // reconcile's card facts and the user's own resolutions — bible-wide
    // canon, and the claims prose is most likely to contradict.
    const s = scene({ continuity_facts_established: ['f1'] });
    const set = buildFactSet(s, [
      factRow('f1', 'Ivy carries a key.', 'sc1'),
      factRow('f2', 'The door is iron.', 'sc1'),
      factRow('f3', 'Ivy is left-handed.', null),
      factRow('f4', 'Elsewhere fact.', 'sc9'),
    ]);
    expect(set.own.map((f) => f.id)).toEqual(['f1']);
    expect(set.sceneAttributed.map((f) => f.id)).toEqual(['f2']);
    expect(set.unattributed.map((f) => f.id)).toEqual(['f3']);
  });

  it('drops tombstones — the log page does not filter them', () => {
    const set = buildFactSet(scene(), [
      factRow('f1', 'live', null),
      { seq: 2, id: 'f2', created_at: 'x', data: { id: 'f2', deleted_at: 'now' } },
    ]);
    expect(set.unattributed.map((f) => f.id)).toEqual(['f1']);
  });

  it('skips an indexed id whose row is gone rather than rendering a blank', () => {
    const s = scene({ continuity_facts_established: ['f1', 'deleted-since'] });
    const set = buildFactSet(s, [factRow('f1', 'live', 'sc1')]);
    expect(set.own).toHaveLength(1);
  });

  it('never double-counts a fact listed in the scene index', () => {
    const s = scene({ continuity_facts_established: ['f1'] });
    const set = buildFactSet(s, [factRow('f1', 'x', 'sc1')]);
    expect(set.sceneAttributed).toHaveLength(0);
  });
});

describe('resolveHints', () => {
  it('prefers rendering_hints, falling back to narrative defaults', () => {
    const hints = { pov: 'first', tense: null } as RenderingHintsSection['novel'];
    const narrative = {
      pov_default: 'third_limited',
      tense_default: 'past',
    } as NarrativeSection;
    const out = resolveHints(hints, narrative);
    expect(out.pov).toBe('first');
    // A null in rendering_hints falls THROUGH to the default rather than
    // overriding it with nothing (the schema's own D4 note).
    expect(out.tense).toBe('past');
  });

  it('defaults compression to balanced when nothing is set', () => {
    expect(resolveHints(null, null).compressionLevel).toBe('balanced');
  });
});

describe('assembleRenderBrief', () => {
  it('carries the scene, participants and facts through under cap', () => {
    const brief = assembleRenderBrief(
      baseInput({
        scene: scene({ continuity_facts_established: ['f1'] }),
        factRows: [factRow('f1', 'Ivy carries a key.', 'sc1')],
      })
    );
    expect(isRefusal(brief)).toBe(false);
    if (isRefusal(brief)) return;
    expect(brief.participants.map((c) => c.id)).toEqual(['char-ivy']);
    expect(brief.facts.own).toHaveLength(1);
    expect(brief.drops).toEqual([]);
  });

  it('only includes the scene’s own participants', () => {
    const brief = assembleRenderBrief(
      baseInput({ characters: [character(), character({ id: 'char-other' })] })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.participants).toHaveLength(1);
  });

  it('REFUSES when the mandatory core alone busts the cap', () => {
    // §3.5: refuse with a named error rather than silently rendering a
    // partial brief. The core is never dropped, so there is no honest
    // alternative.
    const brief = assembleRenderBrief(
      baseInput({
        scene: scene({ detailed_summary: 'x'.repeat(400_000) }),
      })
    );
    expect(isRefusal(brief)).toBe(true);
    if (!isRefusal(brief)) return;
    expect(brief.reason).toBe('core_exceeds_cap');
    expect(brief.coreTokens).toBeGreaterThan(brief.capTokens);
  });

  it('drops in the stated priority order', () => {
    const big = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => factRow(`${prefix}${i}`, 'y'.repeat(400), null));
    const bigScene = Array.from({ length: 30 }, (_, i) =>
      factRow(`s${i}`, 'z'.repeat(400), 'sc1')
    );
    const nonFiring: WorldRule[] = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      text: 'w'.repeat(400),
      category: 'other',
      source: { kind: 'lorebook_entry', ref: { book_id: 'b', entry_id: `e${i}` }, snapshot: {}, captured_at: 'x' } as WorldRule['source'],
      confidence: 'inferred',
      established_in: null,
    }));

    const brief = assembleRenderBrief(
      baseInput({
        factRows: [...big(30, 'u'), ...bigScene],
        rules: { ...NO_RULES, nonFiring },
        capTokens: 1200,
        precedingSummary: 'p'.repeat(2000),
      })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');

    const kinds = brief.drops.map((d) => d.kind);
    // The bible-wide tail goes first, then the scene's other facts, then
    // the preceding summary. Non-firing rules are NOT a drop kind — the
    // selector excluded them before the cap ever ran.
    expect(kinds[0]).toBe('unattributed_facts');
    expect(kinds.indexOf('unattributed_facts')).toBeLessThan(
      kinds.indexOf('other_scene_facts')
    );
    expect(brief.rules).toHaveLength(0);
    expect(brief.rulesNotActive).toBe(30);
    expect(brief.facts.unattributed).toHaveLength(0);
  });

  it('reports what it dropped, with counts — never silently', () => {
    const brief = assembleRenderBrief(
      baseInput({
        factRows: Array.from({ length: 12 }, (_, i) =>
          factRow(`u${i}`, 'y'.repeat(800), null)
        ),
        capTokens: 900,
      })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    const drop = brief.drops.find((d) => d.kind === 'unattributed_facts');
    expect(drop?.count).toBe(12);
  });

  it('reports non-firing rules as a SELECTION fact, not a cap drop', () => {
    // "Not active in this scene" and "did not fit" are different things to
    // tell a user, and only the second is the cap's doing.
    const nonFiring: WorldRule[] = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      text: 'w',
      category: 'other',
      source: { kind: 'lorebook_entry', ref: { book_id: 'b', entry_id: `e${i}` }, snapshot: {}, captured_at: 'x' } as WorldRule['source'],
      confidence: 'inferred',
      established_in: null,
    }));
    const brief = assembleRenderBrief(baseInput({ rules: { ...NO_RULES, nonFiring } }));
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    // Excluded outright, even though there was plenty of room.
    expect(brief.rules).toHaveLength(0);
    expect(brief.rulesNotActive).toBe(7);
    expect(brief.drops).toEqual([]);
  });

  it('does not report a drop for a category that was empty anyway', () => {
    // Reporting one would tell the user something was left out when
    // nothing was.
    const brief = assembleRenderBrief(
      baseInput({
        factRows: Array.from({ length: 40 }, (_, i) =>
          factRow(`u${i}`, 'y'.repeat(400), null)
        ),
        capTokens: 900,
      })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.drops.map((d) => d.kind)).not.toContain('non_firing_rules');
    expect(brief.drops.map((d) => d.kind)).toContain('unattributed_facts');
  });

  it('strips dialogue examples last, keeping the character record', () => {
    const withExamples = character({
      personality: {
        traits: [],
        motivations: [],
        fears: [],
        values: [],
        voice_profile: {
          register: 'casual',
          speech_patterns: 'clipped',
          verbal_tics: [],
          dialogue_examples: [{ text: 'q'.repeat(3000) }, { text: 'r'.repeat(3000) }],
          vocabulary_signals: { favored: [], avoided: [] },
        },
      },
    });
    const brief = assembleRenderBrief(
      baseInput({ characters: [withExamples], capTokens: 300 })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.drops.map((d) => d.kind)).toContain('dialogue_examples');
    // The record itself survives — it is mandatory core.
    expect(brief.participants[0].canonical_name).toBe('Ivy');
    expect(
      brief.participants[0].personality?.voice_profile?.dialogue_examples
    ).toEqual([]);
  });

  it('keeps the FIRING rules even when the brief is over cap', () => {
    // They are what the selector exists to find; dropping them would
    // leave the brief holding the rules that did not fire.
    const firing: WorldRule[] = [
      {
        id: 'r-fire',
        text: 'The lanterns burn cold.',
        category: 'other',
        source: { kind: 'lorebook_entry', ref: { book_id: 'b', entry_id: 'e' }, snapshot: {}, captured_at: 'x' } as WorldRule['source'],
        confidence: 'explicit',
        established_in: null,
      },
    ];
    const brief = assembleRenderBrief(
      baseInput({
        rules: { ...NO_RULES, included: firing },
        factRows: Array.from({ length: 40 }, (_, i) =>
          factRow(`u${i}`, 'y'.repeat(400), null)
        ),
        capTokens: 700,
      })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.rules.map((r) => r.id)).toEqual(['r-fire']);
  });

  it('carries the selector’s caveats through to the brief', () => {
    const brief = assembleRenderBrief(
      baseInput({
        rules: {
          included: [],
          nonFiring: [],
          caveats: { approximate: true, constantsOnly: true, unresolvedRules: 3 },
        },
      })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.caveats).toEqual({
      approximate: true,
      constantsOnly: true,
      unresolvedRules: 3,
    });
  });

  it('uses a 24k cap by default', () => {
    expect(BRIEF_TOKEN_CAP).toBe(24_000);
    const userVoice = { style_summary: 'terse' } as UserVoiceSection;
    const brief = assembleRenderBrief(baseInput({ userVoice }));
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.estimatedTokens).toBeLessThan(BRIEF_TOKEN_CAP);
  });
});

// ---------------------------------------------------------------------------
// Adversarial review findings (all four lenses, confirmed)
// ---------------------------------------------------------------------------

describe('the cap is actually a cap', () => {
  const firing = (n: number, chars: number): WorldRule[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      text: 'w'.repeat(chars),
      category: 'other',
      source: {
        kind: 'lorebook_entry',
        ref: { book_id: 'b', entry_id: `e${i}` },
        snapshot: {},
        captured_at: 'x',
      } as WorldRule['source'],
      confidence: 'explicit',
      established_in: null,
    }));

  it('never returns a brief over cap, even on firing rules alone', () => {
    // Review's executed probe: 400 firing rules × 400 chars returned a
    // NON-refusal brief at 44,121 estimated tokens with drops: [] — 1.8x
    // the cap, reported as a fully-assembled brief. Reachable on ordinary
    // data: cold start's rule budget is 180KB and every `constant` entry's
    // rule lands in `included` unconditionally.
    const brief = assembleRenderBrief(baseInput({ rules: { ...NO_RULES, included: firing(400, 400) } }));
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.estimatedTokens).toBeLessThanOrEqual(BRIEF_TOKEN_CAP);
  });

  it('reports the firing rules it had to trim, rather than dropping them in silence', () => {
    const brief = assembleRenderBrief(baseInput({ rules: { ...NO_RULES, included: firing(400, 600) } }));
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    const drop = brief.drops.find((d) => d.kind === 'firing_rules');
    expect(drop).toBeDefined();
    expect(drop!.count).toBeGreaterThan(0);
    expect(brief.rules.length).toBe(400 - drop!.count);
  });

  it('trims firing rules LAST — after every optional category', () => {
    const brief = assembleRenderBrief(
      baseInput({
        rules: { ...NO_RULES, included: firing(200, 600), nonFiring: firing(5, 600) },
        factRows: Array.from({ length: 20 }, (_, i) => factRow(`u${i}`, 'y'.repeat(400), null)),
        precedingSummary: 'p'.repeat(2000),
      })
    );
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    const kinds = brief.drops.map((d) => d.kind);
    expect(kinds[kinds.length - 1]).toBe('firing_rules');
    expect(kinds).toContain('unattributed_facts');
    expect(kinds).toContain('preceding_summary');
  });

  it('keeps every firing rule when they fit', () => {
    const brief = assembleRenderBrief(baseInput({ rules: { ...NO_RULES, included: firing(3, 100) } }));
    if (isRefusal(brief)) throw new Error('unexpected refusal');
    expect(brief.rules).toHaveLength(3);
    expect(brief.drops.map((d) => d.kind)).not.toContain('firing_rules');
  });
});
