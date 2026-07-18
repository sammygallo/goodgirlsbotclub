// Approximate tokenizer used for context budgeting.
// We do not ship a full BPE tokenizer on mobile; instead we use a
// character-to-token heuristic calibrated against common tokenizers.

// Rough heuristics:
//  - GPT-family: ~4 chars/token English
//  - Claude: ~3.5 chars/token English
//  - Gemini: ~4 chars/token English
//  - Mistral/Llama: ~3.5 chars/token English

export type TokenizerProfile =
  | 'gpt'
  | 'claude'
  | 'gemini'
  | 'llama'
  | 'generic';

function charsPerToken(profile: TokenizerProfile): number {
  switch (profile) {
    case 'gpt':
      return 4.0;
    case 'claude':
      return 3.6;
    case 'gemini':
      return 4.0;
    case 'llama':
      return 3.5;
    default:
      return 3.8;
  }
}

export function profileForProvider(provider: string): TokenizerProfile {
  switch (provider) {
    case 'openai':
    case 'groq':
    case 'mistralai':
    case 'openrouter':
      return 'gpt';
    case 'claude':
      return 'claude';
    case 'makersuite':
      return 'gemini';
    default:
      return 'generic';
  }
}

/**
 * Approximate the number of tokens in the given text.
 * Uses a character-based heuristic; good enough for context budgeting.
 */
export function estimateTokens(
  text: string,
  profile: TokenizerProfile = 'generic'
): number {
  if (!text) return 0;
  const cpt = charsPerToken(profile);
  // Word boundaries cost a bit more; add a small overhead per whitespace block.
  const whitespaceCount = (text.match(/\s+/g) || []).length;
  const base = Math.ceil(text.length / cpt);
  // Add small per-message overhead (role markers, separators)
  return base + Math.floor(whitespaceCount * 0.05);
}

export function estimateMessageTokens(
  message: { role: string; content: string },
  profile: TokenizerProfile = 'generic'
): number {
  // Per-message overhead: role marker, separators (~4 tokens in ChatML)
  return estimateTokens(message.content, profile) + 4;
}

export function estimateConversationTokens(
  messages: { role: string; content: string }[],
  profile: TokenizerProfile = 'generic'
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateMessageTokens(m, profile);
  }
  // Final priming tokens
  return total + 2;
}

// Default max context size per provider (in tokens)
export const DEFAULT_CONTEXT_SIZES: Record<string, number> = {
  openai: 16384,
  claude: 200000,
  makersuite: 32768,
  mistralai: 32768,
  groq: 8192,
  openrouter: 32768,
  cohere: 8192,
};

export function getDefaultContextSize(provider: string): number {
  return DEFAULT_CONTEXT_SIZES[provider] ?? 8192;
}

/**
 * Trim a list of history messages so that the total token budget is respected.
 * Keeps the system prompt, a configurable number of anchor/priority messages,
 * and as many recent messages as possible.
 *
 * @param systemPrompts  Messages that must always be kept (system prompts, anchors).
 * @param history        Historical user/assistant messages (oldest first).
 * @param responseReserve Tokens to reserve for the AI response.
 * @param maxTokens      Total token budget.
 * @param profile        Tokenizer profile.
 */
export function trimHistoryToBudget<
  T extends { role: string; content: string }
>(
  systemPrompts: T[],
  history: T[],
  responseReserve: number,
  maxTokens: number,
  profile: TokenizerProfile = 'generic'
): { kept: T[]; dropped: number; usedTokens: number; overBudget: boolean } {
  const budget = Math.max(256, maxTokens - responseReserve);
  const systemCost = systemPrompts.reduce(
    (acc, m) => acc + estimateMessageTokens(m, profile),
    0
  );
  let remaining = budget - systemCost - 2;

  // Walk from most recent to oldest, keeping what fits. The most recent
  // message (the user's just-sent turn) is ALWAYS kept, even when the system
  // block has eaten the whole budget — otherwise a long thread with a large
  // system block (accumulated summary + RAG) would drop every turn and ship a
  // turn-less request, which providers answer with an empty completion or a
  // 400. A degraded request the model can still respond to beats silence.
  // When that forced inclusion drives `remaining` negative, `overBudget`
  // tells the caller the assembled request may exceed the model's real
  // context window even though this function "succeeded".
  const kept: T[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const cost = estimateMessageTokens(msg, profile);
    if (kept.length > 0 && cost > remaining) break;
    kept.unshift(msg);
    remaining -= cost;
  }

  const dropped = history.length - kept.length;
  const usedTokens = budget - remaining;
  return { kept, dropped, usedTokens, overBudget: remaining < 0 };
}
