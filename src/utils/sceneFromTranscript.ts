/**
 * Scene-from-transcript — distill the tail of a chat into a single
 * video-generation prompt for the scene-video pipeline.
 *
 * One model call via the user's active provider (same `api.generateMessage`
 * SSE path as lorebookFromTranscript). The output is plain text: a compact
 * visual description (setting, light, what the character is doing, mood)
 * that the backend forwards to Replicate's reference-to-video model. The
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
/** Cap on the returned prompt; the backend trims again at 1500. */
const MAX_SCENE_PROMPT_CHARS = 1200;
/** Cap on the character-description excerpt included for context. */
const MAX_DESCRIPTION_CHARS = 600;

export interface SceneSummaryOptions {
  /** Character card description — wardrobe/setting context for the model. */
  characterDescription?: string;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
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

/** Strip fences/labels/quotes the model may wrap around the prompt. */
function cleanPromptText(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  t = t.replace(/^(?:video\s*prompt|prompt|scene)\s*[:-]\s*/i, '').trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1);
  }
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_SCENE_PROMPT_CHARS) {
    const cut = t.slice(0, MAX_SCENE_PROMPT_CHARS);
    const sp = cut.lastIndexOf(' ');
    t = sp > 0 ? cut.slice(0, sp) : cut;
  }
  return t;
}

function systemPrompt(characterName: string): string {
  return `You are a prompt writer for an AI video model. From the tail of a roleplay chat, write ONE prompt describing the current moment as a short cinematic scene.

Rules:
- Output ONLY the prompt text — no preamble, no quotes, no markdown, no lists.
- 60–120 words, present tense, third person.
- Cover: the setting and time of day, lighting and atmosphere, what ${characterName} is physically doing (movement, posture, expression, gestures), and the mood. At most one camera hint (e.g. slow push-in).
- ${characterName}'s face and body come from a separate reference image — do not invent facial features, hair, or body details; mention wardrobe only if the chat establishes it.
- No dialogue or quotation marks. No inner thoughts. Only what a camera could film.`;
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
  return `${descBlock}Recent chat transcript:\n${transcript}\n\nVideo prompt:`;
}

/**
 * Summarize the recent transcript into a scene prompt. Throws on provider
 * errors or an empty result — callers fall back to the raw message text.
 * Honors `signal` for cancellation (throws the standard AbortError).
 */
export async function summarizeScene(
  messages: TranscriptMsg[],
  characterName: string,
  opts: SceneSummaryOptions = {}
): Promise<string> {
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
    // A scene prompt is ~120 words; 400 tokens leaves slack without
    // letting a rambling model run long.
    { maxTokens: 400 }
  );

  if (!stream) {
    throw new Error('No response from the model.');
  }

  let raw = '';
  for await (const token of parseSSEStream(stream)) {
    raw += token;
  }

  const prompt = cleanPromptText(raw);
  if (!prompt) {
    throw new Error('The model returned an empty scene prompt.');
  }
  return prompt;
}
