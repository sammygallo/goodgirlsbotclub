// Reading a render unit's `continuity` payload (step 3, phase 5).
//
// The payload is `Record<string, unknown>` on the wire and is written by
// `storyRenderStore`, but a reader must not assume the writer that produced
// any given row is the one running today: units outlive deploys, and a
// half-written row from a crashed tab is a real state. Every field is
// therefore narrowed here rather than trusted, and the fallbacks all resolve
// toward "we cannot say" instead of toward "clean".
//
// That direction is the whole point. §3.8's own note on staleness applies
// equally to the check: false-uncertain is cheap, false-verified is not.

import type { ContinuityVerdict } from './types';

export interface UnitNotes {
  /** Contradictions the checker reported. */
  verdicts: ContinuityVerdict[];
  /**
   * The check could not be READ — the model's answer did not parse, the
   * call failed, or it never ran.
   *
   * NOT the same as clean, and the reader must never present it as such.
   * Defaults TRUE for an absent or unshaped payload: a unit whose notes we
   * cannot read is a unit whose continuity we have not verified.
   */
  unreadable: boolean;
  /** Why the stream ended. `stop` is the only terminal that earns
   *  `complete`; everything else is why a chapter is `truncated` (§3.4). */
  terminal: string | null;
  /** The provider's own word for it, when it gave one. */
  finishReason: string | null;
  /** What the 24k cap left out, as `kind → count` (§3.5: never silent). */
  drops: { kind: string; count: number }[];
  /** Rules the SELECTOR excluded as not active in this scene. A selection
   *  fact, not a cap drop — the two are reported separately because they
   *  mean different things and have different fixes. */
  rulesNotActive: number;
  /** The rule set is a reconstruction: probability rolls were re-rolled and
   *  sticky/cooldown state was never recorded. */
  approximate: boolean;
  /** No AI turn in the scene, so the scanner fired nothing and only
   *  always-on entries reached the brief. */
  constantsOnly: boolean;
  /** Lorebook entries the brief could not resolve in the current book set. */
  unresolvedRules: number;
  /** The scene was refused outright, or its model call failed — the message
   *  a reader shows in place of prose it does not have. */
  failure: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function asText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Keep only entries shaped like a verdict. A malformed one rendered blank
 *  reads as "a contradiction with no detail", which is worse than not
 *  listing it. */
function readVerdicts(raw: unknown): ContinuityVerdict[] {
  if (!Array.isArray(raw)) return [];
  const out: ContinuityVerdict[] = [];
  for (const entry of raw) {
    const v = asRecord(entry);
    if (!v) continue;
    const claim = asText(v.claim);
    const canon = asText(v.canon);
    if (!claim || !canon) continue;
    out.push({
      factId: typeof v.factId === 'string' ? v.factId : null,
      claim,
      canon,
      severity: v.severity === 'major' ? 'major' : 'minor',
    });
  }
  return out;
}

function readDrops(raw: unknown): { kind: string; count: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { kind: string; count: number }[] = [];
  for (const entry of raw) {
    const d = asRecord(entry);
    const kind = asText(d?.kind);
    if (!kind) continue;
    out.push({ kind, count: asCount(d?.count) || 1 });
  }
  return out;
}

export function readUnitNotes(continuity: unknown): UnitNotes {
  const c = asRecord(continuity);
  const caveats = asRecord(c?.caveats);

  // The refusal and the call failure are two different writers of the same
  // "there is no prose" outcome, and the user needs to be told which:
  // a refusal is fixed by splitting the scene, a failure by trying again.
  const refused = asText(c?.refused);
  const callError = asText(c?.error);
  const failure = refused
    ? 'This scene carries more required context than one chapter can hold. Splitting it in the Story tab is the fix.'
    : callError
      ? `The model call failed: ${callError}`
      : null;

  return {
    verdicts: readVerdicts(c?.verdicts),
    // Absent means unverified, not verified — see the interface doc.
    unreadable: c?.unreadable === false ? false : true,
    terminal: asText(c?.terminal),
    finishReason: asText(c?.finish_reason),
    drops: readDrops(c?.drops),
    rulesNotActive: asCount(c?.rules_not_active),
    approximate: caveats?.approximate === true,
    constantsOnly: caveats?.constantsOnly === true,
    unresolvedRules: asCount(caveats?.unresolvedRules),
    failure,
  };
}

/** Human labels for `BriefDrop['kind']`, so the reader states what was left
 *  out in the user's terms rather than echoing a discriminant. An unknown
 *  kind falls back to the raw value — a future drop kind should read oddly,
 *  never disappear. */
export const DROP_LABELS: Record<string, string> = {
  unattributed_facts: 'story-wide facts',
  other_scene_facts: 'facts from other scenes',
  preceding_summary: 'the previous scene’s summary',
  dialogue_examples: 'dialogue examples',
  firing_rules: 'lorebook entries that were active here',
};
