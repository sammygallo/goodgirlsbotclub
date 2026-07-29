// Ingestion prompts (story-state phase 6).
//
// PROMPT_VERSION is stamped into the checkpoint on every run. When these
// prompts change, a resumed run whose checkpoint carries an older
// version is NOT safe to continue — half the bible would be built by one
// prompt and half by another — so the store refuses to resume across a
// version change and offers a fresh start instead.
//
// Cold-start is deliberately LLM-light: the schema doc's ingestion table
// is a mechanical mapping (card name → canonical_name, scenario →
// setting_summary, and so on), and running a model over facts we already
// have would spend the user's tokens to paraphrase their own card. The
// model is asked for exactly two things it can do better than a regex:
// structured physical attributes, and a voice-register read.

export const PROMPT_VERSION = 'coldstart-v1';

/** Ask for one JSON object. The parser is brace-matching and truncation
 *  tolerant, but a smaller ask still fails less often. */
export const ATTRIBUTES_SYSTEM = `You extract structured character attributes from a character card for a story bible.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"age_apparent": "", "gender_presentation": "", "hair": {"color": "", "length": "", "style": ""}, "eyes": {"color": "", "shape": ""}, "skin": "", "build": "", "height": "", "distinguishing_features": [], "typical_attire": ""}
- Use ONLY what the card states or directly implies. Leave a field as "" (or [] for the list) when the card does not say — do NOT invent details.
- Keep each value short: a few words, not a sentence.`;

export function attributesPrompt(name: string, description: string): string {
  return `Character name: ${name}

Card description:
${description.slice(0, 6000)}

Attributes (JSON object):`;
}

export const VOICE_SYSTEM = `You characterize how a fictional character SPEAKS, for a story bible's voice profile.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"register": "casual", "speech_patterns": "", "verbal_tics": [], "favored_words": [], "avoided_words": []}
- "register" must be exactly one of: formal, casual, vulgar, archaic, mixed.
- "speech_patterns" is one short sentence describing HOW they talk (rhythm, sentence length, directness) — not what they talk about.
- Base this only on the card's personality text and example dialogue. When there is little to go on, say so with an empty "speech_patterns" rather than guessing.`;

export function voicePrompt(
  name: string,
  personality: string,
  mesExample: string
): string {
  return `Character name: ${name}

Personality:
${personality.slice(0, 3000) || '(none given)'}

Example dialogue:
${mesExample.slice(0, 3000) || '(none given)'}

Voice profile (JSON object):`;
}

/**
 * Pull complete top-level {...} objects out of arbitrary text via brace
 * matching (string/escape aware).
 *
 * Copied in spirit from lorebookFromTranscript's recovery: a model that
 * wraps JSON in prose or gets cut off at max_tokens still yields usable
 * objects, where a single JSON.parse of the whole response would throw
 * away everything.
 */
export function extractJsonObjects(text: string): string[] {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          objs.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return objs;
}

/** First parseable JSON object in a model response, or null. */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  for (const chunk of extractJsonObjects(text)) {
    try {
      const obj = JSON.parse(chunk);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // Truncated or malformed — try the next complete object.
    }
  }
  return null;
}

export function asString(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function asStringList(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim().slice(0, 120))
    .slice(0, max);
}
