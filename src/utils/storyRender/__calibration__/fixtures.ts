// Calibration fixtures for the renderer (step 3, phase 6, Decision 4).
//
// TypeScript rather than JSON on purpose: `AssembleInput` is a large typed
// shape, and a JSON fixture would need a cast at the boundary — which is
// exactly where a fixture silently stops matching the code it is meant to
// pin. As TS, `tsc -b` checks every fixture on every build, and a change to
// `Scene` or `AssembleInput` breaks here loudly instead of drifting.
//
// PROVENANCE MATTERS and is recorded per fixture. A fixture built by hand to
// reach a code path is a fine golden-brief test and is NOT evidence about
// prose quality. Only fixtures whose prose was actually generated and read
// carry a rating — see RATINGS.md.

import type { AssembleInput } from '../contextAssembler';
import type { StoryLogEntry } from '../../../api/client';
import type { BibleCharacter, Scene, WorldRule } from '../../../types/storyBible';

export interface CalibrationFixture {
  /** Also the golden filename stem. */
  name: string;
  /** What this fixture is for — which path through the assembler it walks. */
  description: string;
  /** Where the material came from. Real transcript, or hand-built. */
  provenance: string;
  /** True only when prose was actually generated from this input, read, and
   *  rated in RATINGS.md. Never set this for a hand-built fixture. */
  ratedProse: boolean;
  input: AssembleInput;
}

const IVY_ID = '3b415bb4-fa4e-418c-b120-b345b52d2c90';

function ivy(): BibleCharacter {
  return {
    id: IVY_ID,
    canonical_name: 'Ivy',
    aliases: [],
    role: 'protagonist',
    is_user_persona: false,
    background: 'Keeper of the Reach archive. Precise, unhurried, evasive.',
    relationships: [],
  } as unknown as BibleCharacter;
}

function factRow(id: string, text: string, establishedIn: string | null): StoryLogEntry {
  return {
    seq: 1,
    id,
    created_at: '2026-08-15T00:00:00Z',
    data: {
      id,
      text,
      kind: 'fact',
      established_in: establishedIn,
      confidence: 'stated',
      source: null,
    },
  } as unknown as StoryLogEntry;
}

/**
 * Fixture 1 — the real one.
 *
 * Taken verbatim from the 2026-08-15 verification run: the first end-to-end
 * render on a live provider key. Scene, annotations and fact log are the
 * rows that run actually read, and the prose it produced was read and rated
 * (RATINGS.md). Its two facts are a deliberate contradiction pair, which is
 * why the continuity checker had something true to find.
 */
