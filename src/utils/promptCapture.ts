/**
 * The exact post-transform payload handed to the provider client (E2-S3).
 *
 * WHAT THIS IS: a record taken at the dispatch seam, after both `chatStore.ts`
 * transforms (`maybeApplyInstructMode`, `runGenerateInterceptors`) have run
 * and immediately before `api.generateMessage` is called with the result.
 * `promptBreakdown.ts` measures assembly time — what the builder emitted;
 * this measures dispatch time — what the client actually received. An
 * interceptor may replace the array wholesale, so nothing here assumes the
 * result still has section structure.
 *
 * WHAT IT MUST NOT DO: mutate or freeze the array it was handed (that array
 * is the live object about to be dispatched — see `snapshotMessages`), or
 * infer meaning from array content by pattern-matching.
 */

import type { PromptBreakdown, SectionKind } from './promptBreakdown';

export type PromptCaptureSeam =
  | 'send'
  | 'swipe'
  | 'continue'
  | 'impersonate'
  | 'regenerate'
  | 'group';

export interface PromptCapture {
  id: string;
  /**
   * `unknown[]`, not `ContextMessage[]`: the one thing known about this array
   * is that `runGenerateInterceptors` accepted it (`Array.isArray`). An
   * interceptor can return any JSON-serializable structure in its place, and
   * typing the elements as `{ role, content }` would tell the viewer to trust
   * a shape this capture never checked.
   */
  messages: readonly unknown[];
  collapsedByInstruct: boolean;
  replacedByInterceptor: boolean;
  provider: string;
  model: string;
  usedFallback: boolean;
  textCompletionMode: boolean;
  imagesFolded: number;
  capturedAt: number;
  seam: PromptCaptureSeam;
  characterName: string;
  /**
   * The breakdown produced by THIS SAME dispatch's builder call, not
   * whatever happens to be sitting in `generationStore.lastPromptBreakdown`
   * — that slot is written and tagged independently, so pairing a capture
   * with it can attribute one turn's payload against another turn's
   * breakdown. Attribution consumers read this field, never the store slot.
   */
  breakdown: PromptBreakdown | null;
}

let captureCounter = 0;

/** A fresh id per capture, so `tagLastPromptCaptureMessage` and
 *  `notePromptCaptureFallback` can guard by identity even after
 *  `notePromptCaptureFallback` has replaced the record in the store slot. */
