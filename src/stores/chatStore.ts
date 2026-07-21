import { create } from 'zustand';
import {
  api,
  apiRequest,
  getCsrfToken,
  ChatConflictError,
  type CharacterInfo,
  type GenerationOptions,
  type GenerationImage,
} from '../api/client';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';
import { useSettingsStore } from './settingsStore';
import { usePersonaStore } from './personaStore';
import {
  useGenerationStore,
  POST_HISTORY_SECTIONS,
  type PromptSectionId,
} from './generationStore';
import { useCharacterStore } from './characterStore';
import {
  useWorldInfoStore,
  scanMessagesForEntries,
  loadWiTimers,
  saveWiTimers,
  type WorldInfoPosition,
  type MatchedEntry,
} from './worldInfoStore';
import { parseEmotion, stripEmotionTag, type Emotion } from '../utils/emotions';
import { dataUrlToPart, supportsVision } from '../utils/images';
import { processMacros, type MacroContext } from '../utils/macros';
import {
  estimateConversationTokens,
  estimateTokens,
  profileForProvider,
  trimHistoryToBudget,
} from '../utils/tokenizer';
import { useUsageStore } from './usageStore';
import { usePromptTemplateStore } from './promptTemplateStore';
import { getInstructTemplate, formatInstructPrompt } from '../utils/instructTemplates';
import { useRegexScriptStore } from './regexScriptStore';
import { applyRegexScripts, getActiveScripts } from '../utils/regexScripts';
import { useDataBankStore } from './dataBankStore';
import { useSummarizeStore } from './summarizeStore';
import { useChatHistoryRagStore } from './chatHistoryRagStore';
import { extensionRegistry } from '../extensions/registry';
import type { ContextContribution } from '../extensions/types';
import { useAuthStore } from './authStore';
import { showToastGlobal } from '../components/ui/Toast';
import { parseChatTranscript, toSaveChatPayload } from '../utils/chatTranscript';

// Resolve the display name for the current user: active persona → auth user name → fallback.
function getUserDisplayName(characterAvatar?: string): string {
  const persona = usePersonaStore.getState().getPersonaForContext(characterAvatar);
  if (persona?.name) return persona.name;
  const authName = useAuthStore.getState().currentUser?.name;
  if (authName) return authName;
  return 'User';
}

/**
 * Estimated token usage for a single assistant turn.
 *
 * v1 is tokens-only and client-estimated — the app ships a char-heuristic
 * tokenizer (not real BPE) and the backend does not echo usage, so figures are
 * approximate and surfaced with a leading "~". `source` and `costUsd` are
 * reserved so measured usage and a dollar readout can slot in later without a
 * storage migration. Persisted per message in the JSONL `extra.usage` field.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  source: 'estimated' | 'measured';
  provider?: string;
  model?: string;
  /** Reserved for a future dollar readout; undefined in tokens-only v1. */
  costUsd?: number;
}

export interface ChatMessage {
  id: string;
  name: string;
  isUser: boolean;
  isSystem: boolean;
  content: string;
  timestamp: number;
  emotion?: Emotion | null;
  characterAvatar?: string;
  swipes: string[];
  swipeId: number;
  /** Estimated token usage for this assistant turn (AI messages only).
   *  Drives the per-turn cost chip; recorded at generation finalize and
   *  persisted into the JSONL record's `extra.usage` field. */
  usage?: TokenUsage;
  /** Phase 6.1: user-attached images as data URLs (e.g. data:image/jpeg;base64,...).
   *  Rendered as a grid above content in ChatMessage.tsx and folded into the
   *  provider's multimodal content parts on the LAST user turn when calling
   *  generateMessage. Persisted into the JSONL record's `extra.images` field. */
  images?: string[];
  /** Scene-video: generated MP4 URLs (served from /blobs/scene-video/...).
   *  Rendered as inline <video> players above content in ChatMessage.tsx.
   *  Persisted into the JSONL record's `extra.videos` field. Never sent to
   *  the LLM. */
  videos?: string[];
}

interface ChatFile {
  fileName: string;
  /** Real (non-header) message count. Replaces the legacy `fileSize`
   *  field that was just the JSONL byte count from ST and never
   *  actually rendered. */
  messageCount: number;
  lastMessage: string;
}

/**
 * Strategies that decide which group-chat member(s) respond on each user turn.
 * - list: every member speaks in order (legacy behavior, preserved as default).
 * - natural: pick the member mentioned in the last message, else weighted roll
 *   by talkativeness. Exactly one member responds.
 * - pooled: weighted random pick from the pool, excluding the N most recent
 *   speakers. Exactly one member responds.
 * - manual: no auto-selection; user must force-talk a specific member.
 */
export type GroupActivationStrategy = 'list' | 'natural' | 'pooled' | 'manual';

export const DEFAULT_GROUP_ACTIVATION_STRATEGY: GroupActivationStrategy = 'list';
export const DEFAULT_POOLED_EXCLUDE_RECENT = 1;
export const DEFAULT_AUTO_MODE_DELAY_MS = 1500;

/**
 * Phase 5.3 — how character cards are laid out in a group chat system prompt.
 *
 * - `swap` (default): only the currently speaking character's full info is
 *   injected; other members get a one-line bullet with description +
 *   personality. Lower token cost; the active speaker "swaps in" each turn.
 * - `join`: every member gets a full block (description, personality,
 *   scenario, example dialogue). The current speaker's block is prefixed with
 *   `[SPEAKING NOW]`. Higher token cost but the model has full context on all
 *   characters at once, letting it react consistently to their backstories.
 */
export type GroupCardMode = 'swap' | 'join';

export const DEFAULT_GROUP_CARD_MODE: GroupCardMode = 'swap';

export interface GroupChatInfo {
  fileName: string;
  characterNames: string[];
  characterAvatars: string[];
  lastMessage: string;
  createdAt: number;
  /** How the next speaker is chosen each turn. Added in Phase 5.1. */
  activationStrategy: GroupActivationStrategy;
  /** Avatars of members whose turns are skipped. Added in Phase 5.1. */
  mutedAvatars: string[];
  /** Recent-speaker exclusion window for pooled strategy (N≥0). */
  pooledExcludeRecent: number;
  /** Phase 5.2: auto-continue generation after each AI turn. */
  autoModeEnabled: boolean;
  /** Phase 5.2: delay between auto-mode turns in milliseconds. */
  autoModeDelayMs: number;
  /** Phase 5.2: optional group-wide scenario replacing per-character scenario. */
  scenarioOverride: string;
  /** Phase 5.3: per-member talkativeness override (avatar → [0,1]). Does not
   *  mutate the card; only applies inside this group for weighted strategies. */
  talkativenessOverrides: Record<string, number>;
  /** Phase 5.3: user-editable chat title. Falls back to comma-joined names. */
  title?: string;
  /** Phase 5.3: how member cards are laid out in the system prompt. */
  cardMode: GroupCardMode;
}

/** Phase 8.1: per-chat Author's Note — a persistent instruction that gets
 *  injected into the AI prompt at a configurable depth from the end of the
 *  conversation history. Stored in localStorage keyed by chat file name. */
export interface AuthorNote {
  content: string;
  depth: number;
  role: 'system' | 'user' | 'assistant';
}

const AUTHOR_NOTES_KEY = 'sillytavern_author_notes';

// ---------------------------------------------------------------------------
// A3.1b2: cross-device sync for chat metadata
//
// One section, three sub-fields. The save helpers below (saveAuthorNotes…,
// saveChatVariables…, saveGroupChats…) each touch their own localStorage key
// AND update _latestSnapshot before scheduling a debounced PUT — so every
// existing mutation in the store gets sync for free without per-callsite
// changes.
// ---------------------------------------------------------------------------

const SERVER_KEY = 'stm_chat_state';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

interface ChatStateSnapshot {
  authorNotes: Record<string, AuthorNote>;
  groupChats: GroupChatInfo[];
  chatVariables: Record<string, Record<string, string>>;
}

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
const _latestSnapshot: ChatStateSnapshot = {
  authorNotes: {},
  groupChats: [],
  chatVariables: {},
};

function schedulePersist(): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      { ..._latestSnapshot } as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
}

