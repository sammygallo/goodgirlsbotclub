// The two model calls (plan §3.4): one prose, one continuity.
//
// Pure in the same sense the ingestion passes are — a `DetailedLlmCall`
// comes in, data goes out, and this module never touches storyApi or a
// store.

import { firstJsonObject } from '../llm/json';
import type { DetailedLlmCall } from '../storyIngest/llmBridge';
import type { TerminalSignal } from '../llm/sse';
import type { BibleFact } from '../../types/storyBible';
import {
  CONTINUITY_REPAIR_INSTRUCTION,
  CONTINUITY_SYSTEM,
  PROSE_SYSTEM,
  continuityPrompt,
  prosePrompt,
} from './prompts';
import type { ContinuityVerdict, RenderBrief } from './types';

/** Output cap for one scene's prose. Generous on purpose — the whole
 *  point of surfacing `finish_reason` is that hitting this is DETECTED
 *  rather than silently stored, so the cap can be set for cost rather
 *  than set defensively low and quietly truncating. */
export const PROSE_MAX_TOKENS = 4096;
/** The continuity answer is a short JSON object, not prose. */
export const CONTINUITY_MAX_TOKENS = 1200;

export interface ProseResult {
  prose: string;
  /** How the stream ended. Anything but `'stop'` means the unit must NOT
   *  be stored as complete (plan §3.4). */
  terminal: TerminalSignal;
  /** The provider's raw reason, for a message that can name it. */
  finishReason: string | null;
  llmCalls: number;
}

/**
 * Render one scene to prose.
 *
 * There is deliberately NO repair retry here, unlike every JSON pass in
 * this codebase. A prose response cannot fail to parse — whatever comes
 * back IS the answer — so a retry would be re-billing the user for a
 * second opinion they did not ask for. The failure this call actually has
 * is truncation, and that is reported rather than retried: the store can
 * re-render one scene on a one-row write, which is cheaper and is the
 * user's choice to make.
 */
export async function renderSceneProse(opts: {
  brief: RenderBrief;
  llm: DetailedLlmCall;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<ProseResult> {
  const result = await opts.llm(
    [
      { role: 'system', content: PROSE_SYSTEM },
      { role: 'user', content: prosePrompt(opts.brief) },
    ],
    { maxTokens: opts.maxTokens ?? PROSE_MAX_TOKENS, signal: opts.signal }
  );

  return {
    prose: result.text.trim(),
    terminal: result.terminal,
    finishReason: result.finishReason,
    llmCalls: 1,
  };
}

export interface ContinuityResult {
  verdicts: ContinuityVerdict[];
  /** True when even the repair retry failed to yield a usable object. The
   *  unit keeps its prose and reports "not checked" rather than "clean" —
   *  those are different claims, and only one of them is honest here. */
  unreadable: boolean;
  llmCalls: number;
}

const SEVERITIES: ContinuityVerdict['severity'][] = ['minor', 'major'];

/**
 * Check produced prose against the scene's fact set.
 *
 * Reads only — it never rewrites, which is what keeps this a check rather
 * than a sixth generation stage. Facts are labelled `f1`, `f2`, … and the
 * map back to real ids stays here, so a mangled label resolves to null
 * instead of to the wrong fact.
 */
export async function checkContinuity(opts: {
  prose: string;
  facts: BibleFact[];
  llm: DetailedLlmCall;
  signal?: AbortSignal;
}): Promise<ContinuityResult> {
  if (!opts.prose.trim() || opts.facts.length === 0) {
    return { verdicts: [], unreadable: false, llmCalls: 0 };
  }

  const labelById = new Map<string, string>();
  const idByLabel = new Map<string, string>();
  opts.facts.forEach((f, i) => {
    const label = `f${i + 1}`;
    labelById.set(f.id, label);
    idByLabel.set(label, f.id);
  });
  const labelledFacts = opts.facts
    .map((f) => `${labelById.get(f.id)}: ${f.text}`)
    .join('\n');

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: CONTINUITY_SYSTEM },
    { role: 'user', content: continuityPrompt({ labelledFacts, prose: opts.prose }) },
  ];

  let llmCalls = 0;
  let raw = (await opts.llm(messages, {
    maxTokens: CONTINUITY_MAX_TOKENS,
    signal: opts.signal,
  })).text;
  llmCalls++;
  let parsed = readFindings(firstJsonObject(raw), idByLabel);

  if (parsed === null) {
    raw = (
      await opts.llm(
        [
          ...messages,
          { role: 'assistant' as const, content: raw },
          { role: 'user' as const, content: CONTINUITY_REPAIR_INSTRUCTION },
        ],
        { maxTokens: CONTINUITY_MAX_TOKENS, signal: opts.signal }
      )
    ).text;
    llmCalls++;
    parsed = readFindings(firstJsonObject(raw), idByLabel);
  }

  if (parsed === null) return { verdicts: [], unreadable: true, llmCalls };
  return { verdicts: parsed, unreadable: false, llmCalls };
}

/** Null means "could not read the answer" — distinct from an empty array,
 *  which means "read it, and it found nothing". Collapsing the two would
 *  report an unchecked scene as clean. */
export function readFindings(
  obj: Record<string, unknown> | null,
  idByLabel: Map<string, string>
): ContinuityVerdict[] | null {
  if (!obj || !Array.isArray(obj.findings)) return null;
  const out: ContinuityVerdict[] = [];
  for (const raw of obj.findings as unknown[]) {
    // `null` and primitives are both plausible model output inside a JSON
    // array, and `(null as Record).claim` throws. The whole point of this
    // parser is to survive a weak model's shape mistakes — throwing here
    // would abort a continuity check the user has ALREADY paid for, on
    // the strength of one malformed array element.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const claim = typeof item.claim === 'string' ? item.claim.trim().slice(0, 500) : '';
    const canon = typeof item.canon === 'string' ? item.canon.trim().slice(0, 500) : '';
    // A finding that says nothing is noise, not a verdict.
    if (!claim && !canon) continue;
    const label = typeof item.fact === 'string' ? item.fact.trim() : '';
    const severity = String(item.severity ?? '')
      .trim()
      .toLowerCase() as ContinuityVerdict['severity'];
    out.push({
      // An unrecognized label resolves to null rather than to whatever
      // fact happens to sit at that position.
      factId: idByLabel.get(label) ?? null,
      claim,
      canon,
      severity: SEVERITIES.includes(severity) ? severity : 'minor',
    });
  }
  return out;
}
