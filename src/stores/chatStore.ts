import { create } from 'zustand';
import {
  api,
  apiRequest,
  getCsrfToken,
  ChatConflictError,
  type CharacterInfo,
  type GenerationOptions,
  type GenerationImage,
  type Project,
  type ProjectChatRef,
} from '../api/client';
import type { Edit } from '../types/storyBible';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';
import { useSettingsStore } from './settingsStore';
import { usePersonaStore } from './personaStore';
import {
  useGenerationStore,
  POST_HISTORY_SECTIONS,
  type PromptSectionEntry,
  type PromptSectionId,
} from './generationStore';
import { useCharacterStore } from './characterStore';
// Selfie teaching block (Phase 2). Function-definition imports only — the
// chatStore↔selfie dispatch cycle is broken by keeping the subscription in the
// separate selfieDispatch module (see stores/selfieStore).
import { selfieEligibleForCurrentChat, buildSelfieInstruction } from './selfieStore';
import {
  useWorldInfoStore,
  scanMessagesForEntries,
  loadWiTimers,
  saveWiTimers,
  remapLegacyBookId,
  remapLegacyEntryId,
  type WorldInfoPosition,
  type MatchedEntry,
  type WorldInfoScanReport,
} from './worldInfoStore';
import { useChatLoreConfigStore } from './chatLoreConfigStore';
import { resolveEffectiveBooks } from '../utils/worldInfoComposition';
import { tryServerRetrieval, commitServerRetrieval } from '../utils/serverRetrieval';
import { parseEmotion, stripEmotionTag, type Emotion } from '../utils/emotions';
import { dataUrlToPart, supportsVision } from '../utils/images';
import { processMacros, type MacroContext } from '../utils/macros';
import {
  recordWiFired,
  sanitizeWiFired,
  mergeWiFiredMaps,
  remapWiFiredKeys,
  type WiFiredMap,
  type WiFiredRemapResult,
} from '../utils/wiFired';
import {
  generateMessageId,
  takeWireMessageId,
  ensureUniqueMessageIds,
  rekeyRestoredMessages,
} from '../utils/messageIdentity';
import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  profileForProvider,
  trimHistoryToBudget,
  type TokenizerProfile,
} from '../utils/tokenizer';
import {
  addSlice,
  beginBreakdownPass,
  createPromptBreakdown,
  recordAttachments,
  recordCallSiteTurn,
  withHistoryRole,
  type GroupSlotId,
  type PromptBreakdown,
  type SectionKind,
} from '../utils/promptBreakdown';
import { useUsageStore } from './usageStore';
import { usePromptTemplateStore } from './promptTemplateStore';
import { getInstructTemplate, formatInstructPrompt } from '../utils/instructTemplates';
import { getProviderAndModel, getGenerationOptions } from '../utils/llm/resolve';
import { useRegexScriptStore } from './regexScriptStore';
import { applyRegexScripts, getActiveScripts } from '../utils/regexScripts';
import { useSummarizeStore } from './summarizeStore';
import { useChatHistoryRagStore } from './chatHistoryRagStore';
import { groupHistoryWindow } from '../utils/groupHistoryWindow';
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
  /** #414: user-toggled "hide from AI". When true the message STAYS visible
   *  in the chat UI (dimmed, with a badge) but is EXCLUDED from everything the
   *  model sees — prompt/history, world-info scan, {{last*}} macros, chat RAG,
   *  summaries, and memory extraction. Distinct from isSystem, which removes
   *  the bubble from the UI entirely. Persisted as `extra.hidden`; absent on
   *  pre-#414 chats = not hidden. */
  hidden?: boolean;
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
  /** #414: toggle a message's hidden-from-AI flag (stays visible in the UI). */
  toggleMessageHidden: (messageId: string) => void;
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

// Story-state phase 1: message ids are permanent UUIDs persisted at
// extra.ggbc_id (see utils/messageIdentity.ts). Every create path mints
// through this single alias.
const generateId = generateMessageId;

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
// an overBudget request — per #453, that fires when the PINNED content (the
// newest turn plus pinned critical lore plus the system block) exceeds the
// trim budget, not when the newest message alone does — falling back to the
// given generic message otherwise.
// `retryAction` completes "..., then <retryAction>." (e.g. "tap send again").
// `maxTokens` and `overBudget` must be the values captured at dispatch time
// (the request that actually produced this empty response), not re-read from
// generationStore live — the sampler and trim-budget flag are shared mutable
// state that a concurrent send/swipe/chat-switch can overwrite before this
// stream resolves.
// Exported for tests — the app itself only reaches this via the five solo
// generation call sites' empty-completion branches (review round 1, F19: the
// overBudget string had no test at all, and reverting it via a bad merge
// would silently restore the #453 misdiagnosis this diff exists to fix).
export function buildEmptyResponseError(
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
    // Review round 1 (F4/F11/F19): name all THREE pinned contributors — the
    // old wording named the message and critical lore but dropped the system/
    // character block, which trimHistoryToBudget charges off the top before
    // any pinned message and is very often the largest of the three. This
    // must stay in sync with historyBadge's over-budget string in
    // breakdownBuckets.ts, which names the same triad.
    return `Your message, the assembled system/character block (persona, character card, and World Info), or pinned lore (constant/critical World Info entries) may be too large for the current context window. Try raising Max Context Tokens in Settings → Generation, shortening your message, trimming the character card or persona, or demoting/splitting critical lore entries, then ${retryAction}.`;
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

// Single abort budget for the /retrieval/messages call below — same value
// as src/utils/serverRetrieval.ts's RETRIEVAL_TIMEOUT_MS (module-private
// there, so not reused directly; this helper must also cover the group
// path, which serverRetrieval.ts explicitly must never be imported by).
const RAG_MESSAGES_TIMEOUT_MS = 6000;

function ragAbortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timeoutId) };
}

/**
 * Phase 2 of the memory-consolidation plan — RAG helper.
 * Extracts the last user message from `messages` and queries the
 * server-side message-recall endpoint for `chatFile` (older turns indexed
 * semantically — recalls specific past moments without keeping them in
 * raw history).
 *
 * Data Bank documents used to be a second source queried here; they're now
 * native Lorebooks and flow through the same server-side
 * `/retrieval/context` activation path as any other lorebook entry instead
 * (see dataBankStore.ts's module docstring) — this helper only covers the
 * source that's genuinely still client-side... well, "client-side" is now
 * a misnomer: embedding happens server-side (a POST /chats/save side
 * effect, gated on chatHistoryRagStore's `enabled`), and this call is a
 * single POST /retrieval/messages — a never-throws wrapper mirroring
 * src/utils/serverRetrieval.ts's `tryServerRetrieval`, just for messages
 * instead of lore, and covering the group path that module explicitly
 * must not touch.
 *
 * `boundaryId` — the id of the oldest message in the raw tail this turn's
 * prompt will actually keep — is now an ARGUMENT, not something this helper
 * derives. Until E2-S2 task 1b it came from `computeRagBoundary`
 * (src/utils/ragBoundary.ts), a standalone re-simulation of the solo trim
 * that ran before the builder and therefore had to guess at five things the
 * real assembly knows: the provider's tokenizer profile, the size of the
 * assembled system block (the sim passed an empty one where the real trim
 * passes 2-3K tokens' worth), the at-depth insertions and summary that share
 * the history array with real turns, macro-substituted vs raw content, and
 * the blank/image-only turn skips. Five divergences in two directions do not
 * add up to a "conservative" estimate, so the re-simulation was deleted
 * rather than repaired: solo callers now run the real builder once and read
 * `boundaryId` off an uncommitted `finishConversationContext` pass, and group
 * callers read it off `groupHistoryWindow` — the same function the group
 * builder emits its history from.
 *
 * Pass `null` only to mean "this caller genuinely has no boundary"; the
 * server then falls back to excluding a fixed tail count, which can return
 * chunks the prompt already contains.
 */
export async function resolveRagContext(
  messages: ChatMessage[],
  chatFile: string | undefined,
  boundaryId: string | null
): Promise<string | null> {
  // #414: hidden messages must not feed chat-history RAG — neither as the
  // retrieval query nor (server-side) as embedded/retrievable chunks.
  const visibleMessages = messages.filter((m) => !m.hidden);
  const lastUser = [...visibleMessages].reverse().find((m) => m.isUser && !m.isSystem);
  if (!lastUser?.content.trim()) return null;
  if (!chatFile) return null;
  if (!useChatHistoryRagStore.getState().enabled) return null;

  // Group identity: the save/load identity is groupCharacters[0].avatar /
  // characterAvatars[0] (chatStore.ts's buildChatPayload/loadGroupChat),
  // NOT the current speaker — threading the speaker's avatar here would
  // 404 for every non-first speaker and this never-throws wrapper would
  // silently turn that into empty recall. Solo chats fall back to the
  // currently selected character.
  const groupChat = useChatStore.getState().getGroupChatByFile(chatFile);
  const characterAvatar =
    groupChat?.characterAvatars[0] ?? useCharacterStore.getState().selectedCharacter?.avatar ?? '';
  if (!characterAvatar) return null;

  const { signal, cancel } = ragAbortAfter(RAG_MESSAGES_TIMEOUT_MS);
  try {
    const dto = await api.getRetrievalMessages(
      characterAvatar,
      chatFile,
      lastUser.content,
      3,
      boundaryId,
      signal
    );
    if (!dto || !Array.isArray(dto.chunks)) return null;

    // The server's degradation code for this call (ggbc-backend#81,
    // app/routers/retrieval.py). Read as a switch over KNOWN values with an
    // explicit default because a second consumer is already queued: E9-S7
    // (#455) surfaces `"no_key"` as a UI hint and must be able to add a case
    // rather than rewrite this read.
    //
    // SEMANTICS — do not misread this: a NULL (or absent) reason means only
    // "the id you sent resolved to a live message in the persisted chat". It is NOT a
    // statement that the window is correct. Nothing server-side can validate
    // that; the only defence is that the id came from the real assembly rather
    // than from a re-simulation of it, which is exactly what task 1b's
    // deletion of `computeRagBoundary` bought. Never add code that treats a
    // null reason as validation of the boundary.
    switch (dto.reason) {
      // THE ORDINARY CASE, and `null` is the shape the deployed server
      // actually sends: `RetrievalMessagesOut.reason` is `str | None = None`
      // serialized without `exclude_none`, so every 200 carries the key and
      // an ABSENT `reason` is something no current backend produces.
      // `undefined` is kept in the same arm rather than deleted — the DTO
      // types the field optional, and a stripping proxy or a pre-#81 build
      // would land here — but the two are ONE arm on purpose: split them, or
      // narrow on `!== undefined` anywhere, and every healthy recall turn
      // gets classified as degraded.
      case null:
      case undefined:
        break;
      case 'boundary_not_found':
        // The id we sent named no live message, so the server excluded only a
        // fixed count of newest messages instead of our real raw tail. Recall
        // on that guessed window can return turns the prompt already carries.
        console.warn(
          '[resolveRagContext] server could not resolve boundaryId ' +
            `${JSON.stringify(boundaryId)} — recall ran against a guessed ` +
            'window (newest few messages excluded by count) and may duplicate ' +
            'raw history this turn'
        );
        break;
      default:
        // A reason this build does not know about. Recall still applies; a
        // newer server is allowed to say more than an older client parses.
        break;
    }

    const parts: string[] = [];
    for (const chunk of dto.chunks) {
      const who = chunk.isUser ? 'User' : 'Character';
      parts.push(`[Earlier in chat — ${who}]\n${chunk.text}`);
    }
    if (parts.length === 0) return null;
    return parts.join('\n\n---\n\n');
  } catch (err) {
    console.warn('[resolveRagContext] failed — recall skipped this turn', err);
    return null;
  } finally {
    cancel();
  }
}

/**
 * The boundary a GROUP turn must send to chat-history recall: the oldest
 * message `buildGroupConversationContext` will emit as raw history.
 *
 * Group needs no two-pass fixed point the way solo does. There is no
 * `trimHistoryToBudget` on that path — the window is a fixed slice — so
 * recall's own size cannot move the boundary it is measured against, and the
 * answer is available before the builder runs.
 *
 * It reads `groupHistoryWindow`, the SAME function the builder slices its
 * history from, which is the whole point: these two used to be hand-synced
 * copies of one expression living in two files, and the copy in
 * `ragBoundary.ts` had already drifted a stale anchor 270 lines away from the
 * real one. Exported so a test can prove both callers reach the same function
 * object rather than two equal-looking expressions.
 */
export function groupRecallBoundary(messages: ChatMessage[]): string | null {
  const window = groupHistoryWindow(messages);
  return window.length > 0 ? window[0].id : null;
}

// In/out parameter for the world-info scan inside buildConversationContext
// and buildGroupConversationContext:
// the caller supplies turn/timer state for timed effects and receives back
// the freshly activated entry ids (for saveWiTimers) and, in `fired`, the
// entries whose content actually survived into the assembled prompt — after
// WI token budgeting, promptOrder section-enable filtering, macro-empty
// drops, and token-aware history trimming; sticky carry-overs included.
// Consumed by the WI fired-state telemetry via captureWiFired.
interface WiScanOut {
  currentTurn: number;
  timers: Record<string, number>;
  activated: Set<string>;
  fired?: MatchedEntry[];
  /** What the WI token budget evicted during the scan (fail-loud audit). */
  scanReport?: WorldInfoScanReport;
  /** At-depth entries that survived the scan but were cut by history trim. */
  trimmedAtDepth?: MatchedEntry[];
}

// Chats already warned about pinned lore exceeding the WI budget this app
// session — the toast fires once per chat, not on every generation.
const wiPinnedWarnedChats = new Set<string>();

/** The four promptOrder sections that carry world-info content. Used only by
 *  the token breakdown, to keep the "what the model was actually charged for
 *  lore" number separable from the rest of the system block. */
const WI_SECTION_IDS: ReadonlySet<PromptSectionId> = new Set<PromptSectionId>([
  'wi_before_char',
  'wi_after_char',
  'wi_before_an',
  'wi_after_an',
]);

/** One entry of an assembled prompt — what the builders push and what the API
 *  layer sends. Spelled out inline at ~30 sites before E2-S2; named now
 *  because the prepare/finish split has to carry arrays of them across a
 *  function boundary. */
type ContextEntry = { role: 'user' | 'assistant' | 'system'; content: string };

/**
 * Everything `prepareConversationContext` resolved that
 * `finishConversationContext` still needs.
 *
 * WHY THE SPLIT EXISTS: recall (`ragContext`) is both an INPUT to the builder
 * — it is one of the fourteen Stage-A sections — and a consumer of the very
 * trim budget that decides which messages survive, so the boundary it should
 * be retrieved against is only knowable after a build. E2-S2 task 1b resolves
 * that as a two-pass fixed point: prepare ONCE, finish twice (the first pass
 * uncommitted, to learn the boundary; the second with the recall it produced).
 *
 * WHY THE BOUNDARY IS WHERE IT IS: everything above it executes macros —
 * `sub()` / `processMacros()`, whose `{{setvar}}`/`{{incvar}}` writes are
 * PERSISTED into the chat — and everything below it executes none. Running the
 * second half twice is therefore free; running one block more would silently
 * double-count a macro write forever. The goldens' at-depth macro counters
 * (`src/stores/__goldens__/README.md`, "Task 1b's split boundary is defended
 * by the at-depth counters") exist to fail the moment that boundary moves.
 *
 * The one section that moves ACROSS the boundary is `rag_context`: it is pure
 * template interpolation with no macro call, so `finish` builds it.
 */