function nextCaptureId(): string {
  captureCounter += 1;
  return `pc_${captureCounter}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Copy the dispatched array before freezing it. The array handed in is the
 * live object the store built for its own purposes (or, on the interceptor
 * path, whatever the server returned) — this module does not own it, so
 * freezing it in place would turn a later, unrelated mutation into a thrown
 * generation. `structuredClone` is tried first; a JSON round-trip covers
 * environments or payloads where it is unavailable; if both fail, the
 * original reference is returned unfrozen rather than throwing out of a
 * capture that was meant to be best-effort.
 */
function snapshotMessages(messages: unknown): readonly unknown[] {
  const arr: unknown[] = Array.isArray(messages) ? messages : [];
  try {
    const copy =
      typeof structuredClone === 'function'
        ? structuredClone(arr)
        : (JSON.parse(JSON.stringify(arr)) as unknown[]);
    return deepFreeze(copy) as unknown[];
  } catch {
    try {
      const copy = JSON.parse(JSON.stringify(arr)) as unknown[];
      return deepFreeze(copy) as unknown[];
    } catch {
      return arr;
    }
  }
}

export interface CreatePromptCaptureParams {
  seam: PromptCaptureSeam;
  messages: unknown;
  collapsedByInstruct: boolean;
  replacedByInterceptor: boolean;
  provider: string;
  model: string;
  textCompletionMode: boolean;
  imagesFolded: number;
  characterName: string;
  breakdown: PromptBreakdown | null;
}

export function createPromptCapture(params: CreatePromptCaptureParams): PromptCapture {
  return {
    id: nextCaptureId(),
    messages: snapshotMessages(params.messages),
    collapsedByInstruct: params.collapsedByInstruct,
    replacedByInterceptor: params.replacedByInterceptor,
    provider: params.provider,
    model: params.model,
    usedFallback: false,
    textCompletionMode: params.textCompletionMode,
    imagesFolded: params.imagesFolded,
    capturedAt: Date.now(),
    seam: params.seam,
    characterName: params.characterName,
    breakdown: params.breakdown,
  };
}

// ---------------------------------------------------------------------------
// Section attribution (AC3)
// ---------------------------------------------------------------------------

export interface CaptureAttributionEntry {
  /** Index into `PromptCapture.messages`. */
  index: number;
  /** Human-readable label(s) for this entry. More than one only for the
   *  joined Stage-A entry, which can carry several section ids. */
  labels: string[];
}

export type CaptureAttribution = CaptureAttributionEntry[];

function isRoleContentEntry(value: unknown): value is { role: unknown; content: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
}

function describeSectionKind(kind: SectionKind): string {
  switch (kind.stage) {
    case 'A':
    case 'C':
      return kind.id;
    case 'B':
      switch (kind.cls) {
        case 'history':
          return kind.role ? `history (${kind.role})` : 'history';
        case 'authors_note':
          return 'authors_note';
        case 'characters_note':
          return 'characters_note';
        case 'persona_at_depth':
          return 'persona_at_depth';
        case 'wi_at_depth':
          return 'wi_at_depth';
        case 'ext_at_depth':
          return kind.extensionId ? `ext_at_depth (${kind.extensionId})` : 'ext_at_depth';
        default:
          return kind.cls;
      }
    case 'callSite':
      return `call_site_${kind.turn}`;
    case 'attachments':
      return 'attachments';
    default:
      return 'unknown';
  }
}

/**
 * Map `capture.messages` against the breakdown's slices POSITIONALLY: the
 * joined Stage-A section content is expected in entry 0, and every entry
 * after it is checked against the candidate slices (Stage B, Stage C,
 * call-site — attachments and Stage A excluded) at the SAME index, in the
 * breakdown's own recorded order. This only means anything when the
 * displayed array IS the builder's output — gated on both transform flags
 * before the breakdown is consulted at all.
 *
 * WHY a slice can still be rejected after its position and length agree with
 * an entry: the group at-depth overflow splice records an insertion's slice
 * (an author's-note or WI entry) AFTER slices for entries that come AFTER
 * it in `context`, so slice order and entry order can disagree. When a
 * non-history candidate's `chars` also matches some OTHER post-Stage-A
 * entry, positions alone cannot tell that insertion apart from an ordinary
 * message of equal length, so the match is refused. The function returns
 * `null` for anything it cannot verify, never a best guess.
 */
export function computeCaptureAttribution(
  capture: PromptCapture,
  breakdown: PromptBreakdown | null
): CaptureAttribution | null {
  if (capture.collapsedByInstruct || capture.replacedByInterceptor) return null;
  if (!breakdown) return null;

  const entries = capture.messages;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const stageASlices = breakdown.slices.filter((s) => s.kind.stage === 'A');
  const candidateSlices = breakdown.slices.filter(
    (s) => s.kind.stage === 'B' || s.kind.stage === 'C' || s.kind.stage === 'callSite'
  );

  const result: CaptureAttribution = [];
  let idx = 0;

  if (stageASlices.length > 0) {
    const entry = entries[idx];
    if (!isRoleContentEntry(entry)) return null;
    result.push({ index: idx, labels: stageASlices.map((s) => describeSectionKind(s.kind)) });
    idx += 1;
  }

  const remainingEntries = entries.slice(idx) as { role: unknown; content: string }[];
  if (remainingEntries.length !== candidateSlices.length) return null;

  for (let i = 0; i < remainingEntries.length; i += 1) {
    const entry = remainingEntries[i];
    if (!isRoleContentEntry(entry)) return null;
    const slice = candidateSlices[i];
    if (entry.content.length !== slice.chars) return null;
    if (slice.kind.stage === 'B' && slice.kind.cls === 'history' && slice.kind.role) {
      if (entry.role !== slice.kind.role) return null;
    }
  }

  // Splice-ambiguity rejection — see the WHY paragraph above.
  for (const slice of candidateSlices) {
    if (slice.kind.stage === 'B' && slice.kind.cls === 'history') continue;
    let matches = 0;
    for (const entry of remainingEntries) {
      if (entry.content.length === slice.chars) matches += 1;
    }
    if (matches > 1) return null;
  }

  for (let i = 0; i < remainingEntries.length; i += 1) {
    result.push({ index: idx + i, labels: [describeSectionKind(candidateSlices[i].kind)] });
  }

  return result;
}

/**
 * Deep structural equality: arrays compared in order, objects by key SET
 * and values (key order irrelevant), primitives by `===`. A key present
 * with value `undefined` is NOT the same as the key being absent — both
 * change the key set `Object.keys` reports, which is exactly what should
 * make them differ. Used by `runGenerateInterceptors` (E2-S3, R2-C6) to ask
 * "did the dispatched array actually change" without being fooled by an
 * interceptor that re-serializes the same content with keys in a different
 * order.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => structurallyEqual(v, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    const bKeySet = new Set(bKeys);
    for (const key of aKeys) {
      if (!bKeySet.has(key)) return false;
      if (!structurallyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
  }
  return false;
}
