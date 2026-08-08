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

/** Stream the text tokens out of a generation SSE stream. */
export async function* parseSSEStream(
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

/** Read a generation stream to completion and return the full text. */
export async function collectStream(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  let out = '';
  for await (const token of parseSSEStream(stream)) out += token;
  return out;
}
