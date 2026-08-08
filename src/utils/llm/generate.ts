// One-off "messages in, text out" generation for utility features (AI
// helpers, card tooling, ingestion, transcript extraction).
//
// Promotion of storyIngest's makeLlmCall: every call goes through the same
// proxy a chat message does, so it runs on the user's own key with their
// own provider — the BYO-key invariant holds with no new backend surface.
// Chat turns do NOT use this; chatStore owns its richer streaming path.

import { api } from '../../api/client';
import { collectStream } from './sse';
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

/** Run one generation to completion and return the text. Throws on a null
 *  stream or a mid-stream provider error (never a silent truncation). */
export async function generateOnce(
  messages: ChatMessage[],
  opts: GenerateOnceOptions = {}
): Promise<string> {
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
  return collectStream(stream);
}
