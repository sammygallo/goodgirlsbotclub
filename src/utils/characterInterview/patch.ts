// Character interview — turn parsing + draft patching.
//
// Tolerant of a weak model's imprecise output, same idiom as storyIngest's
// own normalizers (transcriptWalk.ts, coldStart.ts): every helper here
// fails toward "drop the malformed bit", never toward throwing or
// inventing structure the model didn't clearly provide. The only hard
// requirement is a usable `say` string — everything else in InterviewTurn
// is optional per its own type.

import { firstJsonObject } from '../llm/json';
import type { FieldPatch, InterviewDraft, InterviewTurn, StagedLoreEntry } from './types';

/** Tolerant parse of one model turn response into an InterviewTurn, or
 *  null if no usable JSON object (with a non-empty `say`) was found. */
export function parseInterviewTurn(raw: string): InterviewTurn | null {
  const obj = firstJsonObject(raw);
  if (!obj) return null;

  const say = typeof obj.say === 'string' ? obj.say.trim() : '';
  if (!say) return null;

  const turn: InterviewTurn = { say };

  if (isPlainObject(obj.patch)) {
    turn.patch = obj.patch as FieldPatch;
  }

  if (isPlainObject(obj.coverage)) {
    turn.coverage = obj.coverage as InterviewTurn['coverage'];
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
 *  character, rather than regex-capturing it and handing it to
 *  `JSON.parse`: a strict re-parse throws on exactly the kind of malformed
 *  escape (e.g. a JS-style `\'`) or unescaped control character (e.g. a
 *  literal newline) a weaker model is prone to leaving in free-flowing
 *  `say` prose — which is plausibly what made the original response
 *  unparseable in the first place, and would otherwise send this recovery
 *  straight back to the raw-JSON-dump bug it exists to avoid. An unknown
 *  escape is kept literally rather than rejected, and truncation mid-value
 *  (a dangling `\` or no closing quote at all) simply ends the scan and
 *  returns whatever decoded before the cutoff. Returns null if there's no
 *  `"say"` field or nothing usable was decoded. */
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

const STRING_FIELDS = [
  'name',
  'description',
  'personality',
  'first_mes',
  'scenario',
  'mes_example',
  'creator_notes',
] as const satisfies readonly (keyof FieldPatch)[];

const ARRAY_FIELDS = ['alternate_greetings', 'tags'] as const satisfies readonly (keyof FieldPatch)[];

/** Validate + normalize one raw lore item into a StagedLoreEntry, or null
 *  if it's missing a non-empty `keys` array of strings or a non-empty
 *  `content` string. Shared by patch.ts and engine.ts's final-draft
 *  parsing since both accept the same lore shape. */
export function normalizeLoreEntry(value: unknown): StagedLoreEntry | null {
  if (!isPlainObject(value)) return null;
  const keys = value.keys;
  const content = value.content;
  const validKeys =
    Array.isArray(keys) && keys.length > 0 && keys.every((k) => typeof k === 'string' && k.trim().length > 0);
  const validContent = typeof content === 'string' && content.trim().length > 0;
  if (!validKeys || !validContent) return null;

  const entry: StagedLoreEntry = {
    keys: keys as string[],
    content: (content as string).trim(),
  };
  if (typeof value.title === 'string' && value.title.trim()) entry.title = value.title.trim();
  return entry;
}

/** Apply a field patch to the running draft. Field-by-field allowlist per
 *  FieldPatch's own keys — anything else on the raw patch object is
 *  ignored (defense in depth even though parseInterviewTurn should already
 *  only pass through FieldPatch-shaped data). Never mutates `draft` in
 *  place; returns the SAME reference when `patch` is undefined so a no-op
 *  turn doesn't cause unnecessary re-renders upstream. */
export function applyPatch(
  draft: InterviewDraft,
  patch: FieldPatch | undefined
): { draft: InterviewDraft; newLore: StagedLoreEntry[] } {
  if (!patch) return { draft, newLore: [] };

  const next: InterviewDraft = { ...draft };

  for (const field of STRING_FIELDS) {
    const value = patch[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      next[field] = value;
    }
  }

  for (const field of ARRAY_FIELDS) {
    const value = patch[field];
    if (Array.isArray(value) && value.length > 0) {
      next[field] = value as string[];
    }
  }

  const newLore: StagedLoreEntry[] = Array.isArray(patch.lore)
    ? patch.lore.map(normalizeLoreEntry).filter((e): e is StagedLoreEntry => e !== null)
    : [];

  return { draft: next, newLore };
}
