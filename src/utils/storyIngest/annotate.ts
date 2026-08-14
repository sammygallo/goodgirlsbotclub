// Annotate pass (story-state step 3, phase 2, pass "annotate").
//
// One model call per scene, filling the two field groups step 2 modelled
// and deliberately left empty — `scenes[].function` (beat, tension, mood,
// stakes) and `scenes[].transformations` (compression recommendation and
// ratio, pacing notes, dialogue density) — plus one bible-wide call
// filling `narrative.structure`.
//
// It ships BEFORE the renderer and as its own pass (plan §3.3) so a user
// can read the beat map and correct it before spending render tokens on a
// wrong reading, and so a re-render never re-pays for annotation.
//
// Kept network-free like coldStart.ts / transcriptWalk.ts / wiReplay.ts:
// everything here takes data and an `llm` callback and returns data. The
// store owns scene reads, the write-back and the checkpoint, which is what
// keeps this module unit-testable with a fake LLM.

import { deterministicUuid } from '../storyBible/sourceRefs';
import {
  ANNOTATE_REPAIR_INSTRUCTION,
  ANNOTATE_SYSTEM,
  STRUCTURE_REPAIR_INSTRUCTION,
  STRUCTURE_SYSTEM,
  annotatePrompt,
  firstJsonObject,
  structurePrompt,
} from './prompts';
import {
  STALE_ANNOTATION_FLAG,
  type Act,
  type NarrativeSection,
  type NarrativeStructure,
  type Scene,
  type SceneFunction,
  type SceneTransformations,
} from '../../types/storyBible';
import type { LlmCall } from './types';

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Rough per-scene cost: the system prompt, the scene's summaries, its
 *  fact excerpt and the small JSON answer. Measured against the prompt
 *  shapes above rather than derived from a real bible, so it is a
 *  ballpark — which is all the preflight claims it is. */
const ANNOTATE_TOKENS_PER_SCENE = 700;
/** The one bible-wide structure call: a line per scene plus its answer. */
const STRUCTURE_CALL_TOKENS = 900;

/**
 * Preflight estimate for an annotate run, in tokens.
 *
 * Deliberately an UPPER bound over `sceneCount`: the caller (the Story
 * tab) knows how many scenes exist but not how many still need
 * annotating — that needs the full rows, which only the run itself
 * fetches. Quoting the whole-bible figure and saying already-annotated
 * scenes are skipped is honest in the direction that cannot surprise
 * someone spending their own money.
 *
 * Same basis and the same caveat as `estimateColdStartTokens`: a
 * tokenizer profile, not the provider's accounting.
 */
