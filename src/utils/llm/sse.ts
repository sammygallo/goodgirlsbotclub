// Canonical SSE handling for the app's generation streams.
//
// This is the single implementation of the parser that grew as local copies
// in summarizeStore, autoMemoryStore, lorebookFromTranscript, and friends.
// It is the union of the richest variants: multi-shape content extraction
// (OpenAI chat/text deltas, Anthropic content_block_delta, bare `content`,
// `message.content[0].text`) plus mid-stream provider-error surfacing — a
// stream that carries an `error` payload throws instead of silently yielding
// nothing, so callers can't mistake a failed generation for an empty result.
//
// New one-off generation code should use `generateOnce` (./generate.ts)
// rather than calling these directly; the chat path (chatStore) keeps its
// own parser because it also tracks usage/emotion metadata inline.

/**
 * Optional out-param populated with the upstream provider's finish/stop
 * reason as it is observed in the stream.
 *
 * Lifted from `chatStore`'s own parser (which keeps its copy because it
 * also tracks usage/emotion inline) rather than invented here — the same
 * three-source read, so the two cannot disagree about what a provider
 * said. `null` after a completed read means the stream carried NO
 * terminal signal at all, which is a distinct outcome from "stopped
 * normally" and callers that care must treat it as such.
 */
export interface SSEStreamMeta {
  finishReason: string | null;
}

/** What a terminal signal means, once provider vocabularies are folded
 *  together. Deliberately four values, not a boolean: "ran out of output
 *  budget", "the provider refused", and "never said" are three different
 *  failures, and only the first is fixed by raising a cap. */
export type TerminalSignal = 'stop' | 'length' | 'other' | 'absent';

/** Terminal values meaning "the model finished on its own terms". */
const STOP_REASONS = new Set(['stop', 'end_turn', 'stop_sequence']);
/** Terminal values meaning "the output cap cut it off mid-sentence". */
const LENGTH_REASONS = new Set(['length', 'max_tokens']);

/**
 * Classify a raw finish reason.
 *
 * The backend normalizes Anthropic and Google into OpenAI's vocabulary
 * (`app/providers/anthropic.py`, `app/providers/google.py`), so `stop` /
 * `length` / `content_filter` is what usually arrives. The raw provider
 * spellings are accepted too, because OpenAI-family requests are a
 * passthrough and a `custom` profile can point at anything — including
 * an Anthropic endpoint proxied directly, which says `end_turn`.
 *
 * An unrecognized non-empty value is `'other'`, never `'stop'`: guessing
 * "it probably finished" is how a content-filter cutoff gets stored as a
 * finished piece of work.
 */
export function classifyFinishReason(
  raw: string | null | undefined
): TerminalSignal {
  if (!raw) return 'absent';
  const value = raw.trim().toLowerCase();
  if (!value) return 'absent';
  if (STOP_REASONS.has(value)) return 'stop';
  if (LENGTH_REASONS.has(value)) return 'length';
  return 'other';
}

/** Stream the text tokens out of a generation SSE stream. */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  meta?: SSEStreamMeta
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Last non-empty value wins: OpenAI-family streams carry
  // `finish_reason: null` on every content chunk and the real value on
  // the final one, so the falsy guard is what keeps those nulls from
  // erasing a reason that already arrived.
  const captureFinishReason = (
    json: Record<string, unknown>,
    choice: Record<string, unknown> | undefined
  ) => {
    if (!meta) return;
    const reason =
      (choice?.finish_reason as string | undefined) ||
      (json.stop_reason as string | undefined) ||
      ((json.delta as Record<string, unknown> | undefined)?.stop_reason as
        | string
        | undefined);
    if (reason) meta.finishReason = reason;
  };

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
          // BEFORE the content check, not after: a terminal chunk
          // carries a finish reason and NO content (that is what makes it
          // terminal), so capturing inside the `if (content)` below would
          // miss every one of them.
          captureFinishReason(json, json.choices?.[0]);
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
 * Read a generation stream to completion and return the full text.
 *
 * NOTE what this does not do: it returns whatever accumulated when the
 * reader reported done, with no completeness check. A severed connection
 * and a finished answer are indistinguishable from the return value
 * alone. Pass `meta` when that distinction matters — after the call,
 * `meta.finishReason === null` means the stream ended without ever
 * saying why.
 */
export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  meta?: SSEStreamMeta
): Promise<string> {
  let out = '';
  for await (const token of parseSSEStream(stream, meta)) out += token;
  return out;
}
