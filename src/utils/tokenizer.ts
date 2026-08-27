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

/**
 * The flat priming allowance `estimateConversationTokens` adds on top of the
 * per-message costs. Named rather than inlined because the token breakdown
 * reports it as its own reconciliation line (`PromptBreakdown.conversationPriming`)
 * — a consumer summing the breakdown's sections has to account for it, and
 * hardcoding a second copy of the number beside this one is how the two drift.
 */
export const CONVERSATION_PRIMING_TOKENS = 2;

export function estimateConversationTokens(
  messages: { role: string; content: string }[],
  profile: TokenizerProfile = 'generic'
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateMessageTokens(m, profile);
  }
  // Final priming tokens
  return total + CONVERSATION_PRIMING_TOKENS;
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
 * @param pinned         History messages (matched by identity) that must
 *                       always survive the trim — critical world-info
 *                       insertions, and the newest real chat turn (the
 *                       caller knows which element that is; role alone
 *                       can't distinguish a real turn from an injected
 *                       note). Their cost comes off the top, like the
 *                       system block.
 */
export function trimHistoryToBudget<
  T extends { role: string; content: string }
>(
  systemPrompts: T[],
  history: T[],
  responseReserve: number,
  maxTokens: number,
  profile: TokenizerProfile = 'generic',
  pinned?: ReadonlySet<T>
): { kept: T[]; dropped: number; usedTokens: number; overBudget: boolean } {
  const budget = Math.max(256, maxTokens - responseReserve);
  const systemCost = systemPrompts.reduce(
    (acc, m) => acc + estimateMessageTokens(m, profile),
    0
  );
  // The same priming allowance `estimateConversationTokens` charges — this is
  // what makes `usedTokens` comparable with it, and the token breakdown's
  // `trimTotal + stageC === assembledTotal` identity hold. Was a second copy
  // of the literal, which the identity would have silently lost if either
  // moved.
  let remaining = budget - systemCost - CONVERSATION_PRIMING_TOKENS;

  const keepFlags = new Array<boolean>(history.length).fill(false);
  let keptCount = 0;
  if (pinned && pinned.size > 0) {
    for (let i = 0; i < history.length; i++) {
      if (pinned.has(history[i])) {
        keepFlags[i] = true;
        keptCount += 1;
        remaining -= estimateMessageTokens(history[i], profile);
      }
    }
  }

  // Walk from most recent to oldest, keeping what fits. When nothing is
  // pinned, the newest message is ALWAYS kept, even when the system block
  // has eaten the whole budget — otherwise a long thread with a large
  // system block (accumulated summary + RAG) would drop every turn and ship
  // a turn-less request, which providers answer with an empty completion or
  // a 400. (Callers who inject trailing notes after the newest turn pin the
  // turn itself instead, so this fallback isn't fooled by an insertion.)
  // When forced inclusions or pinned messages drive `remaining` negative,
  // `overBudget` tells the caller the assembled request may exceed the
  // model's real context window even though this function "succeeded".
  // Once the contiguous recent window stops fitting, only pinned messages
  // survive from the older history.
  let broke = false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (keepFlags[i]) continue;
    if (broke) continue;
    const cost = estimateMessageTokens(history[i], profile);
    if (keptCount > 0 && cost > remaining) {
      broke = true;
      continue;
    }
    keepFlags[i] = true;
    keptCount += 1;
    remaining -= cost;
  }

  const kept: T[] = [];
  for (let i = 0; i < history.length; i++) {
    if (keepFlags[i]) kept.push(history[i]);
  }
  const dropped = history.length - kept.length;
  const usedTokens = budget - remaining;
  return { kept, dropped, usedTokens, overBudget: remaining < 0 };
}