function loadAuthorNotesFromStorage(): Record<string, AuthorNote> {
  try {
    const stored = localStorage.getItem(AUTHOR_NOTES_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveAuthorNotesToStorage(notes: Record<string, AuthorNote>) {
  localStorage.setItem(AUTHOR_NOTES_KEY, JSON.stringify(notes));
  _latestSnapshot.authorNotes = notes;
  schedulePersist();
}

/**
 * Phase 9.3: per-chat variable storage. Keyed by chat file name, each value is
 * a flat map of variable-name → string value. Populated and mutated by the
 * `{{setvar}}` / `{{addvar}}` / `{{incvar}}` / `{{decvar}}` macros.
 */
const CHAT_VARIABLES_KEY = 'stm:chat-vars';

function loadChatVariablesFromStorage(): Record<string, Record<string, string>> {
  try {
    const stored = localStorage.getItem(CHAT_VARIABLES_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveChatVariablesToStorage(vars: Record<string, Record<string, string>>) {
  try {
    localStorage.setItem(CHAT_VARIABLES_KEY, JSON.stringify(vars));
  } catch {
    // ignore quota
  }
  _latestSnapshot.chatVariables = vars;
  schedulePersist();
}

const GROUP_CHATS_KEY = 'sillytavern_group_chats';

/**
 * Fill defaults for pre-Phase-5.1 records so the rest of the code can assume
 * the new fields are always present.
 */
function migrateGroupChat(raw: Partial<GroupChatInfo> & {
  fileName: string;
  characterNames: string[];
  characterAvatars: string[];
}): GroupChatInfo {
  return {
    fileName: raw.fileName,
    characterNames: raw.characterNames ?? [],
    characterAvatars: raw.characterAvatars ?? [],
    lastMessage: raw.lastMessage ?? '',
    createdAt: raw.createdAt ?? Date.now(),
    activationStrategy:
      raw.activationStrategy === 'natural' ||
      raw.activationStrategy === 'pooled' ||
      raw.activationStrategy === 'list' ||
      raw.activationStrategy === 'manual'
        ? raw.activationStrategy
        : DEFAULT_GROUP_ACTIVATION_STRATEGY,
    mutedAvatars: Array.isArray(raw.mutedAvatars) ? raw.mutedAvatars : [],
    pooledExcludeRecent:
      typeof raw.pooledExcludeRecent === 'number' && raw.pooledExcludeRecent >= 0
        ? Math.floor(raw.pooledExcludeRecent)
        : DEFAULT_POOLED_EXCLUDE_RECENT,
    autoModeEnabled:
      typeof raw.autoModeEnabled === 'boolean' ? raw.autoModeEnabled : false,
    autoModeDelayMs:
      typeof raw.autoModeDelayMs === 'number' && raw.autoModeDelayMs >= 0
        ? Math.floor(raw.autoModeDelayMs)
        : DEFAULT_AUTO_MODE_DELAY_MS,
    scenarioOverride:
      typeof raw.scenarioOverride === 'string' ? raw.scenarioOverride : '',
    talkativenessOverrides: sanitizeTalkativenessOverrides(
      (raw as Partial<GroupChatInfo>).talkativenessOverrides
    ),
    title:
      typeof (raw as Partial<GroupChatInfo>).title === 'string'
        ? (raw as Partial<GroupChatInfo>).title
        : undefined,
    cardMode:
      raw.cardMode === 'join' || raw.cardMode === 'swap'
        ? raw.cardMode
        : DEFAULT_GROUP_CARD_MODE,
  };
}

function sanitizeTalkativenessOverrides(
  raw: unknown
): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !isFinite(value)) continue;
    const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
    out[key] = clamped;
  }
  return out;
}

function loadGroupChatsFromStorage(): GroupChatInfo[] {
  try {
    const stored = localStorage.getItem(GROUP_CHATS_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(migrateGroupChat);
  } catch {
    return [];
  }
}

function saveGroupChatsToStorage(groupChats: GroupChatInfo[]) {
  localStorage.setItem(GROUP_CHATS_KEY, JSON.stringify(groupChats));
  _latestSnapshot.groupChats = groupChats;
  schedulePersist();
}

/** Parse the per-character "talkativeness" extension, clamped to [0, 1].
 *  Falls back to 0.5 when absent, not a number, or out of range.
 *
 *  Phase 5.3: optional `override` (0..1) wins when supplied — this is how
 *  group-level talkativeness sliders take effect without mutating the card. */
export function getTalkativeness(
  character: CharacterInfo,
  override?: number
): number {
  if (typeof override === 'number' && isFinite(override)) {
    if (override < 0) return 0;
    if (override > 1) return 1;
    return override;
  }
  const raw = character.data?.extensions?.talkativeness;
  if (typeof raw !== 'string') return 0.5;
  const n = parseFloat(raw);
  if (!isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Weighted random pick using talkativeness. Falls back to uniform when all
 *  weights are zero or the pool has a single entry.
 *
 *  Phase 5.3: `overrides` (avatar → weight) lets the caller inject group-scope
 *  talkativeness values without mutating the card. */
function weightedRandomPick(
  pool: CharacterInfo[],
  overrides: Record<string, number> | undefined,
  rng: () => number = Math.random
): CharacterInfo | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const weights = pool.map((c) => getTalkativeness(c, overrides?.[c.avatar]));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return pool[Math.floor(rng() * pool.length)];
  }
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Natural Order: pick the character whose name appears in the last
 *  non-system message. If multiple match, weighted roll within the matches.
 *  If none match, weighted roll across the full pool. */
export function selectNaturalOrderSpeaker(
  candidates: CharacterInfo[],
  messages: ChatMessage[],
  overrides?: Record<string, number>,
  rng: () => number = Math.random
): CharacterInfo | null {
  if (candidates.length === 0) return null;

  const lastMeaningful = [...messages].reverse().find((m) => !m.isSystem);
  if (!lastMeaningful || !lastMeaningful.content.trim()) {
    return weightedRandomPick(candidates, overrides, rng);
  }

  const haystack = lastMeaningful.content;
  const mentioned = candidates.filter((c) => {
    const name = (c.name || '').trim();
    if (!name) return false;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
    return pattern.test(haystack);
  });

  if (mentioned.length === 0) {
    return weightedRandomPick(candidates, overrides, rng);
  }
  return weightedRandomPick(mentioned, overrides, rng);
}

/** Pooled Order: weighted random pick from the candidates, excluding
 *  the N most recent distinct AI speakers. If exclusion empties the pool
 *  the full candidate set is used as a safety fallback. */
export function selectPooledOrderSpeaker(
  candidates: CharacterInfo[],
  messages: ChatMessage[],
  excludeRecent: number,
  overrides?: Record<string, number>,
  rng: () => number = Math.random
): CharacterInfo | null {
  if (candidates.length === 0) return null;
  const n = Math.max(0, Math.floor(excludeRecent));
  if (n === 0) return weightedRandomPick(candidates, overrides, rng);

  const recent: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recent.length < n; i--) {
    const m = messages[i];
    if (m.isUser || m.isSystem) continue;
    if (!recent.includes(m.name)) recent.push(m.name);
  }

  const pool = candidates.filter((c) => !recent.includes(c.name));
  if (pool.length === 0) return weightedRandomPick(candidates, overrides, rng);
  return weightedRandomPick(pool, overrides, rng);
}

interface ChatState {
  messages: ChatMessage[];
  chatFiles: ChatFile[];
  groupChats: GroupChatInfo[];
  currentChatFile: string | null;
  isLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  error: string | null;
  abortController: AbortController | null;
  /** Phase 5.3: name of the character currently drafting a reply, surfaced
   *  in the group-chat typing indicator. `null` when nobody is typing. */
  currentSpeakerName: string | null;

  // Existing actions
  fetchChatFiles: (avatarUrl: string) => Promise<void>;
  loadChat: (avatarUrl: string, fileName: string) => Promise<void>;
  loadGroupChat: (groupChat: GroupChatInfo) => Promise<void>;
  startNewChat: (character: CharacterInfo) => Promise<void>;
  startNewGroupChat: (characters: CharacterInfo[]) => Promise<void>;
  addMessage: (message: Omit<ChatMessage, 'id' | 'swipes' | 'swipeId'>) => void;
  sendMessage: (
    content: string,
    character: CharacterInfo,
    availableEmotions?: string[],
    images?: string[]
  ) => Promise<void>;
  sendGroupMessage: (
    content: string,
    characters: CharacterInfo[],
    images?: string[]
  ) => Promise<void>;
  /** Phase 5.2: force a single member to respond next, bypassing strategy + mute. */
  forceGroupMemberTalk: (character: CharacterInfo, characters: CharacterInfo[]) => Promise<void>;
  editMessageAndRegenerate: (messageId: string, newContent: string, character: CharacterInfo, availableEmotions?: string[]) => Promise<void>;
  clearChat: () => void;
  refreshGroupChats: () => void;
  deleteGroupChat: (fileName: string) => void;
  convertCurrentToGroup: (currentCharacter: CharacterInfo, additionalCharacters: CharacterInfo[]) => Promise<void>;

  // Phase 5.1: activation strategies + per-member mute
  setGroupActivationStrategy: (fileName: string, strategy: GroupActivationStrategy) => void;
  toggleGroupMute: (fileName: string, avatar: string) => void;
  setGroupPooledExcludeRecent: (fileName: string, n: number) => void;
  getGroupChatByFile: (fileName: string) => GroupChatInfo | null;

  // Phase 5.2: auto-mode, reorder, scenario override
  setGroupAutoMode: (fileName: string, enabled: boolean) => void;
  setGroupAutoModeDelay: (fileName: string, delayMs: number) => void;
  setGroupScenarioOverride: (fileName: string, scenario: string) => void;
  reorderGroupMembers: (fileName: string, avatars: string[]) => void;

  // Phase 5.3: per-member talkativeness overrides, title, live add/remove, card mode
  setGroupTalkativenessOverride: (
    fileName: string,
    avatar: string,
    value: number | null
  ) => void;
  setGroupTitle: (fileName: string, title: string) => void;
  addGroupChatMember: (fileName: string, character: CharacterInfo) => void;
  removeGroupChatMember: (fileName: string, avatar: string) => void;
  setGroupCardMode: (fileName: string, mode: GroupCardMode) => void;

  // Phase 8.1: Author's Note
  authorNotes: Record<string, AuthorNote>;
  getAuthorNote: (fileName: string) => AuthorNote | null;
  setAuthorNote: (fileName: string, note: Partial<AuthorNote>) => void;

  // Phase 9.3: per-chat variables consumed by the macro system
  chatVariables: Record<string, Record<string, string>>;
  getChatVariables: (fileName: string) => Record<string, string>;
  setChatVariables: (fileName: string, vars: Record<string, string>) => void;

  // Phase 8.6: load a branch snapshot into memory (does not save to disk)
  loadBranchMessages: (messages: ChatMessage[]) => void;

  // New Phase 1 actions
  stopGeneration: () => void;
  editMessage: (messageId: string, newContent: string) => void;
  deleteMessage: (messageId: string) => void;
  swipeLeft: (messageId: string) => void;
  swipeRight: (messageId: string, character: CharacterInfo, availableEmotions?: string[]) => Promise<void>;
  regenerateMessage: (character: CharacterInfo, availableEmotions?: string[]) => Promise<void>;
  continueMessage: (character: CharacterInfo, availableEmotions?: string[]) => Promise<void>;
  impersonate: (character: CharacterInfo, availableEmotions?: string[]) => Promise<string>;
  deleteChat: (avatarUrl: string, fileName: string) => Promise<void>;
  renameChat: (avatarUrl: string, originalFile: string, renamedFile: string) => Promise<void>;
  importChat: (avatarUrl: string, characterName: string, file: File) => Promise<void>;
  insertImageMessage: (
    dataUrl: string,
    prompt: string,
    characterName: string,
    characterAvatar: string,
    character: CharacterInfo
  ) => Promise<void>;
  insertVideoMessage: (
    videoUrl: string,
    characterName: string,
    characterAvatar: string,
    character: CharacterInfo
  ) => Promise<void>;

  /**
   * A3.1b2 — pull author notes, group chats, and per-chat variables from
   * /sync/section/stm_chat_state and reconcile with localStorage. On first
   * call per user with no server record, seeds the server with whatever is
   * already in localStorage so pre-A3 state survives the cutover.
   */
  fetchPrefs: () => Promise<void>;
  /** Wipe chat state + localStorage keys for the current user (logout/switch). */
  resetUser: () => void;
}

let messageIdCounter = 0;
const generateId = () => `msg_${++messageIdCounter}_${Date.now()}`;

// Optional out-param populated with the upstream provider's finish/stop
// reason (e.g. "length", "content_filter", "stop") as it's observed in the
// stream, so callers can tell an over-length cutoff from a content-filter
// refusal instead of just seeing "empty response" either way.
type SSEStreamMeta = { finishReason: string | null };

// Parse SSE stream and extract content tokens
async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  meta?: SSEStreamMeta
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const captureFinishReason = (json: Record<string, unknown>, choice: Record<string, unknown> | undefined) => {
    if (!meta) return;
    const reason =
      (choice?.finish_reason as string | undefined) ||
      (json.stop_reason as string | undefined) ||
      ((json.delta as Record<string, unknown> | undefined)?.stop_reason as string | undefined);
    if (reason) meta.finishReason = reason;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (!data || data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            captureFinishReason(json, choice);
            const content =
              choice?.delta?.content ||
              choice?.text ||
              json.delta?.text ||
              (json.type === 'content_block_delta' ? json.delta?.text : null) ||
              json.content ||
              json.message?.content?.[0]?.text ||
              '';
            if (content) yield content;
          } catch {
            if (data.length > 0 && data !== 'undefined') yield data;
          }
        } else if (!trimmed.startsWith(':') && !trimmed.startsWith('event:')) {
          if (trimmed.length > 0) yield trimmed;
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data && data !== '[DONE]') {
          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];
            captureFinishReason(json, choice);
            const content = choice?.delta?.content ||
                           choice?.text ||
                           json.delta?.text ||
                           json.content || '';
            if (content) yield content;
          } catch {
            yield data;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Build the empty-response error message, distinguishing an over-length
// cutoff or content-filter refusal (when the upstream reason is known) from
// a request whose newest message alone blew the local token budget, falling
// back to the given generic message otherwise.
// `retryAction` completes "..., then <retryAction>." (e.g. "tap send again").
// `maxTokens` and `overBudget` must be the values captured at dispatch time
// (the request that actually produced this empty response), not re-read from
// generationStore live — the sampler and trim-budget flag are shared mutable
// state that a concurrent send/swipe/chat-switch can overwrite before this
// stream resolves.
function buildEmptyResponseError(
  genericMessage: string,
  retryAction: string,
  finishReason: string | null,
  maxTokens: number,
  overBudget: boolean
): string {
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    // finish_reason: length means the OUTPUT cap (sampler.maxTokens, aka
    // "Max Response Tokens" / Response Length in Settings → Generation) was
    // hit before any visible content came out — a completely different knob
    // from the context/input budget. Reasoning-capable models can burn the
    // whole cap on hidden reasoning tokens with nothing visible left over,
    // which shows up easily under a Quick Chat Style like Natural Chat that
    // caps replies at 400 tokens.
    const cap = maxTokens;
    const styleHint = cap <= 512
      ? ' A Chat Style with a short response cap (e.g. Natural Chat) may be active for this chat — check Chat Style in the chat options menu.'
      : '';
    return `The model ran out of its response token budget (currently ${cap}) before writing any visible reply.${styleHint} Raise Max Response Tokens in Settings → Generation → Response Length, then ${retryAction}.`;
  }
  if (finishReason === 'content_filter') {
    return `The response was blocked by the provider's content filter. Try rewording your message, then ${retryAction}.`;
  }
  if (overBudget) {
    return `Your message may be too long for the current context window. Try raising Max Context Tokens in Settings → Generation, or shortening your message, then ${retryAction}.`;
  }
  return genericMessage;
}

/**
 * Record one finished generation for the usage gauge AND build the per-message
 * usage snapshot shown as a cost chip.
 *
 * Called once per *generation* so every send / swipe / regenerate / continue /
 * group-member turn counts toward the lifetime + budget odometers (the
 * "count every generation" decision) — even swipes that get discarded, since
 * those tokens were really spent.
 *
 * Input tokens come from the prompt size computed at context-assembly time
 * (`lastTokenEstimate`); the group path doesn't populate that, so it passes an
 * explicit override. Output is estimated from the completion text. Pass
 * `chipOutputText` when the gauge and the chip should differ (continue: the
 * gauge counts only the freshly streamed tokens, but the chip reflects the
 * whole bubble).
 */
function recordTurnUsage(
  provider: string,
  model: string,
  completion: string,
  opts?: { inputTokensOverride?: number; chipOutputText?: string },
): TokenUsage {
  const profile = profileForProvider(provider);
  const inputTokens = Math.max(
    0,
    Math.round(opts?.inputTokensOverride ?? useGenerationStore.getState().lastTokenEstimate ?? 0),
  );
  const generatedTokens = estimateTokens(completion, profile);
  // The gauge counts the tokens this call actually spent.
  useUsageStore.getState().recordGeneration(inputTokens, generatedTokens);
  // The chip reflects the visible bubble (whole content for a continue).
  const chipOutputTokens =
    opts?.chipOutputText !== undefined
      ? estimateTokens(opts.chipOutputText, profile)
      : generatedTokens;
  return { inputTokens, outputTokens: chipOutputTokens, source: 'estimated', provider, model };
}

// Resolve advanced character fields (checks both top-level and data.*)
function getCharacterField(character: CharacterInfo, field: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (character as any)[field];
  if (typeof top === 'string' && top.trim()) return top;
  const data = character.data as Record<string, unknown> | undefined;
  const nested = data?.[field];
  if (typeof nested === 'string' && nested.trim()) return nested;
  return '';
}

function getAlternateGreetings(character: CharacterInfo): string[] {
  return (
    character.alternate_greetings || character.data?.alternate_greetings || []
  ).filter((g) => g && g.trim());
}

function getDepthPrompt(character: CharacterInfo): {
  prompt: string;
  depth: number;
  role: 'system' | 'user' | 'assistant';
} | null {
  const dp = character.data?.extensions?.depth_prompt;
  if (!dp || !dp.prompt?.trim()) return null;
  return {
    prompt: dp.prompt,
    depth: dp.depth ?? 4,
    role: (dp.role as 'system' | 'user' | 'assistant') || 'system',
  };
}

// Build full macro context from character, persona, and chat state.
function buildMacroContext(
  character: CharacterInfo,
  personaName: string,
  personaDescription: string,
  messages: ChatMessage[],
  model: string,
  variables?: Record<string, string>
): MacroContext {
  const nonSystem = messages.filter((m) => !m.isSystem);
  const lastMessage = nonSystem[nonSystem.length - 1]?.content || '';
  const lastUser = [...nonSystem].reverse().find((m) => m.isUser)?.content || '';
  const lastChar = [...nonSystem].reverse().find((m) => !m.isUser)?.content || '';

  return {
    charName: character.name || '',
    userName: personaName || 'User',
    personaName: personaName || 'User',
    personaDescription: personaDescription || '',
    characterDescription:
      character.description || character.data?.description || '',
    characterPersonality:
      character.personality || character.data?.personality || '',
    characterScenario: character.scenario || character.data?.scenario || '',
    characterExampleMessages:
      character.mes_example || character.data?.mes_example || '',
    lastMessage,
    lastUserMessage: lastUser,
    lastCharMessage: lastChar,
    model,
    variables,
  };
}

/**
 * Phase 8.5 — RAG helper.
 * Extracts the last user message from `messages` and queries two sources
 * for relevant context, run in parallel:
 *   1. The Data Bank (user-uploaded docs, scoped to `characterAvatar`)
 *   2. Chat-history embeddings for `chatFile` (older turns indexed
 *      semantically — recalls specific past moments without keeping them
 *      in raw history)
 *
 * Both sources are gated on the user's settings and an OpenAI embeddings
 * key. Each chunk is prefixed with provenance so the model can cite. Also
 * lazily ensures any new turns have been embedded before querying.
 */
async function resolveRagContext(
  messages: ChatMessage[],
  characterAvatar: string,
  chatFile?: string
): Promise<string | null> {
  const lastUser = [...messages].reverse().find((m) => m.isUser && !m.isSystem);
  if (!lastUser?.content.trim()) return null;

  // Kick off chat-history embedding for any messages that don't have one
  // yet. Don't block generation on it — the next turn will benefit.
  if (chatFile) {
    void useChatHistoryRagStore.getState().ensureEmbedded(
      chatFile,
      messages.map((m) => ({
        content: m.content,
        isUser: m.isUser,
        isSystem: m.isSystem,
      }))
    );
  }

  const [dataBankChunks, historyChunks] = await Promise.all([
    useDataBankStore
      .getState()
      .queryRelevantChunks(lastUser.content, characterAvatar),
    chatFile
      ? useChatHistoryRagStore.getState().queryTopK(chatFile, lastUser.content)
      : Promise.resolve([] as Array<{ text: string; speaker: 'user' | 'assistant'; score: number }>),
  ]);

  const parts: string[] = [];
  for (const c of dataBankChunks) {
    parts.push(`[From: ${c.docName}]\n${c.text}`);
  }
  for (const m of historyChunks) {
    const who = m.speaker === 'user' ? 'User' : 'Character';
    parts.push(`[Earlier in chat — ${who}]\n${m.text}`);
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n---\n\n');
}

// Build conversation context for AI
function buildConversationContext(
  messages: ChatMessage[],
  character: CharacterInfo,
  availableEmotions?: string[],
  wiTimerOut?: { currentTurn: number; timers: Record<string, number>; activated: Set<string> },
  ragContext?: string
): {
  context: { role: 'user' | 'assistant' | 'system'; content: string }[];
  /** True when the newest message alone exceeded the configured token
   *  budget and had to be force-included anyway. Captured here (dispatch
   *  time) rather than round-tripped through generationStore, since a
   *  concurrent send/swipe can overwrite a shared store field before this
   *  call's own stream resolves. */
  overBudget: boolean;
} {
  const context: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

  // Get active persona for this character/chat
  const persona = usePersonaStore
    .getState()
    .getPersonaForContext(character.avatar);
  const personaName = getUserDisplayName(character.avatar);
  const personaDescription = persona?.description || '';

  // Get generation config + provider for macros/tokenizer
  const genState = useGenerationStore.getState();
  const { activeModel, activeProvider } = useSettingsStore.getState();

  // Phase 9.3: clone the chat's variables into a mutable map that macros
  // will read from and write to during processing. After the whole context
  // is built, the snapshot is persisted back to the store via
  // `setChatVariables` so `{{setvar}}` calls survive between turns.
  const chatStoreState = useChatStore.getState();
  const ctxChatFile = chatStoreState.currentChatFile;
  const variables: Record<string, string> = ctxChatFile
    ? { ...chatStoreState.getChatVariables(ctxChatFile) }
    : {};

  const macroCtx = buildMacroContext(
    character,
    personaName,
    personaDescription,
    messages,
    activeModel,
    variables
  );
  const sub = (text: string) => (text ? processMacros(text, macroCtx) : '');

  // Scan active world info books for keyword matches against recent history.
  // The character's embedded book + per-character linked books are
  // auto-activated at scan time (scoped to this call), leaving the global
  // `activeBookIds` list untouched as the user navigates between characters.
  // Persona-linked and chat-linked books are unioned in on top of that so
  // each scope contributes its own bucket.
  const wiState = useWorldInfoStore.getState();
  const charBookIds = useCharacterStore
    .getState()
    .getActiveBookIdsForCharacter(character.avatar || '');
  const personaBookIds = persona?.linkedBookIds ?? [];
  const chatBookIds = ctxChatFile
    ? wiState.chatLinkedBookIds[ctxChatFile] ?? []
    : [];
  const scanBookIds = Array.from(
    new Set([
      ...wiState.activeBookIds,
      ...charBookIds,
      ...personaBookIds,
      ...chatBookIds,
    ])
  );
  const tokenProfile = profileForProvider(activeProvider);
  const matchedEntries = scanMessagesForEntries(
    wiState.books,
    scanBookIds,
    messages,
    {
      scanDepth: wiState.scanDepth,
      maxRecursionSteps: wiState.maxRecursionSteps,
      tokenBudget: wiState.tokenBudget,
      profile: tokenProfile,
      currentTurn: wiTimerOut?.currentTurn,
      wiTimers: wiTimerOut?.timers,
    },
    wiTimerOut?.activated
  );
  const wiByPosition: Record<WorldInfoPosition, MatchedEntry[]> = {
    before_char: [],
    after_char: [],
    before_an: [],
    after_an: [],
    at_depth: [],
  };
  for (const m of matchedEntries) {
    wiByPosition[m.entry.position].push(m);
  }
  // Persona-linked book ids — entries from these books describe the USER, not
  // the bot. Without a label the model often absorbs them as bot identity
  // (e.g. "the bot now thinks it IS the persona"). Prefixing each persona
  // entry with a user-context tag keeps the source semantically scoped.
  const personaBookIdSet = new Set(personaBookIds);
  const wrapWiContent = (m: MatchedEntry): string => {
    const content = sub(m.entry.content);
    if (!content.trim()) return '';
    if (personaBookIdSet.has(m.bookId)) {
      const subject = personaName || 'the user';
      return `[Information about ${subject}, the user you're talking to]\n${content}`;
    }
    return content;
  };
  const joinWi = (list: MatchedEntry[]): string =>
    list
      .map(wrapWiContent)
      .filter((c) => c.trim().length > 0)
      .join('\n\n');

  // Phase 7.1: Extension context contributions
  const extContributions = extensionRegistry.runContextHooks({
    messages: messages.map((m) => ({
      name: m.name,
      isUser: m.isUser,
      isSystem: m.isSystem,
      content: m.content,
    })),
    characterName: character.name,
    characterAvatar: character.avatar || '',
    currentChatFile: ctxChatFile || '',
  });
  const extByPosition: Record<string, ContextContribution[]> = {
    before_char: [],
    after_char: [],
    before_an: [],
    after_an: [],
    at_depth: [],
  };
  for (const c of extContributions) {
    (extByPosition[c.position] ??= []).push(c);
  }
  const joinExt = (list: ContextContribution[]): string =>
    list
      .map((c) => c.content)
      .filter((c) => c.trim().length > 0)
      .join('\n\n');

  const description = sub(getCharacterField(character, 'description'));
  const personality = sub(getCharacterField(character, 'personality'));
  const scenario = sub(getCharacterField(character, 'scenario'));
  const mesExample = sub(getCharacterField(character, 'mes_example'));
  // A transiently-applied linked template (mainPromptSnapshot is non-null
  // while one is active) is an explicit per-chat/per-character style choice.
  // It must beat BOTH of the card author's style channels — system_prompt
  // AND post_history_instructions. The PHI lands after the chat history
  // (the most authoritative slot), so a card PHI like "craft cinematically
  // rich immersive roleplay" re-instructs prose on every turn and silently
  // defeats the chosen style if left in place.
  const linkedStyleActive =
    usePromptTemplateStore.getState().mainPromptSnapshot !== null;
  // Pure chat (companion) mode: the chat should read like plain texting, so
  // everything that frames the conversation as narrated fiction is withheld
  // from the model — the greeting/opening scene, the card's scenario and
  // example prose, and the card PHI.
  const pureChatMode = ctxChatFile
    ? usePromptTemplateStore.getState().chatCompanionModeByChatFile[ctxChatFile] ?? false
    : false;

  const charSystemPromptOverride = genState.prompt.respectCharacterOverride
    ? sub(getCharacterField(character, 'system_prompt'))
    : '';
  const charPostHistoryInstructions =
    genState.prompt.respectCharacterPHI && !linkedStyleActive && !pureChatMode
      ? sub(getCharacterField(character, 'post_history_instructions'))
      : '';

  // User-level prompt overrides from generation settings
  const userMainPrompt = sub(genState.prompt.mainPrompt);
  const userPHI = sub(genState.prompt.postHistoryInstructions);
  const userJailbreak = sub(genState.prompt.jailbreakPrompt);

  const emotionList = availableEmotions && availableEmotions.length > 0
    ? availableEmotions.join(', ')
    : 'neutral (or any emotion that fits the moment)';

  const emotionInstruction = `
IMPORTANT: Begin each response with an emotion tag that reflects your current emotional state. Use this exact format: [emotion:TAG]

Available emotions for this character: ${emotionList}

Example: [emotion:joy] I'm so glad you asked about that!

Choose the emotion that best matches how ${character.name} would feel based on the conversation context.`.trim();

  // Build character info block. Pure chat mode keeps identity (description,
  // personality) but drops the scene-setting fields — scenario and example
  // prose are exactly what teach the model to narrate.
  const charInfoParts = [
    description && `Description: ${description}`,
    personality && `Personality: ${personality}`,
    !pureChatMode && scenario && `Scenario: ${scenario}`,
    !pureChatMode && mesExample && `Example dialogue:\n${mesExample}`,
  ].filter(Boolean);

  const charInfoBlock = charInfoParts.join('\n\n');

  // Main system prompt: linked style > character override > user override >
  // default (see linkedStyleActive above — an explicit style choice beats
  // the card's baked-in system_prompt; otherwise cards shipping their own
  // prompt silently ignore the chosen style while the style's sampler cap
  // still applies, producing verbose-but-truncated replies).
  const mainPrompt =
    (linkedStyleActive && userMainPrompt) ||
    charSystemPromptOverride ||
    userMainPrompt ||
    `You are ${character.name}. Stay in character.`;

  // Persona description injection
  let personaBlock = '';
  if (persona && personaDescription.trim()) {
    const position = persona.descriptionPosition;
    if (position === 'in_prompt' || position === 'before_char') {
      personaBlock = `[The user you're talking to is ${personaName}. ${personaDescription}]`;
    } else if (position === 'after_char') {
      // handled later
    }
  }

  // Phase 9.1: Compute every reorderable section's content into a keyed map.
  // Order + enabled flags come from `genState.promptOrder`; assembly below
  // iterates that array instead of pushing in a hard-coded sequence.
  const wiBeforeChar = joinWi(wiByPosition.before_char);
  const extBeforeChar = joinExt(extByPosition.before_char);
  const wiAfterChar = joinWi(wiByPosition.after_char);
  const extAfterChar = joinExt(extByPosition.after_char);
  const wiBeforeAn = joinWi(wiByPosition.before_an);
  const extBeforeAn = joinExt(extByPosition.before_an);
  const wiAfterAn = joinWi(wiByPosition.after_an);
  const extAfterAn = joinExt(extByPosition.after_an);

  const sectionContent: Partial<Record<PromptSectionId, string>> = {
    main_prompt: mainPrompt,
    persona_before_char:
      persona && persona.descriptionPosition === 'before_char' && personaBlock
        ? personaBlock
        : '',
    wi_before_char: wiBeforeChar,
    ext_before_char: extBeforeChar,
    char_info_block: charInfoBlock,
    wi_after_char: wiAfterChar,
    ext_after_char: extAfterChar,
    persona_after_char:
      persona && persona.descriptionPosition === 'after_char' && personaDescription
        ? `[The user you're talking to is ${personaName}. ${personaDescription}]`
        : '',
    wi_before_an: wiBeforeAn,
    ext_before_an: extBeforeAn,
    jailbreak: userJailbreak,
    emotion_instruction: emotionInstruction,
    rag_context: ragContext
      ? `[Relevant background information]\n${ragContext}`
      : '',
    // With a linked style (or pure chat mode) active the card PHI is
    // suppressed (see above); the slot instead carries a style
    // reinforcement. Post-history placement is what makes this work: in an
    // established chat the history itself anchors the old style (pages of
    // prose beat one instruction at the top), so the chosen style needs the
    // last word too. Pure chat mode uses a sharper no-narration variant.
    char_phi: pureChatMode
      ? `[Style note: reply as plain chat messages in ${character.name}'s voice — no narration, no describing actions or inner thoughts, no scene-setting. Follow the reply length defined in the system prompt, even if earlier replies were longer or written differently.]`
      : linkedStyleActive
        ? '[Style note: follow the writing style and reply length defined in the system prompt for this conversation, even if earlier replies were longer or written differently.]'
        : charPostHistoryInstructions,
    user_phi: userPHI,
    wi_after_an: wiAfterAn,
    ext_after_an: extAfterAn,
  };

  const promptOrder = genState.promptOrder;

  // Pre-history stage: everything that lives in the leading system block.
  const systemParts: string[] = [];
  for (const entry of promptOrder) {
    if (!entry.enabled) continue;
    if (POST_HISTORY_SECTIONS.has(entry.id)) continue;
    const content = sectionContent[entry.id];
    if (content && content.trim()) systemParts.push(content);
  }

  context.push({
    role: 'system',
    content: systemParts.filter(Boolean).join('\n\n'),
  });

  // Decide how many messages to consider for history.
  const ctxConfig = genState.context;
  const allNonSystemMessages = messages.filter((m) => !m.isSystem);
  let historyPool = ctxConfig.tokenAware
    ? allNonSystemMessages
    : messages.slice(-ctxConfig.messageCount).filter((m) => !m.isSystem);
  // When tokenAware is false, historyPool above is pre-windowed to the last
  // ctxConfig.messageCount raw messages — a different index frame than
  // sumForChat.messageCount below, which is always counted from the true
  // start of the chat (see summarizeStore.ts's generateSummary). windowSkew
  // is how many earlier non-system messages that pre-windowing already
  // dropped, so the summary offset rebase further down can correct for it
  // the same way it already corrects for the pure-chat-mode greeting trim.
  // tokenAware mode uses the full non-system list, so skew is always 0 there.
  const windowSkew = allNonSystemMessages.length - historyPool.length;
  // Pure chat mode: hide the greeting block (leading non-user messages) from
  // the model. The opening scene is prose in the character's own voice — as
  // the first "assistant" turn it anchors narration harder than any
  // instruction can counter. The user's first message becomes the real start.
  // `pureChatRemoved` tracks how many leading messages this trim dropped, so
  // summary compaction below (whose messageCount is computed against the
  // untrimmed pool) can re-base its slice index onto historyPool's new
  // indexing instead of double-counting the same messages as still present.
  let pureChatRemoved = 0;
  if (pureChatMode) {
    const firstUserIdx = historyPool.findIndex((m) => m.isUser);
    pureChatRemoved = firstUserIdx === -1 ? historyPool.length : firstUserIdx;
    historyPool = firstUserIdx === -1 ? [] : historyPool.slice(firstUserIdx);
  }
  // Summary compaction: when a summary covers the first N non-system turns,
  // drop those turns from the prompt — the summary is already injected
  // separately by the summarize extension. Big token win on long chats.
  //
  // sumForChat.messageCount is computed against the full non-system message
  // list (chatMessages.filter(!isSystem).length in summarizeStore), i.e.
  // BEFORE both the fixed-window pre-trim (windowSkew) and the pure-chat
  // greeting trim (pureChatRemoved) above. Slicing historyPool by that raw
  // count directly over-shoots by exactly `windowSkew + pureChatRemoved`
  // messages — in the worst case (a summary freshly covering the whole
  // chat) that over-shoot swallows the just-sent turn too, leaving
  // recentMessages empty and shipping a request with zero conversation
  // messages upstream (providers reject that outright, e.g. Anthropic's "at
  // least one message is required" 400). Subtracting both re-bases the
  // count onto historyPool's own indexing before it's used as a slice
  // offset — without windowSkew, a fixed Message Count context (tokenAware
  // off) would keep re-subtracting the summary's full-chat coverage from an
  // already-windowed pool, shrinking the configured window far below what
  // the user set any time compactWhenSummarized is on.
  const sumState = useSummarizeStore.getState();
  const sumForChat = ctxChatFile ? sumState.getSummary(ctxChatFile) : null;
  const summarySliceOffset = sumForChat
    ? Math.max(0, sumForChat.messageCount - pureChatRemoved - windowSkew)
    : 0;
  // Hard floor: never let compaction slice away the last MIN_RAW_TAIL
  // messages in historyPool, however large summarySliceOffset is. The
  // rebasing above handles the pure-chat and fixed-window skew, but the
  // summary can independently "cover" (or exceed) whatever's in historyPool
  // for other reasons too — e.g. swipeRight/regenerate deliberately truncate
  // historyPool to messages before the swiped slot, so a summary covering
  // the full chat trivially exceeds that truncated count. A 1-message floor
  // technically avoids the empty-array 400, but right after each
  // auto-summarize trigger it left only the newest message as raw text —
  // every other recent turn got folded into the terse 2-4 sentence summary,
  // so fine detail from the last few exchanges was lost until enough new
  // messages accumulated to widen the window back out. Keeping several raw
  // turns always in the prompt avoids that "forgets the last few messages"
  // gap while still discarding everything older once it's summarized.
  const MIN_RAW_TAIL = 6;
  const cappedOffset =
    historyPool.length > 0
      ? Math.min(summarySliceOffset, Math.max(historyPool.length - MIN_RAW_TAIL, 0))
      : 0;
  const compactedHistory =
    sumState.compactWhenSummarized && sumForChat && sumForChat.messageCount > 0
      ? historyPool.slice(cappedOffset)
      : historyPool;
  const recentMessages = compactedHistory;

  // Character's Note (depth prompt): inject at configurable depth from the END of the history
  const depthPrompt = getDepthPrompt(character);
  const depthPromptContent = depthPrompt ? sub(depthPrompt.prompt) : '';

  // Phase 8.1: Author's Note — per-chat persistent instruction injected at depth
  const authorNote = ctxChatFile
    ? useChatStore.getState().getAuthorNote(ctxChatFile)
    : null;

  // Persona @ depth
  const personaAtDepth =
    persona && persona.descriptionPosition === 'at_depth' && personaDescription
      ? {
          depth: persona.descriptionDepth,
          role: persona.descriptionRole,
          content: `[The user you're talking to is ${personaName}. ${personaDescription}]`,
        }
      : null;

  // Build a list of history messages with depth-based insertions
  const historyWithInsertions: {
    role: 'user' | 'assistant' | 'system';
    content: string;
  }[] = [];

  // Group WI at-depth entries by their depth value for interleaved injection.
  const wiAtDepthByDepth: Record<number, MatchedEntry[]> = {};
  for (const m of wiByPosition.at_depth) {
    const d = Math.max(0, Math.floor(m.entry.depth));
    if (!wiAtDepthByDepth[d]) wiAtDepthByDepth[d] = [];
    wiAtDepthByDepth[d].push(m);
  }

  // Phase 7.1: Group extension at-depth contributions by their depth value.
  const extAtDepthByDepth: Record<number, ContextContribution[]> = {};
  for (const c of extByPosition.at_depth) {
    const d = Math.max(0, Math.floor(c.depth ?? 0));
    if (!extAtDepthByDepth[d]) extAtDepthByDepth[d] = [];
    extAtDepthByDepth[d].push(c);
  }

  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const depthFromEnd = recentMessages.length - i;

    // Insert depth-prompt items BEFORE this message if depth matches
    if (depthPrompt && depthFromEnd === depthPrompt.depth && depthPromptContent) {
      historyWithInsertions.push({
        role: depthPrompt.role,
        content: depthPromptContent,
      });
    }
    // Phase 8.1: Author's Note injection at depth
    if (authorNote && depthFromEnd === authorNote.depth) {
      historyWithInsertions.push({
        role: authorNote.role,
        content: sub(authorNote.content),
      });
    }
    if (personaAtDepth && depthFromEnd === personaAtDepth.depth) {
      historyWithInsertions.push({
        role: personaAtDepth.role,
        content: personaAtDepth.content,
      });
    }
    // WI at-depth entries: inject as system messages at the matching depth
    const wiHere = wiAtDepthByDepth[depthFromEnd];
    if (wiHere && wiHere.length > 0) {
      const content = joinWi(wiHere);
      if (content) {
        historyWithInsertions.push({ role: 'system', content });
      }
    }
    // Phase 7.1: Extension at-depth contributions
    const extHere = extAtDepthByDepth[depthFromEnd];
    if (extHere && extHere.length > 0) {
      for (const c of extHere) {
        if (c.content.trim()) {
          historyWithInsertions.push({ role: c.role, content: c.content });
        }
      }
    }

    // Skip empty-content turns. A failed generation can leave a blank
    // assistant bubble in the saved history; re-sending it as an empty content
    // block makes providers like Claude 400 ("text content blocks must be
    // non-empty"), which silently breaks every subsequent turn in the chat.
    // Image-only user messages legitimately have empty text — keep those so
    // client.ts can still fold their attachments into the request.
    const subbed = sub(msg.content);
    const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
    if (subbed.trim() !== '' || hasImages) {
      historyWithInsertions.push({
        role: msg.isUser ? 'user' : 'assistant',
        content: subbed,
      });
    }
  }

  // If depth exceeds history length, prepend to entire history
  if (
    depthPrompt &&
    depthPromptContent &&
    depthPrompt.depth > recentMessages.length
  ) {
    historyWithInsertions.unshift({
      role: depthPrompt.role,
      content: depthPromptContent,
    });
  }
  if (authorNote && authorNote.depth > recentMessages.length) {
    historyWithInsertions.unshift({
      role: authorNote.role,
      content: sub(authorNote.content),
    });
  }
  if (personaAtDepth && personaAtDepth.depth > recentMessages.length) {
    historyWithInsertions.unshift({
      role: personaAtDepth.role,
      content: personaAtDepth.content,
    });
  }
  // WI at-depth: any entries whose depth exceeds history length prepend.
  for (const depthKey of Object.keys(wiAtDepthByDepth)) {
    const d = parseInt(depthKey, 10);
    if (d > recentMessages.length) {
      const content = joinWi(wiAtDepthByDepth[d]);
      if (content) {
        historyWithInsertions.unshift({ role: 'system', content });
      }
    }
  }
  // Phase 7.1: Extension at-depth overflow — prepend if depth > history length.
  for (const depthKey of Object.keys(extAtDepthByDepth)) {
    const d = parseInt(depthKey, 10);
    if (d > recentMessages.length) {
      for (const c of extAtDepthByDepth[d]) {
        if (c.content.trim()) {
          historyWithInsertions.unshift({ role: c.role, content: c.content });
        }
      }
    }
  }

  // Token-aware trimming: keep system prompts, drop oldest history that exceeds budget
  let overBudget = false;
  if (ctxConfig.tokenAware) {
    const systemPrompts = context.slice(); // system prompt we already pushed
    const trimmed = trimHistoryToBudget(
      systemPrompts,
      historyWithInsertions,
      ctxConfig.responseReserve,
      ctxConfig.maxTokens,
      tokenProfile
    );
    context.push(...trimmed.kept);
    genState.setLastTokenEstimate(trimmed.usedTokens);
    overBudget = trimmed.overBudget;
  } else {
    context.push(...historyWithInsertions);
  }

  // Phase 9.1: Post-history stage — char PHI, user PHI, wi_after_an, ext_after_an
  // emit in user-defined order (same map computed above).
  for (const entry of promptOrder) {
    if (!entry.enabled) continue;
    if (!POST_HISTORY_SECTIONS.has(entry.id)) continue;
    const content = sectionContent[entry.id];
    if (!content || !content.trim()) continue;
    context.push({ role: 'system', content });
  }

  // If not token-aware, still estimate tokens for the UI badge
  if (!ctxConfig.tokenAware) {
    genState.setLastTokenEstimate(
      estimateConversationTokens(context, tokenProfile)
    );
  }

  // Phase 9.3: persist any `{{setvar}}`/`{{addvar}}`/`{{incvar}}`/`{{decvar}}`
  // writes that happened during macro processing back to the chat's store.
  if (ctxChatFile) {
    chatStoreState.setChatVariables(ctxChatFile, variables);
  }

  return { context, overBudget };
}

// Build conversation context for group chat AI
function buildGroupConversationContext(
  messages: ChatMessage[],
  characters: CharacterInfo[],
  currentCharacter: CharacterInfo,
  scenarioOverride?: string,
  ragContext?: string,
  cardMode: GroupCardMode = DEFAULT_GROUP_CARD_MODE
): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  const context: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

  // Phase 5.3: build the "Characters in this conversation" block according to
  // the chosen mode. Swap keeps the flat one-liner-per-member view (only the
  // current speaker's full info lives elsewhere in the prompt). Join emits a
  // full section per member with description / personality / scenario /
  // examples, and prefixes the current speaker's section with [SPEAKING NOW]
  // so the model knows which one to write for.
  let cardBlock: string;
  if (cardMode === 'join') {
    cardBlock = characters
      .map((char) => {
        const isCurrent = char.avatar === currentCharacter.avatar;
        const desc = getCharacterField(char, 'description');
        const pers = getCharacterField(char, 'personality');
        const scen = getCharacterField(char, 'scenario');
        const examples = getCharacterField(char, 'mes_example');
        const header = isCurrent
          ? `[SPEAKING NOW] ${char.name}`
          : char.name;
        const parts = [
          desc && `Description: ${desc}`,
          pers && `Personality: ${pers}`,
          scen && `Scenario: ${scen}`,
          examples && `Example dialogue:\n${examples}`,
        ].filter(Boolean);
        return `## ${header}\n${parts.join('\n\n')}`;
      })
      .join('\n\n---\n\n');
  } else {
    cardBlock = characters
      .map((char) => {
        const desc = getCharacterField(char, 'description');
        const pers = getCharacterField(char, 'personality');
        const details = [
          desc && `Description: ${desc}`,
          pers && `Personality: ${pers}`,
        ].filter(Boolean).join(' ');
        return `- ${char.name}: ${details || 'A character in the conversation'}`;
      })
      .join('\n');
  }

  // Resolve scenario: override wins, else falls back to current character's
  // scenario. Macros are processed on the override, but {{char}} is ambiguous
  // in a group (multiple speakers), so we scrub char-specific substitutions
  // by passing an empty charName + character fields.
  let scenarioText = '';
  if (scenarioOverride && scenarioOverride.trim()) {
    const persona = usePersonaStore
      .getState()
      .getPersonaForContext(currentCharacter.avatar);
    const personaName = getUserDisplayName(currentCharacter.avatar);
    const { activeModel } = useSettingsStore.getState();
    scenarioText = processMacros(scenarioOverride, {
      charName: '',
      userName: personaName,
      personaName,
      personaDescription: persona?.description || '',
      characterDescription: '',
      characterPersonality: '',
      characterScenario: '',
      lastMessage: '',
      lastUserMessage: '',
      lastCharMessage: '',
      model: activeModel,
    }).trim();
  } else {
    scenarioText =
      currentCharacter.scenario || currentCharacter.data?.scenario || '';
  }

  // Include the current speaker's example dialogue if available — mirrors what
  // buildConversationContext does for solo chat. In Join mode this is already
  // baked into the speaker's own block above, so we suppress the duplicate.
  const mesExample =
    cardMode === 'join' ? '' : getCharacterField(currentCharacter, 'mes_example');

  const systemPrompt = `This is a roleplay group chat. You are playing ${currentCharacter.name} — write ONLY ${currentCharacter.name}'s turn.

Characters in this conversation:
${cardBlock}

${scenarioText ? `Current scenario: ${scenarioText}\n` : ''}${mesExample ? `Example dialogue for ${currentCharacter.name}:\n${mesExample}\n\n` : ''}FORMATTING RULES (follow exactly):
- Wrap ALL actions, movements, and narration in *single asterisks*: *He glances toward the door*
- Write spoken dialogue as plain text or in "quotes": "Hello there!"
- Alternate freely between *action* and "dialogue" throughout your response
- Begin your response with an emotion tag: [emotion:TAG]
- Available emotions: neutral, joy, sadness, anger, surprise, fear, love, excitement, confusion, embarrassment, curiosity, amusement

CONTENT RULES:
- Stay in character as ${currentCharacter.name} only — do NOT write lines for other characters
- React naturally to what other characters and the user say`;

  // Phase 8.5: append Data Bank / RAG context to the system prompt. Group
  // chats use a single flat system message (vs. the section-map in solo
  // chat), so we just concatenate the retrieved chunks at the tail rather
  // than forking the Phase 9 promptOrder system.
  const finalSystemPrompt = ragContext
    ? `${systemPrompt}\n\n[Relevant background information]\n${ragContext}`
    : systemPrompt;

  context.push({ role: 'system', content: finalSystemPrompt });

  // Phase 8.1: Author's Note for group chats
  const { currentChatFile: groupChatFile } = useChatStore.getState();
  const groupAuthorNote = groupChatFile
    ? useChatStore.getState().getAuthorNote(groupChatFile)
    : null;

  const recentMessages = messages.slice(-30).filter((m) => !m.isSystem);
  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const depthFromEnd = recentMessages.length - i;

    // Inject author's note at the configured depth
    if (groupAuthorNote && depthFromEnd === groupAuthorNote.depth) {
      context.push({
        role: groupAuthorNote.role,
        content: groupAuthorNote.content,
      });
    }

    const contentWithName = msg.isUser
      ? msg.content
      : `[${msg.name}]: ${msg.content}`;
    context.push({
      role: msg.isUser ? 'user' : 'assistant',
      content: contentWithName,
    });
  }

  // If depth exceeds history, prepend
  if (groupAuthorNote && groupAuthorNote.depth > recentMessages.length) {
    // Insert after the system prompt (index 1)
    context.splice(1, 0, {
      role: groupAuthorNote.role,
      content: groupAuthorNote.content,
    });
  }

  return context;
}

// Phase 5.2: shared helper that runs a single group-chat turn (build context,
// call API, stream, finalize). Both `sendGroupMessage` and `forceGroupMemberTalk`
// delegate to this to avoid drift in the streaming + parsing path. Returns
// `false` if the turn was aborted or never produced a stream, `true` otherwise.
async function generateGroupTurn(
  character: CharacterInfo,
  characters: CharacterInfo[],
  scenarioOverride: string | undefined,
  abortController: AbortController,
  get: () => ChatState,
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  images?: GenerationImage[]
): Promise<boolean> {
  // Surface this speaker to the typing indicator before the API call so the
  // "X is typing..." row shows during the request, not just after the first
  // token. Reset isStreaming so the indicator isn't masked by the prior
  // speaker's tail streaming state.
  set({ isStreaming: false, currentSpeakerName: character.name });

  const { provider, model } = getProviderAndModel();
  const updatedMessages = get().messages;
  // Phase 8.5: resolve Data Bank / RAG chunks scoped to the current speaker.
  // In a group turn this means Seraphina's character-scoped docs only fire
  // on Seraphina's turn, which matches how solo chats scope per-character.
  const ragCtx = await resolveRagContext(updatedMessages, character.avatar || '', get().currentChatFile || undefined);
  // Phase 5.3: look up the group's card-handling mode so the builder knows
  // whether to produce a swap-style flat bullet list or a full per-member
  // block layout for join mode.
  const chatState = get();
  const groupCardMode =
    chatState.groupChats.find((g) => g.fileName === chatState.currentChatFile)
      ?.cardMode ?? DEFAULT_GROUP_CARD_MODE;
  const context = buildGroupConversationContext(
    updatedMessages,
    characters,
    character,
    scenarioOverride,
    ragCtx ?? undefined,
    groupCardMode
  );

  const finalContext = await runGenerateInterceptors(
    maybeApplyInstructMode(context),
    character.name,
  );
  const stream = await api.generateMessage(
    finalContext,
    character.name,
    provider,
    model,
    abortController.signal,
    getGenerationOptions(),
    images,
    isTextCompletionMode()
  );

  if (!stream) return false;

  const aiMessageId = generateId();
  set((state) => ({
    messages: [
      ...state.messages,
      {
        id: aiMessageId,
        name: character.name,
        isUser: false,
        isSystem: false,
        content: '',
        timestamp: Date.now(),
        characterAvatar: character.avatar,
        swipes: [''],
        swipeId: 0,
      },
    ],
  }));

  let responseText = '';
  for await (const token of parseSSEStream(stream)) {
    if (!get().isSending) break;
    responseText += token;
    if (!get().isStreaming) set({ isStreaming: true });
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === aiMessageId
          ? { ...msg, content: responseText, swipes: [responseText] }
          : msg
      ),
    }));
  }

  const emotion = parseEmotion(responseText);
  // Strip emotion tags (all occurrences), strip the leading [CharacterName]: prefix that the
  // model echoes from conversation-history format, then truncate at the first
  // [AnyName]: marker in the middle — this happens when the model writes multiple
  // characters' turns in one response.
  const strippedText = stripGroupArtifacts(stripEmotionTag(responseText), character.name);

  if (strippedText.trim() === '') {
    // This speaker produced nothing — drop the blank bubble so it neither
    // shows as an empty message nor poisons the next speaker's history.
    set((state) => ({
      messages: state.messages.filter((msg) => msg.id !== aiMessageId),
    }));
    return get().isSending;
  }

  // The group builder doesn't populate lastTokenEstimate, so derive this
  // speaker's prompt size from the context we actually sent.
  const usage = recordTurnUsage(provider, model, strippedText, {
    inputTokensOverride: estimateConversationTokens(
      finalContext as { role: string; content: string }[],
      profileForProvider(provider),
    ),
  });
  set((state) => ({
    messages: state.messages.map((msg) =>
      msg.id === aiMessageId
        ? { ...msg, content: strippedText, emotion, swipes: [strippedText], usage }
        : msg
    ),
  }));

  return get().isSending;
}

