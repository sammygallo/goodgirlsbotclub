/**
 * Create-lorebook-from-transcript — distill an ENTIRE chat into a fresh set of
 * standalone lorebook entries (character facts, world rules, relationships,
 * locations, continuity notes, standing directives) for the user to review and
 * save as a new World Info book.
 *
 * This is the one-shot, user-triggered cousin of the auto-memory extension
 * (`src/stores/autoMemoryStore.ts`), which instead appends recent-window facts
 * to a per-character book automatically. The prompt, SSE parsing, and dedupe
 * rules deliberately mirror that store; the differences here are (1) the whole
 * transcript is processed via token-budgeted chunks so early lore isn't lost,
 * and (2) results are returned as drafts rather than written directly.
 */

import { api } from '../api/client';
import { estimateTokens } from './tokenizer';

export interface DraftLorebookEntry {
  /** Primary keywords a future scan would look for to surface this entry. */
  keys: string[];
  /** The lore text. ~60–110 words; the first sentence carries the whole fact. */
  content: string;
  /** Coarse bucket used for grouping/badging in the review UI. */
  category: string;
}

/** Minimal message shape the extractor needs. Decoupled from store types. */
export type TranscriptMsg = {
  name: string;
  isUser: boolean;
  isSystem: boolean;
  content: string;
};

export interface ExtractOptions {
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  /** Called after each chunk completes: (chunksDone, chunksTotal). */
  onProgress?: (done: number, total: number) => void;
}

export interface ExtractResult {
  entries: DraftLorebookEntry[];
  /** Non-system messages actually fed to the model. */
  messagesProcessed: number;
  /** Total non-system messages in the transcript. */
  messagesTotal: number;
  /** True when the transcript was longer than the chunk cap allowed. */
  truncated: boolean;
}

// Categories the model is asked to bucket entries into — the canonical
// authoring taxonomy (mirrors WI_CATEGORIES in worldInfoStore). Kept loose —
// the review UI badges whatever string comes back, falling back to
// "world_rule".
export const LOREBOOK_CATEGORIES = [
  'character_fact',
  'world_rule',
  'relationship',
  'location',
  'continuity_note',
  'standing_directive',
] as const;

/** Roughly how many transcript tokens to feed the model per chunk. */
const CHUNK_TOKEN_BUDGET = 2500;
/** Hard cap on chunks so a giant log can't fan out into unbounded calls. */
const MAX_CHUNKS = 20;

function transcriptLine(m: TranscriptMsg, characterName: string): string {
  // Use the message's own name for AI turns so group chats read correctly;
  // fall back to the active character's name.
  const speaker = m.isUser ? 'User' : m.name || characterName || 'Character';
  return `${speaker}: ${m.content}`;
}

/**
 * Split the (non-system) transcript into chunks bounded by `CHUNK_TOKEN_BUDGET`
 * and `MAX_CHUNKS`. Returns the rendered transcript text for each chunk — the
 * UI uses `.length` to show the pre-flight call count, and `extractLorebookEntries`
 * reuses the same split so the count is exact.
 */
export function planChunks(
  messages: TranscriptMsg[],
  characterName: string
): string[] {
  const lines = messages
    .filter((m) => !m.isSystem)
    .map((m) => transcriptLine(m, characterName))
    .filter((l) => l.trim().length > 0);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (current.length > 0 && currentTokens + lineTokens > CHUNK_TOKEN_BUDGET) {
      chunks.push(current.join('\n'));
      current = [];
      currentTokens = 0;
    }
    current.push(line);
    currentTokens += lineTokens;
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  return chunks.slice(0, MAX_CHUNKS);
}

/**
 * How many non-system messages the first `MAX_CHUNKS` worth of chunks cover.
 * Used to report truncation without re-deriving the chunk boundaries.
 */