const ivyLedger: CalibrationFixture = {
  name: 'ivy-ledger',
  description:
    'Mid-story scene with an annotated beat, two contradicting facts and one participant. The ordinary path.',
  provenance:
    'Real. Scene 2 of the 2026-08-15 verification render (project "Ivy smoke test"), copied from story_scenes/story_facts.',
  ratedProse: true,
  input: {
    scene: {
      id: '1f0c2d84-6a37-4b91-9e52-0d7c8a4b3e10',
      sequence: 1,
      title: 'The ledger says otherwise',
      summary: 'Sam produces the ledger; Ivy denies ever sealing the wing.',
      detailed_summary:
        'Sam counters that the ledger contradicts her. Ivy insists he misread it and that she has never sealed the north wing — a direct reversal of what she said minutes earlier. Sam presses: which is it?',
      setting: { location_ref: null, time_ref: null, atmosphere: '' },
      participants: [IVY_ID],
      pov_character: null,
      continuity_facts_established: [],
      function: {
        beat: 'rising',
        tension: 7,
        mood: 'tense, adversarial, quietly alarmed',
        stakes: "Sam's ability to trust Ivy — and whatever the north wing hides",
      },
      transformations: {
        compression_recommendation: 'preserve',
        compression_ratio_target: 0.9,
        pacing_notes:
          'let the contradiction land cleanly; hold the beat where Sam registers the reversal',
        dialogue_density: 0.7,
      },
      annotations: {
        user_notes: '',
        author_intent: '',
        flagged_issues: [],
        stale_source: false,
      },
      source: {
        message_range: {
          start: {
            msg_id: 'smoke-msg-3',
            swipe_idx: 0,
            fingerprint: {
              sha: 'bbe34e9e1357520207a56642a8f44be1f0eee0c6c54018c7f2f85f15f28cbda2',
              hash_alg: 'sha256',
              send_date: 1786300180000,
            },
          },
          end: {
            msg_id: 'smoke-msg-5',
            swipe_idx: 0,
            fingerprint: {
              sha: 'baf121c63ce0dd22b38855404eb6ff33d305699a5c82b7ddb596b118b5e105a0',
              hash_alg: 'sha256',
              send_date: 1786300300000,
            },
          },
        },
        total_messages: 3,
        swipe_resolutions: [],
        excluded_segments: [],
      },
    } as unknown as Scene,
    position: 2,
    totalScenes: 3,
    precedingSummary:
      'Sam asks about the closed-off north wing. Ivy states flatly that she keeps it sealed at all times and that nobody has walked it.',
    characters: [ivy()],
    userVoice: null,
    factRows: [
      factRow(
        '85dedbc6-2799-40cf-bc01-08ce675d85ca',
        'Ivy keeps the north wing sealed at all times.',
        '88bdd90b-c399-49c2-b754-7034a5c470ef'
      ),
      factRow(
        '5b379edc-cd89-4c4a-8ba2-bc8094007ee1',
        'Ivy has never sealed the north wing.',
        '88bdd90b-c399-49c2-b754-7034a5c470ef'
      ),
      factRow('92c92ca8-5882-42a2-99d5-f12da5adb326', 'Ivy never leaves the Reach.', null),
    ],
    rules: {
      included: [],
      nonFiring: [],
      caveats: { approximate: false, constantsOnly: true, unresolvedRules: 0 },
    },
    hints: null,
    narrative: null,
  },
};

/**
 * Fixture 2 — the cap.
 *
 * Hand-built to overflow `BRIEF_TOKEN_CAP` so the golden records WHAT gets
 * dropped and in which order. §3.5 forbids a silent drop, and the drop order
 * is the part of the assembler most likely to be changed by accident.
 */
const capOverflow: CalibrationFixture = {
  name: 'cap-overflow',
  description:
    'A fact tail far larger than the cap, so the brief must drop in the stated order and record what it dropped.',
  provenance: 'Hand-built. Not evidence about prose quality.',
  ratedProse: false,
  input: {
    ...ivyLedger.input,
    // Same shape as fixture 1, with a bible-wide fact tail no cap can hold.
    //
    // The count is sized to ACTUALLY overflow `BRIEF_TOKEN_CAP` (24k). The
    // first version of this fixture used 400 facts and the golden came back
    // `drops (0)` — a fixture named for the cap that never reached it, which
    // is precisely the theatre §6 warns about. The golden is what caught it,
    // on the day it was written. If a future cap change makes this stop
    // dropping, the golden will say `drops (0)` again and that IS the alarm.
    factRows: [
      ...ivyLedger.input.factRows,
      ...Array.from({ length: 2000 }, (_, i) =>
        factRow(
          `bulk-${String(i).padStart(4, '0')}`,
          `Background fact ${i}: the Reach keeps ledgers going back nine generations, and this one concerns holding number ${i}, its tenants, its boundary stones and the years its rents went unpaid.`,
          null
        )
      ),
    ],
  },
};

/**
 * Fixture 3 — the first scene.
 *
 * `position: 1` with no preceding summary and no annotation, which is the
 * shape a render of an unannotated bible starts from. Pins that the brief
 * still assembles rather than leaning on fields the first scene never has.
 */
const firstSceneUnannotated: CalibrationFixture = {
  name: 'first-scene-unannotated',
  description:
    'Opening scene, no preceding summary, no beat or transformations — the unannotated path.',
  provenance: 'Hand-built from fixture 1 by clearing the annotation groups.',
  ratedProse: false,
  input: {
    ...ivyLedger.input,
    scene: {
      ...(ivyLedger.input.scene as unknown as Record<string, unknown>),
      function: null,
      transformations: null,
    } as unknown as Scene,
    position: 1,
    precedingSummary: '',
  },
};

