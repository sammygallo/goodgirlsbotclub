// Context assembly for one scene's prose call (plan §3.5).
//
// Pure and network-free: the transcript, the lorebook entries and every
// bible section arrive as parameters. Phase 4's store fetches them.

import { estimateTokens } from '../tokenizer';
import { isFactTombstone } from '../../types/storyBible';
import type {
  BibleCharacter,
  BibleFact,
  NarrativeSection,
  RenderingHintsSection,
  Scene,
  UserVoiceSection,
  WorldRule,
} from '../../types/storyBible';
import type { StoryLogEntry } from '../../api/client';
import type {
  AssembledBrief,
  BriefDrop,
  ResolvedNovelHints,
  SceneFactSet,
  SelectedRules,
} from './types';

/**
 * The assembled brief's ceiling, in estimated tokens.
 *
 * A number and an order are what make the cap testable without a model,
 * which is why the plan states both rather than leaving "fits in context"
 * to a runtime failure. Estimated on the same basis as the rest of the
 * fuel gauge — a tokenizer profile, not the provider's accounting.
 */
export const BRIEF_TOKEN_CAP = 24_000;

/**
 * What gets dropped first when the brief is over cap.
 *
 * Stated in the plan and reproduced here in evaluation order, because the
 * order IS the design: the cheapest-to-lose context goes first, and the
 * mandatory core is never in this list at all.
 */
const DROP_ORDER: BriefDrop['kind'][] = [
  'unattributed_facts',
  'other_scene_facts',
  'preceding_summary',
  'dialogue_examples',
];

/**
 * The last resort, BEYOND the plan's stated order.
 *
 * §3.5 lists five droppable categories and a mandatory core, and gives
 * the assembler exactly two escape hatches: drop in priority order, or
 * refuse. Firing rules are in neither list — they are not core, and they
 * are not in the drop order — which left a third, forbidden outcome: a
 * brief returned OVER cap with `drops: []` and no refusal.
 *
 * That is reachable on ordinary data, not corruption. Cold start's
 * `WORLD_RULE_BYTE_BUDGET` is 180KB, and every `constant` entry's rule is
 * included unconditionally, so a large always-on lorebook fills this
 * category with hundreds of rules — measured at 44k and 65k tokens
 * against a 24k cap in review.
 *
 * So firing rules ARE droppable, last, and partially: as many as fit are
 * kept and the count dropped is reported like any other. Trimming beats
 * refusing here — a scene rendered with most of its world rules is worth
 * having, where a refusal is worth nothing.
 */
const FIRING_RULES_DROP: BriefDrop['kind'] = 'firing_rules';

export interface AssembleInput {
  scene: Scene;
  position: number;
  totalScenes: number;
  /** The preceding scene's `detailed_summary`, or '' for the first. */
  precedingSummary: string;
  /** `entities.characters`. Only the scene's participants are used. */
  characters: BibleCharacter[];
  userVoice: UserVoiceSection | null;
  /** Every fact log ROW, tombstones included — this module filters them.
   *  `_read_log_page` never applies `_fact_is_live()`, so phase 10's
   *  tombstones do come back in the page. */
  factRows: StoryLogEntry[];
  /** Output of `selectWorldRules`. */
  rules: SelectedRules;
  hints: RenderingHintsSection['novel'] | null;
  narrative: NarrativeSection | null;
  capTokens?: number;
}

/** Resolve the novel hints against `narrative`'s canonical defaults.
 *  `rendering_hints.novel` overrides only where it is actually set (the
 *  schema's own D4 note), so a null POV there falls through rather than
 *  overriding a real default with nothing. */
export function resolveHints(
  hints: RenderingHintsSection['novel'] | null | undefined,
  narrative: NarrativeSection | null | undefined
): ResolvedNovelHints {
  return {
    pov: hints?.pov ?? narrative?.pov_default ?? null,
    povCharacterId: hints?.pov_character ?? null,
    tense: hints?.tense ?? narrative?.tense_default ?? null,
    compressionLevel: hints?.compression_level ?? 'balanced',
    targetWordCount: hints?.target_word_count ?? null,
    styleAnchors: hints?.style_anchors ?? [],
  };
}

/** Parse one fact log row, skipping tombstones and unshaped rows. */
function readFact(row: StoryLogEntry): BibleFact | null {
  const data = row?.data as Record<string, unknown> | undefined;
  if (isFactTombstone(data)) return null;
  if (!data || typeof data !== 'object') return null;
  const id = typeof data.id === 'string' ? data.id : row?.id;
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!id || !text) return null;
  return {
    id,
    text,
    category: (data.category ?? 'reveal') as BibleFact['category'],
    established_in:
      typeof data.established_in === 'string' ? data.established_in : null,
    source: (data.source ?? null) as BibleFact['source'],
    confidence: (data.confidence ?? 'explicit') as BibleFact['confidence'],
  };
}