function countProcessedMessages(
  messages: TranscriptMsg[],
  characterName: string,
  chunkCount: number
): number {
  // Re-walk with the same budgeting, stopping once we've emitted `chunkCount`
  // chunks, and count how many real messages fell into them.
  const nonSystem = messages.filter((m) => !m.isSystem);
  let processed = 0;
  let chunks = 0;
  let currentTokens = 0;
  let currentHasContent = false;

  for (const m of nonSystem) {
    const line = transcriptLine(m, characterName);
    if (!line.trim()) continue;
    const lineTokens = estimateTokens(line);
    if (currentHasContent && currentTokens + lineTokens > CHUNK_TOKEN_BUDGET) {
      chunks += 1;
      if (chunks >= chunkCount) break;
      currentTokens = 0;
      currentHasContent = false;
    }
    currentTokens += lineTokens;
    currentHasContent = true;
    processed += 1;
  }
  return processed;
}

// ---------------------------------------------------------------------------
// SSE stream parsing — copied to match the convention already used by
// summarizeStore and autoMemoryStore (both keep a local copy). Kept identical
// so behavior matches the rest of the app's generation paths.
// ---------------------------------------------------------------------------

async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (!data || data === '[DONE]') continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            if (data.length > 0 && data !== 'undefined') yield data;
            continue;
          }
          // Surface backend/provider errors that arrive mid-stream (e.g.
          // "temperature is deprecated for this model") instead of silently
          // yielding nothing — otherwise the caller mistakes a failed
          // generation for an empty result ("No lore found").
          if (json?.error) {
            const msg =
              typeof json.error === 'string'
                ? json.error
                : json.error.message || 'Generation failed';
            throw new Error(msg);
          }
          const content =
            json.choices?.[0]?.delta?.content ||
            json.choices?.[0]?.text ||
            json.delta?.text ||
            (json.type === 'content_block_delta' ? json.delta?.text : null) ||
            json.content ||
            json.message?.content?.[0]?.text ||
            '';
          if (content) yield content;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Category values from the pre-taxonomy prompt (and old saved drafts),
 *  mapped onto the canonical set. Keys are lowercase. */
const LEGACY_CATEGORY_MAP: Record<string, string> = {
  character: 'character_fact',
  location: 'location',
  item: 'world_rule',
  faction: 'world_rule',
  event: 'continuity_note',
  lore: 'world_rule',
};

function normalizeCategory(raw: unknown): string {
  if (typeof raw !== 'string') return 'world_rule';
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return 'world_rule';
  const match = LOREBOOK_CATEGORIES.find((c) => c === lowered);
  if (match) return match;
  return LEGACY_CATEGORY_MAP[lowered] ?? 'world_rule';
}

function entryFromObject(obj: Record<string, unknown>): DraftLorebookEntry | null {
  const rawKeys = Array.isArray(obj.keys)
    ? obj.keys.filter((k): k is string => typeof k === 'string')
    : typeof obj.keys === 'string'
      ? [obj.keys]
      : [];
  const content = typeof obj.content === 'string' ? obj.content.trim() : '';
  const keys = rawKeys.map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0 || !content) return null;
  return { keys, content, category: normalizeCategory(obj.category) };
}

/**
 * Pull complete top-level `{...}` objects out of arbitrary text via brace
 * matching (string/escape aware). Unlike a single `JSON.parse` of the whole
 * array, this survives truncated output (finish_reason "length") — a cut-off
 * final object is simply skipped instead of discarding everything before it.
 */