// Helper: get provider/model with auto-switch
function getProviderAndModel(): { provider: string; model: string } {
  const { activeProvider, activeModel, secrets, globalSecrets, globalSharingEnabled } = useSettingsStore.getState();

  let provider = activeProvider;
  let model = activeModel;

  // Helper: check if a key exists in personal or global secrets
  const hasKey = (key: string) => {
    if (Array.isArray(secrets[key]) && secrets[key].length > 0) return true;
    if (globalSharingEnabled && Array.isArray(globalSecrets[key]) && globalSecrets[key].length > 0) return true;
    return false;
  };

  if (!provider || provider === 'openai') {
    const hasOpenAI = hasKey('api_key_openai');
    const hasClaude = hasKey('api_key_claude');
    if (!hasOpenAI && hasClaude) {
      provider = 'claude';
      model = 'claude-sonnet-4-20250514';
      useSettingsStore.setState({ activeProvider: provider, activeModel: model });
      // Rescue the context budget. Users land on Claude (200k window) via this
      // silent auto-switch but keep the legacy 8192-token default, which on a
      // long thread trims away the whole conversation and yields empty/failed
      // turns. Raise it to a sane-but-cost-conscious window — only when still
      // at/below the old default, so a user's own larger choice is untouched.
      // The guard self-clears after the first bump, so this runs at most once.
      const gen = useGenerationStore.getState();
      if (gen.context.maxTokens <= 8192) {
        gen.setContext({ maxTokens: 32768 });
      }
    }
  }

  return { provider, model };
}

