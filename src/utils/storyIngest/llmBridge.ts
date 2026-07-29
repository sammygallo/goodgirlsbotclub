// Model bridge for ingestion (story-state phase 6).
//
// Turns the app's streaming generation endpoint into the simple
// "messages in, text out" call the passes want. Kept out of the store so
// the passes stay unit-testable without a network, and out of chatStore
// so the ingestion path never pulls that module's init cycle in.

import { api } from '../../api/client';

/** Read a generation stream to completion. Mirrors the SSE handling used
 *  by the lorebook generator: tolerate non-JSON data lines, surface a
 *  mid-stream provider error rather than returning a silent truncation. */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let out = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (!data || data === '[DONE]') continue;

        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          if (data !== 'undefined') out += data;
          continue;
        }
        const obj = json as {
          error?: { message?: string } | string;
          choices?: { delta?: { content?: string }; text?: string }[];
        };
        if (obj?.error) {
          const message =
            typeof obj.error === 'string' ? obj.error : obj.error.message;
          throw new Error(message || 'The model returned an error');
        }
        const choice = obj?.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.text ?? '';
        if (piece) out += piece;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

export interface BridgeOptions {
  provider?: string;
  model?: string;
  characterName?: string;
  /** Only meaningful when provider === 'custom'. A saved custom profile
   *  carries its own endpoint, and ignoring it silently sends the
   *  request to whatever URL happens to be in settings. */
  customUrl?: string;
}

/**
 * Build the `LlmCall` the ingestion passes take.
 *
 * Every call goes through the same proxy a chat message does, so it runs
 * on the user's own key with their own provider — the BYO-key constraint
 * holds without any new backend surface.
 */
export function makeLlmCall(opts: BridgeOptions = {}) {
  return async function callModel(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    { maxTokens, signal }: { maxTokens?: number; signal?: AbortSignal } = {}
  ): Promise<string> {
    const stream = await api.generateMessage(
      messages,
      opts.characterName || 'Story',
      opts.provider,
      opts.model,
      signal,
      {
        maxTokens: maxTokens ?? 1024,
        ...(opts.provider === 'custom' && opts.customUrl
          ? { customUrl: opts.customUrl }
          : {}),
      }
    );
    if (!stream) throw new Error('No response from the model');
    return readStream(stream);
  };
}
