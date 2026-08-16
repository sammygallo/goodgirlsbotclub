// Persona interview — turn parsing + draft patching. Copy-and-adapted from
// characterInterview/patch.ts, scoped to the persona's name/description
// allowlist (no lore). lenientSay is copied verbatim — it is the recovery
// path a truncated turn falls back to, and must stay faithful to the
// character version's fix (character 1f7f4f85) so a persona turn never dumps
// raw JSON into the chat either.

import { firstJsonObject } from '../llm/json';
import type { FieldPatch, PersonaDraft, PersonaInterviewTurn } from './types';

/** Tolerant parse of one model turn response into a PersonaInterviewTurn, or
 *  null if no usable JSON object (with a non-empty `say`) was found. */
export function parseInterviewTurn(raw: string): PersonaInterviewTurn | null {
  const obj = firstJsonObject(raw);
  if (!obj) return null;

  const say = typeof obj.say === 'string' ? obj.say.trim() : '';
  if (!say) return null;

  const turn: PersonaInterviewTurn = { say };

  if (isPlainObject(obj.patch)) {
    turn.patch = obj.patch as FieldPatch;
  }

  if (isPlainObject(obj.coverage)) {
    turn.coverage = obj.coverage as PersonaInterviewTurn['coverage'];
  }

  if (Array.isArray(obj.suggestions)) {
    const suggestions = obj.suggestions.filter((s): s is string => typeof s === 'string');
    if (suggestions.length > 0) turn.suggestions = suggestions;
  }

  turn.done = obj.done === true;

  return turn;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Last-resort recovery for a turn response whose JSON never closes (most
 *  often an output-cap truncation mid-`patch`) but whose `"say"` field —
 *  written first per the output contract — is still intact or at least
 *  partially present. Decodes the string value by hand, character by
 *  character, rather than regex-capturing it and handing it to `JSON.parse`:
 *  a strict re-parse throws on exactly the kind of malformed escape or
 *  unescaped control character a weaker model is prone to leaving in
 *  free-flowing `say` prose. Unknown escapes are kept literally; truncation
 *  mid-value simply ends the scan. Returns null if there's no `"say"` field
 *  or nothing usable was decoded. */
export function lenientSay(raw: string): string | null {
  const start = raw.match(/"say"\s*:\s*"/);
  if (!start || start.index === undefined) return null;

  let i = start.index + start[0].length;
  let out = '';
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') break;
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += JSON_ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }

  const trimmed = out.trim();
  return trimmed || null;
}

const STRING_FIELDS = ['name', 'description'] as const satisfies readonly (keyof FieldPatch)[];

/** Apply a field patch to the running draft. Field-by-field allowlist per
 *  FieldPatch's own keys — anything else on the raw patch object is ignored
 *  (defense in depth even though parseInterviewTurn should already only pass
 *  through FieldPatch-shaped data). Never mutates `draft` in place; returns
 *  the SAME reference when `patch` is undefined so a no-op turn doesn't cause
 *  unnecessary re-renders upstream. */
export function applyPatch(draft: PersonaDraft, patch: FieldPatch | undefined): PersonaDraft {
  if (!patch) return draft;

  let next: PersonaDraft | null = null;
  for (const field of STRING_FIELDS) {
    const value = patch[field];
    if (typeof value === 'string' && value.trim().length > 0 && value !== draft[field]) {
      if (!next) next = { ...draft };
      next[field] = value;
    }
  }

  return next ?? draft;
}
