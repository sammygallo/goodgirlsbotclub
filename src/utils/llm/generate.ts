// One-off "messages in, text out" generation for utility features (AI
// helpers, card tooling, ingestion, transcript extraction).
//
// Promotion of storyIngest's makeLlmCall: every call goes through the same
// proxy a chat message does, so it runs on the user's own key with their
// own provider — the BYO-key invariant holds with no new backend surface.
// Chat turns do NOT use this; chatStore owns its richer streaming path.

import { api } from '../../api/client';
import { classifyFinishReason, collectStream, type SSEStreamMeta, type TerminalSignal } from './sse';
import { getProviderAndModel } from './resolve';

export interface GenerateOnceOptions {
  /** Explicit provider/model; defaults to the resolved active pair
   *  (including the Claude-only-key auto-switch in resolve.ts). */
  provider?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Only meaningful when provider === 'custom'. A saved custom profile
   *  carries its own endpoint, and ignoring it silently sends the
   *  request to whatever URL happens to be in settings. */
  customUrl?: string;
  /** Shown as the "character name" in request metadata/usage accounting. */
  label?: string;
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface GenerationResult {
  text: string;
  /** The provider's raw finish/stop reason, or null if the stream never
   *  carried one. Kept alongside the classification so an unexpected
   *  value can be reported to the user verbatim. */
  finishReason: string | null;
  terminal: TerminalSignal;
}

/**
 * Run one generation and return the text WITH the stream's terminal
 * signal.
 *
 * Callers that store or export the output must use this rather than
 * `generateOnce`, and must treat anything other than `terminal === 'stop'`
 * as incomplete. The reason is that a truncated generation is invisible
 * in the text: prose has no parser, so a chapter cut mid-sentence at the
 * output cap looks exactly like a chapter that ended. The existing JSON
 * passes get away with ignoring this only because their output has to
 * parse — `extractJsonObjects` skips a truncated final object, and the
 * walk retries once.
 *
 * `terminal: 'absent'` is a real and expected outcome, not a defensive
 * branch: `collectStream` returns whatever accumulated when the reader
 * reported done, Anthropic's envelope only arrives on a `message_delta`
 * carrying `stop_reason`, OpenAI-family requests are a passthrough, and a
 * `custom` profile can point anywhere. A severed stream produces exactly
 * this, and calling it complete is the failure this function exists to
 * prevent.
 */
export async function generateOnceDetailed(
  messages: ChatMessage[],
  opts: GenerateOnceOptions = {}
): Promise<GenerationResult> {
  let { provider, model } = opts;
  if (!provider || !model) {
    const resolved = getProviderAndModel();
    provider = provider || resolved.provider;
    model = model || resolved.model;
  }

  const stream = await api.generateMessage(
    messages,
    opts.label || 'Assistant',
    provider,
    model,
    opts.signal,
    {
      maxTokens: opts.maxTokens ?? 1024,
      ...(provider === 'custom' && opts.customUrl
        ? { customUrl: opts.customUrl }
        : {}),
    }
  );
  if (!stream) throw new Error('No response from the model');

  const meta: SSEStreamMeta = { finishReason: null };
  const text = await collectStream(stream, meta);
  return {
    text,
    finishReason: meta.finishReason,
    terminal: classifyFinishReason(meta.finishReason),
  };
}

/**
 * Run one generation to completion and return the text.
 *
 * Throws on a null stream or a mid-stream provider error. It does NOT
 * throw on a truncation — the output cap cutting a response short is
 * silent here, and always has been. Callers whose output must be
 * complete want `generateOnceDetailed`.
 */
export async function generateOnce(
  messages: ChatMessage[],
  opts: GenerateOnceOptions = {}
): Promise<string> {
  const { text } = await generateOnceDetailed(messages, opts);
  return text;
}