function getFallbackProviderAndModel(): { provider: string; model: string } | null {
  const { fallbackProvider, fallbackModel } = useSettingsStore.getState();
  if (!fallbackProvider) return null;
  return { provider: fallbackProvider, model: fallbackModel || fallbackProvider };
}

async function generateWithFallback(
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  characterName: string,
  provider: string,
  model: string,
  signal: AbortSignal,
  generationOptions: GenerationOptions,
  images: GenerationImage[] | undefined,
  textCompletionMode: boolean,
): Promise<{ stream: ReadableStream<Uint8Array> | null; usedFallback: boolean }> {
  try {
    const stream = await api.generateMessage(messages, characterName, provider, model, signal, generationOptions, images, textCompletionMode);
    return { stream, usedFallback: false };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    const fallback = getFallbackProviderAndModel();
    if (!fallback) throw err;
    const stream = await api.generateMessage(messages, characterName, fallback.provider, fallback.model, signal, generationOptions, images, textCompletionMode);
    return { stream, usedFallback: true };
  }
}

// Helper: build generation options from the current sampler + instruct config.
function getGenerationOptions(): GenerationOptions {
  const { sampler, instruct } = useGenerationStore.getState();
  const combinedStops = [...sampler.stopStrings];

  if (instruct.enabled) {
    const tpl = getInstructTemplate(instruct.templateId);
    if (tpl) {
      for (const s of tpl.stopStrings) {
        if (!combinedStops.includes(s)) combinedStops.push(s);
      }
    }
    for (const s of instruct.extraStopStrings) {
      if (s && !combinedStops.includes(s)) combinedStops.push(s);
    }
  }

  return {
    temperature: sampler.temperature,
    maxTokens: sampler.maxTokens,
    topP: sampler.topP,
    topK: sampler.topK,
    minP: sampler.minP,
    frequencyPenalty: sampler.frequencyPenalty,
    presencePenalty: sampler.presencePenalty,
    repetitionPenalty: sampler.repetitionPenalty,
    stopStrings: combinedStops,
  };
}

// Helper: optionally convert message array into a single instruct-mode message
// when instruct mode is enabled (or text completion mode requires it).
function maybeApplyInstructMode(
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  const { instruct } = useGenerationStore.getState();
  // Text completion mode implicitly requires instruct formatting
  if (!instruct.enabled && instruct.completionMode !== 'text') return messages;
  const tpl = getInstructTemplate(instruct.templateId);
  if (!tpl) return messages;

  const prompt = formatInstructPrompt(messages, tpl);
  return [{ role: 'user', content: prompt }];
}