export interface PreparedConversation {
  promptOrder: PromptSectionEntry[];
  /** Every reorderable section's resolved content EXCEPT `rag_context`, which
   *  `finish` fills in from its own argument. */
  sectionContent: Partial<Record<PromptSectionId, string>>;
  historyWithInsertions: ContextEntry[];
  newestTurnMsg: ContextEntry | null;
  wiAtDepthByMessage: Map<object, MatchedEntry[]>;
  /** What each `historyWithInsertions` entry IS — a real turn, or which class
   *  of at-depth insertion. Keyed by object identity (which the trim
   *  preserves), never by a property on the entry: entries are serialized
   *  straight into the network payload (client.ts:1483), so a tag written onto
   *  one would be an emitted-byte change. Separate from `wiAtDepthByMessage`
   *  on purpose — that map feeds the persisted `wi_fired` telemetry and must
   *  not gain non-world-info members. */
  entryClassByMessage: Map<object, SectionKind>;
  wiByPosition: Record<WorldInfoPosition, MatchedEntry[]>;
  wiRendered: Set<MatchedEntry>;
  wiScanReport: WorldInfoScanReport;
  /** Which activation engine produced this turn's entries. AC 9's data: the
   *  drill-down says "reason unavailable (server-path turn)" off THIS, and
   *  never infers it from a missing `matchedKeyCount`. Since E2-S2a a
   *  per-entry reason IS available (MatchedEntry.activationReason) — read
   *  that instead; `matchedKeyCount`'s absence still distinguishes nothing
   *  (undefined for `semantic`, `constant` AND `sticky` alike), and its
   *  presence now only ever means `keyword`. */
  activationSource: 'server' | 'client';
  tokenProfile: TokenizerProfile;
  genState: ReturnType<typeof useGenerationStore.getState>;
  chatStoreState: ReturnType<typeof useChatStore.getState>;
  ctxChatFile: string | null;
  /** The macro variable map the prepare half wrote into. `finish` persists it
   *  — once, on the committing pass only. */
  variables: Record<string, string>;
  wiTimerOut?: WiScanOut;
  /** How many non-system messages Message Count mode's fixed window
   *  (`historyPool = visibleMessages.slice(-ctxConfig.messageCount)`) dropped
   *  before `historyPool` was even built — 0 in token-aware mode, where the
   *  full non-system list is used. Review round 4, R4-B/F3: threaded through
   *  to `finish` so the breakdown collector can record it (see
   *  `flags.droppedByMessageWindow`). */
  windowSkew: number;
}

export interface FinishConversationOptions {
  /**
   * Whether this pass is the real one. `false` makes `finish` a pure
   * function: no `setLastTokenEstimate`, no `setChatVariables`, no
   * `wiTimerOut` mutation. Task 1b's first pass runs uncommitted purely to
   * learn the recall boundary, and a store write from a throwaway pass would
   * be a real, persisted corruption of the user's chat.
   */
  commit?: boolean;
  breakdownOut?: PromptBreakdown;
}

export interface FinishedConversation {
  context: ContextEntry[];
  /** True when the PINNED content alone — the newest turn, plus the system/
   *  character block, plus any pinned constant/critical World Info entries —
   *  exceeded the configured token budget and had to be force-included
   *  anyway (#453; NOT the newest message alone). Captured here (dispatch
   *  time) rather than round-tripped through generationStore, since a
   *  concurrent send/swipe can overwrite a shared store field before this
   *  call's own stream resolves. */
  overBudget: boolean;
  /** `ChatMessage.id` of the oldest KEPT entry that is a real chat turn, or
   *  null. Read by all five solo generation call sites (task 1b): the probe
   *  pass's value is what `resolveRagContext` sends the server. */
  boundaryId: string | null;
}

// Build conversation context for AI. Thin wrapper over the prepare/finish
// pair: one prepare, one committing finish. PRODUCTION NO LONGER CALLS THIS —
// since task 1b the five solo call sites use prepare/finish directly (they need
// the uncommitted probe). It remains the exported seam the golden-prompt
// harness and E8-S4's byte-equivalence check are defined against; the goldens
// pin THIS function's output, and chatStore.callSites.test.ts is what pins the
// call sites' two-pass arrangement.
export function buildConversationContext(
  messages: ChatMessage[],
  character: CharacterInfo,
  availableEmotions?: string[],
  wiTimerOut?: WiScanOut,
  ragContext?: string,
  serverMatchedEntries?: MatchedEntry[],
  breakdownOut?: PromptBreakdown
): { context: ContextEntry[]; overBudget: boolean } {
  const prepared = prepareConversationContext(
    messages,
    character,
    availableEmotions,
    wiTimerOut,
    serverMatchedEntries
  );
  const { context, overBudget } = finishConversationContext(prepared, ragContext, {
    breakdownOut,
  });
  return { context, overBudget };
}

/**
 * The side-effecting half: macro substitution, the world-info scan, extension
 * hooks, and the history array with every at-depth insertion already placed.
 * Runs EXACTLY ONCE per generation. Calling it twice re-rolls `{{random}}`,
 * re-registers world-info activations and double-executes every `{{setvar}}`.
 */
