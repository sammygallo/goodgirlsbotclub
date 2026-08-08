// Tolerant JSON recovery for prompt-instructed model output.
//
// The app has no structured-output plumbing (response_format/tools are not
// carried by the generation proxy for every provider), so utility features
// ask for JSON in the prompt and recover it from whatever comes back. These
// helpers grew in storyIngest/prompts.ts and lorebookFromTranscript; this is
// the single shared copy.

/**
 * Pull complete top-level {...} objects out of arbitrary text via brace
 * matching (string/escape aware).
 *
 * Unlike a single JSON.parse of the whole response, this survives models
 * that wrap JSON in prose or get cut off at max_tokens — a truncated final
 * object is simply skipped instead of discarding everything before it.
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
