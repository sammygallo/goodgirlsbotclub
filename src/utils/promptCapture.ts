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
 * infer meaning from array content by pattern-matching. Both transform flags
 * come from the transforms' own return values, never from comparing the
 * before/after arrays.
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
 * environments or payloads where it is unavailable; if both fail (e.g. a
 * circular structure), the original reference is returned unfrozen rather
 * than throwing out of a capture that was meant to be best-effort.
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
 * Map `capture.messages` positionally against the breakdown's slices: the
 * joined Stage-A section content lands in entry 0, each Stage-B slice in the
 * next entry, each Stage-C slice in the next, and the call-site instruction
 * turn (continue/impersonate) in the last entry. This only means anything
 * when the displayed array IS the builder's output — gated on both transform
 * flags before the breakdown is consulted at all.
 *
 * Every non-Stage-A mapping is checked against the entry it claims: the
 * entry must be `{ role, content }` and its content length must match the
 * slice's recorded `chars`. A breakdown paired with the wrong capture, or a
 * builder change that reorders slices relative to `context`, fails this
 * check rather than mislabelling — the function returns `null` for anything
 * it cannot verify, never a best guess.
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
  const stageBSlices = breakdown.slices.filter((s) => s.kind.stage === 'B');
  const stageCSlices = breakdown.slices.filter((s) => s.kind.stage === 'C');
  const callSiteSlice = breakdown.slices.find((s) => s.kind.stage === 'callSite');

  const expectedCount =
    (stageASlices.length > 0 ? 1 : 0) +
    stageBSlices.length +
    stageCSlices.length +
    (callSiteSlice ? 1 : 0);
  if (entries.length !== expectedCount) return null;

  const result: CaptureAttribution = [];
  let idx = 0;

  if (stageASlices.length > 0) {
    const entry = entries[idx];
    if (!isRoleContentEntry(entry)) return null;
    result.push({ index: idx, labels: stageASlices.map((s) => describeSectionKind(s.kind)) });
    idx += 1;
  }

  for (const slice of stageBSlices) {
    const entry = entries[idx];
    if (!isRoleContentEntry(entry) || entry.content.length !== slice.chars) return null;
    result.push({ index: idx, labels: [describeSectionKind(slice.kind)] });
    idx += 1;
  }

  for (const slice of stageCSlices) {
    const entry = entries[idx];
    if (!isRoleContentEntry(entry) || entry.content.length !== slice.chars) return null;
    result.push({ index: idx, labels: [describeSectionKind(slice.kind)] });
    idx += 1;
  }

  if (callSiteSlice) {
    const entry = entries[idx];
    if (!isRoleContentEntry(entry) || entry.content.length !== callSiteSlice.chars) return null;
    result.push({ index: idx, labels: [describeSectionKind(callSiteSlice.kind)] });
    idx += 1;
  }

  return result;
}
