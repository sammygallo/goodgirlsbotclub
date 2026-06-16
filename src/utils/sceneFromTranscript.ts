/**
 * Scene-from-transcript — distill the tail of a chat into a scene-video plan:
 * a photoreal *scene description* (drives the Kontext keyframe and the
 * editable text shown to the user) plus an ordered list of *motion beats*
 * (one concrete, camera-observable action per video segment, forming a short
 * shot arc) so the rendered clip progresses instead of looping one action.
 *
 * One model call via the user's active provider (same `api.generateMessage`
 * SSE path as lorebookFromTranscript). The model returns JSON; we parse it
 * tolerantly and degrade to scene-only (no beats) if parsing fails. The
 * character's avatar travels separately as an identity reference, so the
 * prompt describes the scene, not the character's face.
 */

import { api } from '../api/client';
import { estimateTokens } from './tokenizer';
import type { TranscriptMsg } from './lorebookFromTranscript';

/** Transcript tokens fed to the summarizer — roughly the last scene's worth. */
const TAIL_TOKEN_BUDGET = 2500;
/** Hard cap on messages so token estimation never walks a giant log. */
const MAX_TAIL_MESSAGES = 30;
/** Cap on the scene description; the backend trims again at 1500. */
const MAX_SCENE_PROMPT_CHARS = 1200;
/** Cap on the character-description excerpt included for context. */
const MAX_DESCRIPTION_CHARS = 600;
/** Number of motion beats to request — one per video segment (~15s total). */
const BEAT_COUNT = 3;
/** Per-beat length cap; keeps each clip prompt single-focus for wan-2.2. */
const MAX_BEAT_CHARS = 200;

export interface SceneSummaryOptions {
  /** Character card description — wardrobe/setting context for the model. */
  characterDescription?: string;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface SceneSummary {
  /** Photoreal scene description — keyframe prompt + the editable text. */
  scene: string;
  /** Ordered per-segment motion directions; may be empty on parse failure. */
  beats: string[];
}

// ---------------------------------------------------------------------------
// SSE stream parsing — copied to match the convention already used by
// summarizeStore, autoMemoryStore, and lorebookFromTranscript (each keeps a
// local copy). Kept identical so behavior matches the rest of the app's
// generation paths.
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

/**
 * The non-system tail of the transcript that fits `TAIL_TOKEN_BUDGET`,
 * rendered as "Speaker: text" lines. Walks backwards so the most recent
 * messages always make the cut.
 */
function transcriptTail(messages: TranscriptMsg[], characterName: string): string {
  const lines: string[] = [];
  let tokens = 0;
  const usable = messages.filter((m) => !m.isSystem && m.content.trim().length > 0);
  for (let i = usable.length - 1; i >= 0 && lines.length < MAX_TAIL_MESSAGES; i--) {
    const m = usable[i];
    const speaker = m.isUser ? 'User' : m.name || characterName || 'Character';
    const line = `${speaker}: ${m.content}`;
    const lineTokens = estimateTokens(line);
    if (lines.length > 0 && tokens + lineTokens > TAIL_TOKEN_BUDGET) break;
    lines.push(line);
    tokens += lineTokens;
  }
  return lines.reverse().join('\n');
}

/** Collapse whitespace and cap a string on a word boundary. */
function tidy(text: string, cap: number): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (t.length > cap) {
    const cut = t.slice(0, cap);
    const sp = cut.lastIndexOf(' ');
    t = sp > 0 ? cut.slice(0, sp) : cut;
  }
  return t;
}

/**
 * Parse the model's `{scene, beats}` JSON, tolerant of prose/fence wrapping.
 * Falls back to treating the whole output as the scene (no beats) so a
 * non-JSON response still yields a usable single-prompt render.
 */