export function estimateAnnotateTokens(sceneCount: number): number {
  if (sceneCount <= 0) return 0;
  return sceneCount * ANNOTATE_TOKENS_PER_SCENE + STRUCTURE_CALL_TOKENS;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Whether this scene still needs the annotate pass.
 *
 * Three cases, and the third is what makes the pass self-healing rather
 * than one-shot: a scene the transcript walk re-emitted with an EXTENDED
 * message range keeps its annotation (plan §3.9a) but carries
 * `STALE_ANNOTATION_FLAG`, because its beat and compression target were
 * computed for less material than it now holds.
 *
 * Both halves are checked independently — a run that died between the two
 * writes is not a thing that can happen (one PUT carries both), but a
 * hand-edited or older row can legitimately carry one and not the other.
 */
export function needsAnnotation(scene: Scene): boolean {
  return (
    !scene.function ||
    !scene.transformations ||
    (scene.annotations?.flagged_issues ?? []).includes(STALE_ANNOTATION_FLAG)
  );
}

// ---------------------------------------------------------------------------
// Normalizers — same discipline as transcriptWalk's: every one fails
// toward a STATED fallback rather than toward inventing structure, and
// every fallback is documented where it is chosen, not buried in a `??`.
// ---------------------------------------------------------------------------

const BEATS: SceneFunction['beat'][] = [
  'inciting',
  'rising',
  'midpoint',
  'crisis',
  'climax',
  'denouement',
  'interlude',
];

const COMPRESSIONS: SceneTransformations['compression_recommendation'][] = [
  'cut',
  'compress',
  'preserve',
  'expand',
];

const STRUCTURE_TYPES: NarrativeStructure['detected_type'][] = [
  'three_act',
  'kishotenketsu',
  'episodic',
  'slice_of_life',
  'none_yet',
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** A finite number or null — `NaN`/`Infinity` reach the backend's
 *  `allow_inf_nan=False` fields as a 422 that fails the whole scene write,
 *  so they are dropped here rather than passed through. */
function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function shortString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** The ratio to assume when the model gave a recommendation but no usable
 *  number. Deliberately NOT 0 (the schema default): 0 tells the renderer
 *  to keep none of the scene, so a missing field would silently delete
 *  content rather than fail. */
const RATIO_FOR: Record<SceneTransformations['compression_recommendation'], number> = {
  cut: 0.15,
  compress: 0.5,
  preserve: 1,
  expand: 1,
};

/** Assumed when the model omits `dialogue_density`. Neither extreme is
 *  safe to guess — 0 tells the renderer the scene is pure narration and 1
 *  that it is pure dialogue — so an even split is the honest "unknown". */
const DEFAULT_DIALOGUE_DENSITY = 0.5;

export interface SceneAnnotation {
  function: SceneFunction;
  transformations: SceneTransformations;
}

/**
 * Parse one annotate response.
 *
 * Returns null when the object carries NEITHER a valid beat NOR a usable
 * tension: an empty `{}` would otherwise normalize into a confident
 * "rising, tension 5, preserve" that reads exactly like a real annotation.
 * A pass whose answer could not be read must say so (the store surfaces
 * the count), not manufacture one.
 */
export function parseAnnotation(obj: Record<string, unknown> | null): SceneAnnotation | null {
  if (!obj) return null;

  const rawBeat = typeof obj.beat === 'string' ? obj.beat.trim().toLowerCase() : '';
  const beat = BEATS.includes(rawBeat as SceneFunction['beat'])
    ? (rawBeat as SceneFunction['beat'])
    : null;
  const rawTension = finiteNumber(obj.tension);
  if (beat === null && rawTension === null) return null;

  const recommendation = (() => {
    const raw =
      typeof obj.compression_recommendation === 'string'
        ? obj.compression_recommendation.trim().toLowerCase()
        : '';
    return COMPRESSIONS.includes(raw as SceneTransformations['compression_recommendation'])
      ? (raw as SceneTransformations['compression_recommendation'])
      : 'preserve';
  })();
  const rawRatio = finiteNumber(obj.compression_ratio_target);
  const rawDensity = finiteNumber(obj.dialogue_density);

  return {
    function: {
      // 'rising' is the generic ongoing beat: it is the one value that
      // claims nothing structural about the scene's place in the story.
      beat: beat ?? 'rising',
      // The backend's range is 1–10 inclusive, so a 0 (or a 7.4) is
      // clamped rather than rejected — the model reached for a scale.
      tension: rawTension === null ? 5 : Math.round(clamp(rawTension, 1, 10)),
      mood: shortString(obj.mood, 120),
      stakes: shortString(obj.stakes, 300),
    },
    transformations: {
      compression_recommendation: recommendation,
      compression_ratio_target:
        rawRatio === null ? RATIO_FOR[recommendation] : clamp(rawRatio, 0, 1),
      pacing_notes: shortString(obj.pacing_notes, 500),
      dialogue_density:
        rawDensity === null ? DEFAULT_DIALOGUE_DENSITY : clamp(rawDensity, 0, 1),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-scene call
// ---------------------------------------------------------------------------

export interface AnnotateSceneParams {
  scene: Scene;
  /** 1-based position and total, for the model's sense of where in the
   *  story this sits. Taken from the caller rather than `scene.sequence`,
   *  which is sparse after a merge deletes a row. */
  position: number;
  totalScenes: number;
  /** The preceding scene's `detailed_summary`, or '' for the first. */
  previousSummary: string;
  /** Texts of the facts this scene establishes. Scenes store message ids,
   *  never message text, so this is the closest thing to the scene's own
   *  content that the bible holds. */
  factTexts: string[];
  llm: LlmCall;
  signal?: AbortSignal;
}

export interface AnnotateSceneOutcome {
  annotation: SceneAnnotation | null;
  /** True when even the repair retry failed to yield a usable object. The
   *  scene is left unannotated rather than aborting the pass — surfaced to
   *  the user as "N scenes could not be read" (no silent caps). */
  parseFailed: boolean;
  llmCalls: number;
}

/** Fact texts sent per scene. Enough to characterize what a scene does
 *  without turning a per-scene call into a bible-wide one. */
const FACT_EXCERPT_LIMIT = 25;

export async function annotateScene(
  params: AnnotateSceneParams
): Promise<AnnotateSceneOutcome> {
  const { scene, llm, signal } = params;

  const excerpt = params.factTexts
    .slice(0, FACT_EXCERPT_LIMIT)
    .map((t) => `- ${t}`)
    .join('\n');

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: ANNOTATE_SYSTEM },
    {
      role: 'user',
      content: annotatePrompt({
        title: scene.title,
        sequence: params.position - 1,
        totalScenes: params.totalScenes,
        previousSummary: params.previousSummary.slice(0, 2000),
        summary: scene.summary.slice(0, 2000),
        detailedSummary: scene.detailed_summary.slice(0, 6000),
        excerpt,
      }),
    },
  ];

  let llmCalls = 0;
  let raw = await llm(messages, { maxTokens: 500, signal });
  llmCalls++;
  let annotation = parseAnnotation(firstJsonObject(raw));

  if (!annotation) {
    raw = await llm(
      [
        ...messages,
        { role: 'assistant' as const, content: raw },
        { role: 'user' as const, content: ANNOTATE_REPAIR_INSTRUCTION },
      ],
      { maxTokens: 500, signal }
    );
    llmCalls++;
    annotation = parseAnnotation(firstJsonObject(raw));
  }

  return { annotation, parseFailed: annotation === null, llmCalls };
}

/**
 * Write an annotation onto a scene.
 *
 * Pure, and the ONLY place that clears `STALE_ANNOTATION_FLAG`: the flag
 * means "this annotation was computed for less material than the scene now
 * holds", so re-annotating is exactly what resolves it. Every other
 * `flagged_issues` entry is a user's, and survives.
 */
export function applyAnnotation(scene: Scene, annotation: SceneAnnotation): Scene {
  return {
    ...scene,
    function: annotation.function,
    transformations: annotation.transformations,
    annotations: {
      ...scene.annotations,
      flagged_issues: (scene.annotations?.flagged_issues ?? []).filter(
        (f) => f !== STALE_ANNOTATION_FLAG
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Bible-wide structure call
// ---------------------------------------------------------------------------

export interface StructureSceneRef {
  id: string;
  title: string;
  beat: SceneFunction['beat'] | null;
  tension: number | null;
}

export interface DetectStructureParams {
  /** Every scene in sequence order, annotated or not. */
  scenes: StructureSceneRef[];
  llm: LlmCall;
  signal?: AbortSignal;
}

export interface DetectStructureOutcome {
  structure: NarrativeStructure | null;
  parseFailed: boolean;
  llmCalls: number;
}

/** Scene lines sent to the structure call. A 300-scene bible would
 *  otherwise put the whole scene list in one prompt; the cut is reported
 *  by the caller rather than made silently. */
export const STRUCTURE_SCENE_LIMIT = 200;

/** Parse the structure response. Acts are resolved against the REAL scene
 *  list here — the model works in 1-based scene numbers and never sees a
 *  UUID, the same reason reconcile hands the judge `f1`/`f2` labels. */
export function parseStructure(
  obj: Record<string, unknown> | null,
  scenes: StructureSceneRef[]
): NarrativeStructure | null {
  if (!obj) return null;
  const rawType =
    typeof obj.detected_type === 'string' ? obj.detected_type.trim().toLowerCase() : '';
  if (!STRUCTURE_TYPES.includes(rawType as NarrativeStructure['detected_type'])) {
    return null;
  }
  const detectedType = rawType as NarrativeStructure['detected_type'];
  const rawConfidence = finiteNumber(obj.detection_confidence);

  const acts: Act[] = [];
  // "acts must be empty when detected_type is none_yet" is a prompt rule,
  // and a prompt rule is not a guarantee — enforce it here so a model that
  // hedges both ways cannot store acts under "no structure detected".
  const rawActs =
    detectedType === 'none_yet' || !Array.isArray(obj.acts) ? [] : (obj.acts as unknown[]);
  let lastUsed = 0;
  for (const rawAct of rawActs) {
    const act = rawAct as Record<string, unknown>;
    const first = finiteNumber(act.first_scene);
    const last = finiteNumber(act.last_scene);
    const label = shortString(act.label, 60);
    // Out of range, inverted, or overlapping a previous act: drop this one
    // entry rather than the whole reading. Acts must run in order, so an
    // act starting before the last one ended is not repairable here.
    const firstIdx = first === null ? null : Math.trunc(first);
    const lastIdx = last === null ? null : Math.trunc(last);
    const usable =
      firstIdx !== null &&
      lastIdx !== null &&
      firstIdx >= 1 &&
      lastIdx <= scenes.length &&
      firstIdx <= lastIdx &&
      firstIdx > lastUsed;
    if (!usable) continue;
    lastUsed = lastIdx;
    const startScene = scenes[firstIdx - 1];
    const endScene = scenes[lastIdx - 1];
    acts.push({
      // Seeded on the act's own scene range so a re-run over an unchanged
      // bible mints the same id — the same rerun-idempotence rule scene
      // and fact ids follow.
      id: deterministicUuid(`act:${startScene.id}:${endScene.id}`),
      label,
      scene_range: [startScene.id, endScene.id],
      beat_function: shortString(act.beat_function, 300),
    });
  }

  return {
    detected_type: detectedType,
    detection_confidence:
      rawConfidence === null ? 0 : Math.round(clamp(rawConfidence, 0, 1) * 100) / 100,
    acts,
  };
}

export async function detectStructure(
  params: DetectStructureParams
): Promise<DetectStructureOutcome> {
  const scenes = params.scenes.slice(0, STRUCTURE_SCENE_LIMIT);
  if (scenes.length === 0) {
    return { structure: null, parseFailed: false, llmCalls: 0 };
  }

  const sceneLines = scenes
    .map(
      (s, i) =>
        `${i + 1}. ${s.title || '(untitled)'} — beat: ${s.beat ?? 'unknown'}, tension: ${
          s.tension ?? 'unknown'
        }`
    )
    .join('\n');
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: STRUCTURE_SYSTEM },
    { role: 'user', content: structurePrompt(sceneLines) },
  ];

  let llmCalls = 0;
  let raw = await params.llm(messages, { maxTokens: 900, signal: params.signal });
  llmCalls++;
  let structure = parseStructure(firstJsonObject(raw), scenes);

  if (!structure) {
    raw = await params.llm(
      [
        ...messages,
        { role: 'assistant' as const, content: raw },
        { role: 'user' as const, content: STRUCTURE_REPAIR_INSTRUCTION },
      ],
      { maxTokens: 900, signal: params.signal }
    );
    llmCalls++;
    structure = parseStructure(firstJsonObject(raw), scenes);
  }

  return { structure, parseFailed: structure === null, llmCalls };
}

/**
 * Fold a detected structure into the narrative section.
 *
 * `writeSection` is a documented FULL REPLACE, and this pass owns exactly
 * one key of this section — `themes`, `motifs`, `unresolved_threads`,
 * `pov_default` and `tense_default` belong to the user and to later
 * phases. Prospective today (nothing else writes `narrative` yet) and
 * cheap to keep correct now rather than to discover later.
 */
export function mergeNarrativeStructure(
  existing: Partial<NarrativeSection> | null | undefined,
  structure: NarrativeStructure
): NarrativeSection {
  return {
    structure,
    themes: existing?.themes ?? [],
    motifs: existing?.motifs ?? [],
    unresolved_threads: existing?.unresolved_threads ?? [],
    pov_default: existing?.pov_default ?? null,
    tense_default: existing?.tense_default ?? null,
  };
}