/**
 * The scene's fact set: a THREE-way union (plan §3.5).
 *
 * The third member is the one that has to be spelled out. The first two
 * exclude null-attributed facts BY CONSTRUCTION —
 * `continuity_facts_established` is only ever pushed for facts the walk
 * mints with `established_in: sceneId`, and the server-side scene filter
 * excludes them too. That tail is `reconcileJudge`'s card-conflict facts
 * and the user's own "write my own" resolutions: bible-wide canon, and
 * the foundational claims prose is most likely to contradict.
 *
 * World rules are NOT in this set — they are `world.rules` entries, never
 * `story_facts` rows, and reach the brief only through the rule selector.
 */
export function buildFactSet(scene: Scene, factRows: StoryLogEntry[]): SceneFactSet {
  const live: BibleFact[] = [];
  for (const row of factRows) {
    const fact = readFact(row);
    if (fact) live.push(fact);
  }
  const byId = new Map(live.map((f) => [f.id, f]));
  const ownIds = new Set(scene.continuity_facts_established ?? []);

  const own: BibleFact[] = [];
  for (const id of ownIds) {
    const fact = byId.get(id);
    // A listed id with no live row is a fact the user deleted since the
    // walk indexed it. Skipped, not rendered as a blank.
    if (fact) own.push(fact);
  }

  const sceneAttributed: BibleFact[] = [];
  const unattributed: BibleFact[] = [];
  for (const fact of live) {
    if (ownIds.has(fact.id)) continue;
    if (fact.established_in === scene.id) sceneAttributed.push(fact);
    else if (fact.established_in === null) unattributed.push(fact);
  }

  return { own, sceneAttributed, unattributed };
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function factTokens(facts: BibleFact[]): number {
  return facts.reduce((n, f) => n + estimateTokens(f.text) + 4, 0);
}

function ruleTokens(rules: WorldRule[]): number {
  return rules.reduce((n, r) => n + estimateTokens(r.text) + 4, 0);
}

/** A character MINUS dialogue examples — part of the mandatory core. */
function characterCoreTokens(c: BibleCharacter): number {
  const voice = c.personality?.voice_profile;
  return (
    estimateTokens(c.canonical_name) +
    estimateTokens((c.aliases ?? []).join(', ')) +
    estimateTokens(c.background ?? '') +
    estimateTokens(c.physical_description?.summary ?? '') +
    estimateTokens(voice?.speech_patterns ?? '') +
    estimateTokens((voice?.verbal_tics ?? []).join(', ')) +
    estimateTokens((c.personality?.traits ?? []).map((t) => t.trait).join(', ')) +
    estimateTokens(c.arc?.current_state ?? '') +
    16
  );
}

function dialogueExampleTokens(characters: BibleCharacter[]): number {
  return characters.reduce(
    (n, c) =>
      n +
      (c.personality?.voice_profile?.dialogue_examples ?? []).reduce(
        (m, d) => m + estimateTokens(d.text) + 4,
        0
      ),
    0
  );
}

/** Every access is optional, deliberately. Sections cross the network as
 *  `Record<string, unknown>` and are cast, so a body written by an older
 *  build — or a half-written one — reaches here shaped differently than
 *  the type claims. A sizer that throws would fail the whole render on a
 *  field it was only trying to measure. */
function userVoiceTokens(v: UserVoiceSection | null): number {
  if (!v) return 0;
  return (
    estimateTokens(v.style_summary ?? '') +
    estimateTokens((v.rhetorical_devices ?? []).join(', ')) +
    estimateTokens((v.diction?.preferred_vocabulary ?? []).join(', ')) +
    estimateTokens((v.diction?.avoided_vocabulary ?? []).join(', ')) +
    24
  );
}

function sceneTokens(scene: Scene): number {
  return (
    estimateTokens(scene.title) +
    estimateTokens(scene.summary) +
    estimateTokens(scene.detailed_summary) +
    estimateTokens(scene.setting?.atmosphere ?? '') +
    32
  );
}

function hintsTokens(hints: ResolvedNovelHints): number {
  return estimateTokens(hints.styleAnchors.join(', ')) + 48;
}

/**
 * Assemble one scene's brief, capped.
 *
 * Returns a `BriefRefusal` when the MANDATORY CORE alone busts the cap.
 * The core is the target scene, the participants' records minus their
 * dialogue examples, `user_voice` and the hints — §3.5 says it is never
 * dropped, so the only honest alternative to refusing is silently
 * rendering a scene the model cannot see all of.
 */
export function assembleRenderBrief(input: AssembleInput): AssembledBrief {
  const cap = input.capTokens ?? BRIEF_TOKEN_CAP;
  const hints = resolveHints(input.hints, input.narrative);

  const participantIds = new Set(input.scene.participants ?? []);
  const participants = input.characters.filter((c) => participantIds.has(c.id));

  const facts = buildFactSet(input.scene, input.factRows);

  // --- the mandatory core, sized first ---------------------------------
  const coreTokens =
    sceneTokens(input.scene) +
    participants.reduce((n, c) => n + characterCoreTokens(c), 0) +
    userVoiceTokens(input.userVoice) +
    hintsTokens(hints) +
    // The scene's OWN facts are core: a scene rendered without the facts
    // it established is the one case where the continuity checker is
    // guaranteed to fire on the renderer's own omission.
    factTokens(facts.own);

  if (coreTokens > cap) {
    return { refused: true, reason: 'core_exceeds_cap', coreTokens, capTokens: cap };
  }

  // --- everything else, dropped in the stated order ---------------------
  const optional = {
    unattributed_facts: facts.unattributed,
    other_scene_facts: facts.sceneAttributed,
    preceding_summary: input.precedingSummary,
    dialogue_examples: participants,
  };

  const sizeOf = (kind: BriefDrop['kind']): number => {
    switch (kind) {
      case 'unattributed_facts':
        return factTokens(optional.unattributed_facts);
      case 'other_scene_facts':
        return factTokens(optional.other_scene_facts);
      case 'preceding_summary':
        return estimateTokens(optional.preceding_summary);
      case 'dialogue_examples':
        return dialogueExampleTokens(optional.dialogue_examples);
      case 'firing_rules':
        // Sized and trimmed separately below — it is not a DROP_ORDER
        // member, so this arm is unreachable from the loop. Present only
        // to keep the switch exhaustive over BriefDrop['kind'].
        return 0;
    }
  };

  const countOf = (kind: BriefDrop['kind']): number => {
    switch (kind) {
      case 'unattributed_facts':
        return optional.unattributed_facts.length;
      case 'other_scene_facts':
        return optional.other_scene_facts.length;
      case 'preceding_summary':
        return optional.preceding_summary.trim() ? 1 : 0;
      case 'dialogue_examples':
        return optional.dialogue_examples.reduce(
          (n, c) =>
            n + (c.personality?.voice_profile?.dialogue_examples ?? []).length,
          0
        );
      case 'firing_rules':
        return 0;
    }
  };

  // Firing rules are dropped LAST — after every optional category — but
  // they ARE dropped. They are what the selector exists to find, so they
  // outrank the five categories above; they are not core, so they cannot
  // be allowed to bust the cap in silence.
  let total = coreTokens + ruleTokens(input.rules.included);
  for (const kind of DROP_ORDER) total += sizeOf(kind);

  const drops: BriefDrop[] = [];
  const dropped = new Set<BriefDrop['kind']>();
  for (const kind of DROP_ORDER) {
    if (total <= cap) break;
    const size = sizeOf(kind);
    const count = countOf(kind);
    total -= size;
    dropped.add(kind);
    // A kind that was empty anyway is not a "drop" worth reporting — it
    // would tell the user something was left out when nothing was.
    if (count > 0) drops.push({ kind, count });
  }

  // Still over after everything optional is gone: trim firing rules from
  // the tail until the brief fits. `coreTokens <= cap` is already
  // guaranteed by the refusal above, so this terminates with room to
  // spare rather than looping to empty in the normal case.
  let includedRules = input.rules.included;
  if (total > cap && includedRules.length > 0) {
    const kept = [...includedRules];
    while (total > cap && kept.length > 0) {
      const gone = kept.pop() as WorldRule;
      total -= estimateTokens(gone.text) + 4;
    }
    const droppedCount = includedRules.length - kept.length;
    includedRules = kept;
    if (droppedCount > 0) drops.push({ kind: FIRING_RULES_DROP, count: droppedCount });
  }

  return {
    scene: input.scene,
    position: input.position,
    totalScenes: input.totalScenes,
    precedingSummary: dropped.has('preceding_summary') ? '' : input.precedingSummary,
    participants: dropped.has('dialogue_examples')
      ? participants.map(stripDialogueExamples)
      : participants,
    userVoice: input.userVoice,
    facts: {
      own: facts.own,
      sceneAttributed: dropped.has('other_scene_facts') ? [] : facts.sceneAttributed,
      unattributed: dropped.has('unattributed_facts') ? [] : facts.unattributed,
    },
    // Firing (and active-constant) rules ONLY. A non-firing rule is
    // excluded by the selector, never re-added when there happens to be
    // room — that would make the selector a no-op on any bible under the
    // cap, which is the arbitrary truncation §3.5 exists to replace.
    rules: includedRules,
    hints,
    caveats: input.rules.caveats,
    drops,
    rulesNotActive: input.rules.nonFiring.length,
    estimatedTokens: total,
  };
}

function stripDialogueExamples(c: BibleCharacter): BibleCharacter {
  if (!c.personality?.voice_profile) return c;
  return {
    ...c,
    personality: {
      ...c.personality,
      voice_profile: { ...c.personality.voice_profile, dialogue_examples: [] },
    },
  };
}