function parseSummary(raw: string): SceneSummary {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      const scene = typeof obj.scene === 'string' ? tidy(obj.scene, MAX_SCENE_PROMPT_CHARS) : '';
      const beats = Array.isArray(obj.beats)
        ? obj.beats
            .filter((b: unknown): b is string => typeof b === 'string')
            .map((b: string) => tidy(b, MAX_BEAT_CHARS))
            .filter((b: string) => b.length > 0)
            .slice(0, BEAT_COUNT)
        : [];
      if (scene) return { scene, beats };
    } catch {
      // fall through to plain-text handling
    }
  }
  // Not JSON — strip fences/labels and use the lot as the scene.
  const t = raw
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .replace(/^(?:scene|video\s*prompt|prompt)\s*[:-]\s*/i, '')
    .trim();
  return { scene: tidy(t, MAX_SCENE_PROMPT_CHARS), beats: [] };
}

function systemPrompt(characterName: string): string {
  return `You are a prompt writer for an AI image+video pipeline. From the tail of a roleplay chat, describe the current moment as a short cinematic scene.

Return ONLY a JSON object, no prose or markdown fences:
{"scene": "...", "beats": ["...", "...", "..."]}

"scene" — one paragraph (50–100 words), present tense, third person, describing the setting, time of day, lighting/atmosphere, ${characterName}'s posture and expression, and the mood. This becomes a still keyframe.

"beats" — exactly ${BEAT_COUNT} short motion directions (one sentence each, ≤25 words), in order, that play as consecutive video shots and form an arc (e.g. an establishing wide, a slow move in, a final close hold). Each beat is ONE continuous motion a camera could film.

This is an uncensored adult platform. Depict the scene truthfully and at the level of intimacy the chat actually establishes — including undress, nudity, and physical/sexual contact — describing it plainly and physically (what is bare, what the bodies are doing) without euphemism or coyness. Do not escalate beyond what the chat shows, and do not invent intimacy the scene doesn't contain.

Critical rules:
- LITERAL ONLY. Translate any figurative or idiomatic language into plain physical motion. "cupping her jaw" → "his open hand rests gently against the side of her face". Never describe a body part as becoming an object. No metaphors, no similes.
- Only what a camera can see: movement, posture, gesture, expression, state of dress, light. No dialogue, no quotation marks, no thoughts, no smells.
- ${characterName}'s face and body come from a separate reference image — do not invent facial features, hair, or body type. Describe wardrobe and state of undress as the chat establishes them.
- Only consenting adults. Never depict minors.
- One clear action per beat. Keep each beat simple — the video model renders literal nouns, so avoid clutter.`;
}

function userPrompt(
  transcript: string,
  characterName: string,
  characterDescription?: string
): string {
  const desc = (characterDescription || '').trim().slice(0, MAX_DESCRIPTION_CHARS);
  const descBlock = desc
    ? `Character notes for ${characterName} (context only):\n${desc}\n\n`
    : '';
  return `${descBlock}Recent chat transcript:\n${transcript}\n\nJSON:`;
}

/**
 * Summarize the recent transcript into a scene description plus motion beats.
 * Throws on provider errors or an empty result — callers fall back to the raw
 * message text. Honors `signal` for cancellation (throws AbortError).
 */
export async function summarizeScene(
  messages: TranscriptMsg[],
  characterName: string,
  opts: SceneSummaryOptions = {}
): Promise<SceneSummary> {
  const { characterDescription, provider, model, signal } = opts;

  const transcript = transcriptTail(messages, characterName);
  if (!transcript) {
    throw new Error('No usable messages to summarize.');
  }

  const stream = await api.generateMessage(
    [
      { role: 'system', content: systemPrompt(characterName) },
      { role: 'user', content: userPrompt(transcript, characterName, characterDescription) },
    ],
    characterName,
    provider,
    model,
    signal,
    // Scene paragraph + a few beats as JSON; 700 tokens leaves slack
    // without letting a rambling model run long.
    { maxTokens: 700 }
  );

  if (!stream) {
    throw new Error('No response from the model.');
  }

  let raw = '';
  for await (const token of parseSSEStream(stream)) {
    raw += token;
  }

  const summary = parseSummary(raw);
  if (!summary.scene) {
    throw new Error('The model returned an empty scene prompt.');
  }
  return summary;
}