function extractJsonObjects(text: string): string[] {
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

/**
 * Parse draft entries from an LLM response. Tolerant of fenced/prose-wrapped
 * output AND of truncation: each complete entry object is recovered and parsed
 * independently.
 */
function parseEntriesFromResponse(text: string): DraftLorebookEntry[] {
  const out: DraftLorebookEntry[] = [];
  for (const chunk of extractJsonObjects(text)) {
    let obj: unknown;
    try {
      obj = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const entry = entryFromObject(obj as Record<string, unknown>);
    if (entry) out.push(entry);
  }
  return out;
}

const SYSTEM_PROMPT = `You are an information-extraction assistant building a reusable lorebook from a roleplay chat transcript. Extract durable, canonical facts worth remembering across future sessions.

Entry standard:
- One self-contained fact per entry. If you need "and" to describe what an entry covers, split it into two entries.
- The first sentence must carry the whole fact on its own — dense and declarative. The model reading this entry mid-generation has no other context: never write "as mentioned above", "she also", or anything that leans on another entry.
- Target roughly 60-110 words per entry: the core fact first, then the specifics that make it usable.
- "keys" are 3-6 identifiers or phrases that actually appear in the prose — names, aliases, place names, specific terms. Never speculative paraphrases a keyword scan would not find.
- Keys are matched case-insensitively as SUBSTRINGS of recent chat text, not as whole words. Favor distinctive proper nouns, place names, and multi-word phrases that appear verbatim in the transcript.
- Never use everyday words (the, she, her, they, said, about, back, over, just…) and never use a fragment shorter than 3 characters. Because matching is by substring, "ana" fires inside "banana" and a common word fires on nearly every message, burying the entries that matter.
- Do not list a phrase when a shorter key you already included would match it anyway: if "Hollow" is in the list, "the Hollow Road" can never be the reason the entry fires, so it only adds noise.

Output rules:
- Return ONLY a JSON array. No prose, no markdown fences.
- Each item: {"keys": ["keyword1", "keyword2"], "content": "the fact", "category": "character_fact"}.
- "category" must be one of: character_fact, world_rule, relationship, location, continuity_note, standing_directive.
- Skip facts already covered by the "Already extracted" list.
- Skip transient chatter (greetings, small talk, weather flavor, one-off reactions).
- Prefer durable world-state over moment-to-moment action.
- If nothing new is worth recording, return [].`;

function buildUserPrompt(chunk: string, knownDigest: string): string {
  return `Already extracted (do not repeat these):
${knownDigest || '(none yet)'}

Chat transcript excerpt:
${chunk}

New lorebook entries (JSON array):`;
}

/**
 * Run the full extraction across all chunks sequentially, deduping as it goes.
 * Resolves with the collected drafts plus coverage metadata. Honors `signal`
 * for cancellation (throws the standard AbortError, like fetch).
 */
export async function extractLorebookEntries(
  messages: TranscriptMsg[],
  characterName: string,
  opts: ExtractOptions = {}
): Promise<ExtractResult> {
  const { provider, model, signal, onProgress } = opts;
  const messagesTotal = messages.filter((m) => !m.isSystem).length;
  const chunks = planChunks(messages, characterName);
  const total = chunks.length;

  const messagesProcessed = countProcessedMessages(
    messages,
    characterName,
    total
  );

  const entries: DraftLorebookEntry[] = [];
  // Cheap dedupe key, matching autoMemory: normalized content prefix.
  const seenContent = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Digest of already-found entries so later chunks don't repeat
    // themselves. Capped two ways: per-entry (the ~60-110-word authoring
    // target made full contents ~4x longer than the digest was designed
    // for) and overall, so a long run can't blow small context windows.
    const DIGEST_ENTRY_CHARS = 160;
    const DIGEST_TOTAL_CHARS = 6000;
    let knownDigest = entries
      .slice(-40)
      .map((e) => {
        const body =
          e.content.length > DIGEST_ENTRY_CHARS
            ? `${e.content.slice(0, DIGEST_ENTRY_CHARS)}…`
            : e.content;
        return `- (${e.keys.join(', ')}) ${body}`;
      })
      .join('\n');
    if (knownDigest.length > DIGEST_TOTAL_CHARS) {
      // Keep the tail — the most recent entries are the likeliest repeats.
      knownDigest = knownDigest.slice(-DIGEST_TOTAL_CHARS);
    }

    const stream = await api.generateMessage(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(chunks[i], knownDigest) },
      ],
      characterName,
      provider,
      model,
      signal,
      // Entry lists are long; the default 1024 truncates mid-array and the
      // whole chunk's output is lost. Give the model room to finish.
      { maxTokens: 8192 }
    );

    if (!stream) {
      throw new Error('No response from the model during extraction.');
    }

    let raw = '';
    for await (const token of parseSSEStream(stream)) {
      raw += token;
    }

    for (const entry of parseEntriesFromResponse(raw)) {
      const norm = entry.content.trim().toLowerCase().slice(0, 80);
      if (seenContent.has(norm)) continue;
      seenContent.add(norm);
      entries.push(entry);
    }

    onProgress?.(i + 1, total);
  }

  return {
    entries,
    messagesProcessed,
    messagesTotal,
    truncated: messagesProcessed < messagesTotal,
  };
}