/** Phase 10.3: returns true when the user has selected text completion mode. */
function isTextCompletionMode(): boolean {
  return useGenerationStore.getState().instruct.completionMode === 'text';
}

type ContextMessage = { role: 'user' | 'assistant' | 'system'; content: string };

/**
 * Run installed server extensions' generate-interceptors before AI generation.
 * Extensions that declare `generate_interceptor: true` in manifest.json are called
 * at POST /api/plugins/<name>/generate-interceptors. Fails silently per-extension.
 */
async function runGenerateInterceptors(
  context: ContextMessage[],
  characterName: string,
): Promise<ContextMessage[]> {
  let result = context;
  try {
    const { useServerExtensionStore } = await import('./serverExtensionStore');
    const { installed, manifests } = useServerExtensionStore.getState();
    const interceptors = installed.filter((e) => manifests[e.name]?.generate_interceptor === true);
    for (const ext of interceptors) {
      const extName = ext.name.replace(/^third-party\//, '');
      try {
        const resp = await apiRequest<{ messages?: ContextMessage[] } | null>(
          `/api/plugins/${encodeURIComponent(extName)}/generate-interceptors`,
          { method: 'POST', body: JSON.stringify({ messages: result, character: characterName }) },
        );
        if (resp?.messages && Array.isArray(resp.messages)) {
          result = resp.messages;
        }
      } catch {
        // Extension doesn't implement this endpoint — skip silently
      }
    }
  } catch {
    // Store not available — skip
  }
  return result;
}

// Helper: save chat to backend
// Build the SillyTavern-compatible save payload (header element followed by
// the messages) for a chat. Shared by the normal save path and the
// page-unload beacon flush so both produce byte-identical request bodies.
function buildChatPayload(
  messages: ChatMessage[],
  character: CharacterInfo,
  currentChatFile: string,
  isGroupChat?: boolean,
  groupCharacters?: CharacterInfo[]
): { avatarUrl: string; fileName: string; chatData: unknown[] } {
  // Phase 8.1: include author's note in chat header metadata
  const authorNote = useChatStore.getState().getAuthorNote(currentChatFile);

  const chatData: unknown[] = [
    {
      user_name: getUserDisplayName(),
      character_name: isGroupChat && groupCharacters
        ? groupCharacters.map(c => c.name).join(', ')
        : character.name,
      create_date: new Date().toISOString(),
      ...(isGroupChat ? { is_group_chat: true } : {}),
      ...(authorNote ? {
        author_note: {
          content: authorNote.content,
          depth: authorNote.depth,
          role: authorNote.role,
        },
      } : {}),
    },
    ...messages.map((msg) => ({
      name: msg.name,
      is_user: msg.isUser,
      is_system: msg.isSystem,
      mes: msg.content,
      send_date: msg.timestamp,
      swipes: msg.swipes,
      swipe_id: msg.swipeId,
      ...(msg.characterAvatar ? { character_avatar: msg.characterAvatar } : {}),
      // Phase 6.1: persist image attachments into extra.images (array) and
      // extra.image (first element, SillyTavern-compat fallback for any
      // code path that still reads the scalar form). Scene videos ride
      // along in extra.videos.
      ...((msg.images && msg.images.length > 0) ||
      (msg.videos && msg.videos.length > 0) ||
      msg.usage
        ? {
            extra: {
              ...(msg.images && msg.images.length > 0
                ? { images: msg.images, image: msg.images[0] }
                : {}),
              ...(msg.videos && msg.videos.length > 0 ? { videos: msg.videos } : {}),
              // Per-turn token usage (estimated). Opaque to the backend.
              ...(msg.usage ? { usage: msg.usage } : {}),
            },
          }
        : {}),
    })),
  ];

  const avatarUrl = isGroupChat && groupCharacters
    ? groupCharacters[0].avatar
    : character.avatar;

  return { avatarUrl, fileName: currentChatFile, chatData };
}

// Module-level snapshot of the most recent save context + a primed CSRF token
// so the page-unload beacon (registered once below) can rebuild and flush the
// live in-memory chat without access to React component scope.
let lastSaveContext: {
  character: CharacterInfo;
  isGroupChat: boolean;
  groupCharacters?: CharacterInfo[];
} | null = null;
let cachedCsrfToken = '';
// Prime the CSRF token early so a mid-turn unload flush can set the header
// without awaiting a round-trip while the page is tearing down.
if (typeof window !== 'undefined') {
  getCsrfToken().then((t) => { cachedCsrfToken = t; }).catch(() => {});
}

// Last server_ts observed per chat file (the backend's optimistic-concurrency
// token). Sent back as base_ts on the next save so a stale/out-of-order write
// can't clobber a newer message tail. Keyed by file name (unique per chat).
const chatServerTsByFile = new Map<string, number>();

export function getChatServerTs(fileName: string): number | undefined {
  return chatServerTsByFile.get(fileName);
}

// Adopt authoritative server state after a conflict we can't safely overwrite
// (the server is ahead of us). If it's the active chat, refresh the in-memory
// messages so the user sees the newer tail instead of losing it.
function reconcileServerState(fileName: string, serverMessages: unknown[]) {
  const state = useChatStore.getState();
  if (state.currentChatFile !== fileName) return;
  const rest = Array.isArray(serverMessages) ? serverMessages.slice(1) : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized = rest.map((m) => normalizeMessage(m as any));
  useChatStore.setState({ messages: normalized });
}

async function saveChatToBackend(
  messages: ChatMessage[],
  character: CharacterInfo,
  currentChatFile: string | null,
  isGroupChat?: boolean,
  groupCharacters?: CharacterInfo[],
  allowTruncate = false
) {
  if (!currentChatFile) return;

  const { avatarUrl, fileName, chatData } = buildChatPayload(
    messages,
    character,
    currentChatFile,
    isGroupChat,
    groupCharacters
  );

  // Remember context (and keep the CSRF token warm) so the unload beacon can
  // flush whatever is in memory if the tab closes mid-turn.
  lastSaveContext = { character, isGroupChat: !!isGroupChat, groupCharacters };
  getCsrfToken().then((t) => { cachedCsrfToken = t; }).catch(() => {});

  // base_ts is the last server_ts we observed for this chat — the optimistic-
  // concurrency token. Undefined for a chat we've never loaded/saved (first
  // save → unconditional write).
  let baseTs: number | null | undefined = chatServerTsByFile.get(fileName);
  const truncateOk = allowTruncate;

  // A dropped save silently loses the user's last messages on reload, so
  // retry a few times with backoff before surfacing the failure. Conflicts
  // (409) are resolved separately and also consume an attempt.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { server_ts } = await api.saveChat(
        avatarUrl,
        fileName,
        chatData,
        baseTs ?? null,
        truncateOk
      );
      chatServerTsByFile.set(fileName, server_ts);
      return;
    } catch (err) {
      if (err instanceof ChatConflictError) {
        const { current_ts, current_messages } = err.conflict;
        // The server's token is now authoritative regardless of how we resolve.
        chatServerTsByFile.set(fileName, current_ts);

        // If our payload is at least as complete as the server's, our state is
        // the newer/superset one (the common self-induced race: our own
        // earlier save bumped the token mid-turn). Retry with the fresh token
        // and keep our messages.
        const serverLen = Array.isArray(current_messages) ? current_messages.length : 0;
        if (chatData.length >= serverLen && attempt < MAX_ATTEMPTS) {
          baseTs = current_ts;
          continue;
        }

        // Otherwise the server is ahead of us (another tab/session appended
        // messages). Don't clobber it — adopt the server state into memory so
        // the newer tail is preserved rather than lost.
        reconcileServerState(fileName, current_messages);
        showToastGlobal('Chat was updated elsewhere — reloaded the latest messages', 'warning');
        return;
      }

      console.error(`[Chat] Save attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      // All retries exhausted — surface it so the user knows their last
      // messages are at risk rather than dropping them silently.
      useChatStore.setState({
        error: 'Failed to save chat — your last messages may not be saved. Check your connection.',
      });
      showToastGlobal('Failed to save chat — your last messages may not be saved', 'error');
    }
  }
}

// Persist the active chat after an intentional truncation (message delete,
// branch reset). These edit actions don't carry the character context, so we
// resolve it from the stores here. allow_truncate tells the backend the
// shrinking array is deliberate, not a stale-save race to be rejected.
async function persistTruncatingEdit() {
  const { currentChatFile, messages, getGroupChatByFile } = useChatStore.getState();
  if (!currentChatFile) return;
  const charState = useCharacterStore.getState();
  const groupChat = getGroupChatByFile(currentChatFile);
  if (groupChat) {
    const chars = groupChat.characterAvatars
      .map((av) => charState.characters.find((c) => c.avatar === av))
      .filter((c): c is CharacterInfo => !!c);
    if (chars.length === 0) return;
    await saveChatToBackend(messages, chars[0], currentChatFile, true, chars, true);
  } else {
    const character = charState.selectedCharacter;
    if (!character) return;
    await saveChatToBackend(messages, character, currentChatFile, false, undefined, true);
  }
}

// ---- Fix #4: flush an in-flight chat on tab close / navigation. ----
// The normal save runs at turn boundaries; if the tab is closed mid-stream
// those messages would never reach the backend. A keepalive POST (which
// survives unload) flushes the current in-memory state. Guarded on isSending
// so we only pay the cost during the risky mid-generation window.
function flushChatOnUnload() {
  if (typeof window === 'undefined') return;
  const state = useChatStore.getState();
  if (!state.isSending || !state.currentChatFile || !lastSaveContext) return;
  if (state.messages.length === 0) return;
  try {
    const { avatarUrl, fileName, chatData } = buildChatPayload(
      state.messages,
      lastSaveContext.character,
      state.currentChatFile,
      lastSaveContext.isGroupChat,
      lastSaveContext.groupCharacters
    );
    const baseTs = chatServerTsByFile.get(fileName);
    const body = JSON.stringify({
      character_avatar: avatarUrl,
      file_name: fileName,
      messages: chatData,
      // Mid-stream the array only grows, so base_ts matches and no truncate is
      // needed. Conflicts can't be handled during unload — best effort only.
      ...(typeof baseTs === 'number' ? { base_ts: baseTs } : {}),
    });
    // keepalive lets us send the CSRF header (sendBeacon cannot set headers)
    // while still surviving the unload.
    fetch('/chats/save', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': cachedCsrfToken,
      },
      body,
    }).catch(() => {
      // Last resort if the keepalive fetch rejects: a header-less beacon.
      try {
        navigator.sendBeacon?.(
          '/chats/save',
          new Blob([body], { type: 'application/json' })
        );
      } catch {
        /* give up — nothing more we can do during unload */
      }
    });
  } catch {
    /* never block unload */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushChatOnUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChatOnUnload();
  });
}

// Helper: create a message with swipe defaults
function createMessage(data: Omit<ChatMessage, 'id' | 'swipes' | 'swipeId'>): ChatMessage {
  return {
    ...data,
    id: generateId(),
    swipes: [data.content],
    swipeId: 0,
  };
}

/** Phase 6.1: convert stored data-URL images into the provider-neutral
 *  `{mimeType, base64}` form the API client expects. Malformed entries
 *  are silently dropped — callers already staged valid data URLs. */
function resolveImagesForSend(
  images: string[] | undefined
): GenerationImage[] | undefined {
  if (!images || images.length === 0) return undefined;
  const parts: GenerationImage[] = [];
  for (const url of images) {
    const part = dataUrlToPart(url);
    if (part) parts.push(part);
  }
  return parts.length > 0 ? parts : undefined;
}

/** Phase 6.1: pull the most recent user message's images from a history
 *  so follow-up generations (swipe/regen/continue/edit-and-regen) keep the
 *  multimodal attachment in play even when the caller didn't pass images
 *  directly. Returns undefined if the model can't see images or the last
 *  user message has none. */
function imagesFromLastUserMessage(
  messages: ChatMessage[],
  provider: string,
  model: string
): GenerationImage[] | undefined {
  if (!supportsVision(provider, model)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.isUser) continue;
    return resolveImagesForSend(m.images);
  }
  return undefined;
}

/**
 * Strip group-chat formatting artifacts the model echoes from conversation history:
 * 1. Leading `[CharacterName]: ` prefix (model echoes its own label)
 * 2. Everything from the first `\n[AnyName]: ` onwards (model wrote another character's turn)
 */
function stripGroupArtifacts(text: string, characterName: string): string {
  // Remove leading own-name prefix
  let result = text.replace(new RegExp(`^\\[${characterName}\\]:\\s*`, 'i'), '').trim();
  // Truncate at the first mid-response [Name]: marker (another character's turn bled in)
  const otherTurnMatch = result.match(/\n\[[^\]]+\]:\s*/);
  if (otherTurnMatch && otherTurnMatch.index !== undefined) {
    result = result.slice(0, otherTurnMatch.index).trim();
  }
  return result;
}

/** Phase 8.2: apply permanent (non-display-only) regex scripts to user input text. */
function applyUserInputRegex(text: string, characterAvatar?: string): string {
  const scripts = getActiveScripts(
    useRegexScriptStore.getState().scripts,
    characterAvatar,
    'user_input'
  ).filter((s) => !s.displayOnly);
  return scripts.length > 0 ? applyRegexScripts(text, scripts) : text;
}

/** Reset streaming flags in a `finally` block only when the local controller
 *  is still the active one. Prevents a slow-unwinding generator from wiping
 *  the state of a newer operation the user kicked off (e.g. stop → force-talk
 *  in quick succession). */
function resetStreamingStateIfOwner(
  localController: AbortController,
  get: () => ChatState,
  set: (partial: Partial<ChatState>) => void
) {
  if (get().abortController === localController) {
    set({
      isSending: false,
      isStreaming: false,
      abortController: null,
      currentSpeakerName: null,
    });
  }
}

// Helper: normalize loaded messages to always have swipes
function normalizeMessage(msg: {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  send_date: number;
  swipes?: string[];
  swipe_id?: number;
  character_avatar?: string;
  // Phase 6.1: vision attachments persisted via extra.images (our field)
  // with a fallback to extra.image (single-item, SillyTavern-compat).
  extra?: {
    images?: unknown;
    image?: unknown;
    videos?: unknown;
    usage?: unknown;
    [key: string]: unknown;
  };
}): ChatMessage {
  const content = msg.swipes && msg.swipe_id !== undefined
    ? msg.swipes[msg.swipe_id] ?? msg.mes
    : msg.mes;

  // Recover image attachments. Array form wins; scalar `extra.image`
  // (SillyTavern single-image legacy) is promoted to a 1-element array.
  let images: string[] | undefined;
  const rawImages = msg.extra?.images;
  if (Array.isArray(rawImages)) {
    const arr = rawImages.filter(
      (x): x is string => typeof x === 'string' && x.startsWith('data:')
    );
    if (arr.length > 0) images = arr;
  } else if (typeof msg.extra?.image === 'string' && msg.extra.image.startsWith('data:')) {
    images = [msg.extra.image];
  }

  // Recover scene videos — served blob URLs (/blobs/scene-video/...), not
  // data URLs, so accept any non-empty string that looks like a URL/path.
  let videos: string[] | undefined;
  const rawVideos = msg.extra?.videos;
  if (Array.isArray(rawVideos)) {
    const arr = rawVideos.filter(
      (x): x is string =>
        typeof x === 'string' && (x.startsWith('/') || x.startsWith('data:') || x.startsWith('http'))
    );
    if (arr.length > 0) videos = arr;
  }

  // Recover per-turn token usage written by recordTurnUsage.
  let usage: TokenUsage | undefined;
  const rawUsage = msg.extra?.usage;
  if (rawUsage && typeof rawUsage === 'object') {
    const u = rawUsage as Record<string, unknown>;
    const inputTokens = Number(u.inputTokens);
    const outputTokens = Number(u.outputTokens);
    if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) {
      usage = {
        inputTokens: Math.max(0, Math.round(inputTokens)),
        outputTokens: Math.max(0, Math.round(outputTokens)),
        source: u.source === 'measured' ? 'measured' : 'estimated',
        provider: typeof u.provider === 'string' ? u.provider : undefined,
        model: typeof u.model === 'string' ? u.model : undefined,
        costUsd: Number.isFinite(Number(u.costUsd)) ? Number(u.costUsd) : undefined,
      };
    }
  }

  return {
    id: generateId(),
    name: msg.name,
    isUser: msg.is_user,
    isSystem: msg.is_system,
    content,
    timestamp: msg.send_date,
    swipes: msg.swipes && msg.swipes.length > 0 ? msg.swipes : [msg.mes],
    swipeId: msg.swipe_id ?? 0,
    characterAvatar: msg.character_avatar,
    images,
    videos,
    usage,
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  chatFiles: [],
  groupChats: loadGroupChatsFromStorage(),
  currentChatFile: null,
  isLoading: false,
  isSending: false,
  isStreaming: false,
  error: null,
  abortController: null,
  currentSpeakerName: null,

  // Phase 8.1: Author's Note
  authorNotes: loadAuthorNotesFromStorage(),

  getAuthorNote: (fileName: string) => {
    const note = get().authorNotes[fileName];
    if (!note || !note.content?.trim()) return null;
    return note;
  },

  setAuthorNote: (fileName: string, partial: Partial<AuthorNote>) => {
    const { authorNotes } = get();
    const existing = authorNotes[fileName] || { content: '', depth: 4, role: 'system' as const };
    const updated = {
      ...authorNotes,
      [fileName]: {
        content: partial.content ?? existing.content,
        depth: partial.depth ?? existing.depth,
        role: partial.role ?? existing.role,
      },
    };
    saveAuthorNotesToStorage(updated);
    set({ authorNotes: updated });
  },

  // Phase 9.3: Chat variables (consumed by macro system)
  chatVariables: loadChatVariablesFromStorage(),

  getChatVariables: (fileName: string) => {
    return get().chatVariables[fileName] ?? {};
  },

  setChatVariables: (fileName: string, vars: Record<string, string>) => {
    const { chatVariables } = get();
    const updated = { ...chatVariables, [fileName]: { ...vars } };
    saveChatVariablesToStorage(updated);
    set({ chatVariables: updated });
  },

  refreshGroupChats: () => {
    set({ groupChats: loadGroupChatsFromStorage() });
  },

  deleteGroupChat: (fileName: string) => {
    const { groupChats } = get();
    const updated = groupChats.filter((g) => g.fileName !== fileName);
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  convertCurrentToGroup: async (currentCharacter: CharacterInfo, additionalCharacters: CharacterInfo[]) => {
    const { currentChatFile, messages, groupChats } = get();
    if (!currentChatFile) return;

    const allCharacters = [currentCharacter, ...additionalCharacters];
    const newGroupChat: GroupChatInfo = {
      fileName: currentChatFile,
      characterNames: allCharacters.map((c) => c.name),
      characterAvatars: allCharacters.map((c) => c.avatar),
      lastMessage: messages[messages.length - 1]?.content || '',
      createdAt: Date.now(),
      activationStrategy: DEFAULT_GROUP_ACTIVATION_STRATEGY,
      mutedAvatars: [],
      pooledExcludeRecent: DEFAULT_POOLED_EXCLUDE_RECENT,
      autoModeEnabled: false,
      autoModeDelayMs: DEFAULT_AUTO_MODE_DELAY_MS,
      scenarioOverride: '',
      talkativenessOverrides: {},
      title: undefined,
      cardMode: DEFAULT_GROUP_CARD_MODE,
    };

    const updatedGroupChats = [...groupChats, newGroupChat];
    saveGroupChatsToStorage(updatedGroupChats);
    set({ groupChats: updatedGroupChats });

    // Switch characterStore into group mode with all members
    await useCharacterStore.getState().setGroupChatCharacters(allCharacters.map((c) => c.avatar));
  },

  // ---- Phase 5.1: activation strategies + mute ----
  getGroupChatByFile: (fileName: string) => {
    return get().groupChats.find((g) => g.fileName === fileName) || null;
  },

  setGroupActivationStrategy: (fileName, strategy) => {
    const { groupChats } = get();
    const updated = groupChats.map((g) =>
      g.fileName === fileName ? { ...g, activationStrategy: strategy } : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  // Phase 5.3: how character cards are laid out in the group system prompt.
  setGroupCardMode: (fileName, mode) => {
    const { groupChats } = get();
    const updated = groupChats.map((g) =>
      g.fileName === fileName ? { ...g, cardMode: mode } : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  toggleGroupMute: (fileName, avatar) => {
    const { groupChats } = get();
    const updated = groupChats.map((g) => {
      if (g.fileName !== fileName) return g;
      const muted = new Set(g.mutedAvatars);
      if (muted.has(avatar)) muted.delete(avatar);
      else muted.add(avatar);
      return { ...g, mutedAvatars: Array.from(muted) };
    });
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  setGroupPooledExcludeRecent: (fileName, n) => {
    const clamped = Math.max(0, Math.floor(n));
    const { groupChats } = get();
    const updated = groupChats.map((g) =>
      g.fileName === fileName ? { ...g, pooledExcludeRecent: clamped } : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  // ---- Phase 5.2: auto-mode, reorder, scenario override ----
  setGroupAutoMode: (fileName, enabled) => {
    const { groupChats } = get();
    const updated = groupChats.map((g) =>
      g.fileName === fileName ? { ...g, autoModeEnabled: enabled } : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  setGroupAutoModeDelay: (fileName, delayMs) => {
    const clamped = Math.max(0, Math.floor(delayMs));
    const { groupChats } = get();
    const updated = groupChats.map((g) =>
      g.fileName === fileName ? { ...g, autoModeDelayMs: clamped } : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  setGroupScenarioOverride: (fileName, scenario) => {
    const { groupChats } = get();
    const updated = groupChats.map((g) =>
      g.fileName === fileName ? { ...g, scenarioOverride: scenario } : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  reorderGroupMembers: (fileName, avatars) => {
    const { groupChats } = get();
    const updated = groupChats.map((g) => {
      if (g.fileName !== fileName) return g;
      // Reorder characterAvatars + characterNames in lockstep. Skip any avatar
      // in the payload that isn't in the record, and preserve any existing
      // members missing from the payload by appending them in original order.
      const oldAvatars = g.characterAvatars;
      const oldNames = g.characterNames;
      const nameByAvatar = new Map<string, string>();
      oldAvatars.forEach((a, i) => nameByAvatar.set(a, oldNames[i] ?? ''));
      const validAvatars = avatars.filter((a) => nameByAvatar.has(a));
      const missing = oldAvatars.filter((a) => !validAvatars.includes(a));
      const nextAvatars = [...validAvatars, ...missing];
      const nextNames = nextAvatars.map((a) => nameByAvatar.get(a) ?? '');
      return {
        ...g,
        characterAvatars: nextAvatars,
        characterNames: nextNames,
      };
    });
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  // ---- Phase 5.3: per-member talkativeness, title, live add/remove ----
  setGroupTalkativenessOverride: (fileName, avatar, value) => {
    const { groupChats } = get();
    const updated = groupChats.map((g) => {
      if (g.fileName !== fileName) return g;
      const nextOverrides = { ...(g.talkativenessOverrides || {}) };
      if (value === null || typeof value !== 'number' || !isFinite(value)) {
        delete nextOverrides[avatar];
      } else {
        const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
        nextOverrides[avatar] = clamped;
      }
      return { ...g, talkativenessOverrides: nextOverrides };
    });
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  setGroupTitle: (fileName, title) => {
    const trimmed = title.trim();
    const { groupChats } = get();
    const updated = groupChats.map((g) =>
      g.fileName === fileName
        ? { ...g, title: trimmed.length > 0 ? trimmed : undefined }
        : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  addGroupChatMember: (fileName, character) => {
    const { groupChats, messages } = get();
    const existing = groupChats.find((g) => g.fileName === fileName);
    if (!existing) return;
    if (existing.characterAvatars.includes(character.avatar)) return;

    // Persist roster change.
    const updated = groupChats.map((g) =>
      g.fileName === fileName
        ? {
            ...g,
            characterNames: [...g.characterNames, character.name],
            characterAvatars: [...g.characterAvatars, character.avatar],
          }
        : g
    );
    saveGroupChatsToStorage(updated);

    // Post greeting so the new member exists in context before being asked
    // to speak. Use first_mes when available, otherwise a neutral join marker.
    const firstMes = character.first_mes || character.data?.first_mes || '';
    const greeting: ChatMessage = firstMes.trim()
      ? createMessage({
          name: character.name,
          isUser: false,
          isSystem: false,
          content: firstMes,
          timestamp: Date.now(),
          characterAvatar: character.avatar,
        })
      : createMessage({
          name: 'System',
          isUser: false,
          isSystem: true,
          content: `${character.name} joined the chat.`,
          timestamp: Date.now(),
        });

    set({
      groupChats: updated,
      messages: [...messages, greeting],
    });
  },

  removeGroupChatMember: (fileName, avatar) => {
    const { groupChats } = get();
    const existing = groupChats.find((g) => g.fileName === fileName);
    if (!existing) return;
    if (!existing.characterAvatars.includes(avatar)) return;
    // Refuse if removing would drop the group below 2 members — a group of 1
    // is indistinguishable from a solo chat and breaks several assumptions.
    if (existing.characterAvatars.length <= 2) return;

    const idx = existing.characterAvatars.indexOf(avatar);
    const nextAvatars = existing.characterAvatars.filter((_, i) => i !== idx);
    const nextNames = existing.characterNames.filter((_, i) => i !== idx);
    const nextMuted = existing.mutedAvatars.filter((a) => a !== avatar);
    const nextOverrides = { ...(existing.talkativenessOverrides || {}) };
    delete nextOverrides[avatar];

    const updated = groupChats.map((g) =>
      g.fileName === fileName
        ? {
            ...g,
            characterAvatars: nextAvatars,
            characterNames: nextNames,
            mutedAvatars: nextMuted,
            talkativenessOverrides: nextOverrides,
          }
        : g
    );
    saveGroupChatsToStorage(updated);
    set({ groupChats: updated });
  },

  fetchChatFiles: async (avatarUrl: string) => {
    set({ isLoading: true, error: null });
    try {
      const chats = await api.getChats(avatarUrl);
      const chatFiles: ChatFile[] = chats.map((chat) => ({
        fileName: chat.file_name,
        messageCount: chat.message_count,
        lastMessage: chat.last_mes,
      }));
      set({ chatFiles, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch chats',
      });
    }
  },

  loadChat: async (avatarUrl: string, fileName: string) => {
    set({ isLoading: true, error: null, currentChatFile: fileName });
    try {
      const { messages: rawMessages, server_ts } = await api.getChatMessages(avatarUrl, fileName);
      const messages = rawMessages.map(normalizeMessage);
      // Record the concurrency token so the next save echoes it as base_ts.
      chatServerTsByFile.set(fileName, server_ts);
      set({ messages, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load chat',
      });
    }
  },

  loadGroupChat: async (groupChat: GroupChatInfo) => {
    set({ isLoading: true, error: null, currentChatFile: groupChat.fileName });
    try {
      const avatarUrl = groupChat.characterAvatars[0];
      const { messages: rawMessages, server_ts } = await api.getChatMessages(avatarUrl, groupChat.fileName);
      const messages = rawMessages.map(normalizeMessage);
      chatServerTsByFile.set(groupChat.fileName, server_ts);
      set({ messages, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load group chat',
      });
    }
  },

  startNewChat: async (character: CharacterInfo) => {
    const messages: ChatMessage[] = [];

    const firstMes = character.first_mes || character.data?.first_mes || '';
    const altGreetings = getAlternateGreetings(character);

    if (firstMes || altGreetings.length > 0) {
      // Build swipes array: primary greeting + alternate greetings
      const swipes = [firstMes, ...altGreetings].filter(Boolean);
      const firstMessage = createMessage({
        name: character.name,
        isUser: false,
        isSystem: false,
        content: swipes[0] || '',
        timestamp: Date.now(),
        characterAvatar: character.avatar,
      });
      // Override the swipes to include all greetings
      firstMessage.swipes = swipes;
      firstMessage.swipeId = 0;
      messages.push(firstMessage);
    }

    const fileName = await api.createChat(character.name);
    set({ messages, currentChatFile: fileName, error: null });
  },

  startNewGroupChat: async (characters: CharacterInfo[]) => {
    const messages: ChatMessage[] = [];

    messages.push(createMessage({
      name: 'System',
      isUser: false,
      isSystem: true,
      content: `Group chat started with ${characters.map(c => c.name).join(', ')}`,
      timestamp: Date.now(),
    }));

    for (const character of characters) {
      const firstMes = character.first_mes || character.data?.first_mes || '';
      const altGreetings = getAlternateGreetings(character);
      if (firstMes || altGreetings.length > 0) {
        const swipes = [firstMes, ...altGreetings].filter(Boolean);
        const message = createMessage({
          name: character.name,
          isUser: false,
          isSystem: false,
          content: swipes[0] || '',
          timestamp: Date.now() + characters.indexOf(character),
          characterAvatar: character.avatar,
        });
        message.swipes = swipes;
        message.swipeId = 0;
        messages.push(message);
      }
    }

    const groupName = `Group_${characters.map(c => c.name).join('_')}`;
    const fileName = await api.createChat(groupName);

    const { groupChats } = get();
    const newGroupChat: GroupChatInfo = {
      fileName,
      characterNames: characters.map((c) => c.name),
      characterAvatars: characters.map((c) => c.avatar),
      lastMessage: messages[messages.length - 1]?.content || '',
      createdAt: Date.now(),
      activationStrategy: DEFAULT_GROUP_ACTIVATION_STRATEGY,
      mutedAvatars: [],
      pooledExcludeRecent: DEFAULT_POOLED_EXCLUDE_RECENT,
      autoModeEnabled: false,
      autoModeDelayMs: DEFAULT_AUTO_MODE_DELAY_MS,
      scenarioOverride: '',
      talkativenessOverrides: {},
      title: undefined,
      cardMode: DEFAULT_GROUP_CARD_MODE,
    };
    const updatedGroupChats = [...groupChats, newGroupChat];
    saveGroupChatsToStorage(updatedGroupChats);

    set({
      messages,
      currentChatFile: fileName,
      groupChats: updatedGroupChats,
      error: null,
    });
  },

  addMessage: (message) => {
    const newMessage = createMessage(message);
    set((state) => ({ messages: [...state.messages, newMessage] }));
  },

  // ---- Stop Generation ----
  stopGeneration: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
    }
    // Clear abortController + sending flags synchronously so the next action
    // (e.g. force-talk after stop) sees clean state immediately. The in-flight
    // generation's `finally` block guards against trampling a newer controller.
    set({
      isSending: false,
      isStreaming: false,
      abortController: null,
      currentSpeakerName: null,
    });
  },

  // ---- Edit Message (save only, no regeneration) ----
  editMessage: (messageId: string, newContent: string) => {
    set((state) => ({
      messages: state.messages.map((msg) => {
        if (msg.id !== messageId) return msg;
        const newSwipes = [...msg.swipes];
        newSwipes[msg.swipeId] = newContent;
        return { ...msg, content: newContent, swipes: newSwipes };
      }),
    }));
  },

  // ---- Phase 8.6: Load Branch Messages (in-memory only, no disk write) ----
  loadBranchMessages: (branchMessages: ChatMessage[]) => {
    set({ messages: branchMessages });
  },

  // ---- Delete Message ----
  deleteMessage: (messageId: string) => {
    set((state) => ({
      messages: state.messages.filter((msg) => msg.id !== messageId),
    }));
    // Intentional shrink — persist with allow_truncate so the backend's
    // regression guard doesn't reject it as a stale save.
    void persistTruncatingEdit();
  },

  // ---- Swipe Left (previous swipe) ----
  swipeLeft: (messageId: string) => {
    set((state) => ({
      messages: state.messages.map((msg) => {
        if (msg.id !== messageId || msg.swipeId <= 0) return msg;
        const newSwipeId = msg.swipeId - 1;
        return { ...msg, swipeId: newSwipeId, content: msg.swipes[newSwipeId] };
      }),
    }));
  },

  // ---- Swipe Right (next swipe, or generate new if at end) ----
  swipeRight: async (messageId: string, character: CharacterInfo, availableEmotions?: string[]) => {
    const { messages } = get();
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;

    // If there's a next swipe, just navigate to it
    if (msg.swipeId < msg.swipes.length - 1) {
      set((state) => ({
        messages: state.messages.map((m) => {
          if (m.id !== messageId) return m;
          const newSwipeId = m.swipeId + 1;
          return { ...m, swipeId: newSwipeId, content: m.swipes[newSwipeId] };
        }),
      }));
      return;
    }

    // Generate a new swipe
    const abortController = new AbortController();
    set({ isSending: true, isStreaming: false, error: null, abortController });

    try {
      // Build context from messages up to (but not including) this AI message
      const msgIndex = messages.findIndex((m) => m.id === messageId);
      const contextMessages = messages.slice(0, msgIndex);
      const { currentChatFile } = get();
      const currentTurn = contextMessages.filter((m) => !m.isUser && !m.isSystem).length;
      const wiTimerActivated = new Set<string>();
      const ragCtx = await resolveRagContext(contextMessages, character.avatar || '', currentChatFile || undefined);
      const { context, overBudget } = buildConversationContext(contextMessages, character, availableEmotions, {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: wiTimerActivated,
      }, ragCtx ?? undefined);
      const { provider, model } = getProviderAndModel();
      const generationOptions = getGenerationOptions();

      const finalContext = await runGenerateInterceptors(
        maybeApplyInstructMode(context),
        character.name,
      );
      const stream = await api.generateMessage(
        finalContext,
        character.name,
        provider,
        model,
        abortController.signal,
        generationOptions,
        imagesFromLastUserMessage(contextMessages, provider, model),
        isTextCompletionMode()
      );
      if (!stream) return;

      // Add new empty swipe
      const newSwipeIndex = msg.swipes.length;
      set((state) => ({
        messages: state.messages.map((m) => {
          if (m.id !== messageId) return m;
          return { ...m, swipes: [...m.swipes, ''], swipeId: newSwipeIndex, content: '' };
        }),
      }));

      let responseText = '';
      const sseMeta: SSEStreamMeta = { finishReason: null };
      for await (const token of parseSSEStream(stream, sseMeta)) {
        if (!get().isSending) break; // Aborted
        responseText += token;
        if (!get().isStreaming) set({ isStreaming: true });
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== messageId) return m;
            const newSwipes = [...m.swipes];
            newSwipes[newSwipeIndex] = responseText;
            return { ...m, content: responseText, swipes: newSwipes };
          }),
        }));
      }

      const emotion = parseEmotion(responseText);
      const cleanedContent = stripEmotionTag(responseText);

      if (cleanedContent.trim() === '') {
        // Empty swipe — discard the blank swipe slot we appended and snap back
        // to the previous swipe instead of leaving a blank one in the rotation.
        const aborted = !get().isSending;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== messageId) return m;
            const restoredSwipes = m.swipes.slice(0, newSwipeIndex);
            const swipes = restoredSwipes.length > 0 ? restoredSwipes : [''];
            const swipeId = swipes.length - 1;
            return { ...m, swipes, swipeId, content: swipes[swipeId] ?? '' };
          }),
          error: aborted
            ? state.error
            : buildEmptyResponseError(
                'The model returned an empty response. Try swiping again.',
                'swiping again',
                sseMeta.finishReason,
                generationOptions.maxTokens ?? 0,
                overBudget
              ),
        }));
      } else {
        const usage = recordTurnUsage(provider, model, cleanedContent);
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== messageId) return m;
            const newSwipes = [...m.swipes];
            newSwipes[newSwipeIndex] = cleanedContent;
            return { ...m, content: cleanedContent, emotion, swipes: newSwipes, usage };
          }),
        }));

        // Save
        saveWiTimers(currentChatFile || '', wiTimerActivated, currentTurn);
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        set({ error: error instanceof Error ? error.message : 'Failed to generate swipe' });
      }
    } finally {
      // Fix #2: flush in finally so aborted/errored swipes still persist.
      await saveChatToBackend(get().messages, character, get().currentChatFile);
      set({ isSending: false, isStreaming: false, abortController: null });
    }
  },

  // ---- Regenerate (create new swipe on last AI message) ----
  regenerateMessage: async (character: CharacterInfo, availableEmotions?: string[]) => {
    const { messages } = get();
    // Find last AI message
    const lastAiMsg = [...messages].reverse().find((m) => !m.isUser && !m.isSystem);
    if (!lastAiMsg) return;
    await get().swipeRight(lastAiMsg.id, character, availableEmotions);
  },

  // ---- Continue (extend last AI message) ----
  continueMessage: async (character: CharacterInfo, availableEmotions?: string[]) => {
    const { messages } = get();
    const lastAiMsg = [...messages].reverse().find((m) => !m.isUser && !m.isSystem);
    if (!lastAiMsg) return;

    const abortController = new AbortController();
    set({ isSending: true, isStreaming: false, error: null, abortController });

    try {
      // Build context including the current AI message
      const ragCtx = await resolveRagContext(messages, character.avatar || '', get().currentChatFile || undefined);
      const { context, overBudget } = buildConversationContext(messages, character, availableEmotions, undefined, ragCtx ?? undefined);
      // Append the continue instruction as a user turn, not a system one.
      // Gemini extracts system messages into its separate systemInstruction
      // field, which would leave contents[] ending with an assistant ('model')
      // role and trip its "conversation must end with a user message" 400.
      // User-role works on every provider — Anthropic coerces non-user/assistant
      // roles to user anyway, OpenAI is permissive.
      context.push({
        role: 'user',
        content: '(Continue your previous response naturally. Do not repeat what you already said. Pick up exactly where you left off.)',
      });

      const { provider, model } = getProviderAndModel();
      const finalContext = await runGenerateInterceptors(
        maybeApplyInstructMode(context),
        character.name,
      );
      const generationOptions = getGenerationOptions();
      const stream = await api.generateMessage(
        finalContext,
        character.name,
        provider,
        model,
        abortController.signal,
        generationOptions,
        imagesFromLastUserMessage(messages, provider, model),
        isTextCompletionMode()
      );
      if (!stream) return;

      const existingContent = lastAiMsg.content;
      let newTokens = '';
      const sseMeta: SSEStreamMeta = { finishReason: null };

      for await (const token of parseSSEStream(stream, sseMeta)) {
        if (!get().isSending) break;
        newTokens += token;
        if (!get().isStreaming) set({ isStreaming: true });
        const fullContent = existingContent + newTokens;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== lastAiMsg.id) return m;
            const newSwipes = [...m.swipes];
            newSwipes[m.swipeId] = fullContent;
            return { ...m, content: fullContent, swipes: newSwipes };
          }),
        }));
      }

      // Strip any new emotion tags from the continuation
      const fullText = existingContent + newTokens;
      const cleanedContent = stripEmotionTag(fullText);

      // Gauge counts only the freshly streamed tokens (the prior reply was
      // already billed when first generated); the chip shows the whole bubble.
      // Skip accounting entirely when the continuation produced nothing (empty
      // completion / provider filter / abort) — otherwise we'd bump the
      // odometers by a full prompt's worth of input and clobber the existing
      // per-turn chip. Mirrors the empty-completion guard in the other paths.
      const produced = newTokens.trim() !== '';
      const usage = produced
        ? recordTurnUsage(provider, model, newTokens, { chipOutputText: cleanedContent })
        : lastAiMsg.usage;
      const aborted = !get().isSending;
      set((state) => ({
        messages: state.messages.map((m) => {
          if (m.id !== lastAiMsg.id) return m;
          const newSwipes = [...m.swipes];
          newSwipes[m.swipeId] = cleanedContent;
          return { ...m, content: cleanedContent, swipes: newSwipes, usage };
        }),
        error:
          produced || aborted
            ? state.error
            : buildEmptyResponseError(
                'The model did not add anything new. Try tapping Continue again.',
                'tapping Continue again',
                sseMeta.finishReason,
                generationOptions.maxTokens ?? 0,
                overBudget
              ),
      }));

    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        set({ error: error instanceof Error ? error.message : 'Failed to continue message' });
      }
    } finally {
      // Fix #2: flush in finally so an aborted/errored continuation still
      // persists the tokens that did stream in.
      await saveChatToBackend(get().messages, character, get().currentChatFile);
      set({ isSending: false, isStreaming: false, abortController: null });
    }
  },

  // ---- Impersonate (generate as user, return text without sending) ----
  impersonate: async (character: CharacterInfo, availableEmotions?: string[]): Promise<string> => {
    const { messages } = get();
    const abortController = new AbortController();
    set({ isSending: true, isStreaming: false, error: null, abortController });

    try {
      const ragCtx = await resolveRagContext(messages, character.avatar || '', get().currentChatFile || undefined);
      const { context, overBudget } = buildConversationContext(messages, character, availableEmotions, undefined, ragCtx ?? undefined);
      // User-role instruction so Gemini (which extracts system into a
      // separate systemInstruction field) doesn't leave contents[] ending
      // with an assistant turn and trip its 400. See continueMessage above
      // for the full rationale.
      context.push({
        role: 'user',
        content: `(Now write the next message as the user (You). Write from a first-person perspective as the user would. Do NOT include an emotion tag. Do NOT write as ${character.name}.)`,
      });

      const { provider, model } = getProviderAndModel();
      const finalContext = await runGenerateInterceptors(
        maybeApplyInstructMode(context),
        character.name,
      );
      const generationOptions = getGenerationOptions();
      const stream = await api.generateMessage(finalContext, character.name, provider, model, abortController.signal, generationOptions, undefined, isTextCompletionMode());
      if (!stream) return '';

      let responseText = '';
      const sseMeta: SSEStreamMeta = { finishReason: null };
      for await (const token of parseSSEStream(stream, sseMeta)) {
        if (!get().isSending) break;
        responseText += token;
        if (!get().isStreaming) set({ isStreaming: true });
      }

      const cleanedContent = stripEmotionTag(responseText);
      if (cleanedContent.trim() === '' && get().isSending) {
        set({
          error: buildEmptyResponseError(
            'The model returned an empty response. Try impersonating again.',
            'trying again',
            sseMeta.finishReason,
            generationOptions.maxTokens ?? 0,
            overBudget
          ),
        });
      }
      return cleanedContent;
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        set({ error: error instanceof Error ? error.message : 'Failed to impersonate' });
      }
      return '';
    } finally {
      set({ isSending: false, isStreaming: false, abortController: null });
    }
  },

  // ---- Delete Chat File ----
  deleteChat: async (avatarUrl: string, fileName: string) => {
    try {
      // B2 — real DELETE now that chats live in Postgres. The legacy
      // ST path overwrote with an empty array because /api/chats/delete
      // was finicky; the DB-backed delete removes the row cleanly.
      await api.deleteChat(avatarUrl, fileName);
      const { fetchChatFiles } = get();
      await fetchChatFiles(avatarUrl);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete chat' });
    }
  },

  // ---- Rename Chat File ----
  renameChat: async (avatarUrl: string, originalFile: string, renamedFile: string) => {
    try {
      const sanitized = await api.renameChat(avatarUrl, originalFile, renamedFile);
      // If the renamed chat is the one currently loaded, update the
      // in-memory pointer so subsequent saves target the new filename
      // instead of the (now non-existent) original file.
      const { currentChatFile, fetchChatFiles } = get();
      if (currentChatFile === originalFile) {
        set({ currentChatFile: sanitized });
      }
      await fetchChatFiles(avatarUrl);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to rename chat' });
    }
  },

  // ---- Import Chat File ----
  importChat: async (avatarUrl: string, characterName: string, file: File) => {
    try {
      const userName = getUserDisplayName();
      const parsed = await parseChatTranscript(file, { characterName, userName });
      const fileName = await api.createChat(characterName);
      const { server_ts } = await api.saveChat(avatarUrl, fileName, toSaveChatPayload(parsed));
      chatServerTsByFile.set(fileName, server_ts);
      const { fetchChatFiles } = get();
      await fetchChatFiles(avatarUrl);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to import chat' });
    }
  },

  // ---- Insert Image Message (image gen result inline) ----
  insertImageMessage: async (
    dataUrl: string,
    prompt: string,
    characterName: string,
    characterAvatar: string,
    character: CharacterInfo
  ) => {
    const { addMessage, currentChatFile } = get();
    addMessage({
      name: characterName,
      isUser: false,
      isSystem: false,
      content: prompt ? `*${prompt}*` : '',
      timestamp: Date.now(),
      characterAvatar,
      images: [dataUrl],
    });
    // Persist to backend (non-fatal if it fails)
    await saveChatToBackend(get().messages, character, currentChatFile);
  },

  // ---- Insert Video Message (scene-video result inline) ----
  insertVideoMessage: async (
    videoUrl: string,
    characterName: string,
    characterAvatar: string,
    character: CharacterInfo
  ) => {
    const { addMessage, currentChatFile } = get();
    addMessage({
      name: characterName,
      isUser: false,
      isSystem: false,
      content: '',
      timestamp: Date.now(),
      characterAvatar,
      videos: [videoUrl],
    });
    // Persist to backend (non-fatal if it fails)
    await saveChatToBackend(get().messages, character, currentChatFile);
  },

  // ---- Send Message (updated with abort support) ----
  sendMessage: async (
    content: string,
    character: CharacterInfo,
    availableEmotions?: string[],
    images?: string[]
  ) => {
    // Phase 8.7: STscript slash command intercept
    if (content.trimStart().startsWith('/')) {
      try {
        const stscript = await import('../utils/stscript');
        const ctx = stscript.buildExecutionContext({ originalInput: content.trimStart() });
        await stscript.executeSlashCommand(content.trimStart(), ctx);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Slash command error' });
      }
      return;
    }

    const { addMessage } = get();

    // Phase 6.1: non-vision model guard. Refuse to send images to a model
    // that can't read them — otherwise the backend turns the content-part
    // payload into an opaque 400/500. The user-facing message still posts
    // (minus attachments) so the user can retry after switching models.
    const { provider, model } = getProviderAndModel();
    let attachedImages = images;
    let visionError: string | null = null;
    if (attachedImages && attachedImages.length > 0 && !supportsVision(provider, model)) {
      visionError = `${model || provider || 'This model'} can't see images. Switch to a vision-capable model (GPT-4o, Claude 3+, Gemini) to send attachments.`;
      attachedImages = undefined;
    }

    // Phase 8.2: apply permanent regex scripts to user input
    const processedContent = applyUserInputRegex(content, character.avatar);

    addMessage({
      name: getUserDisplayName(character.avatar),
      isUser: true,
      isSystem: false,
      content: processedContent,
      timestamp: Date.now(),
      images: attachedImages,
    });

    // Fix #1: persist the user's message immediately, before generation. If
    // the turn is aborted or generation throws, the user's message still
    // survives a reload instead of living only in memory until end-of-turn.
    await saveChatToBackend(get().messages, character, get().currentChatFile);

    const abortController = new AbortController();
    set({ isSending: true, isStreaming: false, error: visionError, abortController });

    try {
      const updatedMessages = get().messages;
      const { currentChatFile } = get();
      const currentTurn = updatedMessages.filter((m) => !m.isUser && !m.isSystem).length;
      const wiTimerActivated = new Set<string>();
      const ragCtx = await resolveRagContext(updatedMessages, character.avatar || '', currentChatFile || undefined);
      const { context, overBudget } = buildConversationContext(updatedMessages, character, availableEmotions, {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: wiTimerActivated,
      }, ragCtx ?? undefined);
      const generationOptions = getGenerationOptions();

      const finalContext = await runGenerateInterceptors(
        maybeApplyInstructMode(context),
        character.name,
      );
      const { stream, usedFallback } = await generateWithFallback(
        finalContext,
        character.name,
        provider,
        model,
        abortController.signal,
        generationOptions,
        resolveImagesForSend(attachedImages),
        isTextCompletionMode()
      );
      if (usedFallback) showToastGlobal('Primary provider failed — using fallback', 'warning');

      if (stream) {
        const aiMessageId = generateId();
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: aiMessageId,
              name: character.name,
              isUser: false,
              isSystem: false,
              content: '',
              timestamp: Date.now(),
              swipes: [''],
              swipeId: 0,
            },
          ],
        }));

        let responseText = '';
        const sseMeta: SSEStreamMeta = { finishReason: null };
        for await (const token of parseSSEStream(stream, sseMeta)) {
          if (!get().isSending) break;
          responseText += token;
          if (!get().isStreaming) set({ isStreaming: true });
          set((state) => ({
            messages: state.messages.map((msg) =>
              msg.id === aiMessageId ? { ...msg, content: responseText, swipes: [responseText] } : msg
            ),
          }));
        }

        const emotion = parseEmotion(responseText);
        const cleanedContent = stripEmotionTag(responseText);

        if (cleanedContent.trim() === '') {
          // Zero tokens streamed back (empty completion, upstream timeout, or
          // provider filter). Drop the blank placeholder rather than saving it
          // — a persisted empty bubble both reads as "nothing happened" and
          // poisons later turns. Surface a retry hint unless the user aborted.
          const aborted = !get().isSending;
          set((state) => ({
            messages: state.messages.filter((msg) => msg.id !== aiMessageId),
            error: aborted
              ? state.error
              : buildEmptyResponseError(
                  'The model returned an empty response. Tap send again to retry.',
                  'tap send again',
                  sseMeta.finishReason,
                  generationOptions.maxTokens ?? 0,
                  overBudget
                ),
          }));
        } else {
          const usage = recordTurnUsage(provider, model, cleanedContent);
          set((state) => ({
            messages: state.messages.map((msg) =>
              msg.id === aiMessageId
                ? { ...msg, content: cleanedContent, emotion, swipes: [cleanedContent], usage }
                : msg
            ),
          }));

          saveWiTimers(currentChatFile || '', wiTimerActivated, currentTurn);
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        set({ error: error instanceof Error ? error.message : 'Failed to send message' });
      }
    } finally {
      // Fix #2: flush in finally so aborted/errored turns still persist
      // whatever is in memory (partial AI reply + the user message).
      await saveChatToBackend(get().messages, character, get().currentChatFile);
      set({ isSending: false, isStreaming: false, abortController: null });
    }
  },

  // ---- Send Group Message (updated with abort support) ----
  sendGroupMessage: async (
    content: string,
    characters: CharacterInfo[],
    images?: string[]
  ) => {
    // Phase 8.7: STscript slash command intercept (group chat)
    if (content.trimStart().startsWith('/')) {
      try {
        const stscript = await import('../utils/stscript');
        const ctx = stscript.buildExecutionContext({ originalInput: content.trimStart() });
        await stscript.executeSlashCommand(content.trimStart(), ctx);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Slash command error' });
      }
      return;
    }

    const { addMessage, currentChatFile, getGroupChatByFile } = get();

    // Phase 6.1: non-vision model guard — same as single-character send.
    const { provider, model } = getProviderAndModel();
    let attachedImages = images;
    let visionError: string | null = null;
    if (
      attachedImages &&
      attachedImages.length > 0 &&
      !supportsVision(provider, model)
    ) {
      visionError = `${model || provider || 'This model'} can't see images. Switch to a vision-capable model (GPT-4o, Claude 3+, Gemini) to send attachments.`;
      attachedImages = undefined;
    }

    // Phase 8.2: apply permanent regex scripts to user input (group)
    const processedGroupContent = applyUserInputRegex(content);

    addMessage({
      name: getUserDisplayName(),
      isUser: true,
      isSystem: false,
      content: processedGroupContent,
      timestamp: Date.now(),
      images: attachedImages,
    });

    if (visionError) {
      set({ error: visionError });
    }

    // Fix #1: persist the user's group message immediately, before any
    // generation, so it survives a reload even if the turn is aborted.
    if (currentChatFile && characters.length > 0) {
      await saveChatToBackend(get().messages, characters[0], currentChatFile, true, characters);
    }

    // Resolve strategy + mute from the persisted group chat record. Missing
    // record (very old group chats not reloaded) falls back to list order
    // with no mutes so the legacy behavior still ships.
    const groupChat = currentChatFile ? getGroupChatByFile(currentChatFile) : null;
    const strategy: GroupActivationStrategy =
      groupChat?.activationStrategy ?? DEFAULT_GROUP_ACTIVATION_STRATEGY;
    const mutedAvatars = new Set(groupChat?.mutedAvatars ?? []);
    const pooledExcludeRecent =
      groupChat?.pooledExcludeRecent ?? DEFAULT_POOLED_EXCLUDE_RECENT;
    const autoModeEnabled = groupChat?.autoModeEnabled ?? false;
    const autoModeDelayMs =
      groupChat?.autoModeDelayMs ?? DEFAULT_AUTO_MODE_DELAY_MS;
    const scenarioOverride = groupChat?.scenarioOverride;
    const talkativenessOverrides = groupChat?.talkativenessOverrides;

    // Manual strategy: just post the user message and wait for force-talk.
    // Auto-mode is ignored when the strategy is manual — the user is in
    // full control. The user message was already persisted by Fix #1 above.
    if (strategy === 'manual') {
      return;
    }

    const activeCharacters = characters.filter((c) => !mutedAvatars.has(c.avatar));
    if (activeCharacters.length === 0) {
      set({ error: 'All group members are muted. Unmute someone to continue.' });
      return;
    }

    // Pick the initial speaker queue. List replays the legacy behavior
    // (everyone speaks once in order); natural/pooled pick one.
    const pickSpeakers = (): CharacterInfo[] => {
      if (strategy === 'list') return activeCharacters;
      if (strategy === 'natural') {
        const pick = selectNaturalOrderSpeaker(
          activeCharacters,
          get().messages,
          talkativenessOverrides
        );
        return pick ? [pick] : [];
      }
      if (strategy === 'pooled') {
        const pick = selectPooledOrderSpeaker(
          activeCharacters,
          get().messages,
          pooledExcludeRecent,
          talkativenessOverrides
        );
        return pick ? [pick] : [];
      }
      return [];
    };

    const initialQueue = pickSpeakers();
    if (initialQueue.length === 0) {
      set({ error: 'Could not select a speaker for this turn.' });
      return;
    }

    const abortController = new AbortController();
    // Preserve visionError from the pre-send guard — the turn is still
    // attempted (without images), but we keep the inline warning visible.
    set({
      isSending: true,
      isStreaming: false,
      error: visionError,
      abortController,
    });
    const resolvedImages = resolveImagesForSend(attachedImages);

    try {
      // Run the user-kicked turn(s) first, then loop while auto-mode is on
      // and the user hasn't stopped us. Each loop tick re-runs pickSpeakers:
      // for list-mode this still replays the whole roster each tick (that's
      // what list means — a single "turn" for list is all members speaking
      // once), and natural/pooled pick one speaker per tick.
      let queue: CharacterInfo[] = initialQueue;
      let isFirstTurn = true;
      while (queue.length > 0 && get().isSending) {
        for (const character of queue) {
          if (!get().isSending) break;
          // Only the first turn of the first tick gets images — subsequent
          // characters in the same round are responding to the prior speaker,
          // not to the user's attachment. (We'd re-send the same bytes to
          // each character otherwise.)
          const continued = await generateGroupTurn(
            character,
            characters,
            scenarioOverride,
            abortController,
            get,
            set,
            isFirstTurn ? resolvedImages : undefined
          );
          isFirstTurn = false;
          if (!continued) break;
        }

        if (!autoModeEnabled || !get().isSending) break;

        // Delay between auto-mode ticks. Poll isSending so stop breaks the
        // wait promptly rather than leaving a dangling timer.
        const delay = Math.max(0, autoModeDelayMs);
        if (delay > 0) {
          const start = Date.now();
          while (Date.now() - start < delay && get().isSending) {
            await new Promise((r) => setTimeout(r, Math.min(100, delay)));
          }
        }
        if (!get().isSending) break;
        queue = pickSpeakers();
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        set({ error: error instanceof Error ? error.message : 'Failed to send group message' });
      }
    } finally {
      // Fix #2: flush in finally so aborted/errored group turns still persist
      // whatever members did manage to reply.
      const { currentChatFile: finalChatFile } = get();
      if (finalChatFile && characters.length > 0) {
        await saveChatToBackend(
          get().messages,
          characters[0],
          finalChatFile,
          true,
          characters
        );
      }
      resetStreamingStateIfOwner(abortController, get, set);
    }
  },

  // ---- Force Group Member Talk (Phase 5.2) ----
  // Makes the given member respond next, bypassing the activation strategy
  // and mute state for exactly one turn. Intended to be wired to per-member
  // "talk next" buttons in the group controls panel.
  forceGroupMemberTalk: async (
    character: CharacterInfo,
    characters: CharacterInfo[]
  ) => {
    if (get().isSending) return; // caller should also gate the button
    const { currentChatFile, getGroupChatByFile } = get();
    const groupChat = currentChatFile ? getGroupChatByFile(currentChatFile) : null;
    const scenarioOverride = groupChat?.scenarioOverride;

    const abortController = new AbortController();
    set({ isSending: true, isStreaming: false, error: null, abortController });

    try {
      const { provider, model } = getProviderAndModel();
      await generateGroupTurn(
        character,
        characters,
        scenarioOverride,
        abortController,
        get,
        set,
        imagesFromLastUserMessage(get().messages, provider, model)
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        set({
          error:
            error instanceof Error
              ? error.message
              : 'Failed to force member to respond',
        });
      }
    } finally {
      // Fix #2: flush in finally so an aborted/errored forced turn still
      // persists any reply that streamed in.
      const { currentChatFile: finalChatFile } = get();
      if (finalChatFile && characters.length > 0) {
        await saveChatToBackend(
          get().messages,
          characters[0],
          finalChatFile,
          true,
          characters
        );
      }
      resetStreamingStateIfOwner(abortController, get, set);
    }
  },

  // ---- Edit and Regenerate (updated) ----
  editMessageAndRegenerate: async (messageId: string, newContent: string, character: CharacterInfo, availableEmotions?: string[]) => {
    const { messages } = get();

    const messageIndex = messages.findIndex((m) => m.id === messageId);
    if (messageIndex === -1) return;

    // Update the message and remove all messages after it
    const updatedMessages = messages.slice(0, messageIndex + 1).map((msg) =>
      msg.id === messageId ? { ...msg, content: newContent, swipes: [newContent], swipeId: 0 } : msg
    );

    const abortController = new AbortController();
    set({ messages: updatedMessages, isSending: true, isStreaming: false, error: null, abortController });

    try {
      const { currentChatFile } = get();
      const currentTurn = updatedMessages.filter((m) => !m.isUser && !m.isSystem).length;
      const wiTimerActivated = new Set<string>();
      const ragCtx = await resolveRagContext(updatedMessages, character.avatar || '', currentChatFile || undefined);
      const { context, overBudget } = buildConversationContext(updatedMessages, character, availableEmotions, {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: wiTimerActivated,
      }, ragCtx ?? undefined);
      const { provider, model } = getProviderAndModel();
      const generationOptions = getGenerationOptions();

      const finalContext = await runGenerateInterceptors(
        maybeApplyInstructMode(context),
        character.name,
      );
      const stream = await api.generateMessage(
        finalContext,
        character.name,
        provider,
        model,
        abortController.signal,
        generationOptions,
        imagesFromLastUserMessage(updatedMessages, provider, model),
        isTextCompletionMode()
      );

      if (stream) {
        const aiMessageId = generateId();
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: aiMessageId,
              name: character.name,
              isUser: false,
              isSystem: false,
              content: '',
              timestamp: Date.now(),
              swipes: [''],
              swipeId: 0,
            },
          ],
        }));

        let responseText = '';
        const sseMeta: SSEStreamMeta = { finishReason: null };
        for await (const token of parseSSEStream(stream, sseMeta)) {
          if (!get().isSending) break;
          responseText += token;
          if (!get().isStreaming) set({ isStreaming: true });
          set((state) => ({
            messages: state.messages.map((msg) =>
              msg.id === aiMessageId ? { ...msg, content: responseText, swipes: [responseText] } : msg
            ),
          }));
        }

        const emotion = parseEmotion(responseText);
        const cleanedContent = stripEmotionTag(responseText);

        if (cleanedContent.trim() === '') {
          // Empty completion on edit-and-regenerate — drop the blank
          // placeholder instead of persisting it (see sendMessage above).
          // Note: the generic Regenerate control targets the chat's last AI
          // message, which after this drop is an earlier turn preceding the
          // edit — so the retry hint below points at "Save & regenerate" on
          // the edited message instead, the control that actually reruns
          // this same request.
          const aborted = !get().isSending;
          set((state) => ({
            messages: state.messages.filter((msg) => msg.id !== aiMessageId),
            error: aborted
              ? state.error
              : buildEmptyResponseError(
                  'The model returned an empty response. Edit your message again and choose "Save & regenerate" to retry.',
                  'choosing "Save & regenerate" again',
                  sseMeta.finishReason,
                  generationOptions.maxTokens ?? 0,
                  overBudget
                ),
          }));
        } else {
          const usage = recordTurnUsage(provider, model, cleanedContent);
          set((state) => ({
            messages: state.messages.map((msg) =>
              msg.id === aiMessageId
                ? { ...msg, content: cleanedContent, emotion, swipes: [cleanedContent], usage }
                : msg
            ),
          }));

          saveWiTimers(currentChatFile || '', wiTimerActivated, currentTurn);
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        set({ error: error instanceof Error ? error.message : 'Failed to regenerate response' });
      }
    } finally {
      // Fix #2 + truncation: edit-and-regenerate rewrites history (drops every
      // message after the edited one), so the array can shrink below what's
      // stored — flush in finally with allow_truncate so an aborted/errored
      // regen still persists and the backend doesn't reject the smaller array.
      await saveChatToBackend(
        get().messages,
        character,
        get().currentChatFile,
        false,
        undefined,
        true
      );
      set({ isSending: false, isStreaming: false, abortController: null });
    }
  },

  clearChat: () => set({ messages: [], chatFiles: [], currentChatFile: null }),

  resetUser: () => {
    // Stop any pending debounced persist from flushing the previous user's
    // snapshot into the next account.
    _persistEnabled = false;
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    _latestSnapshot.authorNotes = {};
    _latestSnapshot.groupChats = [];
    _latestSnapshot.chatVariables = {};
    set({
      messages: [],
      chatFiles: [],
      groupChats: [],
      currentChatFile: null,
      isStreaming: false,
      isSending: false,
      error: null,
      abortController: null,
      currentSpeakerName: null,
      authorNotes: {},
      chatVariables: {},
    });
    try { localStorage.removeItem(CHAT_VARIABLES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(AUTHOR_NOTES_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(GROUP_CHATS_KEY); } catch { /* ignore */ }
    clearLocalTs(LOCAL_TS_KEY);
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | (ChatStateSnapshot & { _ts?: number })
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      if (!stored) {
        // First sync — seed the server with whatever is in localStorage.
        _persistEnabled = true;
        const s = get();
        const hasAnything =
          Object.keys(s.authorNotes).length > 0 ||
          s.groupChats.length > 0 ||
          Object.keys(s.chatVariables).length > 0;
        _latestSnapshot.authorNotes = s.authorNotes;
        _latestSnapshot.groupChats = s.groupChats;
        _latestSnapshot.chatVariables = s.chatVariables;
        if (hasAnything) {
          patchServerKey(
            SERVER_KEY,
            { ..._latestSnapshot } as unknown as Record<string, unknown>,
            LOCAL_TS_KEY,
          ).catch(() => {});
        }
        return;
      }

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        // Local has unconfirmed mutations — push them.
        _persistEnabled = true;
        const s = get();
        _latestSnapshot.authorNotes = s.authorNotes;
        _latestSnapshot.groupChats = s.groupChats;
        _latestSnapshot.chatVariables = s.chatVariables;
        patchServerKey(
          SERVER_KEY,
          { ..._latestSnapshot } as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      // Server has newer (or equal) state — apply.
      _persistEnabled = false;
      const authorNotes =
        stored.authorNotes && typeof stored.authorNotes === 'object'
          ? stored.authorNotes
          : {};
      const groupChats = Array.isArray(stored.groupChats)
        ? stored.groupChats.map(migrateGroupChat)
        : [];
      const chatVariables =
        stored.chatVariables && typeof stored.chatVariables === 'object'
          ? stored.chatVariables
          : {};
      // Cache to localStorage so the next cold load is instant.
      try {
        localStorage.setItem(AUTHOR_NOTES_KEY, JSON.stringify(authorNotes));
        localStorage.setItem(GROUP_CHATS_KEY, JSON.stringify(groupChats));
        localStorage.setItem(CHAT_VARIABLES_KEY, JSON.stringify(chatVariables));
        recordServerTs(LOCAL_TS_KEY, serverTs);
      } catch { /* ignore */ }
      _latestSnapshot.authorNotes = authorNotes;
      _latestSnapshot.groupChats = groupChats;
      _latestSnapshot.chatVariables = chatVariables;
      set({ authorNotes, groupChats, chatVariables });
      _persistEnabled = true;
    } catch {
      // Network failure — keep local. Future mutations will mark LOCAL_TS_KEY
      // dirty and the next fetchPrefs will detect the local-newer case.
      _persistEnabled = true;
    }
  },
}));
