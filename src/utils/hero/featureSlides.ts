// E6-S2 / D-H6 — the hero's slide configuration: types and the validator for
// `public/hero/feature-slides.json`.
//
// ZERO IMPORTS, on purpose. tools/heroSlides.test.ts imports this file under
// the node tsconfig (no DOM lib, no `src/` path aliases) so it can run the
// SHIPPED json through the very validator the app uses, instead of a copy of
// it that could drift. Keep it that way: no component, store or DOM global may
// leak in here.
//
// The file is first-party static content (a deploy of the static asset is the
// only way to change it), never user-writable storage. Validation therefore
// guards against a CURATION mistake (a typo, a half-edited entry), not against
// a hostile author — and the one rule that matters either way is the same: a
// bad entry or a bad file must cost the hero that entry (or the config), never
// the hero itself.

/** Schema version this build understands. Anything else yields zero slides. */
export const FEATURE_SLIDES_VERSION = 1;

/** Where the app fetches the config from (served from `public/`). */
export const FEATURE_SLIDES_URL = '/hero/feature-slides.json';

/** What a feature slide's call-to-action opens. */
export type FeatureModalConfig =
  | { kind: 'feature'; heading: string; image?: string; bodyMarkdown: string }
  | { kind: 'character'; avatar: string };

/** A product announcement or feature slide (D-H6). Absent `kind` means this. */
export interface FeatureSlideConfig {
  kind: 'feature';
  id: string;
  enabled: boolean;
  title: string;
  body: string;
  image: string;
  /** '' when the image is decorative (the usual case). */
  imageAlt: string;
  /** A permission string, checked with hasPermission(); dropped when unmet. */
  requires?: string;
  cta: { label: string; modal: FeatureModalConfig };
}

/** A featured character (re-scope 2026-10-12). The card supplies the content. */
export interface CharacterSlideConfig {
  kind: 'character';
  id: string;
  enabled: boolean;
  avatar: string;
  requires?: string;
}

export type SlideConfig = FeatureSlideConfig | CharacterSlideConfig;

/** One skipped entry, with the reason a curator needs to fix it. */
export interface SlideProblem {
  index: number;
  id: string | null;
  reason: string;
}

export interface ValidatedSlides {
  slides: SlideConfig[];
  /** One per skipped entry. */
  problems: SlideProblem[];
  /** Set when the file as a whole is unusable (then `slides` is empty). */
  rootProblem: string | null;
}

type Fail = { ok: false; reason: string };
type Ok<T> = { ok: true; value: T };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFilled(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Reads an OPTIONAL string field: absent is fine, present must be a string. */
function optionalString(o: Record<string, unknown>, key: string): Ok<string | undefined> | Fail {
  const v = o[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, reason: `"${key}" must be a string` };
  return { ok: true, value: v };
}

function parseModal(raw: unknown): Ok<FeatureModalConfig> | Fail {
  if (!isRecord(raw)) return { ok: false, reason: '"cta.modal" must be an object' };
  if (raw.kind === 'character') {
    if (!isFilled(raw.avatar)) {
      return { ok: false, reason: 'cta.modal of kind "character" needs a string "avatar"' };
    }
    return { ok: true, value: { kind: 'character', avatar: raw.avatar } };
  }
  if (raw.kind === 'feature') {
    if (!isFilled(raw.heading)) {
      return { ok: false, reason: 'cta.modal of kind "feature" needs a string "heading"' };
    }
    if (!isFilled(raw.bodyMarkdown)) {
      return { ok: false, reason: 'cta.modal of kind "feature" needs a string "bodyMarkdown"' };
    }
    const image = optionalString(raw, 'image');
    if (!image.ok) return { ok: false, reason: `cta.modal ${image.reason}` };
    return {
      ok: true,
      value: {
        kind: 'feature',
        heading: raw.heading,
        bodyMarkdown: raw.bodyMarkdown,
        ...(image.value ? { image: image.value } : {}),
      },
    };
  }
  return { ok: false, reason: '"cta.modal.kind" must be "feature" or "character"' };
}

/** Fields every entry kind shares: enabled (default true) and requires. */
function parseCommon(o: Record<string, unknown>): Ok<{ enabled: boolean; requires?: string }> | Fail {
  let enabled = true;
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return { ok: false, reason: '"enabled" must be true or false' };
    enabled = o.enabled;
  }
  if (o.requires === undefined) return { ok: true, value: { enabled } };
  if (!isFilled(o.requires)) return { ok: false, reason: '"requires" must be a non-empty string' };
  return { ok: true, value: { enabled, requires: o.requires } };
}

