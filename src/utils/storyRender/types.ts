// Render engine types (productization step 3, phase 3).
//
// The renderer turns a locked bible into novel prose. Everything in this
// directory is PURE and NETWORK-FREE — the transcript, the lorebook
// entries and every bible section arrive as parameters, and the store
// (phase 4) owns fetching them. That is the same split that made step 2's
// ingestion passes unit-testable without a network, repeated deliberately.

import type {
  BibleCharacter,
  BibleFact,
  RenderPov,
  RenderingHintsSection,
  Scene,
  Tense,
  UserVoiceSection,
  WorldRule,
} from '../../types/storyBible';

/** The novel hints a run is configured with, already resolved against
 *  `narrative`'s defaults (plan §3.5: "`narrative.pov_default` /
 *  `tense_default` and the resolved `rendering_hints.novel`"). */
export interface ResolvedNovelHints {
  pov: RenderPov | null;
  povCharacterId: string | null;
  tense: Tense | null;
  compressionLevel: RenderingHintsSection['novel']['compression_level'];
  targetWordCount: number | null;
  styleAnchors: string[];
}

/**
 * Something the cap left out.
 *
 * Never silent, by §3.5's own rule: "Everything past the cap is dropped in
 * a stated priority order, and the drop is surfaced in the UI and logged
 * — never silent." The store carries these to the run's notes, the same
 * way ingestion surfaces its unreadable chunks.
 */
export interface BriefDrop {
  kind:
    | 'unattributed_facts'
    | 'other_scene_facts'
    | 'preceding_summary'
    | 'dialogue_examples'
    /** The last resort, beyond §3.5's stated five: firing rules trimmed
     *  from the tail because the core plus every firing rule still
     *  exceeded the cap. Reported like any other drop rather than
     *  returning an over-cap brief in silence. */
    | 'firing_rules';
  /** How many items of this kind were dropped. `1` for the singular
   *  preceding-summary case. */
  count: number;
}

/** Why the world rules in a brief are only an approximation of what the
 *  story was actually played under. Carried through to the UI rather than
 *  asserted as fact — `wiReplay` documents the same caveat. */
export interface RuleSelectionCaveats {
  /** Probability rolls were re-rolled and sticky/cooldown state was never
   *  recorded, so a "firing" entry is "could have fired". */
  approximate: boolean;
  /** The scene has no AI turn, so the scanner fires nothing for it and
   *  only `constant` entries reach the brief. */
  constantsOnly: boolean;
  /** Rules whose lorebook entry could not be found in the CURRENT book
   *  set — detached, deleted, or edited since the story was played. Their
   *  `constant` flag is therefore unknowable, so they cannot be included
   *  by the constants floor. */
  unresolvedRules: number;
}

export interface SelectedRules {
  /** Entry fired against this scene's window, or is an active `constant`. */
  included: WorldRule[];
  /**
   * Everything else. EXCLUDED from the brief, not merely deprioritised.
   *
   * Including these when there is room would make the selector a no-op for
   * every bible that fits under the cap — which is exactly the "all rules
   * up to a cap, arbitrary truncation dressed as selection" that §3.5 was
   * rewritten to escape. Kept here so the count can be surfaced as a
   * SELECTION fact ("N rules were not active in this scene") rather than
   * as a cap drop.
   */
  nonFiring: WorldRule[];
  caveats: RuleSelectionCaveats;
}

/**
 * The scene's fact set — a THREE-way union (plan §3.5).
 *
 * Kept as three lists rather than one merged array because the cap drops
 * them at different priorities: the bible-wide unattributed tail goes
 * before the scene-attributed extras, which go before the scene's own.
 */
export interface SceneFactSet {
  /** `scene.continuity_facts_established`, resolved to rows. */
  own: BibleFact[];
  /** Facts whose `established_in === scene.id` but which the scene's own
   *  index does not list. */
  sceneAttributed: BibleFact[];
  /** Every live fact with `established_in: null` — bible-wide canon the
   *  first two exclude BY CONSTRUCTION, and the claims prose is most
   *  likely to contradict. */
  unattributed: BibleFact[];
}

/** What the prose call receives. Every field is already capped. */
export interface RenderBrief {
  scene: Scene;
  /** 1-based position and total, for the model's sense of place. */
  position: number;
  totalScenes: number;
  precedingSummary: string;
  participants: BibleCharacter[];
  userVoice: UserVoiceSection | null;
  facts: SceneFactSet;
  rules: WorldRule[];
  hints: ResolvedNovelHints;
  caveats: RuleSelectionCaveats;
  /** Everything the cap left out, in the order it was dropped. */
  drops: BriefDrop[];
  /** Rules the SELECTOR excluded because their entry did not fire against
   *  this scene's window. Not a cap drop — reported separately so the UI
   *  can distinguish "not relevant here" from "did not fit". */
  rulesNotActive: number;
  /** Estimated tokens for the assembled brief, after capping. */
  estimatedTokens: number;
}

/**
 * The assembler refuses rather than silently rendering a partial brief.
 *
 * §3.5: "if [the mandatory core] alone exceeds the cap the run refuses
 * with a named error rather than silently rendering a partial brief."
 */
export interface BriefRefusal {
  refused: true;
  reason: 'core_exceeds_cap';
  /** What the mandatory core alone came to, so the message can say by how
   *  much rather than just "too big". */
  coreTokens: number;
  capTokens: number;
}

export type AssembledBrief = RenderBrief | BriefRefusal;

export function isRefusal(brief: AssembledBrief): brief is BriefRefusal {
  return (brief as BriefRefusal).refused === true;
}

/** One continuity finding against the produced prose (plan §3.4: the
 *  second call reads the prose against the scene's fact set and returns
 *  structured verdicts — it never rewrites). */
export interface ContinuityVerdict {
  /** The fact this contradicts, when the model named one we recognize. */
  factId: string | null;
  /** What the prose says that cannot be true. */
  claim: string;
  /** What canon says instead. */
  canon: string;
  severity: 'minor' | 'major';
}
