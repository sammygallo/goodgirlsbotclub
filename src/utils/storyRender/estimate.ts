// Preflight estimate for a render run (productization step 3, phase 5).
//
// Plan §6's first mitigation: "Preflight token estimate before any spend."
// Pure and network-free like the rest of this directory — the Render tab
// already holds every input by the time it can offer a range, so this
// costs a pass of string length arithmetic and no requests at all.
//
// It runs the REAL assembler over the REAL range rather than multiplying a
// per-scene guess. That matters more than it looks: the assembler is what
// applies the 24k cap, drops optional context in priority order and
// refuses a scene whose mandatory core alone busts the cap (§3.5). An
// estimate that skipped it would quote the uncapped size of a brief the
// run will never send, and would promise output for scenes the run is
// going to refuse.

import { estimateTokens } from '../tokenizer';
import { assembleRenderBrief } from './contextAssembler';
import { selectWorldRules, sceneWindow } from './ruleSelector';
import { CONTINUITY_MAX_TOKENS, PROSE_MAX_TOKENS } from './renderScene';
import { isRefusal } from './types';
import type { StoryLogEntry, StorySceneOut } from '../../api/client';
import type { ReplayEntry } from '../storyIngest/wiReplay';
import type { IngestMessage } from '../storyIngest/types';
import type {
  BibleCharacter,
  NarrativeSection,
  RenderingHintsSection,
  Scene,
  UserVoiceSection,
  WorldRule,
} from '../../types/storyBible';

export interface RenderEstimateInput {
  /** Every scene row in sequence order — the same list `start` resolves
   *  its range against, so the two cannot disagree about what is included. */
  scenes: StorySceneOut[];
  sceneIdStart: string;
  sceneIdEnd: string;
  factRows: StoryLogEntry[];
  characters: BibleCharacter[];
  worldRules: WorldRule[];
  userVoice: UserVoiceSection | null;
  hints: RenderingHintsSection['novel'] | null;
  narrative: NarrativeSection | null;
  messages: IngestMessage[];
  wiEntries: ReplayEntry[];
  wiScanDepth?: number;
}

export interface RenderEstimate {
  /** Scenes in the range, refusals included. */
  scenes: number;
  /**
   * Prompt tokens, summed over both calls per scene.
   *
   * The continuity call's prompt carries the produced prose, which does
   * not exist yet, so it is priced at the prose call's own output ceiling
   * — the largest it can be.
   */
  inputTokens: number;
  /** A CEILING, not a prediction: both calls cap their output, and prose
   *  usually stops well short. Presented as "up to" for that reason. */
  maxOutputTokens: number;
  /** `inputTokens + maxOutputTokens` — the worst case for the range. */
  total: number;
  /** Scenes the assembler will refuse outright (`core_exceeds_cap`). They
   *  cost nothing and produce nothing, and the tab says so rather than
   *  letting the user discover it one scene into a paid run. */
  refusedScenes: number;
  /** Scenes whose optional context the 24k cap will trim. §3.5 forbids a
   *  silent drop, and a preflight is the earliest place to say it. */
  scenesWithDrops: number;
  /** Rules the SELECTOR excluded as not active in their scene — summed
   *  across the range. Not a cap drop; reported separately, as §3.5 asks. */
  rulesNotActive: number;
  /** Scenes whose message range could not be located in the transcript, so
   *  the scanner saw an empty window and only constants reached the brief.
   *  A render still runs; it is just working from less than it looks. */
  scenesWithoutWindow: number;
}

/** The three-way fact union as the continuity call will send it. Priced
 *  from the brief's OWN fact set, which is the capped one. */
function factTokens(facts: { text: string }[]): number {
  return facts.reduce((n, f) => n + estimateTokens(f.text) + 4, 0);
}

/**
 * Resolve the inclusive scene range, or null when either anchor is
 * missing. Mirrors `storyRenderStore.start`'s own resolution exactly —
 * including the `(sequence, id)` sort — so an estimate is never computed
 * over a different span than the run will use.
 */
export function resolveSceneRange(
  scenes: StorySceneOut[],
  sceneIdStart: string,
  sceneIdEnd: string
): StorySceneOut[] | null {
  const ordered = [...scenes].sort(
    (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)
  );
  const startIdx = ordered.findIndex((s) => s.id === sceneIdStart);
  const endIdx = ordered.findIndex((s) => s.id === sceneIdEnd);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return null;
  return ordered.slice(startIdx, endIdx + 1);
}

export function estimateRenderRun(
  input: RenderEstimateInput
): RenderEstimate | null {
  const ordered = [...input.scenes].sort(
    (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)
  );
  const range = resolveSceneRange(ordered, input.sceneIdStart, input.sceneIdEnd);
  if (!range) return null;

  const offset = ordered.findIndex((s) => s.id === range[0].id);

  let inputTokens = 0;
  let maxOutputTokens = 0;
  let refusedScenes = 0;
  let scenesWithDrops = 0;
  let rulesNotActive = 0;
  let scenesWithoutWindow = 0;

  for (let i = 0; i < range.length; i++) {
    const row = range[i];
    const scene = row.data as unknown as Scene;
    // Position and preceding summary are read from the WHOLE list, not
    // from the range: `driveRender` does the same, because scene 12's
    // predecessor is scene 11 whether or not 11 is in the range, and the
    // preceding summary is a real slice of the brief's token budget.
    const absolute = offset + i;
    const previous =
      absolute > 0 ? (ordered[absolute - 1].data as unknown as Scene) : null;

    const window = sceneWindow(
      input.messages,
      scene.source.message_range.start.msg_id,
      scene.source.message_range.end.msg_id,
      input.wiScanDepth
    );
    if (window.length === 0) scenesWithoutWindow++;

    const rules = selectWorldRules({
      rules: input.worldRules,
      entries: input.wiEntries,
      window,
      scanDepth: input.wiScanDepth,
    });

    const brief = assembleRenderBrief({
      scene,
      position: absolute + 1,
      totalScenes: ordered.length,
      precedingSummary: previous?.detailed_summary ?? '',
      characters: input.characters,
      userVoice: input.userVoice,
      factRows: input.factRows,
      rules,
      hints: input.hints,
      narrative: input.narrative,
    });

    if (isRefusal(brief)) {
      refusedScenes++;
      continue;
    }

    if (brief.drops.length > 0) scenesWithDrops++;
    rulesNotActive += brief.rulesNotActive;

    const facts = [
      ...brief.facts.own,
      ...brief.facts.sceneAttributed,
      ...brief.facts.unattributed,
    ];
    inputTokens += brief.estimatedTokens;
    inputTokens += PROSE_MAX_TOKENS + factTokens(facts);
    maxOutputTokens += PROSE_MAX_TOKENS + CONTINUITY_MAX_TOKENS;
  }

  return {
    scenes: range.length,
    inputTokens,
    maxOutputTokens,
    total: inputTokens + maxOutputTokens,
    refusedScenes,
    scenesWithDrops,
    rulesNotActive,
    scenesWithoutWindow,
  };
}