function parseEntry(raw: unknown, index: number): Ok<SlideConfig> | Fail {
  if (!isRecord(raw)) return { ok: false, reason: 'entry is not an object' };

  const kind = raw.kind === undefined ? 'feature' : raw.kind;
  if (kind !== 'feature' && kind !== 'character') {
    return { ok: false, reason: '"kind" must be "feature" or "character" (or absent)' };
  }

  const common = parseCommon(raw);
  if (!common.ok) return common;

  if (kind === 'character') {
    // A character entry needs only its avatar: the card supplies name, art,
    // creator and the creator-notes blurb, so nothing else here can go stale.
    if (!isFilled(raw.avatar)) return { ok: false, reason: 'character entry needs a string "avatar"' };
    const id = isFilled(raw.id) ? raw.id : `character-${index}`;
    return { ok: true, value: { kind: 'character', id, avatar: raw.avatar, ...common.value } };
  }

  for (const key of ['id', 'title', 'body', 'image'] as const) {
    if (!isFilled(raw[key])) return { ok: false, reason: `missing or empty "${key}"` };
  }
  const imageAlt = optionalString(raw, 'imageAlt');
  if (!imageAlt.ok) return imageAlt;

  const cta = raw.cta;
  if (!isRecord(cta)) return { ok: false, reason: 'missing "cta"' };
  if (!isFilled(cta.label)) return { ok: false, reason: 'missing or empty "cta.label"' };
  const modal = parseModal(cta.modal);
  if (!modal.ok) return modal;

  return {
    ok: true,
    value: {
      kind: 'feature',
      id: raw.id as string,
      title: raw.title as string,
      body: raw.body as string,
      image: raw.image as string,
      imageAlt: imageAlt.value ?? '',
      cta: { label: cta.label, modal: modal.value },
      ...common.value,
    },
  };
}

/**
 * Pure validation: returns the usable entries and a problem per skipped one.
 * Never throws, whatever it is handed.
 *
 * The root must be an object with `version === 1` and a `slides` array;
 * anything else is a root problem and yields no slides at all (an unknown
 * version is a file written for a different build, so its entries cannot be
 * trusted to mean what this build thinks they mean).
 */
export function validateFeatureSlides(raw: unknown): ValidatedSlides {
  if (!isRecord(raw)) {
    return { slides: [], problems: [], rootProblem: 'config root is not an object' };
  }
  if (raw.version !== FEATURE_SLIDES_VERSION) {
    return {
      slides: [],
      problems: [],
      rootProblem: `unknown version ${JSON.stringify(raw.version)} (this build reads version ${FEATURE_SLIDES_VERSION})`,
    };
  }
  if (!Array.isArray(raw.slides)) {
    return { slides: [], problems: [], rootProblem: '"slides" is not an array' };
  }

  const slides: SlideConfig[] = [];
  const problems: SlideProblem[] = [];
  raw.slides.forEach((entry, index) => {
    const parsed = parseEntry(entry, index);
    if (parsed.ok) {
      slides.push(parsed.value);
      return;
    }
    const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : null;
    problems.push({ index, id, reason: parsed.reason });
  });
  return { slides, problems, rootProblem: null };
}

/**
 * The runtime entry point: validates, then reports each problem with exactly
 * ONE console.warn so a curator can find the bad entry from the console
 * (D-H6: "skipped with one console.warn"). Returns only the usable entries.
 */
export function parseFeatureSlides(raw: unknown): SlideConfig[] {
  const { slides, problems, rootProblem } = validateFeatureSlides(raw);
  if (rootProblem) console.warn(`[hero] ${FEATURE_SLIDES_URL} ignored: ${rootProblem}`);
  for (const p of problems) {
    const which = p.id ? `#${p.index} ("${p.id}")` : `#${p.index}`;
    console.warn(`[hero] ${FEATURE_SLIDES_URL} skipped slide ${which}: ${p.reason}`);
  }
  return slides;
}