/**
 * Fixture 4 — everything the other three leave out.
 *
 * The phase-6 review found that fixtures 1–3 all shared empty rules, a null
 * `userVoice`, null hints and a bare character, so EVERY conditional block
 * in `prosePrompt` was skipped by every golden. A verifier gutted
 * `characterBrief` and deleted the world-rules and author-voice
 * interpolations outright: 129 tests stayed green and all six goldens were
 * byte-identical. A harness whose whole job is catching "what silently
 * stopped reaching the model" would have missed the model being told
 * nothing about who anyone is.
 *
 * So this fixture populates every optional branch at once: a full character
 * (aliases, appearance, traits, register, speech, tics, arc, dialogue
 * examples), world rules, an author voice, and hints that set POV, tense,
 * word count and style anchors. It is deliberately maximal — its golden is
 * the one that fails when any of those stops being sent.
 */
const fullBrief: CalibrationFixture = {
  name: 'full-brief',
  description:
    'Every optional block populated at once: character voice profile, world rules, author voice, and hints setting POV, tense, word count and style anchors.',
  provenance:
    'Hand-built. Exists because the review proved the other fixtures skipped every conditional block in prosePrompt.',
  ratedProse: false,
  input: {
    ...ivyLedger.input,
    characters: [
      {
        id: IVY_ID,
        canonical_name: 'Ivy',
        aliases: ['the Keeper', 'Ives'],
        role: 'protagonist',
        is_user_persona: false,
        background: 'Keeper of the Reach archive for nineteen years.',
        relationships: [],
        physical_description: {
          summary: 'Tall, grey at the temples, ink on the side of her right hand.',
        },
        personality: {
          traits: [{ trait: 'exacting' }, { trait: 'evasive' }, { trait: 'unhurried' }],
          voice_profile: {
            register: 'formal, clipped',
            speech_patterns: 'Answers the question asked and no more.',
            verbal_tics: ['"As you like."', 'repeats a denial verbatim rather than rephrasing'],
            dialogue_examples: [
              { text: 'The archive does not run itself.' },
              { text: "You've misread it." },
            ],
          },
        },
        arc: { current_state: 'Cornered by her own contradictory answers.' },
      } as unknown as BibleCharacter,
    ],
    rules: {
      included: [
        {
          id: 'rule-1',
          text: 'The Reach archive is sealed to outsiders after dark.',
          category: 'social',
          established_in: null,
        },
        {
          id: 'rule-2',
          text: 'Ledgers record intent to enter, not entry itself.',
          category: 'social',
          established_in: null,
        },
      ] as unknown as WorldRule[],
      nonFiring: [
        { id: 'rule-3', text: 'Boundary stones are re-cut every ninth year.' },
      ] as unknown as WorldRule[],
      caveats: { approximate: true, constantsOnly: false, unresolvedRules: 2 },
    },
    userVoice: {
      style_summary: 'Spare, concrete, dialogue-forward. Trusts the reader to infer.',
      register: 'literary',
      rhetorical_devices: ['understatement', 'repetition with variation'],
      diction: {
        sentence_length: { distribution: 'short, with occasional long compound' },
        paragraph_density: 'sparse',
        preferred_vocabulary: ['ledger', 'threshold', 'quiet'],
        avoided_vocabulary: ['suddenly', 'very'],
      },
      pov_preferences: {},
      interaction_style: {},
      sample_passages: [],
      confidence: 0.8,
    } as unknown as AssembleInput['userVoice'],
    hints: {
      pov: 'third_limited',
      pov_character: IVY_ID,
      tense: 'past',
      chapter_breaks: [],
      chapter_titles: [],
      compression_level: 'tight',
      target_word_count: 60000,
      style_anchors: ['no dream sequences', 'sparse, concrete description'],
    },
  },
};

export const CALIBRATION_FIXTURES: CalibrationFixture[] = [
  ivyLedger,
  capOverflow,
  firstSceneUnannotated,
  fullBrief,
];
