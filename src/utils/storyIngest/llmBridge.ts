// Model bridge for ingestion (story-state phase 6).
//
// Turns the app's streaming generation endpoint into the simple
// "messages in, text out" call the passes want. Kept out of the store so
// the passes stay unit-testable without a network, and out of chatStore
// so the ingestion path never pulls that module's init cycle in.

import { generateOnce } from '../llm/generate';

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
    return generateOnce(messages, {
      provider: opts.provider,
      model: opts.model,
      label: opts.characterName || 'Story',
      maxTokens: maxTokens ?? 1024,
      signal,
      customUrl: opts.customUrl,
    });
  };
}