export function prepareConversationContext(
  messages: ChatMessage[],
  character: CharacterInfo,
  availableEmotions?: string[],
  wiTimerOut?: WiScanOut,
  /**
   * When provided (by a call site that awaited tryServerRetrieval and got a
   * non-null result), used in place of the local scanMessagesForEntries
   * call — see the assignment below. Everything downstream of
   * matchedEntries (position grouping, macro substitution, persona-book
   * tagging, fired-state telemetry) is source-agnostic and untouched either
   * way. Undefined (the default) preserves today's behavior exactly: always
   * scan locally.
   */
  serverMatchedEntries?: MatchedEntry[]
): PreparedConversation {

  // #414: hidden messages stay in the UI but must never reach the model.
  // Strip them once here and use `visibleMessages` for every model-facing read
  // below — macros, world-info scan, extension hooks, and the history pool —
  // so a hidden turn can't leak via a lorebook trigger or a {{last*}} macro,
  // not just via the literal prompt turns.
  const visibleMessages = messages.filter((m) => !m.hidden);

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
    visibleMessages,
    activeModel,
    variables
  );
  const sub = (text: string) => (text ? processMacros(text, macroCtx) : '');

  // Scan active world info books for keyword matches against recent history.
  // The character's owned books (its embedded book plus any character-scoped
  // documents) + per-character linked books are
  // auto-activated at scan time (scoped to this call), leaving the global
  // `activeBookIds` list untouched as the user navigates between characters.
  // Persona-linked books are unioned in on top of that so each scope
  // contributes its own bucket. The legacy chat-linked-books map is folded
  // in via resolveEffectiveBooks (chatConfig), not unioned directly here.
  const wiState = useWorldInfoStore.getState();
  // Composition input is own books + the caller's group's shared books
  // (own wins on id collision) — widens what resolveEffectiveBooks /
  // scanMessagesForEntries can see without touching either, per Phase 1's
  // purity contract.
  const composableBooks = wiState.getComposableBooks();
  const charBookIds = useCharacterStore
    .getState()
    .getActiveBookIdsForCharacter(character.avatar || '');
  const personaBookIds = persona?.linkedBookIds ?? [];
  const inheritedBookIds = Array.from(
    new Set([
      ...wiState.activeBookIds,
      ...charBookIds,
      ...personaBookIds,
    ])
  );
  const chatConfig = ctxChatFile
    ? useChatLoreConfigStore.getState().getEffectiveConfig(ctxChatFile)
    : undefined;
  const { effectiveBooks, effectiveActiveIds } = resolveEffectiveBooks(
    composableBooks,
    inheritedBookIds,
    chatConfig
  );
  const tokenProfile = profileForProvider(activeProvider);
  const wiScanReport: WorldInfoScanReport = {
    dropped: [],
    pinnedTokens: 0,
    totalTokens: 0,
    budget: 0,
    pinnedOverBudget: false,
  };
  // serverMatchedEntries, when present, already IS this turn's fully
  // resolved activation result (server-side activation engine, budget-
  // trimmed) — skip the local scan entirely rather than run both.
  // wiScanReport stays at its zeroed default in that case: the server
  // doesn't return a "what got budget-evicted" list, so the pinned-over-
  // budget audit toast below simply can't fire for a server-path turn (a
  // known, minor limitation — no wrong lore is injected, just that one
  // audit signal is unavailable).
  const matchedEntries = serverMatchedEntries ?? scanMessagesForEntries(
    effectiveBooks,
    effectiveActiveIds,
    visibleMessages,
    {
      scanDepth: wiState.scanDepth,
      maxRecursionSteps: wiState.maxRecursionSteps,
      tokenBudget: wiState.tokenBudget,
      profile: tokenProfile,
      currentTurn: wiTimerOut?.currentTurn,
      wiTimers: wiTimerOut?.timers,
    },
    wiTimerOut?.activated,
    wiScanReport
  );
  if (wiTimerOut) wiTimerOut.scanReport = wiScanReport;
  // Fail-loud instead of silently degrading: when the never-evictable lore
  // (constant + critical) alone exceeds the WI budget, trimming can't help —
  // the fix is architectural (raise the budget, demote or split entries).
  // Warn once per chat per app session.
  if (
    wiScanReport.pinnedOverBudget &&
    ctxChatFile &&
    !wiPinnedWarnedChats.has(ctxChatFile)
  ) {
    wiPinnedWarnedChats.add(ctxChatFile);
    showToastGlobal(
      `Constant + critical lore (~${wiScanReport.pinnedTokens} tokens) exceeds the World Info budget (${wiScanReport.budget}). Raise the budget or demote entries.`,
      'warning'
    );
  }
  // NOTE: wiTimerOut.fired is assigned at the END of this function, from the
  // entries that actually survive into the prompt — the raw scan result here
  // still faces section-enable filtering, macro-empty drops, and token-aware
  // history trimming below.
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
  // Entries whose wrapped content was non-empty at render time. Tracked here
  // (inside the single joinWi pass) rather than by re-wrapping later, because
  // wrapWiContent runs macros and {{setvar}}-style writes must not execute
  // twice. Feeds the fired-state telemetry: an entry whose macros expand to
  // nothing never reaches the prompt and must not be recorded as fired.
  const wiRendered = new Set<MatchedEntry>();
  const joinWi = (list: MatchedEntry[]): string =>
    list
      .map((m) => ({ m, c: wrapWiContent(m) }))
      .filter(({ m, c }) => {
        const ok = c.trim().length > 0;
        if (ok) wiRendered.add(m);
        return ok;
      })
      .map(({ c }) => c)
      .join('\n\n');

  // Phase 7.1: Extension context contributions
  const extContributions = extensionRegistry.runContextHooks({
    messages: visibleMessages.map((m) => ({
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

  // Selfie teaching block (Phase 2) — injected ONLY when this single-character
  // chat is selfie-eligible (feature on + provenance-cleared avatar + the user
  // can generate images + a Replicate key). Empty otherwise, so the model is
  // never told the tag exists for a character it can't send selfies for.
  const selfieInstruction = selfieEligibleForCurrentChat().eligible
    ? buildSelfieInstruction(character.name)
    : '';

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
    selfie_instruction: selfieInstruction,
    // rag_context is DELIBERATELY absent here: it is the one section whose
    // content crosses the prepare/finish boundary, because task 1b's second
    // pass is what supplies it. Nothing is lost by deferring it — it is a
    // template interpolation with no macro call — and `finish` writes the
    // identical string into this same map before the Stage-A loop reads it.
    // With linked style (or pure chat mode) active the card PHI is
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

  // The Stage-A system message is assembled in `finishConversationContext`,
  // not here — `rag_context` is one of its sections and only exists there.
  // The loop that joins it runs no macros, so moving it below the boundary
  // costs nothing and re-running it is free.

  // Decide how many messages to consider for history.
  // #414: build the pool from visibleMessages (hidden already stripped) so a
  // hidden message never reaches the prompt AND never consumes a fixed-window
  // slot (filtered before the slice). The summary-offset math below keys off
  // this same non-hidden pool, and summarizeStore's messageCount is filtered
  // to match — keep both in lockstep or the compaction offset drifts.
  const ctxConfig = genState.context;
  const allNonSystemMessages = visibleMessages.filter((m) => !m.isSystem);
  let historyPool = ctxConfig.tokenAware
    ? allNonSystemMessages
    : visibleMessages.slice(-ctxConfig.messageCount).filter((m) => !m.isSystem);
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
  // The newest REAL chat turn (not an injected note). Pinned through the
  // token-aware trim below: role alone can't distinguish a real turn from a
  // user/assistant-role insertion pushed after it, and the request must
  // never ship without the user's latest message.
  let newestTurnMsg: {
    role: 'user' | 'assistant' | 'system';
    content: string;
  } | null = null;
  // Maps each WI at-depth insertion (by message object identity, which
  // trimHistoryToBudget preserves) to the entries it carries, so the
  // fired-state telemetry can tell which at-depth entries survived trimming.
  const wiAtDepthByMessage = new Map<object, MatchedEntry[]>();
  // E2-S2: what each entry below IS. Same object-identity trick as the map
  // above, for the same reason (the trim preserves identity, and a property
  // written onto the entry would ship in the request body). Deliberately a
  // SECOND map rather than an extra field on the first: that one is the
  // persisted world-info telemetry's input and must stay world-info-only.
  const entryClassByMessage = new Map<object, SectionKind>();
  // Tag whatever was just pushed onto / unshifted into historyWithInsertions.
  // Positional on purpose: it reads as one line directly beneath the push it
  // belongs to, which is what keeps all sixteen insertion sites and their
  // classes visibly in lockstep.
  const tagPushed = (kind: SectionKind) =>
    entryClassByMessage.set(
      historyWithInsertions[historyWithInsertions.length - 1],
      kind
    );
  const tagUnshifted = (kind: SectionKind) =>
    entryClassByMessage.set(historyWithInsertions[0], kind);

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
      tagPushed({ stage: 'B', cls: 'characters_note' });
    }
    // Phase 8.1: Author's Note injection at depth. Guard the post-macro
    // result: a macro-only note (e.g. {{setvar::…}}) renders to '', and an
    // empty content block makes providers like Claude 400 (see below).
    if (authorNote && depthFromEnd === authorNote.depth) {
      const anContent = sub(authorNote.content);
      if (anContent.trim()) {
        historyWithInsertions.push({
          role: authorNote.role,
          content: anContent,
        });
        tagPushed({ stage: 'B', cls: 'authors_note' });
      }
    }
    if (personaAtDepth && depthFromEnd === personaAtDepth.depth) {
      historyWithInsertions.push({
        role: personaAtDepth.role,
        content: personaAtDepth.content,
      });
      tagPushed({ stage: 'B', cls: 'persona_at_depth' });
    }
    // WI at-depth entries: inject as system messages at the matching depth
    const wiHere = wiAtDepthByDepth[depthFromEnd];
    if (wiHere && wiHere.length > 0) {
      const content = joinWi(wiHere);
      if (content) {
        const insertion = { role: 'system' as const, content };
        historyWithInsertions.push(insertion);
        wiAtDepthByMessage.set(insertion, wiHere.filter((m) => wiRendered.has(m)));
        entryClassByMessage.set(insertion, { stage: 'B', cls: 'wi_at_depth' });
      }
    }
    // Phase 7.1: Extension at-depth contributions
    const extHere = extAtDepthByDepth[depthFromEnd];
    if (extHere && extHere.length > 0) {
      for (const c of extHere) {
        if (c.content.trim()) {
          historyWithInsertions.push({ role: c.role, content: c.content });
          tagPushed({ stage: 'B', cls: 'ext_at_depth', extensionId: c.sourceExtensionId });
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
      const turn = {
        role: msg.isUser ? ('user' as const) : ('assistant' as const),
        content: subbed,
      };
      historyWithInsertions.push(turn);
      entryClassByMessage.set(turn, {
        stage: 'B',
        cls: 'history',
        messageId: msg.id,
      });
      newestTurnMsg = turn;
    }
  }

  // Depth 0 — the trailing slot, AFTER the newest message and closest to the
  // generation point. The loop above only reaches depthFromEnd >= 1, so
  // depth-0 insertions were previously dropped on the floor entirely.
  // Same in-loop ordering: depth prompt, author's note, persona, WI, ext.
  // Everything here is trim-guarded: an empty content block 400s providers.
  if (depthPrompt && depthPrompt.depth === 0 && depthPromptContent.trim()) {
    historyWithInsertions.push({
      role: depthPrompt.role,
      content: depthPromptContent,
    });
    tagPushed({ stage: 'B', cls: 'characters_note' });
  }
  if (authorNote && authorNote.depth === 0) {
    const anContent = sub(authorNote.content);
    if (anContent.trim()) {
      historyWithInsertions.push({
        role: authorNote.role,
        content: anContent,
      });
      tagPushed({ stage: 'B', cls: 'authors_note' });
    }
  }
  if (personaAtDepth && personaAtDepth.depth === 0 && personaAtDepth.content.trim()) {
    historyWithInsertions.push({
      role: personaAtDepth.role,
      content: personaAtDepth.content,
    });
    tagPushed({ stage: 'B', cls: 'persona_at_depth' });
  }
  const wiTrailing = wiAtDepthByDepth[0];
  if (wiTrailing && wiTrailing.length > 0) {
    const content = joinWi(wiTrailing);
    if (content) {
      const insertion = { role: 'system' as const, content };
      historyWithInsertions.push(insertion);
      wiAtDepthByMessage.set(
        insertion,
        wiTrailing.filter((m) => wiRendered.has(m))
      );
      entryClassByMessage.set(insertion, { stage: 'B', cls: 'wi_at_depth' });
    }
  }
  const extTrailing = extAtDepthByDepth[0];
  if (extTrailing && extTrailing.length > 0) {
    for (const c of extTrailing) {
      if (c.content.trim()) {
        historyWithInsertions.push({ role: c.role, content: c.content });
        tagPushed({ stage: 'B', cls: 'ext_at_depth', extensionId: c.sourceExtensionId });
      }
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
    tagUnshifted({ stage: 'B', cls: 'characters_note' });
  }
  if (authorNote && authorNote.depth > recentMessages.length) {
    const anContent = sub(authorNote.content);
    if (anContent.trim()) {
      historyWithInsertions.unshift({
        role: authorNote.role,
        content: anContent,
      });
      tagUnshifted({ stage: 'B', cls: 'authors_note' });
    }
  }
  if (personaAtDepth && personaAtDepth.depth > recentMessages.length) {
    historyWithInsertions.unshift({
      role: personaAtDepth.role,
      content: personaAtDepth.content,
    });
    tagUnshifted({ stage: 'B', cls: 'persona_at_depth' });
  }
  // WI at-depth: any entries whose depth exceeds history length prepend.
  for (const depthKey of Object.keys(wiAtDepthByDepth)) {
    const d = parseInt(depthKey, 10);
    if (d > recentMessages.length) {
      const content = joinWi(wiAtDepthByDepth[d]);
      if (content) {
        const insertion = { role: 'system' as const, content };
        historyWithInsertions.unshift(insertion);
        wiAtDepthByMessage.set(
          insertion,
          wiAtDepthByDepth[d].filter((m) => wiRendered.has(m))
        );
        entryClassByMessage.set(insertion, { stage: 'B', cls: 'wi_at_depth' });
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
          tagUnshifted({ stage: 'B', cls: 'ext_at_depth', extensionId: c.sourceExtensionId });
        }
      }
    }
  }

  return {
    promptOrder,
    sectionContent,
    historyWithInsertions,
    newestTurnMsg,
    wiAtDepthByMessage,
    entryClassByMessage,
    wiByPosition,
    wiRendered,
    wiScanReport,
    // AC 9's data. `serverMatchedEntries !== undefined` is the same test the
    // scan above branches on, so the two can never disagree.
    activationSource: serverMatchedEntries !== undefined ? 'server' : 'client',
    tokenProfile,
    genState,
    chatStoreState,
    ctxChatFile,
    variables,
    wiTimerOut,
    windowSkew,
  };
}

/**
 * The pure half: assemble the Stage-A system block (recall included), run the
 * token-aware history trim, emit Stage C, and — only when `commit` is set —
 * write the two store fields this build owns.
 *
 * Executes NO macros. That is not an incidental property, it is the contract
 * that makes task 1b's fixed point safe, and it is checked by the goldens'
 * at-depth macro counters rather than left to a comment.
 */
export function finishConversationContext(
  prepared: PreparedConversation,
  ragContext?: string,
  opts?: FinishConversationOptions
): FinishedConversation {
  const {
    promptOrder,
    sectionContent,
    historyWithInsertions,
    newestTurnMsg,
    wiAtDepthByMessage,
    entryClassByMessage,
    wiByPosition,
    wiRendered,
    wiScanReport,
    activationSource,
    tokenProfile,
    genState,
    chatStoreState,
    ctxChatFile,
    variables,
    wiTimerOut,
    windowSkew,
  } = prepared;
  const commit = opts?.commit !== false;
  const out = opts?.breakdownOut;
  // Clear anything a previous pass left in the collector and stamp this one.
  // `finish` is designed to run more than once per prepare (task 1b's
  // uncommitted boundary pass), and every `addSlice` below appends.
  beginBreakdownPass(out, ctxChatFile);
  const ctxConfig = genState.context;
  const context: ContextEntry[] = [];

  // The one section whose content lives on this side of the boundary — pure
  // interpolation, no macro call, byte-for-byte what prepare used to build.
  sectionContent.rag_context = ragContext
    ? `[Relevant background information]\n${ragContext}`
    : '';

  // Pre-history stage: everything that lives in the leading system block.
  // `systemPartIds` runs in lockstep with `systemParts` — once the fourteen
  // sections are joined into one message their individual costs are gone, and
  // no amount of parsing `context` afterwards brings them back.
  const systemParts: string[] = [];
  const systemPartIds: PromptSectionId[] = [];
  for (const entry of promptOrder) {
    if (!entry.enabled) continue;
    if (POST_HISTORY_SECTIONS.has(entry.id)) continue;
    const content = sectionContent[entry.id];
    if (content && content.trim()) {
      systemParts.push(content);
      systemPartIds.push(entry.id);
    }
  }

  context.push({
    role: 'system',
    content: systemParts.filter(Boolean).join('\n\n'),
  });

  // World-info tokens as EMITTED (post-macro, post-wrapWiContent). Summed off
  // strings that already exist — re-rendering an entry to measure it would
  // execute its {{setvar}} writes a second time.
  let wiEmittedTokens = 0;
  const stageAMessage = context[0];
  if (out) {
    // The profile the numbers were actually measured with — the call site
    // passes a placeholder rather than re-deriving the provider itself.
    out.profile = tokenProfile;
    let sectionSum = 0;
    for (let i = 0; i < systemParts.length; i++) {
      const tokens = estimateTokens(systemParts[i], tokenProfile);
      sectionSum += tokens;
      if (WI_SECTION_IDS.has(systemPartIds[i])) wiEmittedTokens += tokens;
      addSlice(out, { stage: 'A', id: systemPartIds[i] }, tokens, systemParts[i].length);
    }
    out.totals.stageA = sectionSum;
    // DEFINITIONAL, not derived from separator lengths: estimateTokens is
    // non-additive, and a '\n\n' join merges the whitespace run at each part's
    // edge instead of adding one. See PromptBreakdown.stageAJoinResidual.
    const stageAContentTokens = estimateTokens(stageAMessage.content, tokenProfile);
    out.stageAJoinResidual = stageAContentTokens - sectionSum;
    out.stageAMessageOverhead =
      estimateMessageTokens(stageAMessage, tokenProfile) - stageAContentTokens;
  }

  // Token-aware trimming: keep system prompts, drop oldest history that exceeds budget
  let overBudget = false;
  let keptHistory = historyWithInsertions;
  let droppedFromHistory = 0;
  // What the trim charged. Identical to trimmed.usedTokens, and to
  // estimateConversationTokens(systemPrompts ++ kept) — see the identity tests.
  let trimTotal = 0;
  if (ctxConfig.tokenAware) {
    const systemPrompts = context.slice(); // system prompt we already pushed
    // Two kinds of messages must survive the history trim: critical
    // at-depth lore (the WI budget already refused to evict it — without
    // this, "never evicted" would only be true for the scan pass) and the
    // newest real chat turn (trailing depth-0 insertions sit after it, so
    // the trimmer's own newest-first fallback can't identify it by
    // position or role).
    const pinnedMessages = new Set<ContextEntry>();
    if (newestTurnMsg) pinnedMessages.add(newestTurnMsg);
    for (const [msg, entries] of wiAtDepthByMessage) {
      if (entries.some((m) => m.entry.critical)) {
        pinnedMessages.add(msg as ContextEntry);
      }
    }
    const trimmed = trimHistoryToBudget(
      systemPrompts,
      historyWithInsertions,
      ctxConfig.responseReserve,
      ctxConfig.maxTokens,
      tokenProfile,
      pinnedMessages
    );
    context.push(...trimmed.kept);
    if (commit) genState.setLastTokenEstimate(trimmed.usedTokens);
    overBudget = trimmed.overBudget;
    keptHistory = trimmed.kept;
    droppedFromHistory = trimmed.dropped;
    trimTotal = trimmed.usedTokens;
  } else {
    context.push(...historyWithInsertions);
    // No trim ran, so there is no usedTokens to read. The same identity —
    // system block + kept history, Stage C excluded — computed directly.
    trimTotal = estimateConversationTokens(context, tokenProfile);
  }

  // Stage B, measured on what SURVIVED. Measuring historyWithInsertions here
  // instead would report tokens for messages the model is never sent.
  // Untagged entries cannot happen (all sixteen insertion sites tag), but a
  // future seventeenth would land in raw history rather than throw.
  let boundaryId: string | null = null;
  if (out) {
    let stageB = 0;
    for (const entry of keptHistory) {
      const kind: SectionKind =
        entryClassByMessage.get(entry) ?? { stage: 'B', cls: 'history' };
      const tokens = estimateMessageTokens(entry, tokenProfile);
      stageB += tokens;
      if (kind.stage === 'B' && kind.cls === 'wi_at_depth') {
        wiEmittedTokens += estimateTokens(entry.content, tokenProfile);
      }
      // The role comes off the entry the builder already pushed, not from a
      // second read of `msg.isUser` — see `withHistoryRole`.
      addSlice(out, withHistoryRole(kind, entry.role), tokens, entry.content.length);
    }
    out.totals.stageB = stageB;
  }
  // The recall boundary task 1b needs: the OLDEST kept entry that is a real
  // chat turn. Not `keptHistory[0]` — that can be an injected note, which has
  // no message id and would hand the server a boundary it cannot resolve.
  for (const entry of keptHistory) {
    const kind = entryClassByMessage.get(entry);
    if (kind && kind.stage === 'B' && kind.cls === 'history' && kind.messageId) {
      boundaryId = kind.messageId;
      break;
    }
  }

  // Phase 9.1: Post-history stage — char PHI, user PHI, wi_after_an, ext_after_an
  // emit in user-defined order (same map computed above).
  let stageCTotal = 0;
  for (const entry of promptOrder) {
    if (!entry.enabled) continue;
    if (!POST_HISTORY_SECTIONS.has(entry.id)) continue;
    const content = sectionContent[entry.id];
    if (!content || !content.trim()) continue;
    context.push({ role: 'system', content });
    if (out) {
      // Stage C is one message per section, so attribution is free here —
      // no join, no residual.
      const tokens = estimateMessageTokens({ role: 'system', content }, tokenProfile);
      stageCTotal += tokens;
      if (WI_SECTION_IDS.has(entry.id)) {
        wiEmittedTokens += estimateTokens(content, tokenProfile);
      }
      addSlice(out, { stage: 'C', id: entry.id }, tokens, content.length);
    }
  }

  // If not token-aware, still estimate tokens for the UI badge
  if (!ctxConfig.tokenAware && commit) {
    genState.setLastTokenEstimate(
      estimateConversationTokens(context, tokenProfile)
    );
  }

  // Phase 9.3: persist any `{{setvar}}`/`{{addvar}}`/`{{incvar}}`/`{{decvar}}`
  // writes that happened during macro processing back to the chat's store.
  if (commit && ctxChatFile) {
    chatStoreState.setChatVariables(ctxChatFile, variables);
  }

  // Report the WI entries that actually made it into the assembled prompt —
  // NOT the raw scan result. Three filters separate the two: positional
  // sections can be disabled (or absent) in promptOrder, macro-empty content
  // is dropped at render (wiRendered), and at-depth insertions can be
  // trimmed away by the token budget (wiAtDepthByMessage ∩ keptHistory).
  //
  // Derived unconditionally (it is pure, and cheap) because the fired-state
  // telemetry and the token breakdown need the same set; only the WRITE is
  // gated, on both `wiTimerOut` and `commit`.
  const injectedWi: MatchedEntry[] = [];
  const enabledSections = new Set(
    promptOrder.filter((e) => e.enabled).map((e) => e.id)
  );
  const positionBySection: Array<[PromptSectionId, WorldInfoPosition]> = [
    ['wi_before_char', 'before_char'],
    ['wi_after_char', 'after_char'],
    ['wi_before_an', 'before_an'],
    ['wi_after_an', 'after_an'],
  ];
  for (const [sectionId, position] of positionBySection) {
    if (!enabledSections.has(sectionId)) continue;
    for (const m of wiByPosition[position]) {
      if (wiRendered.has(m)) injectedWi.push(m);
    }
  }
  for (const msg of keptHistory) {
    const atDepth = wiAtDepthByMessage.get(msg);
    if (atDepth) injectedWi.push(...atDepth);
  }
  // At-depth entries the history trim cut after the scan passed them —
  // never critical ones (those are pinned above), but part of the audit.
  const keptSet = new Set<object>(keptHistory);
  const trimmedAtDepth: MatchedEntry[] = [];
  for (const [msg, atDepth] of wiAtDepthByMessage) {
    if (!keptSet.has(msg)) trimmedAtDepth.push(...atDepth);
  }
  if (commit && wiTimerOut) {
    wiTimerOut.fired = injectedWi;
    wiTimerOut.trimmedAtDepth = trimmedAtDepth;
  }

  if (out) {
    out.totals.stageC = stageCTotal;
    out.totals.trimTotal = trimTotal;
    out.totals.assembledTotal = estimateConversationTokens(context, tokenProfile);
    out.wi.emittedTokens = wiEmittedTokens;
    // The WI budget's own cost function (worldInfoStore.ts:1325) — RAW entry
    // content, before macros and before the persona attribution wrapper. AC 6
    // wants both numbers precisely because they differ.
    out.wi.rawTokens = injectedWi.reduce(
      (sum, m) => sum + estimateTokens(m.entry.content, tokenProfile),
      0
    );
    out.wi.budget = wiScanReport.budget;
    out.wi.droppedIds = wiScanReport.dropped.map((m) => m.entry.id);
    out.wi.activationSource = activationSource;
    out.flags.overBudget = overBudget;
    out.flags.historyTrimmed = ctxConfig.tokenAware;
    out.flags.droppedFromHistory = droppedFromHistory;
    // Review round 4, R4-B/F3: `windowSkew` is a direct measurement (not a
    // mode test) — it is already 0 whenever tokenAware is on, because
    // `historyPool` is the full non-system list on that path (see
    // `prepareConversationContext`'s comment above `windowSkew`'s
    // computation). `messageWindowSize`, like `responseReserve` above, IS a
    // mode test: there is no non-null "window size" to report when this
    // build never windowed on message count at all.
    out.flags.droppedByMessageWindow = windowSkew;
    out.flags.messageWindowSize = ctxConfig.tokenAware ? null : ctxConfig.messageCount;
    // The reserve is read at one place only — the trim call above — so with
    // `tokenAware` off it constrained nothing and there is no Reserved slice
    // to draw, exactly as in group.
    out.flags.hasReservedSlice = ctxConfig.tokenAware;
    // ...and the number behind that flag, so a panel sizing the Reserved
    // slice never has to re-read the live setting — which the user can change
    // between this send and that render.
    //
    // The EFFECTIVE reserve, not the configured one: `trimHistoryToBudget`
    // floors the budget at 256 (`Math.max(256, maxTokens - responseReserve)`,
    // tokenizer.ts), so with e.g. maxTokens 1024 / reserve 2048 the trim
    // subtracts 768, not 2048. Reporting the raw setting there would hand
    // task 3 a Reserved wedge larger than the whole context window — the
    // fifth-round review reproduced exactly that with shipped defaults
    // (reserve defaults to 2048; the Max Context slider goes down to 1024).
    out.responseReserve = ctxConfig.tokenAware
      ? ctxConfig.maxTokens -
        Math.max(256, ctxConfig.maxTokens - ctxConfig.responseReserve)
      : null;
    out.boundaryId = boundaryId;
  }

  return { context, overBudget, boundaryId };
}

// Build conversation context for group chat AI.
// Exported for tests — the app itself only reaches this via generateGroupTurn.
export function buildGroupConversationContext(
  messages: ChatMessage[],
  characters: CharacterInfo[],
  currentCharacter: CharacterInfo,
  scenarioOverride?: string,
  ragContext?: string,
  cardMode: GroupCardMode = DEFAULT_GROUP_CARD_MODE,
  wiTimerOut?: WiScanOut,
  /**
   * E9-S6 review-fix: whether THIS build's caller will hand the same image
   * attachments to `api.generateMessage`. It is one half of the test for whether
   * a blank user turn that exists ONLY to carry an attachment is worth keeping —
   * the turn also has to be the one the fold lands on, see the history loop
   * below. Defaults to `true`, the historical group behavior and what
   * solo can always assume, so existing callers and tests are unaffected;
   * `generateGroupTurn` passes the real value for the turn it is building.
   */
  attachmentsFolded: boolean = true,
  /**
   * E2-S2: optional token-breakdown collector. Trailing and optional so the
   * ~30 existing assertions on this function's bare-array return, and every
   * existing call, are untouched — group's return type deliberately does NOT
   * change to carry it.
   */
  breakdownOut?: PromptBreakdown
): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  const context: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];

  // #414: hidden messages are excluded from the group prompt too — used for the
  // macro context and world-info scan below (recentMessages filters separately).
  const visibleMessages = messages.filter((m) => !m.hidden);

  const groupChatState = useChatStore.getState();
  const groupChatFile = groupChatState.currentChatFile;
  // Same contract as solo's: a reused collector describes THIS build, not the
  // union of every build it was passed to.
  beginBreakdownPass(breakdownOut, groupChatFile);
  const persona = usePersonaStore
    .getState()
    .getPersonaForContext(currentCharacter.avatar);
  const personaName = getUserDisplayName(currentCharacter.avatar);
  const personaDescription = persona?.description || '';
  const { activeModel, activeProvider } = useSettingsStore.getState();

  // Phase 9.3 parity with solo chat: macros read from and write to the chat's
  // variable map, persisted at the end of the build. {{char}} resolves to the
  // speaker whose turn this is — the model is being asked to write exactly
  // that character, so a speaker-relative macro means the same thing here as
  // it does in a solo chat. E9-S6: this is the group build's speaker-relative
  // substitution point, used for room-shared and persona-scoped world-info
  // content, the author's note, USER history turns, the scenario fallback (and
  // the scenario override), and the speaker's own mes_example.
  // Text that belongs to ONE named character resolves against that character
  // instead (see subMember below): per-member card blocks, stored ASSISTANT
  // turns (authorOfTurn), and entries from a world-info book owned by a
  // specific member (wrapWiContent).
  const variables: Record<string, string> = groupChatFile
    ? { ...groupChatState.getChatVariables(groupChatFile) }
    : {};
  const wiMacroCtx = buildMacroContext(
    currentCharacter,
    personaName,
    personaDescription,
    visibleMessages,
    activeModel,
    variables
  );
  const subSpeaker = (text: string) => (text ? processMacros(text, wiMacroCtx) : '');
  // E9-S6/AC8: {{char}}/{{description}}/{{personality}}/{{scenario}} inside a
  // MEMBER's own card block must resolve to THAT member, not the current
  // speaker — resolving member B's card text with the speaker's name would be
  // the same identity-bleed the WI attribution wrapper below (:1894-1907,
  // pre-rename line numbers) exists to prevent. Same shared `variables`
  // reference as subSpeaker, so a {{setvar}} inside a card field still lands
  // in the one map persisted at the end of the build.
  const memberMacroCtx = (member: CharacterInfo) =>
    buildMacroContext(
      member,
      personaName,
      personaDescription,
      visibleMessages,
      activeModel,
      variables
    );
  const subMember = (member: CharacterInfo, text: string) =>
    text ? processMacros(text, memberMacroCtx(member)) : '';

  // World Info. Book scoping is the union of every scope that can contribute
  // to this room: the globally-active books, EVERY member's owned (embedded
  // book plus any character-scoped documents) + linked books
  // (not just the current speaker's — lore about member B is precisely
  // what member A needs in order to react to them coherently), and the
  // speaker-resolved persona's books. The legacy chat-linked-books map is
  // folded in via resolveEffectiveBooks (chatConfig), not unioned directly
  // here. getActiveBookIdsForCharacter already refuses a book owned by a
  // different character, so the union can't pull a private book in on
  // membership alone.
  const wiState = useWorldInfoStore.getState();
  // Composition input is own books + the caller's group's shared books
  // (own wins on id collision) — widens what resolveEffectiveBooks /
  // scanMessagesForEntries can see without touching either, per Phase 1's
  // purity contract.
  const composableBooks = wiState.getComposableBooks();
  const characterStoreState = useCharacterStore.getState();
  const memberBookIds = characters.flatMap((c) =>
    characterStoreState.getActiveBookIdsForCharacter(c.avatar || '')
  );
  const personaBookIds = persona?.linkedBookIds ?? [];
  const inheritedBookIds = Array.from(
    new Set([
      ...wiState.activeBookIds,
      ...memberBookIds,
      ...personaBookIds,
    ])
  );
  const chatConfig = groupChatFile
    ? useChatLoreConfigStore.getState().getEffectiveConfig(groupChatFile)
    : undefined;
  const { effectiveBooks, effectiveActiveIds } = resolveEffectiveBooks(
    composableBooks,
    inheritedBookIds,
    chatConfig
  );
  const tokenProfile = profileForProvider(activeProvider);
  const wiScanReport: WorldInfoScanReport = {
    dropped: [],
    pinnedTokens: 0,
    totalTokens: 0,
    budget: 0,
    pinnedOverBudget: false,
  };
  const matchedEntries = scanMessagesForEntries(
    effectiveBooks,
    effectiveActiveIds,
    visibleMessages,
    {
      scanDepth: wiState.scanDepth,
      maxRecursionSteps: wiState.maxRecursionSteps,
      tokenBudget: wiState.tokenBudget,
      profile: tokenProfile,
      currentTurn: wiTimerOut?.currentTurn,
      wiTimers: wiTimerOut?.timers,
    },
    wiTimerOut?.activated,
    wiScanReport
  );
  if (wiTimerOut) wiTimerOut.scanReport = wiScanReport;
  // Same fail-loud contract as solo chat: never-evictable lore that alone
  // busts the WI budget can't be fixed by trimming. Warn once per chat.
  if (
    wiScanReport.pinnedOverBudget &&
    groupChatFile &&
    !wiPinnedWarnedChats.has(groupChatFile)
  ) {
    wiPinnedWarnedChats.add(groupChatFile);
    showToastGlobal(
      `Constant + critical lore (~${wiScanReport.pinnedTokens} tokens) exceeds the World Info budget (${wiScanReport.budget}). Raise the budget or demote entries.`,
      'warning'
    );
  }

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

  // Attribution. A group prompt has several characters in play at once, so an
  // unlabelled block of lore out of member B's own book reads as though it
  // described the speaker — the same identity-bleed the persona label below
  // guards against, which is why solo chat needs neither. Only
  // character-OWNED books (an embedded book, or one with an explicit owner)
  // are attributed; books shared across the room stay unlabelled.
  // Owner name is resolved from the full roster, not just `characters` (this
  // room's members): a book can be manually toggled globally-active or
  // chat-linked without being owned by anyone actually in the room, and an
  // unlabelled block of that owner's lore would read as the current
  // speaker's — the same identity-bleed this attribution exists to prevent.
  // The map carries the owner's whole CharacterInfo rather than just their
  // name: the substitution below needs the owner's card fields, and the name
  // is `.name` off the same object. A parallel name map would be a second
  // structure to keep in sync with this one for nothing.
  const memberByOwnedBookId = new Map<string, CharacterInfo>();
  for (const book of composableBooks) {
    if (!book.ownerCharacterAvatar) continue;
    const owner =
      characters.find((c) => c.avatar === book.ownerCharacterAvatar) ??
      characterStoreState.characters.find(
        (c) => c.avatar === book.ownerCharacterAvatar
      );
    if (owner) memberByOwnedBookId.set(book.id, owner);
  }
  const personaBookIdSet = new Set(personaBookIds);
  const wrapWiContent = (m: MatchedEntry): string => {
    // An entry out of a book this room has positively identified as member B's
    // is B's own lore, so its macros resolve against B — the same subMember
    // mechanism the per-member card blocks use, and for the same reason.
    // Substituting it speaker-relative produced a block that named B in its
    // attribution header and the SPEAKER in its body: B's own
    // `{{char}} distrusts {{user}}.` came out as
    //   [Information about Marcus, another character in this conversation]
    //   Seraphina distrusts User.
    // i.e. the prompt asserting a trait off Marcus's card as a fact about
    // Seraphina, inside the very wrapper that exists to stop that bleed. Solo
    // renders the same entry correctly because it has one character.
    // Which context each kind of book gets:
    //   - PERSONA-scoped: subSpeaker. That lore is about the USER, {{char}} in
    //     it is genuinely ambiguous, and it is not this fix. Checked first, so
    //     a book that is both persona-linked and character-owned stays
    //     persona-relative — matching the header precedence below.
    //   - character-OWNED: the owner's context. Keyed on OWNERSHIP, not on
    //     whether the header is emitted, and both are keyed on AVATAR, not
    //     NAME: the header below is suppressed only when
    //     `owner.avatar === currentCharacter.avatar` — the same key this map
    //     is built from above, and the same one `isCurrent` (:2056) and
    //     `authorOfTurn` (:2266-2271) use. Only in that case are
    //     subMember(owner, …) and subSpeaker(…) equivalent, because owner IS
    //     currentCharacter. Nothing enforces unique `name`s across the
    //     roster (membership is keyed on avatar throughout —
    //     toggleGroupChatCharacter / setGroupChatCharacters have no name
    //     check), so gating either test on name instead would let two
    //     different cards that happen to share a name disagree: one test
    //     would treat the owner as the speaker while the other did not.
    //     An owner resolved from the full roster rather than this room's
    //     members is still the right macro character — the header already
    //     names them as the subject.
    //   - room-shared / unowned: subSpeaker. Correct today, matches solo, and
    //     the group convention documented above ({{char}} = the speaker).
    // Still exactly ONE processMacros call per entry per build, so the
    // wiRendered/joinWi single-pass invariant below is untouched.
    const isPersonaBook = personaBookIdSet.has(m.bookId);
    const owner = isPersonaBook ? undefined : memberByOwnedBookId.get(m.bookId);
    const content = owner
      ? subMember(owner, m.entry.content)
      : subSpeaker(m.entry.content);
    if (!content.trim()) return '';
    if (isPersonaBook) {
      const subject = personaName || 'the user';
      return `[Information about ${subject}, the user you're talking to]\n${content}`;
    }
    if (owner && owner.avatar !== currentCharacter.avatar) {
      return `[Information about ${owner.name}, another character in this conversation]\n${content}`;
    }
    return content;
  };
  // Entries whose wrapped content was non-empty at render time — tracked in
  // the single joinWi pass rather than by re-wrapping later, since
  // wrapWiContent runs macros and {{setvar}} writes must not execute twice.
  const wiRendered = new Set<MatchedEntry>();
  const joinWi = (list: MatchedEntry[]): string =>
    list
      .map((m) => ({ m, c: wrapWiContent(m) }))
      .filter(({ m, c }) => {
        const ok = c.trim().length > 0;
        if (ok) wiRendered.add(m);
        return ok;
      })
      .map(({ c }) => c)
      .join('\n\n');

  // E9-S6 review-fix: card fields, the speaker's scenario and the speaker's
  // mes_example are computed BEFORE the joinWi calls below. Solo resolves its
  // card fields first (:1184-1187) and renders world info afterwards
  // (:1276-1282); group had the two stages inverted. That was unobservable
  // while group card fields shipped raw, but once they execute macros the
  // inversion bites: a {{setvar}} in a card description landed one stage too
  // late for a {{getvar}} in a lore entry, so build 1 rendered the OLD value
  // and every later build stayed exactly one behind, never self-correcting.
  // This moves COMPUTATION only — the SECTION ORDER of the system prompt below
  // is unchanged, and the joinWi/wiRendered single-pass invariant is untouched
  // (nothing moved here calls joinWi or wrapWiContent). Read "unchanged" as
  // order, not bytes: the whole point is that a lore entry now reads the FRESH
  // value a card field wrote, so its rendered text can differ — and an entry
  // that renders empty is dropped by joinWi, exactly as it is in solo. See the
  // after_an note below for the same distinction spelled out in full.

  // E9-S6 review-fix: the speaker's scenario reaches the prompt at TWO sites in
  // join mode — the speaker's own card block, and the `Current scenario:`
  // fallback below — and it used to be substituted separately at each. That
  // re-ran every write/roll macro inside it: a scenario of `Day {{incvar::day}}`
  // advanced the persisted counter by two per turn forever and emitted two
  // disagreeing values ("Scenario: Day 1" and "Current scenario: Day 2") in one
  // prompt. It is now substituted at most ONCE per build and the resulting
  // STRING is reused at both sites. For the SPEAKER,
  // subMember(currentCharacter, …) and subSpeaker(…) build the same context, so
  // one string is correct at both. Mirrors solo's :1186, which computes each
  // card field once and reuses it.
  // Deliberately lazy rather than an eager const: in swap mode WITH a
  // scenarioOverride neither site renders the speaker's scenario, and an eager
  // computation would start executing its write macros for text nothing emits
  // — trading the double-execution bug for a phantom-execution one. Laziness
  // also keeps the speaker's scenario executing at its original position in the
  // card-block map rather than ahead of it, so macro ordering between a
  // member's own fields is unchanged.
  let speakerScenarioMemo: string | null = null;
  const speakerScenario = (): string => {
    if (speakerScenarioMemo === null) {
      speakerScenarioMemo = subSpeaker(
        getCharacterField(currentCharacter, 'scenario')
      );
    }
    return speakerScenarioMemo;
  };

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
        const desc = subMember(char, getCharacterField(char, 'description'));
        const pers = subMember(char, getCharacterField(char, 'personality'));
        const scen = isCurrent
          ? speakerScenario()
          : subMember(char, getCharacterField(char, 'scenario'));
        const examples = subMember(char, getCharacterField(char, 'mes_example'));
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
        const desc = subMember(char, getCharacterField(char, 'description'));
        const pers = subMember(char, getCharacterField(char, 'personality'));
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
  // by passing an empty charName + character fields. That scrubbing is
  // deliberate and stays; the `variables` reference below is NOT part of it.
  //
  // E9-S6 (scope widened by Sammy): this branch builds its own inline
  // MacroContext rather than going through buildMacroContext, and it used to
  // omit `variables` entirely — the one key that is not char-specific. The
  // effect was confined to this path: {{getvar::x}} in an override always
  // rendered empty (processMacros reads `ctx.variables?.[key] ?? ''`) and
  // {{setvar::x::…}} writes were computed and then dropped on the floor
  // (`if (ctx.variables) ctx.variables[key] = value`). It now receives the
  // SAME mutable map object the other two contexts in this function share
  // (subSpeaker's wiMacroCtx and subMember's per-member contexts), not a copy
  // — a copy would make the writes visible to the rest of THIS build and then
  // lose them at the setChatVariables persist below.
  //
  // A {{setvar}} in an override is now a REAL persisted write, so it has to
  // run exactly once per build, and it does: this branch is the `if` half of
  // an if/else whose `else` is the fallback, `scenarioOverride` reaches the
  // function only as the value read straight off the group-chat record
  // (sendGroupMessage/forceGroupMemberTalk -> generateGroupTurn), and nothing
  // downstream re-substitutes `scenarioText` — it is interpolated into the
  // system prompt as a finished string.
  //
  // ORDER: this sits where it already sat — after the card blocks above, before
  // the joinWi calls below — and that is the intended slot, not an accident of
  // where the code happened to be. Solo has no scenario-override equivalent, so
  // there is no parity answer to copy; the reasoning is:
  //   1. It is the scenario stage. The override and the fallback are mutually
  //      exclusive renderings of the same slot, and the fallback executes right
  //      here (in the `else` below, or inside the join card block just above).
  //      Running them at the same point means turning an override on or off
  //      does not shift when every OTHER macro in the build executes.
  //   2. Cards before scenario, scenario before world info, matches solo's
  //      stage order (card fields :1184-1187, world info :1276-1282) and the
  //      review fix that moved cardBlock above the joins for exactly that
  //      reason. So an override's {{getvar}} sees card-field writes, and a lore
  //      entry's {{getvar}} sees the override's writes, in the SAME build.
  //   3. Emission order does not fully back this up, and should not be read
  //      as though it did: `before_an`/`after_an` are both computed and
  //      printed after this block, consistent with #2. `before_char` /
  //      `after_char` are not — they print ABOVE `Current scenario:` in the
  //      finished prompt (:2213-2218) but are joined, and therefore
  //      macro-executed, below this block same as before_an/after_an
  //      (:2176-2178/:2205). A {{setvar}} in a before_char/after_char entry
  //      runs too late for this override's {{getvar}} to see it, even though
  //      it prints earlier on the page. That gap is a consequence of #2 (all
  //      four WI positions execute as one group, after scenario) and is not
  //      something this fix changes or claims to fix.
  let scenarioText = '';
  if (scenarioOverride && scenarioOverride.trim()) {
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
      variables,
    }).trim();
  } else {
    // E9-S6/AC2: the fallback scenario is the speaker's own field, rendered
    // outside any per-member card block, so it keeps the speaker-relative
    // convention rather than scenarioOverride's deliberate char-scrubbing
    // above. It reuses the ONE substituted string computed above instead of
    // running the field through processMacros a second time — see
    // speakerScenario for why that mattered.
    scenarioText = speakerScenario();
  }

  // Include the current speaker's example dialogue if available — mirrors what
  // buildConversationContext does for solo chat. In Join mode this is already
  // baked into the speaker's own block above, so we suppress the duplicate.
  // E9-S6/AC3: speaker-relative substitution — this lives outside the
  // per-member card blocks built above.
  const mesExample =
    cardMode === 'join'
      ? ''
      : subSpeaker(getCharacterField(currentCharacter, 'mes_example'));

  const wiBeforeChar = joinWi(wiByPosition.before_char);
  const wiAfterChar = joinWi(wiByPosition.after_char);
  const wiBeforeAn = joinWi(wiByPosition.before_an);
  // E9-S6 review-fix (round 2): after_an is JOINED here with its three siblings,
  // even though it is EMITTED after the history loop below. Solo renders all
  // four non-depth positions together at :1276-1283, before its own history loop
  // at :1476; joining this one at its emission site instead left group inverting
  // solo for exactly one position — a {{setvar}} in a history turn was visible to
  // a {{getvar}} in after_an lore in group but not in solo. Computation moves,
  // emission does not: the `context.push` stays at the post-history slot, so the
  // SLOT ORDER of the prompt is unchanged.
  //
  // What this does NOT claim (round-3 review corrected an earlier version of
  // this comment that did): the emitted BYTES can change, and so can the
  // `wiTimerOut.fired` set. joinWi only adds an entry to `wiRendered` when its
  // wrapped content is non-empty, and moving the join changes what an after_an
  // entry renders TO — it can no longer read a {{setvar}} a history turn writes.
  // An entry that used to render non-empty on that value now renders empty, so
  // its whole system message disappears from the prompt and it drops out of
  // `fired`. That is the point of the fix, not a side effect: it is what solo
  // already does.
  // Unchanged: joinWi is still called exactly once per position (the wiRendered
  // single-pass invariant, which exists so {{setvar}} cannot execute twice), and
  // the derivation of `fired` at :2335 is untouched.
  // Who sees the changed set: `fired` feeds captureWiFired -> recordWiFired
  // (utils/wiFired.ts) -> the persisted `header.wi_fired` map -> story-ingest WI
  // replay (utils/storyIngest/wiReplay.ts). It is telemetry and story-bible
  // replay. It is NOT the WI sticky/cooldown clock: those timers come from the
  // `activated` set via saveWiTimers (:2488), which rendering never touches.
  const wiAfterAn = joinWi(wiByPosition.after_an);

  // World-info positional sections. A group prompt has no promptOrder
  // section map to slot them into (it's one flat system message), so the
  // four non-depth positions land at the nearest structural equivalent:
  // before/after the character block, and — for the author's-note pair —
  // the tail of the system message and a post-history message respectively,
  // matching where solo chat's pre- and post-history stages put them.
  // E2-S2: each conditional interpolation lifted to a named const, so the
  // token breakdown can measure the EMITTED fragment — wrapper newlines
  // included — instead of re-deriving the template's shape beside it and
  // drifting. Byte-for-byte the same expressions, in the same order; the group
  // goldens are what proves it.
  const wiBeforeCharSlot = wiBeforeChar ? `\n${wiBeforeChar}\n` : '';
  const wiAfterCharSlot = wiAfterChar ? `\n${wiAfterChar}\n` : '';
  const scenarioSlot = scenarioText ? `Current scenario: ${scenarioText}\n` : '';
  const mesExampleSlot = mesExample
    ? `Example dialogue for ${currentCharacter.name}:\n${mesExample}\n\n`
    : '';
  const wiBeforeAnSlot = wiBeforeAn ? `${wiBeforeAn}\n\n` : '';

  const systemPrompt = `This is a roleplay group chat. You are playing ${currentCharacter.name} — write ONLY ${currentCharacter.name}'s turn.
${wiBeforeCharSlot}
Characters in this conversation:
${cardBlock}
${wiAfterCharSlot}
${scenarioSlot}${mesExampleSlot}${wiBeforeAnSlot}FORMATTING RULES (follow exactly):
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

  // E2-S2: the flat system message, per EMITTED SLOT. Tagging a conceptual
  // "character info" instead would move tokens between slices whenever the
  // user flips Card mode — swap emits description + personality in the cards
  // and routes scenario/examples through their own slots, join emits all four
  // inside the block — with zero change to what the model is sent.
  const tk = (s: string) => estimateTokens(s, tokenProfile);
  let groupWiEmitted = 0;
  if (breakdownOut) {
    breakdownOut.profile = tokenProfile;
    const wiSlots: Array<[GroupSlotId, string]> = [
      ['group_wi_before_char', wiBeforeCharSlot],
      ['group_wi_after_char', wiAfterCharSlot],
      ['group_wi_before_an', wiBeforeAnSlot],
    ];
    let named = tk(cardBlock) + tk(scenarioSlot) + tk(mesExampleSlot);
    addSlice(breakdownOut, { stage: 'A', id: 'group_cards' }, tk(cardBlock), cardBlock.length);
    addSlice(breakdownOut, { stage: 'A', id: 'group_scenario' }, tk(scenarioSlot), scenarioSlot.length);
    addSlice(breakdownOut, { stage: 'A', id: 'group_examples' }, tk(mesExampleSlot), mesExampleSlot.length);
    for (const [id, text] of wiSlots) {
      const tokens = tk(text);
      named += tokens;
      groupWiEmitted += tokens;
      addSlice(breakdownOut, { stage: 'A', id }, tokens, text.length);
    }
    // Chrome is the DIFFERENCE, never a measured constant: the fixed template
    // text plus every rounding effect the non-additive estimator introduces at
    // the seams. Solo calls the same quantity its Stage-A join residual; group
    // has real chrome to carry too, so the two are one line here.
    const chromeChars =
      systemPrompt.length -
      cardBlock.length -
      scenarioSlot.length -
      mesExampleSlot.length -
      wiSlots.reduce((n, [, text]) => n + text.length, 0);
    addSlice(
      breakdownOut,
      { stage: 'A', id: 'group_system_chrome' },
      tk(systemPrompt) - named,
      chromeChars
    );
    // Recall is a STRING CONCAT onto the system prompt, not a message of its
    // own, so its cost is the concat DELTA — not estimateTokens(ragContext),
    // which would miss the header and the joining blank line.
    addSlice(
      breakdownOut,
      { stage: 'A', id: 'group_rag_context' },
      tk(finalSystemPrompt) - tk(systemPrompt),
      finalSystemPrompt.length - systemPrompt.length
    );
    breakdownOut.stageAMessageOverhead =
      estimateMessageTokens(context[0], tokenProfile) - tk(finalSystemPrompt);
  }
  /** Measure whatever was just pushed onto `context`. Positional so it reads
   *  as one line under the push it belongs to. */
  const sliceForPushed = (kind: SectionKind) => {
    const entry = context[context.length - 1];
    addSlice(
      breakdownOut,
      withHistoryRole(kind, entry.role),
      estimateMessageTokens(entry, tokenProfile),
      entry.content.length
    );
  };
  /** Same, for the two overflow branches — they splice in at index 1. */
  const sliceForSpliced = (kind: SectionKind) => {
    const entry = context[1];
    addSlice(
      breakdownOut,
      withHistoryRole(kind, entry.role),
      estimateMessageTokens(entry, tokenProfile),
      entry.content.length
    );
  };

  // Phase 8.1: Author's Note for group chats
  const groupAuthorNote = groupChatFile
    ? groupChatState.getAuthorNote(groupChatFile)
    : null;

  // WI at-depth entries, grouped by depth for interleaved injection —
  // same shape as solo chat's wiAtDepthByDepth.
  const wiAtDepthByDepth: Record<number, MatchedEntry[]> = {};
  for (const m of wiByPosition.at_depth) {
    const d = Math.max(0, Math.floor(m.entry.depth));
    if (!wiAtDepthByDepth[d]) wiAtDepthByDepth[d] = [];
    wiAtDepthByDepth[d].push(m);
  }

  // E9-S6 review-fix: a stored assistant turn is its AUTHOR's text, so its
  // macros must resolve against that author rather than against whoever
  // happens to speak next. Both seeding paths (startNewGroupChat,
  // addGroupChatMember) push each member's `first_mes` into history RAW, and
  // {{char}} is one of the most common idioms in a card greeting — substituting
  // Marcus's stored greeting against Seraphina emitted
  // `[Marcus]: *Seraphina looks up as User walks in.*`, i.e. the same stored
  // line asserting a different identity depending on who speaks next. That is
  // precisely the identity bleed the per-member card substitution above exists
  // to prevent. Resolution order is avatar (ChatMessage.characterAvatar) ->
  // `name` match -> the current speaker: chats that predate `characterAvatar`
  // still have to resolve to a real member rather than throwing or handing
  // buildMacroContext an undefined character.
  const authorOfTurn = (msg: ChatMessage): CharacterInfo =>
    (msg.characterAvatar
      ? characters.find((c) => c.avatar === msg.characterAvatar)
      : undefined) ??
    characters.find((c) => c.name === msg.name) ??
    currentCharacter;

  // #414: exclude hidden messages from the group prompt too. Filter before the
  // slice so a hidden message doesn't consume one of the last-30 slots — that
  // ordering, and the isSystem filter that follows the slice, live in
  // `groupHistoryWindow` because the chat-history recall path has to exclude
  // exactly what this loop emits (see that module's docstring).
  const recentMessages = groupHistoryWindow(messages);
  // E9-S6 review-fix (round 2): `attachmentsFolded` answers a question about the
  // whole BUILD ("does this generateMessage call carry images?"), but the image
  // exemption in the loop below is evaluated per MESSAGE. api.generateMessage
  // folds the caller's attachments into exactly ONE turn — the last message with
  // role 'user', located by a backwards scan (client.ts:1485-1507) — so at most
  // one blank user turn can ever be redeemed by a fold. Index of that turn,
  // computed once so the loop can require the turn to BE it.
  const lastUserIndexInRecent = (() => {
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      if (recentMessages[i].isUser) return i;
    }
    return -1;
  })();
  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    const depthFromEnd = recentMessages.length - i;

    // Inject author's note at the configured depth. E9-S6/AC4: guard the
    // post-macro result exactly like solo (:1487-1497) — `getAuthorNote`
    // only rejects RAW blank content, so a macro-only note (e.g.
    // {{setvar::x::1}}) renders to '' and an empty content block 400s
    // providers like Claude, silently breaking every later turn in the chat.
    if (groupAuthorNote && depthFromEnd === groupAuthorNote.depth) {
      const anContent = subSpeaker(groupAuthorNote.content);
      if (anContent.trim()) {
        context.push({
          role: groupAuthorNote.role,
          content: anContent,
        });
        sliceForPushed({ stage: 'B', cls: 'authors_note' });
      }
    }

    // WI at-depth entries: inject as system messages at the matching depth
    const wiHere = wiAtDepthByDepth[depthFromEnd];
    if (wiHere && wiHere.length > 0) {
      const content = joinWi(wiHere);
      if (content) {
        context.push({ role: 'system', content });
        groupWiEmitted += tk(content);
        sliceForPushed({ stage: 'B', cls: 'wi_at_depth' });
      }
    }

    // E9-S6/AC5+AC6: substitute FIRST, then apply the `[Name]: ` prefix for
    // non-user turns — matching solo's history + blank-guard (:1521-1538).
    // A user turn whose post-macro content is blank and carries nothing else
    // is skipped entirely (an empty content block 400s providers). Blank
    // ASSISTANT turns are left exactly as before — a documented, separate
    // out-of-scope parity gap (see the story brief), not touched here.
    // A user's own line stays speaker-relative: {{char}} in text the USER
    // typed means "the character I'm talking to", which in a group is the
    // current speaker. Everything else is its author's own text.
    const subbedContent = msg.isUser
      ? subSpeaker(msg.content)
      : subMember(authorOfTurn(msg), msg.content);
    const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
    // E9-S6 review-fix: a blank user turn is worth keeping ONLY as a carrier for
    // an attachment that is about to be folded into it, so the exemption has to
    // match the one turn client.ts will actually fold into. Two conditions, and
    // both are load-bearing:
    //   - `attachmentsFolded`: api.generateMessage folds only the CALLER-supplied
    //     `images` argument (client.ts:1484-1508), and sendGroupMessage passes it
    //     for the FIRST speaker of a round only (a deliberate cost decision:
    //     "We'd re-send the same bytes to each character otherwise"). For every
    //     later speaker there is nothing to fold at all.
    //   - `i === lastUserIndexInRecent`: even when this build DOES carry images,
    //     the fold lands on a single turn. An older blank image-carrying turn
    //     gets nothing folded into it no matter what, so keeping it just ships
    //     `{ role: 'user', content: '' }` — the empty content block that 400s
    //     Claude and keeps 400ing while that message stays in the last 30.
    // When the fold WILL happen the turn must survive: dropping it would make
    // client.ts's backwards `lastUserIdx` scan fold the image into an EARLIER
    // user turn, attaching it to the wrong message. And when the last user turn
    // is itself dropped here (blank with nothing to carry), every user turn that
    // remains is non-blank, so the misplaced fold still produces a valid request.
    // KNOWN GAP, out of this story's scope and filed separately: a group author's
    // note configured with role 'user' is pushed at its own depth, which for a
    // build whose newest message is not the user's (forceGroupMemberTalk on a
    // history ending in an assistant turn) can land AFTER the kept turn and take
    // the fold instead. Same outcome on main and pre-fix — this narrows the
    // window rather than closing that one.
    const keepForAttachment =
      hasImages && attachmentsFolded && i === lastUserIndexInRecent;
    const skipBlankUserTurn =
      msg.isUser && subbedContent.trim() === '' && !keepForAttachment;
    if (!skipBlankUserTurn) {
      const contentWithName = msg.isUser
        ? subbedContent
        : `[${msg.name}]: ${subbedContent}`;
      context.push({
        role: msg.isUser ? 'user' : 'assistant',
        content: contentWithName,
      });
      // Group has no separate "Your message" bucket: `generateGroupTurn` hands
      // the builder the user's own turn already inside `messages`, so it is
      // just the last entry of this loop. Extracting it by index would be
      // possible (`lastUserIndexInRecent` is right there) but would give group
      // a slice solo derives from a different mechanism — 8 buckets, not 10.
      sliceForPushed({ stage: 'B', cls: 'history', messageId: msg.id });
    }
  }

  // Depth 0 — the trailing slot, after the newest message and closest to the
  // generation point. The loop above only reaches depthFromEnd >= 1.
  const wiTrailing = wiAtDepthByDepth[0];
  if (wiTrailing && wiTrailing.length > 0) {
    const content = joinWi(wiTrailing);
    if (content) {
      context.push({ role: 'system', content });
      groupWiEmitted += tk(content);
      sliceForPushed({ stage: 'B', cls: 'wi_at_depth' });
    }
  }

  // If depth exceeds history, prepend. E9-S6/AC4: same post-macro trim guard
  // as the in-loop injection above. For depth >= 1 the two branches are
  // mutually exclusive — the loop matches 1 <= depth <= recentMessages.length
  // and this one matches depth > recentMessages.length — so a note that fires
  // has its content substituted exactly once per build.
  // Depth 0 matches NEITHER branch and is dropped entirely (the loop only
  // reaches depthFromEnd >= 1 and this test is strictly greater-than): a real
  // bug, separately filed, deliberately out of this story's scope. Solo has an
  // explicit depth-0 branch at :1553-1561; group does not. Do not read the
  // exactly-once claim above as depth-0 coverage.
  if (groupAuthorNote && groupAuthorNote.depth > recentMessages.length) {
    const anContent = subSpeaker(groupAuthorNote.content);
    if (anContent.trim()) {
      // Insert after the system prompt (index 1)
      context.splice(1, 0, {
        role: groupAuthorNote.role,
        content: anContent,
      });
      sliceForSpliced({ stage: 'B', cls: 'authors_note' });
    }
  }

  // WI at-depth overflow: entries whose depth exceeds the history length land
  // right after the system prompt, same as the author's note above.
  for (const depthKey of Object.keys(wiAtDepthByDepth)) {
    const d = parseInt(depthKey, 10);
    if (d > recentMessages.length) {
      const content = joinWi(wiAtDepthByDepth[d]);
      if (content) {
        context.splice(1, 0, { role: 'system', content });
        groupWiEmitted += tk(content);
        sliceForSpliced({ stage: 'B', cls: 'wi_at_depth' });
      }
    }
  }

  // Post-history slot (solo chat's wi_after_an stage). Joined above with the
  // other three non-depth positions; only the emission happens here.
  if (wiAfterAn) {
    context.push({ role: 'system', content: wiAfterAn });
    groupWiEmitted += tk(wiAfterAn);
    sliceForPushed({ stage: 'C', id: 'group_wi_after_an' });
  }

  // Phase 9.3: persist any macro variable writes back to the chat's store.
  if (groupChatFile) {
    groupChatState.setChatVariables(groupChatFile, variables);
  }

  // Report the entries that actually reached the prompt. Unlike solo chat
  // there are only two filters to survive — a group prompt has no
  // promptOrder section toggles and no token-aware history trim — so every
  // entry that rendered to non-empty content was injected somewhere above,
  // and nothing at-depth can be trimmed away after the fact.
  const groupFired = matchedEntries.filter((m) => wiRendered.has(m));
  if (wiTimerOut) {
    wiTimerOut.fired = groupFired;
    wiTimerOut.trimmedAtDepth = [];
  }

  if (breakdownOut) {
    let stageA = 0;
    let stageB = 0;
    let stageC = 0;
    for (const slice of breakdownOut.slices) {
      if (slice.kind.stage === 'A') stageA += slice.tokens;
      else if (slice.kind.stage === 'B') stageB += slice.tokens;
      else if (slice.kind.stage === 'C') stageC += slice.tokens;
    }
    breakdownOut.totals.stageA = stageA;
    breakdownOut.totals.stageB = stageB;
    breakdownOut.totals.stageC = stageC;
    breakdownOut.totals.assembledTotal = estimateConversationTokens(
      context,
      tokenProfile
    );
    breakdownOut.totals.trimTotal =
      breakdownOut.totals.assembledTotal - stageC;
    // Group's chrome slice already absorbs every rounding effect at the
    // template seams, so there is no separate join residual to report.
    breakdownOut.stageAJoinResidual = 0;
    breakdownOut.wi.emittedTokens = groupWiEmitted;
    breakdownOut.wi.rawTokens = groupFired.reduce(
      (sum, m) => sum + tk(m.entry.content),
      0
    );
    breakdownOut.wi.budget = wiScanReport.budget;
    breakdownOut.wi.droppedIds = wiScanReport.dropped.map((m) => m.entry.id);
    // Group never calls server retrieval (utils/serverRetrieval.ts:32-33), so
    // its activations always come from the client engine.
    breakdownOut.wi.activationSource = 'client';
    // AC 7: group has no history trim — badge the HISTORY slice "not trimmed",
    // not the whole view "un-budgeted". The WI slice above IS budgeted, and
    // `wi.budget` / `wi.droppedIds` are how the panel shows that.
    breakdownOut.flags.historyTrimmed = false;
    breakdownOut.flags.overBudget = false;
    breakdownOut.flags.droppedFromHistory = 0;
    // Group never reads `responseReserve` — no trim runs here at all. Null,
    // not 0: 0 is a legal reserve, and the panel must be able to tell "no
    // reserve was set" from "the reserve was never consulted".
    breakdownOut.flags.hasReservedSlice = false;
    breakdownOut.responseReserve = null;
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
  //
  // The boundary comes from `groupRecallBoundary`, which reads the same
  // `groupHistoryWindow` the builder below slices its history from — so recall
  // excludes exactly what this turn's prompt will carry. See that function for
  // why group needs no two-pass fixed point.
  const ragCtx = await resolveRagContext(
    updatedMessages,
    get().currentChatFile || undefined,
    groupRecallBoundary(updatedMessages)
  );
  // Phase 5.3: look up the group's card-handling mode so the builder knows
  // whether to produce a swap-style flat bullet list or a full per-member
  // block layout for join mode.
  const chatState = get();
  const groupCardMode =
    chatState.groupChats.find((g) => g.fileName === chatState.currentChatFile)
      ?.cardMode ?? DEFAULT_GROUP_CARD_MODE;
  // World-info timed effects (sticky / cooldown / delay). Scoped to this one
  // speaker's turn: a group round runs generateGroupTurn once per member, and
  // each of those is its own generation as far as WI is concerned.
  const groupChatFile = chatState.currentChatFile;
  const currentTurn = updatedMessages.filter(
    (m) => !m.isUser && !m.isSystem
  ).length;
  const wiTimerActivated = new Set<string>();
  const wiOut: WiScanOut = {
    currentTurn,
    timers: loadWiTimers(groupChatFile || ''),
    activated: wiTimerActivated,
  };
  const breakdown = createPromptBreakdown('group');
  const context = buildGroupConversationContext(
    updatedMessages,
    characters,
    character,
    scenarioOverride,
    ragCtx ?? undefined,
    groupCardMode,
    wiOut,
    // E9-S6 review-fix: only this turn's own `images` argument reaches
    // api.generateMessage below, so only this turn can have an attachment
    // folded into it. Callers that withhold images for a later speaker in the
    // round must not leave a blank user turn behind to carry nothing.
    Boolean(images && images.length > 0),
    breakdown
  );
  recordAttachments(breakdown, images);
  useGenerationStore.getState().setLastPromptBreakdown(breakdown);

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
  // Record fired WI only once the request actually dispatched — a thrown send
  // or null stream is not a generation (mirrors saveWiTimers gating).
  captureWiFired(groupChatFile, wiOut, currentTurn);

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
  // E2-S2 task 4: tag the breakdown published above with the message it
  // describes, guarded by object identity — a later speaker in this same
  // round may already have replaced the slot by the time this line runs.
  // Freshly created message, so swipe 0 (review round 1, M3/F6).
  useGenerationStore.getState().tagLastBreakdownMessage(breakdown, aiMessageId, 0);

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

  // Advance the timed-effect clock only for a turn that actually produced
  // text — same gating as the solo paths.
  saveWiTimers(groupChatFile || '', wiTimerActivated, currentTurn);

  return get().isSending;
}

// getProviderAndModel / getGenerationOptions moved to utils/llm/resolve.ts so
// one-off generation utilities resolve settings identically to a chat turn.

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
  // Story-state phase 0: round-trip the accumulated WI fired-state. The
  // header is rebuilt from scratch on every save, so anything not re-emitted
  // here is lost — the map was hydrated from the previous header at load.
  // MUST stay wiFiredByFile.get(...), never getWiFiredForChat(...) — the
  // latter's legacy-id remap (E2-S5 Gap 1) is a read-time-only view by
  // design (see its own doc comment), and persisting it instead would
  // silently, irreversibly migrate every legacy wi_fired key on the chat's
  // next save (AC4). Pinned by
  // chatStore.wiFiredServerPath.test.ts's AC4 case, which drives a real
  // legacy-id remap and asserts the saved header still carries the
  // UN-remapped key.
  const wiFired = wiFiredByFile.get(currentChatFile);

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
      ...(wiFired && Object.keys(wiFired).length > 0 ? { wi_fired: wiFired } : {}),
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
      // Story-state phase 1: extra is now ALWAYS present — ggbc_id is the
      // message's permanent identity and must survive every save.
      // Phase 6.1: image attachments ride in extra.images (array) and
      // extra.image (first element, SillyTavern-compat fallback for any
      // code path that still reads the scalar form). Scene videos ride
      // along in extra.videos.
      extra: {
        ggbc_id: msg.id,
        ...(msg.images && msg.images.length > 0
          ? { images: msg.images, image: msg.images[0] }
          : {}),
        ...(msg.videos && msg.videos.length > 0 ? { videos: msg.videos } : {}),
        // Per-turn token usage (estimated). Opaque to the backend.
        ...(msg.usage ? { usage: msg.usage } : {}),
        // #414: hide-from-AI flag. Conditional emit so non-hidden messages
        // (and every pre-#414 chat) keep a byte-identical payload — the
        // unload beacon requires a deterministic body.
        ...(msg.hidden ? { hidden: true } : {}),
      },
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

// Per-chat WI fired-state telemetry (story-state phase 0). Hydrated from
// `header.wi_fired` on chat load and re-serialized into the header on every
// save — without the hydrate step, buildChatPayload's from-scratch header
// rebuild would clobber previously captured state on the first save after a
// reload. Keyed by file name, like chatServerTsByFile.
const wiFiredByFile = new Map<string, WiFiredMap>();

/**
 * Read-time legacy-id remap of a chat's captured telemetry (E2-S5 Gap 1),
 * shared by getWiFiredForChat and isWiFiredCoveragePartial below. Computed
 * fresh on every call rather than cached or written back into
 * `wiFiredByFile` — a persisted migration would trade away reversibility
 * for a telemetry map that doesn't need it (see wiFired.ts's
 * remapWiFiredKeys doc comment), AND would sidestep the T2 readiness gate:
 * caching a remap taken before worldInfoStore's legacyIdRemapReady() has
 * resolved would freeze in a "no known remap" verdict for every legacy key
 * that was actually just not-yet-loaded. Pinned by
 * chatStore.wiFiredLegacyRemap.test.ts's readiness-boundary case: one chat
 * file read before AND after fetchPrefs, which fails under a per-fileName
 * memo.
 *
 * Why a live call is safe at every point along that boundary — corrected
 * from an earlier revision of this comment, which claimed
 * remapLegacyBookId/remapLegacyEntryId "return null for everything
 * pre-readiness." They do not: worldInfoStore's fetchPrefs calls
 * buildLegacyIdRemap (populating the maps synchronously) well BEFORE its
 * later `await fetchSharedBooks()` leg and the legacyIdRemapReady() gate
 * opening, so a call in that window sees real, non-null answers despite
 * readiness not having resolved. What actually makes any pre-readiness read
 * safe is that the maps only ever exist in one of two states in a session:
 * EMPTY (before this session's first buildLegacyIdRemap call, or after
 * resetUser/clearLegacyIdRemap — every legacy-shaped key then reports
 * `partial: true` via the shape check below, never a silent "resolved"),
 * or FINAL (from the instant buildLegacyIdRemap returns — its output
 * depends only on the old/new book snapshots it was called with, never on
 * fetchSharedBooks or anything else fetchPrefs does afterward). FINAL is
 * not permanent: a logout during fetchPrefs's awaited fetchSharedBooks leg
 * (worldInfoStore.ts:3990, before the gate resolves at :3998) runs
 * resetUser -> clearLegacyIdRemap and returns the maps to EMPTY. That is
 * harmless here precisely BECAUSE nothing is cached — EMPTY is the
 * conservative state, reporting partial rather than a silent "resolved".
 * What matters is that there is no partially-populated state in between
 * for a call to observe: every observable state is EMPTY or FINAL. Recomputing
 * here means a call during EMPTY correctly reports partial, and a call
 * during FINAL — whether or not legacyIdRemapReady() has resolved yet —
 * transparently returns the real mapping; a cache taken during EMPTY is
 * exactly what would freeze the wrong verdict. These maps are chat-sized
 * (tens of entries), so recomputing costs nothing worth caching for.
 */
function remappedWiFired(fileName: string): WiFiredRemapResult | undefined {
  const raw = wiFiredByFile.get(fileName);
  if (!raw) return undefined;
  return remapWiFiredKeys(raw, remapLegacyBookId, remapLegacyEntryId);
}

/**
 * A chat's WI fired-state telemetry, with any pre-cutover
 * `wibook_x:wi_y` keys (fa3cd1bf, 12 days before the native-CRUD cutover
 * 77e689d2) folded onto their current native id — remap-or-keep, per T1:
 * a key with no confident remap is returned UNCHANGED, never dropped, so no
 * telemetry is ever discarded. That is NOT the same as this being a
 * superset view of what wiFiredByFile holds, though (an earlier revision of
 * this comment claimed it was): when two keys DO remap onto the same
 * current key — a pre-cutover key and its post-cutover successor for the
 * same entry — remapWiFiredKeys merges them into one row (summed count;
 * see its own doc comment in wiFired.ts), so the output key SET can be
 * smaller than the input's even though no observation was lost. Does NOT
 * affect what gets persisted — buildChatPayload reads wiFiredByFile
 * directly (see its own comment above, at the `wiFiredByFile.get(...)`
 * line), so captureWiFired's write path and the `wi_fired` header field are
 * byte-for-byte unchanged by this function's existence (AC4). See
 * isWiFiredCoveragePartial for whether this view is known-incomplete.
 */
export function getWiFiredForChat(fileName: string): WiFiredMap | undefined {
  return remappedWiFired(fileName)?.map;
}

/**
 * True when getWiFiredForChat's remap could not place at least one
 * pre-cutover key among this chat's current entries (AC1's "or flag
 * partial-coverage" branch) — e.g. the legacy id's server-recorded
 * successor is itself gone, or worldInfoStore's remap map hasn't finished
 * loading yet (T2). Callers that turn "never fired" into a finding (the
 * future E5-S1 audit; wiReplay.ts's own notObservable today) should read a
 * `true` here as "this chat's absence-of-firing signal cannot be trusted
 * as a fact" rather than as a low/zero trigger count.
 */
export function isWiFiredCoveragePartial(fileName: string): boolean {
  return remappedWiFired(fileName)?.partial ?? false;
}

/** Fold one generation's injected WI entries into the chat's telemetry. */
function captureWiFired(
  chatFile: string | null | undefined,
  wiOut: WiScanOut,
  currentTurn: number
) {
  if (!chatFile || !wiOut.fired || wiOut.fired.length === 0) return;
  // Only persist telemetry for entries the local store can resolve by id.
  //
  // This guard once existed because the two id schemes were genuinely
  // disjoint: before the native-CRUD cutover (77e689d2, 2026-08-07), local
  // books lived in the stm_worldinfo blob under generateId('wibook')/('wi')
  // ids while the server minted its own UUIDs, so a server-path firing
  // could never be recorded at all. That is no longer true, and this
  // comment asserted the opposite for far too long — it was written on
  // 2026-08-06 (9ced3e43, server-side lore retrieval) and was falsified
  // the very NEXT DAY by 77e689d2, which introduced normalizeNativeBook
  // and `set({ books: nativeBooks })` in one commit. (The later blob-strip
  // package #71/#435/#74, 2026-08-23, is hygiene on top — not the
  // convergence; see docs/legacy-id-strip-scoping.md, which names
  // 77e689d2 "the 2026-08-07 cutover commit".) Native /lorebooks is now
  // the system of record (see worldInfoStore.ts's PersistedShape
  // docstring), `books` is populated ONLY from that fetch, and both
  // normalizers adopt the server's primary key verbatim —
  // normalizeNativeBook and normalizeNativeEntry each do
  // `id: String(dto.id)`. The backend
  // activation engine ranks those same lorebook_entries rows
  // (_activation.py imports LorebookEntry), so on a server-path turn
  // dtoToMatchedEntry's entry.id IS the local entry's id and this filter
  // passes. Two committed tests pin the CLIENT half of that: each
  // normalizer forwards its DTO's id unchanged — serverRetrieval.test.ts
  // ('srv-entry-1') and worldInfoStore.test.ts's native-bootstrap case
  // ('native-entry-1'). Be precise about what that does NOT cover: they
  // use different fixtures and neither asserts the two ids come from the
  // same row, so if the backend ever emitted a synthetic id from
  // POST /retrieval/context while GET /lorebooks/{id} kept the primary
  // key, both stay green and this filter would silently resume dropping
  // every server-path firing. Pinned against THAT gap (E2-S5 AC3) by
  // src/stores/chatStore.wiFiredServerPath.test.ts, which seeds ONE
  // fixture id into both the local native bootstrap and the mocked
  // POST /retrieval/context response and drives a real sendMessage turn —
  // proving this filter passes a same-row id through end to end. What that
  // file's own header comment is careful NOT to claim: a genuine BACKEND
  // id divergence (the server actually returning two different ids for one
  // row) is invisible to a frontend test whose mock supplies both ids
  // itself; closing that needs a ggbc-backend contract test instead,
  // filed as ggbc-backend#83.
  //
  // The filter still earns its place for entries the local store has not
  // fetched. One case can actually happen: an entry created on another
  // device since this client last ran fetchPrefs. The shared-book case
  // cannot, in the opposite direction to the obvious guess — an active
  // shared-origin book makes the chat ineligible for server retrieval
  // outright (serverRetrieval.ts condition 4b), so the server path never
  // activates over one. Recording an unresolvable entry would not be
  // inert — the story-bible replay
  // (src/utils/storyIngest/wiReplay.ts) builds its lookup keys from LOCAL
  // entry ids, so an unresolvable key would sit unreachable, discarding
  // the real measured telemetry, while the entry's own key falls back to
  // an approximate keyword replay or is wrongly marked as never fired.
  // What it drops is therefore a coverage gap, not a scheme mismatch — and
  // a narrower one than the pre-cutover wi_fired keys E2-S5 fixes
  // elsewhere: those are keyed but MISFILED (wiFired.ts's
  // remapWiFiredKeys, Gap 1, folds them onto their native id at read time;
  // wiReplay.ts's notObservable field, Gap 2, downgrades neverFired's
  // confidence when a captured key can't be placed among current entries
  // at all), while an entry dropped HERE for being unfetched never reaches
  // wiFiredByFile in the first place, leaving no key for either mechanism
  // to see. Still accepted as rare for the reason two paragraphs up (the
  // shared-book case can't happen).
  const localEntryIds = new Set(
    useWorldInfoStore
      .getState()
      .getComposableBooks()
      .flatMap((b) => b.entries.map((e) => e.id))
  );
  const fired = wiOut.fired
    .filter((m) => localEntryIds.has(m.entry.id))
    .map((m) => ({ bookId: m.bookId, entryId: m.entry.id }));
  if (fired.length === 0) return;
  const map = wiFiredByFile.get(chatFile) ?? {};
  recordWiFired(map, fired, currentTurn);
  wiFiredByFile.set(chatFile, map);
}

export function getChatServerTs(fileName: string): number | undefined {
  return chatServerTsByFile.get(fileName);
}

// Adopt authoritative server state after a conflict we can't safely overwrite
// (the server is ahead of us). If it's the active chat, refresh the in-memory
// messages so the user sees the newer tail instead of losing it.
function reconcileServerState(fileName: string, serverMessages: unknown[]) {
  // Adopt the winner's WI fired-state too (conservative union with ours) —
  // both maps describe the same chat, and dropping the server's copy here
  // would clobber it on our next save. Runs even for a non-active chat,
  // since the telemetry map is keyed per file.
  const header = Array.isArray(serverMessages) ? serverMessages[0] : undefined;
  const serverFired = sanitizeWiFired(
    header && typeof header === 'object'
      ? (header as Record<string, unknown>).wi_fired
      : undefined
  );
  if (Object.keys(serverFired).length > 0) {
    wiFiredByFile.set(
      fileName,
      mergeWiFiredMaps(wiFiredByFile.get(fileName) ?? {}, serverFired)
    );
  }

  const state = useChatStore.getState();
  if (state.currentChatFile !== fileName) return;
  const rest = Array.isArray(serverMessages) ? serverMessages.slice(1) : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalized = ensureUniqueMessageIds(rest.map((m) => normalizeMessage(m as any)));
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
          // The payload we're about to resend was built BEFORE the conflict,
          // so its header's wi_fired snapshot may predate telemetry another
          // tab persisted meanwhile. Merge the server's copy into ours and
          // refresh the outgoing header so the retry doesn't clobber it.
          const serverHeader = Array.isArray(current_messages) ? current_messages[0] : undefined;
          const serverFired = sanitizeWiFired(
            serverHeader && typeof serverHeader === 'object'
              ? (serverHeader as Record<string, unknown>).wi_fired
              : undefined
          );
          if (Object.keys(serverFired).length > 0) {
            const merged = mergeWiFiredMaps(wiFiredByFile.get(fileName) ?? {}, serverFired);
            wiFiredByFile.set(fileName, merged);
            const ourHeader = chatData[0];
            if (ourHeader && typeof ourHeader === 'object') {
              (ourHeader as Record<string, unknown>).wi_fired = merged;
            }
          }
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
  // Story-state phase 1: extra.ggbc_id is the message's permanent identity.
  extra?: {
    ggbc_id?: unknown;
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
  // Accept both data: URLs (image-gen inserts) AND served /blobs/… URLs
  // (character selfies) — same tolerance as the video filter below; a data:-only
  // filter would silently drop selfies on reload.
  const isImageRef = (x: unknown): x is string =>
    typeof x === 'string' && (x.startsWith('data:') || x.startsWith('/') || x.startsWith('http'));
  let images: string[] | undefined;
  const rawImages = msg.extra?.images;
  const scalarImage = msg.extra?.image;
  if (Array.isArray(rawImages)) {
    const arr = rawImages.filter(isImageRef);
    if (arr.length > 0) images = arr;
  } else if (isImageRef(scalarImage)) {
    images = [scalarImage];
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
    // Story-state phase 1: adopt the persisted permanent id; mint only for
    // messages that predate ids (backfilled server-side in phase 2).
    // Cross-message duplicates are re-minted by ensureUniqueMessageIds at
    // the load sites — this function only sees one message at a time.
    id: takeWireMessageId(msg.extra) ?? generateId(),
    name: msg.name,
    isUser: msg.is_user,
    isSystem: msg.is_system,
    // #414: read the hide-from-AI flag back. `=== true` is the backward-compat
    // guard — absent on every pre-#414 chat, which reads as not-hidden.
    hidden: msg.extra?.hidden === true,
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

// ---------------------------------------------------------------------------
// Rename healing (story-state phase 10 §7)
// ---------------------------------------------------------------------------

/** Chat identity is the (avatar, file_name) PAIR — a rename moves only the
 *  second half, so both must match for a row to be one this heal owns. */
function sameChatRef(a: ProjectChatRef, b: ProjectChatRef): boolean {
  return a.character_avatar === b.character_avatar && a.file_name === b.file_name;
}

function isChatRef(value: unknown): value is ProjectChatRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.character_avatar === 'string' && typeof v.file_name === 'string';
}

/** A project row this heal is willing to PATCH. `chats` and `server_ts` cross
 *  the fetch boundary as `unknown` — and a 409 body's `current` is adopted
 *  without validation by the client — so a row that doesn't carry a real
 *  member array is skipped rather than spread into a PATCH that would blank
 *  the list or write `base_ts: undefined`. */
function isPatchableProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.server_ts === 'number' &&
    Array.isArray(v.chats) &&
    v.chats.every(isChatRef)
  );
}

/** The `meta.source.chat` pointer, proven object-by-object rather than cast:
 *  the section arrives as `unknown` and the rewrite below re-spreads BOTH
 *  levels, so a `source` or `chat` that isn't an object would silently
 *  produce a meta row with the wrong shape. */
function metaChatPointer(data: unknown): {
  source: Record<string, unknown>;
  chat: Record<string, unknown>;
  ref: ProjectChatRef;
} | null {
  if (!data || typeof data !== 'object') return null;
  const source = (data as Record<string, unknown>).source;
  if (!source || typeof source !== 'object') return null;
  const chat = (source as Record<string, unknown>).chat;
  if (!chat || typeof chat !== 'object') return null;
  const ref = (chat as Record<string, unknown>).ref;
  if (!isChatRef(ref)) return null;
  return {
    source: source as Record<string, unknown>,
    chat: chat as Record<string, unknown>,
    ref,
  };
}

/**
 * Repoint every Work — and every Work's bible — that referenced a chat by the
 * name it just lost (phase 10 §7).
 *
 * The rename ITSELF has already succeeded by the time this runs, so nothing
 * here may surface as a rename failure, one Work's failure must not stop the
 * next, and success is silent. Relink (Story tab) stays the guaranteed
 * recovery path for whatever this best-effort pass misses.
 */
async function healRenamedChatRefs(
  oldRef: ProjectChatRef,
  newRef: ProjectChatRef
): Promise<void> {
  let degraded = false;
  const note = (what: string, error: unknown) => {
    degraded = true;
    console.warn(`[chatStore] rename heal: ${what}`, error);
  };

  try {
    // Lazy imports only: this module already sits inside the
    // authStore/lovenseStore cycle, and a static edge into projectStore
    // TDZ-crashes the app at boot — projectStore.openChatRef reaches back
    // into this module exactly the same way.
    const [{ useProjectStore }, client, { bibleUuid, capturedAt }] = await Promise.all([
      import('./projectStore'),
      import('../api/client'),
      import('../utils/storyBible/sourceRefs'),
    ]);
    const {
      projectsApi,
      storyApi,
      ProjectConflictError,
      StoryConflictError,
      isStoryManifestShape,
    } = client;

    const withRenamedChats = (p: Project) => ({
      chats: p.chats.map((c) => (sameChatRef(c, oldRef) ? newRef : c)),
    });

    /** `updateSelected`'s adopt-and-re-derive shape, but per-row: a rename
     *  reaches Works that are not the selected one, which that action cannot
     *  express. */
    const repointProject = async (project: Project): Promise<Project> => {
      try {
        return await projectsApi.update(project.id, {
          ...withRenamedChats(project),
          base_ts: project.server_ts,
        });
      } catch (error) {
        if (!(error instanceof ProjectConflictError) || !isPatchableProject(error.current)) {
          throw error;
        }
        const winner = error.current;
        // The winner may already carry the new name (another device healed
        // it, or the user relinked by hand) — re-deriving from it then means
        // there is nothing left to write.
        if (!winner.chats.some((c) => sameChatRef(c, oldRef))) return winner;
        return projectsApi.update(winner.id, {
          ...withRenamedChats(winner),
          base_ts: winner.server_ts,
        });
      }
    };

    /** Returns false when this bible was not pointing at the renamed chat, so
     *  the caller knows not to log an edit for a write that never happened. */
    const rewriteMeta = async (
      projectId: string,
      data: Record<string, unknown>,
      baseTs: number
    ): Promise<boolean> => {
      const pointer = metaChatPointer(data);
      if (!pointer || !sameChatRef(pointer.ref, oldRef)) return false;
      await storyApi.putSection(
        projectId,
        'meta',
        {
          // A section PUT is a full replace, so everything read is resent and
          // only the pointer moves. `snapshot` and `captured_at` stay VERBATIM
          // (§5.5's relink rule — the snapshot records what was true at
          // capture), and `ingest_watermark` is untouched: zeroing it would
          // make the transcript walk re-read a chat whose messages did not
          // change.
          ...data,
          source: { ...pointer.source, chat: { ...pointer.chat, ref: newRef } },
          updated_at: capturedAt(),
        },
        baseTs
      );
      return true;
    };

    const healBible = async (projectId: string) => {
      // §7 says "GET meta; 404 → skip", but apiRequest collapses a 404 into a
      // generic Error, and treating every read failure as "no bible" would
      // swallow the exact case this hook exists for. The manifest answers the
      // same question explicitly — storyStore.load already gates section
      // reads this way for the same normal-but-noisy 404.
      const manifest = await storyApi.manifest(projectId);
      if (!isStoryManifestShape(manifest)) {
        throw new Error('unrecognized story manifest');
      }
      if (!manifest.sections.some((s) => s.section === 'meta')) return;

      const section = await storyApi.getSection(projectId, 'meta');
      let rewrote: boolean;
      try {
        rewrote = await rewriteMeta(projectId, section.data, section.server_ts);
      } catch (error) {
        if (!(error instanceof StoryConflictError) || !error.current) throw error;
        rewrote = await rewriteMeta(projectId, error.current.data, error.currentTs);
      }
      if (!rewrote) return;

      // §5.6's field mapping, built inline: storyStore owns the shared
      // recordEdit helper, but importing storyStore from here would add
      // precisely the static store edge §7 forbids.
      const edit: Edit = {
        // Minted BEFORE the POST so a transport retry re-sends the same id and
        // the server's idempotency absorbs it instead of double-logging.
        id: bibleUuid(),
        occurred_at: capturedAt(),
        // The user initiated the rename, even though this write is automatic.
        actor: 'user',
        surface: 'bible_direct',
        target: { type: 'meta', id: null },
        // Only the file name moved — the avatar half of the ref is identical
        // by construction. Clamped like every other edit diff; only a
        // pathological file name could reach the cap.
        diff: `source chat renamed: ${oldRef.file_name} → ${newRef.file_name}`.slice(0, 2000),
        classification: 'cosmetic',
        propagated_to_bible: true,
        propagation_notes: '',
      };
      await storyApi.appendEdit(projectId, edit as unknown as Record<string, unknown>);
    };

    // The list projection carries `chat_count` but not the refs themselves, so
    // membership needs a per-row GET; the count at least keeps chat-less Works
    // out of that fan-out.
    const rows = (await projectsApi.list()).filter((r) => r.chat_count > 0);
    for (const row of rows) {
      try {
        const project = await projectsApi.get(row.id);
        if (!isPatchableProject(project)) continue;
        if (!project.chats.some((c) => sameChatRef(c, oldRef))) continue;

        const repointed = await repointProject(project);
        // Keep an open Works panel honest about the row just rewritten — but
        // only if it is still the one on screen.
        if (useProjectStore.getState().selected?.id === repointed.id) {
          useProjectStore.setState({ selected: repointed });
        }
        await healBible(row.id);
      } catch (error) {
        note(`Work ${row.id} still points at the old chat name`, error);
      }
    }
  } catch (error) {
    note('no Work could be repointed', error);
  } finally {
    if (degraded) {
      showToastGlobal(
        'Chat renamed — a Work still points at the old name; use Relink in its Story tab',
        'warning'
      );
    }
  }
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
      const { header, messages: rawMessages, server_ts } = await api.getChatWithHeader(avatarUrl, fileName);
      const messages = ensureUniqueMessageIds(rawMessages.map(normalizeMessage));
      // Record the concurrency token so the next save echoes it as base_ts.
      chatServerTsByFile.set(fileName, server_ts);
      // Hydrate WI fired-state telemetry so it accretes across sessions
      // instead of being clobbered by the next header rebuild. Merged (not
      // replaced) so captures that never reached the server — e.g. a failed
      // save before a reload — survive a re-load of the same chat.
      wiFiredByFile.set(
        fileName,
        mergeWiFiredMaps(wiFiredByFile.get(fileName) ?? {}, sanitizeWiFired(header?.wi_fired))
      );
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
      const { header, messages: rawMessages, server_ts } = await api.getChatWithHeader(avatarUrl, groupChat.fileName);
      const messages = ensureUniqueMessageIds(rawMessages.map(normalizeMessage));
      chatServerTsByFile.set(groupChat.fileName, server_ts);
      // Group generations don't scan WI today, but hydrate anyway so any
      // previously captured state survives the header rebuild on save.
      // Merged for the same failed-save-then-reload reason as loadChat.
      wiFiredByFile.set(
        groupChat.fileName,
        mergeWiFiredMaps(wiFiredByFile.get(groupChat.fileName) ?? {}, sanitizeWiFired(header?.wi_fired))
      );
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
    // Re-key the snapshot against the live chat before swapping it in:
    // checkpoint ids may predate permanent UUIDs (or hold UUIDs that never
    // reached disk), and restoring them verbatim would persist stale ids
    // over the chat's real ones on the next truncating save. Cloning also
    // stops the branch store's stored snapshot from aliasing live state.
    set({
      messages: ensureUniqueMessageIds(
        rekeyRestoredMessages(branchMessages, get().messages)
      ),
    });
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

  // ---- #414: Toggle Message Hidden (hide from AI, keep visible) ----
  toggleMessageHidden: (messageId: string) => {
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === messageId ? { ...msg, hidden: !msg.hidden } : msg,
      ),
    }));
    // Not a truncation (array length is unchanged), but persistTruncatingEdit
    // is the right helper: allow_truncate is a harmless superset permission on
    // a non-shrinking save, and it resolves the solo/group character context
    // for us — same as deleteMessage.
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
      const wiOut = {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: wiTimerActivated,
      };
      // Server-side lore retrieval is intentionally NOT used on this path.
      // swipeRight deliberately excludes the message being re-swiped from
      // both the local context window (contextMessages) and currentTurn,
      // but tryServerRetrieval/POST /retrieval/context takes no window
      // argument — the server always derives turn_no and its recall/
      // keyword tail from the FULL persisted Chat.messages row, which
      // still contains that message's old (pre-swipe) content at read
      // time (nothing is truncated server-side for a swipe). That produces
      // a server turn_no one ahead of currentTurn and a stale-text keyword
      // scan the client-side path would never match, so this call site
      // always falls back to the client-side scan rather than risk
      // silently wrong or early-firing lore.
      // TWO-PASS RECALL (E2-S2 task 1b) — THE CANONICAL EXPLANATION. The other
      // four solo call sites repeat this shape and point back here.
      //
      // Recall is both an INPUT to the builder (one of the fourteen Stage-A
      // sections) and a consumer of the trim budget that decides which turns
      // survive, so the boundary it must be retrieved against is only knowable
      // after a build. `prepare` runs ONCE — it is the side-effecting half
      // (macro writes, world-info activation) and running it twice would
      // double-execute every `{{setvar}}`. `finish` is pure and runs twice:
      // an uncommitted probe with no recall, purely to learn the boundary,
      // then the real committing pass with the recall that probe produced.
      //
      // DIRECTION INVARIANT — why one round trip is enough and no fixed-point
      // iteration is needed: recall lands in the Stage-A system block, which
      // `trimHistoryToBudget` charges as FIXED overhead before it keeps any
      // history. So pass 2 has strictly less budget left for turns than pass 1
      // did: it keeps a subset, and its boundary is therefore the same message
      // or a NEWER one (boundary₂ >= boundary₁, never older). The failure mode
      // that leaves is under-recall — a band of messages that pass 2
      // actually dropped from the prompt but that we asked the server to treat
      // as still present, so they simply are not recalled. The band is NOT
      // fixed-size: it grows with the share of budget recall consumes (QA
      // measured 0→17 of 24 turns as recall went 0→400 words on a tight
      // budget). The opposite error
      // — recalling a message the prompt also carries, i.e. duplication — is
      // unreachable by construction. That is the safe direction, and it is why
      // the probe deliberately runs WITHOUT recall rather than with a guess.
      //
      // No new round trips: this reorders awaits that already existed.
      const prepared = prepareConversationContext(contextMessages, character, availableEmotions, wiOut);
      const probe = finishConversationContext(prepared, undefined, { commit: false });
      const ragCtx = await resolveRagContext(contextMessages, currentChatFile || undefined, probe.boundaryId);
      const breakdown = createPromptBreakdown('solo');
      const { context, overBudget } = finishConversationContext(prepared, ragCtx ?? undefined, { commit: true, breakdownOut: breakdown });
      const { provider, model } = getProviderAndModel();
      // Hoisted out of the generateMessage argument list so the breakdown can
      // see the same attachments the request carries — they never pass
      // through the builder, so nothing inside it could have counted them.
      const swipeImages = imagesFromLastUserMessage(contextMessages, provider, model);
      recordAttachments(breakdown, swipeImages);
      useGenerationStore.getState().setLastPromptBreakdown(breakdown);
      // E2-S2 task 4: this swipe re-generates `messageId` in place, so it is
      // the id this breakdown describes. `msg.swipes.length` (captured before
      // this call ever appends anything) is the NEW swipe index the generation
      // below is about to land in — the same value `newSwipeIndex` resolves to
      // further down. Tagging the swipe this build produces, not the one on
      // screen right now, is what lets a swipe-back afterward stop reading as
      // "owned" (review round 1, M3/F6): the sheet's ownership check compares
      // this against the message's CURRENT swipe id, not its swipe id at tag
      // time.
      useGenerationStore.getState().tagLastBreakdownMessage(breakdown, messageId, msg.swipes.length);
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
        swipeImages,
        isTextCompletionMode()
      );
      if (!stream) return;
      // Record fired WI only once the request actually dispatched — a thrown
      // send or null stream is not a generation (mirrors saveWiTimers gating).
      captureWiFired(currentChatFile, wiOut, currentTurn);

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

        // Server-side lore retrieval is never used on this path (see the
        // comment above buildConversationContext's call above) — swipe
        // always advances the LOCAL timed-effect store, never the
        // server-side one, so a swipe turn can never disagree with a
        // send/edit turn on which store is authoritative for this chat.
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
      const { currentChatFile } = get();
      // The continuation re-touches the last AI turn, so its turn index is
      // the count of AI messages BEFORE that message — mirrors swipeRight,
      // which excludes the regenerated message from the count.
      const currentTurn = Math.max(
        0,
        messages.filter((m) => !m.isUser && !m.isSystem).length - 1
      );
      // Wire the WI out-param through (was undefined): timed effects now see
      // real turn/timer state on this path, and fired entries get captured.
      // Timers are NOT persisted here — only send/swipe record activations.
      const wiOut = {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: new Set<string>(),
      };
      // Server-side lore retrieval is intentionally NOT used on this path.
      // currentTurn above is deliberately count-1 (mirrors swipeRight,
      // excluding the message being continued from the turn count), but
      // tryServerRetrieval/POST /retrieval/context takes no turn argument —
      // the server always derives turn_no by counting every AI message in
      // the FULL persisted Chat.messages row, including the one being
      // continued. That server turn_no would run one ahead of currentTurn,
      // letting a delay-gated entry fire through the server path a turn
      // earlier than the client-side engine would ever allow, so this call
      // site always falls back to the client-side scan.
      // Two-pass recall — see swipeRight for the full rationale and the
      // direction invariant. Always-local path, so no tryServerRetrieval to
      // sequence before `prepare`.
      const prepared = prepareConversationContext(messages, character, availableEmotions, wiOut);
      const probe = finishConversationContext(prepared, undefined, { commit: false });
      const ragCtx = await resolveRagContext(messages, currentChatFile || undefined, probe.boundaryId);
      const breakdown = createPromptBreakdown('solo');
      const { context, overBudget } = finishConversationContext(prepared, ragCtx ?? undefined, { commit: true, breakdownOut: breakdown });
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
      recordCallSiteTurn(breakdown, 'continue', context[context.length - 1].content);

      const { provider, model } = getProviderAndModel();
      const continueImages = imagesFromLastUserMessage(messages, provider, model);
      recordAttachments(breakdown, continueImages);
      useGenerationStore.getState().setLastPromptBreakdown(breakdown);
      // E2-S2 task 4: continueMessage takes no messageId argument (unlike
      // swipeRight) — `lastAiMsg`, resolved above, is the turn this build
      // extends, so its id is what the breakdown describes. Unlike swipeRight,
      // this EXTENDS the current swipe rather than creating a new one (see the
      // `newSwipes[m.swipeId] = ...` writes below), so the swipe it describes
      // is `lastAiMsg.swipeId` as captured here, unchanged by this call
      // (review round 1, M3/F6).
      useGenerationStore.getState().tagLastBreakdownMessage(breakdown, lastAiMsg.id, lastAiMsg.swipeId);
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
        continueImages,
        isTextCompletionMode()
      );
      if (!stream) return;
      // Post-dispatch capture — see swipeRight for the rationale.
      captureWiFired(currentChatFile, wiOut, currentTurn);

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
      const { currentChatFile } = get();
      // Impersonation writes the user turn that precedes the NEXT AI turn,
      // so its turn index counts all existing AI messages — like sendMessage.
      const currentTurn = messages.filter((m) => !m.isUser && !m.isSystem).length;
      // Wire the WI out-param through (was undefined) — see continueMessage.
      const wiOut = {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: new Set<string>(),
      };
      // Server-side lore retrieval: eligibility-gated, always falls back to
      // the client-side scan on any failure/ineligibility (see
      // src/utils/serverRetrieval.ts). Content is safe to read server-side
      // here — impersonate's `messages` is untouched this turn, matching
      // what the server would re-read from the persisted Chat row. No
      // commit call below (impersonate has never persisted WI timers — see
      // the comment above wiOut — so there's nothing to mirror there).
      //
      // Awaited BEFORE `prepare` (it used to sit after the recall call):
      // `prepare` consumes `serverMatchedEntries` as the world-info scan's
      // input, so it cannot run until this resolves.
      const serverRetrieval = await tryServerRetrieval(character.avatar || '', currentChatFile || '');
      // Two-pass recall — see swipeRight for the full rationale and the
      // direction invariant.
      const prepared = prepareConversationContext(messages, character, availableEmotions, wiOut, serverRetrieval?.matchedEntries);
      const probe = finishConversationContext(prepared, undefined, { commit: false });
      const ragCtx = await resolveRagContext(messages, currentChatFile || undefined, probe.boundaryId);
      const breakdown = createPromptBreakdown('solo');
      const { context, overBudget } = finishConversationContext(prepared, ragCtx ?? undefined, { commit: true, breakdownOut: breakdown });
      // User-role instruction so Gemini (which extracts system into a
      // separate systemInstruction field) doesn't leave contents[] ending
      // with an assistant turn and trip its 400. See continueMessage above
      // for the full rationale.
      context.push({
        role: 'user',
        content: `(Now write the next message as the user (You). Write from a first-person perspective as the user would. Do NOT include an emotion tag. Do NOT write as ${character.name}.)`,
      });
      recordCallSiteTurn(breakdown, 'impersonate', context[context.length - 1].content);
      // No recordAttachments here: impersonate passes `undefined` images to
      // api.generateMessage below, so this request carries none.
      useGenerationStore.getState().setLastPromptBreakdown(breakdown);

      const { provider, model } = getProviderAndModel();
      const finalContext = await runGenerateInterceptors(
        maybeApplyInstructMode(context),
        character.name,
      );
      const generationOptions = getGenerationOptions();
      const stream = await api.generateMessage(finalContext, character.name, provider, model, abortController.signal, generationOptions, undefined, isTextCompletionMode());
      if (!stream) return '';
      // Post-dispatch capture — see swipeRight for the rationale.
      captureWiFired(currentChatFile, wiOut, currentTurn);

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
      // Drop the dead chat's WI telemetry — a chat later renamed to this
      // name must not inherit it.
      wiFiredByFile.delete(fileName);
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
      // Carry the WI fired-state over to the new key — the next save targets
      // the new filename, and without this the rebuilt header would emit no
      // wi_fired and clobber the telemetry persisted in the renamed row.
      const fired = wiFiredByFile.get(originalFile);
      if (fired) {
        wiFiredByFile.set(sanitized, fired);
        wiFiredByFile.delete(originalFile);
      }
      // If the renamed chat is the one currently loaded, update the
      // in-memory pointer so subsequent saves target the new filename
      // instead of the (now non-existent) original file.
      const { currentChatFile, fetchChatFiles } = get();
      if (currentChatFile === originalFile) {
        set({ currentChatFile: sanitized });
      }
      await fetchChatFiles(avatarUrl);
      // Story-state phase 10 §7: repoint Works and bibles that still name the
      // old file. Trailing and self-contained — it swallows its own failures,
      // so a heal that goes wrong can never reach the catch below and report
      // a rename that already landed as failed.
      await healRenamedChatRefs(
        { character_avatar: avatarUrl, file_name: originalFile },
        // The SERVER-sanitized name, never the caller's raw input: the refs
        // have to match what /chats/rename actually stored.
        { character_avatar: avatarUrl, file_name: sanitized }
      );
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
      // Server-side lore retrieval: eligibility-gated, always falls back to
      // the client-side scan on any failure/ineligibility (see
      // src/utils/serverRetrieval.ts). `updatedMessages` is provably in
      // sync with the persisted Chat row here — saveChatToBackend just ran
      // unconditionally above, before this try block. Awaited before
      // `prepare`, which consumes its entries as the world-info scan input.
      const serverRetrieval = await tryServerRetrieval(character.avatar || '', currentChatFile || '');
      const wiOut = {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: wiTimerActivated,
      };
      // Two-pass recall — see swipeRight for the full rationale and the
      // direction invariant.
      const prepared = prepareConversationContext(updatedMessages, character, availableEmotions, wiOut, serverRetrieval?.matchedEntries);
      const probe = finishConversationContext(prepared, undefined, { commit: false });
      const ragCtx = await resolveRagContext(updatedMessages, currentChatFile || undefined, probe.boundaryId);
      const breakdown = createPromptBreakdown('solo');
      const { context, overBudget } = finishConversationContext(prepared, ragCtx ?? undefined, { commit: true, breakdownOut: breakdown });
      const sendImages = resolveImagesForSend(attachedImages);
      recordAttachments(breakdown, sendImages);
      useGenerationStore.getState().setLastPromptBreakdown(breakdown);
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
        sendImages,
        isTextCompletionMode()
      );
      if (usedFallback) showToastGlobal('Primary provider failed — using fallback', 'warning');

      if (stream) {
        // Post-dispatch capture — see swipeRight for the rationale.
        captureWiFired(currentChatFile, wiOut, currentTurn);
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
        // E2-S2 task 4 — see generateGroupTurn for the identity-guard rationale.
        // Freshly created message, so swipe 0 (review round 1, M3/F6).
        useGenerationStore.getState().tagLastBreakdownMessage(breakdown, aiMessageId, 0);

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

          // Mirrors the server's read/commit pair: when this turn used the
          // server-side lore read, advance server-side timed-effect state
          // via the commit endpoint (fire-and-forget, echoing back the
          // read's own turnNo per its "echoed back rather than re-derived"
          // contract) instead of the local saveWiTimers. Only reached after
          // a confirmed-successful, non-empty generation — same gating as
          // saveWiTimers always had.
          if (serverRetrieval) {
            commitServerRetrieval(
              character.avatar || '',
              currentChatFile || '',
              serverRetrieval.turnNo,
              serverRetrieval.activatedEntryIds
            );
          } else {
            saveWiTimers(currentChatFile || '', wiTimerActivated, currentTurn);
          }
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

    // Persist the edited/truncated messages immediately, before any
    // server-side retrieval read. tryServerRetrieval's POST
    // /retrieval/context call makes the backend re-read Chat.messages
    // straight off the DB row (deliberately, to stay safe against a
    // stale/forged tail) — if we called it before saving, the server would
    // score lore against the OLD pre-edit, pre-truncation text instead of
    // what the user just edited. Mirrors sendMessage's Fix #1 persist-
    // before-retrieval ordering. allowTruncate=true because editing an
    // earlier message drops everything after it, which can shrink the
    // array below what's currently persisted.
    await saveChatToBackend(updatedMessages, character, get().currentChatFile, false, undefined, true);

    try {
      const { currentChatFile } = get();
      const currentTurn = updatedMessages.filter((m) => !m.isUser && !m.isSystem).length;
      const wiTimerActivated = new Set<string>();
      const wiOut = {
        currentTurn,
        timers: loadWiTimers(currentChatFile || ''),
        activated: wiTimerActivated,
      };
      // Server-side lore retrieval: eligibility-gated, always falls back to
      // the client-side scan on any failure/ineligibility (see
      // src/utils/serverRetrieval.ts). Wired here too (not just
      // sendMessage/impersonate) so edit-and-regenerate doesn't silently
      // diverge from whichever timed-effect store (server vs local) the
      // rest of the chat's turns are using — see the commit/save branch
      // below. Safe to call now: updatedMessages was just persisted above,
      // so the server's re-read of Chat.messages matches what's on screen.
      // Awaited before `prepare`, which consumes its entries as the
      // world-info scan input.
      const serverRetrieval = await tryServerRetrieval(character.avatar || '', currentChatFile || '');
      // Two-pass recall — see swipeRight for the full rationale and the
      // direction invariant.
      const prepared = prepareConversationContext(updatedMessages, character, availableEmotions, wiOut, serverRetrieval?.matchedEntries);
      const probe = finishConversationContext(prepared, undefined, { commit: false });
      const ragCtx = await resolveRagContext(updatedMessages, currentChatFile || undefined, probe.boundaryId);
      const breakdown = createPromptBreakdown('solo');
      const { context, overBudget } = finishConversationContext(prepared, ragCtx ?? undefined, { commit: true, breakdownOut: breakdown });
      const { provider, model } = getProviderAndModel();
      const regenImages = imagesFromLastUserMessage(updatedMessages, provider, model);
      recordAttachments(breakdown, regenImages);
      useGenerationStore.getState().setLastPromptBreakdown(breakdown);
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
        regenImages,
        isTextCompletionMode()
      );

      if (stream) {
        // Post-dispatch capture — see swipeRight for the rationale.
        captureWiFired(currentChatFile, wiOut, currentTurn);
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
        // E2-S2 task 4 — see generateGroupTurn for the identity-guard rationale.
        // Freshly created message, so swipe 0 (review round 1, M3/F6).
        useGenerationStore.getState().tagLastBreakdownMessage(breakdown, aiMessageId, 0);

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

          // Mirrors sendMessage/swipeRight's read/commit pair — see the
          // comment above wiOut in this function.
          if (serverRetrieval) {
            commitServerRetrieval(
              character.avatar || '',
              currentChatFile || '',
              serverRetrieval.turnNo,
              serverRetrieval.activatedEntryIds
            );
          } else {
            saveWiTimers(currentChatFile || '', wiTimerActivated, currentTurn);
          }
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
