// API Client. Auth + invitations talk to ggbc-backend; characters/chats/
// generation go to /api/* which ggbc-backend transparently proxies to
// SillyTavern with a per-user ST session it manages internally.

let csrfToken: string | null = null;

export async function getCsrfToken(): Promise<string> {
  if (csrfToken !== null) return csrfToken;

  // ggbc-backend doesn't use CSRF tokens — same-origin httpOnly cookies plus
  // SameSite=Lax are enough. The proxy strips any X-CSRF-Token header from
  // incoming requests and injects its own when forwarding to ST.
  //
  // We still attempt the fetch for compatibility with deployments where the
  // edge router serves /csrf-token, but a 404 is fine: we fall back to an
  // empty token, which both ggbc-backend and the proxy ignore.
  try {
    const response = await fetch('/csrf-token', { credentials: 'include' });
    if (response.ok) {
      const data = (await response.json()) as { token?: string };
      csrfToken = data.token ?? '';
    } else {
      csrfToken = '';
    }
  } catch {
    csrfToken = '';
  }
  return csrfToken;
}

/** Call after logout so the next request fetches a fresh token from the new session. */
export function clearCsrfToken(): void {
  csrfToken = null;
}

/** 409 body from POST /chats/save (mirrors the backend's ChatConflictDetail).
 *  `error` is "conflict" (stale base_ts) or "message_count_regression"
 *  (the save would shrink the stored array without allow_truncate). */
export interface ChatConflict {
  error: string;
  current_ts: number;
  current_messages: unknown[];
}

/** Thrown by api.saveChat on a 409 so callers can merge against the
 *  authoritative server state instead of silently clobbering it. */
export class ChatConflictError extends Error {
  conflict: ChatConflict;
  constructor(conflict: ChatConflict) {
    super(`chat save conflict: ${conflict.error}`);
    this.name = 'ChatConflictError';
    this.conflict = conflict;
  }
}

/** 409 body from PUT /sync/section/{name} (mirrors backend SectionConflictDetail).
 *  Returned when the section's server_ts moved since we last observed it. */
export interface SectionConflict {
  error: string;
  current_ts: number;
  current_data: unknown;
}

/** Thrown by putSection on a 409 so the sync layer can merge against the
 *  authoritative server state and retry instead of silently overwriting it. */
export class SectionConflictError extends Error {
  conflict: SectionConflict;
  constructor(conflict: SectionConflict) {
    super(`section sync conflict: ${conflict.error}`);
    this.name = 'SectionConflictError';
    this.conflict = conflict;
  }
}

// ggbc-backend speaks roles (owner/admin/contributor/end_user); SillyTavern
// speaks permission group ids (e.g. owner-default). The frontend was built
// around the ST shape, so we translate at the boundary.
const ROLE_TO_GROUP: Record<import('../types').UserRole, string> = {
  owner: 'owner-default',
  admin: 'admin-default',
  contributor: 'contributor-default',
  end_user: 'end-user-default',
};

export function roleToGroupId(role: import('../types').UserRole): string {
  return ROLE_TO_GROUP[role];
}

export function groupIdToRole(groupId: string): import('../types').UserRole {
  if (groupId.startsWith('owner')) return 'owner';
  if (groupId.startsWith('admin')) return 'admin';
  if (groupId.startsWith('contributor')) return 'contributor';
  return 'end_user';
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getCsrfToken();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': token,
    ...options.headers,
  };

  const response = await fetch(endpoint, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    // ggbc-backend (FastAPI) reports errors as { detail }; keep .error/.message
    // for any legacy/edge shapes so the user sees the crafted message, not a
    // bare "HTTP 4xx".
    throw new Error(error.error || error.detail || error.message || `HTTP ${response.status}`);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) return {} as T;

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response from ${endpoint}`);
  }
}

/** Like apiRequest but returns the raw response body as a string (for plain-text endpoints). */
export async function apiRequestText(
  endpoint: string,
  options: RequestInit = {}
): Promise<string> {
  const token = await getCsrfToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': token,
    ...options.headers,
  };
  const response = await fetch(endpoint, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    // ggbc-backend (FastAPI) reports errors as { detail }; keep .error/.message
    // for any legacy/edge shapes so the user sees the crafted message, not a
    // bare "HTTP 4xx".
    throw new Error(error.error || error.detail || error.message || `HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * PUT one settings section with optimistic concurrency. Sends the last-observed
 * `server_ts` as `base_ts`; the backend returns the new `server_ts` on success
 * or a 409 + current state when another device wrote first. Throws
 * SectionConflictError on 409 so the caller can merge and retry instead of
 * clobbering. Mirrors saveChat's 409 handling for the per-section /sync API
 * (apiRequest collapses non-2xx into a generic Error and would hide the 409 body).
 */
export async function putSection(
  name: string,
  data: unknown,
  baseTs?: number | null
): Promise<{ server_ts: number; data: unknown }> {
  const token = await getCsrfToken();
  const response = await fetch(`/sync/section/${name}`, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    body: JSON.stringify({
      data,
      ...(typeof baseTs === 'number' ? { base_ts: baseTs } : {}),
    }),
  });

  if (response.status === 409) {
    // FastAPI nests the model under `detail`.
    const body = await response.json().catch(() => ({}));
    const detail = (body?.detail ?? body) as Partial<SectionConflict>;
    throw new SectionConflictError({
      error: typeof detail?.error === 'string' ? detail.error : 'conflict',
      current_ts: typeof detail?.current_ts === 'number' ? detail.current_ts : 0,
      current_data: detail?.current_data ?? null,
    });
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error || err?.message || `HTTP ${response.status}`);
  }

  const out = (await response.json().catch(() => ({}))) as {
    server_ts?: number;
    data?: unknown;
  };
  return {
    server_ts: typeof out.server_ts === 'number' ? out.server_ts : 0,
    data: out.data,
  };
}

// ---------------------------------------------------------------------------
// B1: character ↔ DB translation helpers
//
// Wire shape returned by ggbc-backend's GET /characters is:
//   { id, avatar, name, data: {...v2/v3 card...}, chat, fav, tags, server_ts,
//     create_date, last_modified }
//
// The frontend's CharacterInfo flattens many fields up to top-level and keeps
// `data` as a nested mirror; characterStore + lots of components read either
// shape. These helpers translate between the two so the cutover doesn't
// require touching every callsite.
// ---------------------------------------------------------------------------

interface ServerCharacter {
  id: string;
  avatar: string;
  name: string;
  data: Record<string, unknown>;
  chat: string | null;
  fav: boolean;
  tags: string[];
  server_ts: number;
  create_date: string;
  last_modified: string;
  // Avatar-provenance safety gate (backend migration 0024). Read-only; the
  // selfie feature reads it to decide whether a character may send selfies.
  // Values: generated | fictional-declared | grandfathered | uploaded | unknown.
  avatar_provenance?: string;
  // Studio-LoRA state (Phase C2), computed server-side from lora_trainings.
  // 'succeeded' = servable weights exist for the CURRENT avatar (the selfie
  // modal's Studio gate); other values are the latest matching row's
  // in-flight/failed status; null/absent = never trained for this avatar.
  lora_status?: string | null;
  lora_trained_at?: string | null;
}

function toCharacterInfo(row: ServerCharacter): CharacterInfo {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const created = Date.parse(row.create_date) || 0;
  const modified = Date.parse(row.last_modified) || 0;
  return {
    name: row.name,
    avatar: row.avatar,
    description: (data.description as string | undefined),
    personality: (data.personality as string | undefined),
    first_mes: (data.first_mes as string | undefined),
    scenario: (data.scenario as string | undefined),
    mes_example: (data.mes_example as string | undefined),
    create_date: row.create_date,
    date_added: created,
    date_last_chat: modified,
    fav: row.fav,
    tags: row.tags,
    alternate_greetings: data.alternate_greetings as string[] | undefined,
    system_prompt: data.system_prompt as string | undefined,
    post_history_instructions: data.post_history_instructions as string | undefined,
    character_version: data.character_version as string | undefined,
    creator_notes: data.creator_notes as string | undefined,
    creator: data.creator as string | undefined,
    avatar_provenance: row.avatar_provenance,
    lora_status: row.lora_status,
    lora_trained_at: row.lora_trained_at,
    data: data as CharacterInfo['data'],
  };
}

function splitTags(tags: string | string[] | undefined): string[] {
  if (Array.isArray(tags)) return tags.filter((t) => typeof t === 'string' && t.length > 0);
  if (!tags) return [];
  return tags.split(',').map((t) => t.trim()).filter(Boolean);
}

function sanitizeAvatarName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._ ()-]/g, '_').trim();
  return cleaned || 'Unnamed';
}

/**
 * Build the v2 spec `data` object from the legacy CharacterCreateData shape.
 *
 * `data_overrides` and `extensions` carry whatever the caller has that this
 * function doesn't already model as an explicit field — V3-only card keys
 * (`nickname`, `source`, …) and third-party extension namespaces (`chub`,
 * `risuai`, …). Both are spread in FIRST so the explicit fields that follow
 * always win over a passed-through value. Previously `data`/`extensions`
 * were built from scratch every call, so anything not in this function's
 * own field list — including on a plain edit-and-save with no import
 * involved — was silently discarded on every save.
 */
function buildCardData(input: CharacterCreateData & { avatar_url?: string }): {
  data: Record<string, unknown>;
  tags: string[];
} {
  const tags = splitTags(input.tags);
  const data: Record<string, unknown> = {
    ...(input.data_overrides || {}),
    name: input.ch_name,
    description: input.description ?? '',
    personality: input.personality ?? '',
    first_mes: input.first_mes ?? '',
    scenario: input.scenario ?? '',
    mes_example: input.mes_example ?? '',
    creator_notes: input.creator_notes ?? '',
    creator: input.creator ?? '',
    tags,
  };
  if (input.alternate_greetings) data.alternate_greetings = input.alternate_greetings;
  if (input.system_prompt !== undefined) data.system_prompt = input.system_prompt;
  if (input.post_history_instructions !== undefined) {
    data.post_history_instructions = input.post_history_instructions;
  }
  if (input.character_version !== undefined) data.character_version = input.character_version;

  // depth_prompt/talkativeness are still authoritatively driven by this
  // call's own scalar fields (both callers derive them fresh from live form
  // state on every save, including deliberately clearing them) — so those
  // two keys are deleted from the spread before being recomputed, rather
  // than merged, so a cleared field can't be resurrected by a stale value
  // in `input.extensions`. Every other key in `input.extensions` (anything
  // this function doesn't model) passes through untouched.
  const extensions: Record<string, unknown> = { ...(input.extensions || {}) };
  delete extensions.depth_prompt;
  delete extensions.talkativeness;
  if (
    input.depth_prompt_prompt !== undefined ||
    input.depth_prompt_depth !== undefined ||
    input.depth_prompt_role !== undefined
  ) {
    extensions.depth_prompt = {
      prompt: input.depth_prompt_prompt ?? '',
      depth: input.depth_prompt_depth ?? 4,
      role: input.depth_prompt_role ?? 'system',
    };
  }
  if (input.talkativeness !== undefined) extensions.talkativeness = input.talkativeness;
  if (Object.keys(extensions).length > 0) data.extensions = extensions;

  // NB: avatar provenance is deliberately NOT written into `data` here — it is
  // sent as the explicit top-level `avatar_provenance_source` field by
  // createCharacter/editCharacter, so a stamp can't round-trip through the card
  // blob and be re-trusted on a later edit. See utils/avatarProvenance.
  return { data, tags };
}

async function putAvatarBlob(avatar: string, file: File): Promise<void> {
  // /blobs is a per-user bytea store; raw body with Content-Type. The blob
  // key for character art is `character/{avatar}` (the namespace
  // `character/` groups them alongside `persona-avatar/`, `vn-bg/`).
  const body = await file.arrayBuffer();
  const resp = await fetch(`/blobs/character/${encodeURIComponent(avatar)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'image/png' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(text || `Failed to upload avatar (HTTP ${resp.status})`);
  }
}

export interface UserInfo {
  handle: string;
  name: string;
  avatar: string;
  password: boolean; // true if user has a password set
  created?: number;
}

export type CharacterVisibility = 'global' | 'personal';

export interface CharacterMetadataEntry {
  ownerHandle: string;
  visibility: CharacterVisibility;
  claimedAt: number;
  // Populated only when the caller is an admin/owner viewing a card that
  // multiple users have a copy of. Lists the other users' handles so the
  // UI can render an "also owned by X" hint without an extra request.
  otherOwners?: string[];
}

export type CharacterMetadataMap = Record<string, CharacterMetadataEntry>;

export interface UserHandleSummary {
  handle: string;
  name: string;
}

/** One entry from GET /worldinfo/shared — another user's book they've marked shared. */
export interface SharedWorldInfoBookDTO {
  owner_handle: string;
  owner_name: string | null;
  book: unknown; // deliberately untyped here — worldInfoStore normalizes it, client.ts must not import store types
}

/**
 * A lorebook row from the native /lorebooks API (LorebookOut, camelCase —
 * matches app/schemas/lorebook.py's aliases). Deliberately loosely typed,
 * same reasoning as SharedWorldInfoBookDTO/RetrievalContextEntryDTO above:
 * worldInfoStore.ts normalizes this defensively into WorldInfoBook;
 * client.ts must not import store types. `id`/`ownerHandle`/`server_ts` are
 * pulled out explicitly because every caller needs them unconditionally
 * (id to key on, server_ts to thread back as the next PUT's baseTs).
 */
export interface LorebookDTO {
  id: string;
  ownerHandle: string;
  server_ts: number;
  [key: string]: unknown; // name, ownerCharacterAvatar, autoExtracted, scope,
  // visibility, createdAt, updatedAt
}

/**
 * A lorebook entry row from the native /lorebooks API (LorebookEntryOut) —
 * same shape/reasoning as RetrievalContextEntryDTO, reused here rather than
 * redeclared since the two endpoints share the exact wire shape.
 */
export type LorebookEntryDTO = RetrievalContextEntryDTO;

/** GET /lorebooks/{id} — a LorebookDTO with its nested entries. */
export interface LorebookWithEntriesDTO extends LorebookDTO {
  entries: LorebookEntryDTO[];
}

/**
 * One ranked result from POST /lorebooks/search (LorebookSearchHit).
 * `score` is a fused RRF rank, only meaningful relative to other hits in
 * the SAME response — never compare it across two different search calls.
 * The three per-signal scores are `null` (not `0`) when that signal didn't
 * fire for this entry at all, e.g. `semanticScore` is null for an entry
 * with no embedding yet, not "scored a semantic zero".
 */
export interface LorebookSearchHit {
  entry: LorebookEntryDTO;
  score: number;
  keywordScore?: number | null;
  semanticScore?: number | null;
  ftsScore?: number | null;
}

/** 409 body for PUT /lorebooks/{id} (LorebookConflictDetail). */
export interface LorebookConflict {
  error: string;
  current_ts: number;
  current: LorebookDTO | null;
}

/** Thrown by api.updateLorebook on a 409 so the store can reconcile against
 *  the authoritative row instead of clobbering it. Mirrors ProjectConflictError. */
export class LorebookConflictError extends Error {
  conflict: LorebookConflict;
  constructor(conflict: LorebookConflict) {
    super('lorebook write conflict');
    this.name = 'LorebookConflictError';
    this.conflict = conflict;
  }
}

/** 409 body for PUT /lorebooks/{id}/entries/{entry_id} (LorebookEntryConflictDetail). */
export interface LorebookEntryConflict {
  error: string;
  current_ts: number;
  current: LorebookEntryDTO | null;
}

/** Thrown by api.updateLorebookEntry on a 409. Mirrors LorebookConflictError —
 *  a separate class (not reused) because a book-level and an entry-level
 *  conflict are distinct concerns, same reasoning as the backend's two
 *  separate *ConflictDetail schemas. */
export class LorebookEntryConflictError extends Error {
  conflict: LorebookEntryConflict;
  constructor(conflict: LorebookEntryConflict) {
    super('lorebook entry write conflict');
    this.name = 'LorebookEntryConflictError';
    this.conflict = conflict;
  }
}

/**
 * One entry from POST /retrieval/context — the full flat WorldInfoEntry-
 * shaped object (camelCase, matches app/schemas/lorebook.py's
 * LorebookEntryOut) plus two additive, un-aliased backend fields:
 * `lorebook_id` and `server_ts` (confirmed literal snake_case on the wire —
 * LorebookEntryOut leaves them un-aliased deliberately, same as this repo's
 * other sync-protocol responses). Deliberately loosely typed, same
 * reasoning as SharedWorldInfoBookDTO above: src/utils/serverRetrieval.ts
 * normalizes this into WorldInfoEntry/MatchedEntry; client.ts must not
 * import store types.
 */
export interface RetrievalContextEntryDTO {
  id: string;
  lorebook_id: string;
  server_ts: number;
  /** Phase 3.2 of the memory-consolidation plan: set only by
   *  POST/PUT /lorebooks/{id}/entries(/{entryId}) when that specific write
   *  pushed the book's pinned (critical ∪ constant) set over the World Info
   *  token budget — null/absent everywhere else, including every entry in
   *  a POST /retrieval/context response. */
  pinnedBudgetWarning?: { pinnedTokens: number; budgetTokens: number } | null;
  [key: string]: unknown; // keys, content, comment, enabled, position, depth,
  // order, keysSecondary, selective, selectiveLogic, scanDepth, probability,
  // useProbability, group, groupOverride, groupWeight, preventRecursion,
  // excludeRecursion, sticky, cooldown, delay, critical, semanticOnly,
  // category, relatedIds, source, revisions, createdAt, updatedAt
}

/** Response for POST /retrieval/context — see RetrievalContextEntryDTO. */
export interface RetrievalContextDTO {
  entries: RetrievalContextEntryDTO[];
  turnNo: number;
  activatedEntryIds: string[];
}

/** One chunk from POST /retrieval/messages (Phase 2 of the
 *  memory-consolidation plan — server-side chat-history RAG). `text` is
 *  read live from the chat row server-side, never from storage, so it's
 *  always current even if the underlying embedding is stale. */
export interface MessageChunkDTO {
  ggbcId: string;
  text: string;
  isUser: boolean;
  score: number;
}

/** Response for POST /retrieval/messages. `chunks` is empty (not an
 *  error) whenever RAG isn't usable for this call; `reason`, when
 *  present, distinguishes why (today only `"no_key"`) — additive/optional
 *  so it's safe to ignore. */
export interface RetrievalMessagesDTO {
  chunks: MessageChunkDTO[];
  reason?: string;
}

export interface CharacterInfo {
  name: string;
  avatar: string; // filename like "CharacterName.png"
  description?: string;
  personality?: string;
  first_mes?: string;
  scenario?: string;
  mes_example?: string;
  create_date?: string;
  date_added?: number;
  date_last_chat?: number;
  chat_size?: number;
  fav?: boolean;
  tags?: string[];
  // Global character sharing (populated by the server; may be absent on older
  // backends, in which case callers treat as 'personal' / null).
  visibility?: CharacterVisibility;
  owner_handle?: string | null;
  // Admin-only: handles of other users with a copy of this same-named card.
  // Server only populates this for admin/owner callers; omitted otherwise.
  other_owners?: string[];
  // Advanced Character Card V2 fields
  alternate_greetings?: string[];
  system_prompt?: string;
  post_history_instructions?: string;
  character_version?: string;
  creator_notes?: string;
  creator?: string;
  // Avatar-provenance safety gate (backend). Only generated/fictional-declared/
  // grandfathered avatars may send selfies. See utils/avatarProvenance.
  avatar_provenance?: string;
  // Studio-LoRA state (Phase C2), computed server-side. 'succeeded' means a
  // trained model exists for the character's CURRENT avatar — the selfie
  // modal's Studio mode gates on exactly this value.
  lora_status?: string | null;
  lora_trained_at?: string | null;
  data?: {
    name?: string;
    description?: string;
    personality?: string;
    first_mes?: string;
    scenario?: string;
    mes_example?: string;
    creator_notes?: string;
    creator?: string;
    tags?: string[];
    alternate_greetings?: string[];
    system_prompt?: string;
    post_history_instructions?: string;
    character_version?: string;
    extensions?: {
      depth_prompt?: {
        prompt?: string;
        depth?: number;
        role?: string;
      };
      talkativeness?: string;
      fav?: boolean;
      [key: string]: unknown;
    };
  };
}

export interface CharacterCreateData {
  ch_name: string;
  description?: string;
  personality?: string;
  first_mes?: string;
  scenario?: string;
  mes_example?: string;
  creator_notes?: string;
  creator?: string;
  tags?: string;
  // Advanced fields - sent via data object JSON string
  alternate_greetings?: string[];
  system_prompt?: string;
  post_history_instructions?: string;
  character_version?: string;
  depth_prompt_prompt?: string;
  depth_prompt_depth?: number;
  depth_prompt_role?: string;
  talkativeness?: string;
  fav?: boolean;
  /** Card-data keys not modeled above (V3-only fields, third-party
   *  extension namespace payloads that live outside `extensions`) — spread
   *  into `data` verbatim so an import/edit round trip doesn't drop them. */
  data_overrides?: Record<string, unknown>;
  /** The full `data.extensions` object to preserve (third-party namespaces,
   *  ggbc provenance). depth_prompt/talkativeness within it are still
   *  overridden by this call's own scalar fields above. */
  extensions?: Record<string, unknown>;
  /** How this save's avatar came to be — set ONLY when a new avatar is chosen
   *  (generation/upload/import), so the backend's selfie safety gate can derive
   *  whether the avatar is a known fictional image. Omitted on a text-only edit,
   *  which preserves the existing provenance. See utils/avatarProvenance. */
  avatarProvenance?: AvatarSource;
}

export interface CharacterEditData extends CharacterCreateData {
  avatar_url: string;
  chat?: string;
  create_date?: string;
}

/** Save/resume for in-progress character creation — see /character-drafts.
 *  One slot per (user, kind); `payload` is flow-specific and opaque to the
 *  client wrapper (the manual form's field values, or the interview's
 *  transcript/draft/coverage/staged-lore/phase). */
export type CharacterDraftKind = 'manual' | 'interview';

export interface CharacterDraft {
  kind: CharacterDraftKind;
  payload: Record<string, unknown>;
  updated_at: string;
}

// Generation sampler options passed through to the backend.
// Most fields are optional and only sent when set to non-default values.
export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  stopStrings?: string[];
  /** Overrides the settings-store custom endpoint for THIS call only.
   *  Needed by callers that run against a saved connection profile
   *  (e.g. story ingestion), whose custom URL is the profile's, not the
   *  one currently selected in settings. Ignored unless provider is
   *  'custom'. */
  customUrl?: string;
}

/**
 * Some newer models reject the classic sampler params outright — the backend
 * returns a 400 ("`temperature` is deprecated for this model") rather than
 * ignoring them. For those we omit temperature/top_p/etc. and let the provider
 * use its own defaults. Currently this covers Claude Opus/Sonnet/Haiku 4.7 and
 * newer; extend the version check as other models surface the same constraint.
 */
export function modelRejectsSamplers(model?: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  const claude = m.match(/claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (claude) {
    const major = Number(claude[1]);
    const minor = Number(claude[2]);
    if (major > 4) return true;
    if (major === 4 && minor >= 7) return true;
  }
  return false;
}

/** Phase 6.1 — image attachment sent with generateMessage. `base64` is
 *  the raw payload (NO `data:...;base64,` prefix); the API client folds
 *  these into OpenAI-style content parts before POST. */
export interface GenerationImage {
  mimeType: string;
  base64: string;
}

export const api = {
  // Auth endpoints
  async getUsers(): Promise<UserInfo[]> {
    const response = await apiRequest<UserInfo[] | undefined>('/api/users/list', {
      method: 'POST',
    });
    // Returns array directly, or empty array if 204 (discreet login).
    // Must use Array.isArray — a 204 causes apiRequest to return {} which
    // is truthy, so `response || []` would incorrectly return {} instead of [].
    return Array.isArray(response) ? response : [];
  },

  async login(handle: string, password?: string): Promise<{ handle: string }> {
    // ggbc-backend's /auth/login returns the full user object; we only need
    // the handle here — callers fetch the full user via /api/users/me (which
    // ggbc-backend proxies to ST so the rich shape with permissions/avatar
    // is preserved).
    const user = await apiRequest<{ handle: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ handle, password: password ?? '' }),
    });
    return { handle: user.handle };
  },

  async logout(): Promise<void> {
    await apiRequest('/auth/logout', { method: 'POST' });
  },

  async getCurrentUser(): Promise<{
    handle: string;
    name: string;
    role: import('../types').UserRole;
    avatar?: string;
    groupId?: string;
    permissions?: import('../types').Permission[];
  } | null> {
    // Routed through ggbc-backend's /api proxy to SillyTavern, so the full
    // ST shape (name, avatar, groupId, permissions) flows through unchanged.
    try {
      const user = await apiRequest<{
        handle: string;
        name: string;
        admin: boolean;
        role?: string;
        avatar?: string;
        groupId?: string;
        permissions?: string[];
      }>('/api/users/me');
      const role = (user.role as import('../types').UserRole) ||
        (user.admin ? 'admin' : 'end_user');
      return {
        handle: user.handle,
        name: user.name,
        role,
        avatar: user.avatar,
        groupId: user.groupId,
        permissions: user.permissions,
      };
    } catch {
      return null;
    }
  },

  async changeName(handle: string, name: string): Promise<void> {
    // Still hits ST via proxy — display name lives on the ST user record.
    await apiRequest('/api/users/change-name', {
      method: 'POST',
      body: JSON.stringify({ handle, name }),
    });
  },

  async changePassword(_handle: string, oldPassword: string, newPassword: string): Promise<void> {
    // ggbc-backend's /auth/password operates on the current session — the
    // handle param is kept for backward compatibility with callers but is
    // ignored. Only self-service password change is supported here; admin
    // resets will go via a separate admin endpoint later.
    await apiRequest('/auth/password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: oldPassword,
        new_password: newPassword,
      }),
    });
  },

  async changeAvatar(handle: string, avatar: string): Promise<void> {
    // Avatar still lives on the ST user record; ggbc-backend hasn't taken
    // it over yet. Routed through the proxy.
    await apiRequest('/api/users/change-avatar', {
      method: 'POST',
      body: JSON.stringify({ handle, avatar }),
    });
  },

  async register(
    handle: string,
    name: string,
    password?: string,
    inviteToken?: string,
  ): Promise<{ handle: string }> {
    // Single-call replacement for the old three-step ST bootstrap flow.
    // ggbc-backend handles invite consumption + ST mirror provisioning
    // atomically and sets our session cookie on success.
    const user = await apiRequest<{ handle: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        handle,
        password: password ?? '',
        display_name: name,
        invite_token: inviteToken,
      }),
    });
    return { handle: user.handle };
  },

  async checkCanRegister(): Promise<{ canRegister: boolean; requiresAdmin: boolean }> {
    // A1.3 removes the legacy "is default-user the only account?" probe.
    // ggbc-backend will surface a /auth/can-register endpoint in a follow-up;
    // for now we always advertise registration as available and let the
    // server return a clear error if invite-required is enforced.
    return { canRegister: true, requiresAdmin: false };
  },

  // ---------------------------------------------------------------------
  // Character endpoints — B1: ggbc-backend's /characters (Postgres-backed).
  // PNG art lives in user_blobs under `character/{avatar}` and is uploaded
  // separately by `putAvatarBlob`. The first call after login lazy-imports
  // anything the user had in ST so existing accounts seamlessly carry over.
  // ---------------------------------------------------------------------
  async getCharacters(): Promise<CharacterInfo[]> {
    const rows = await apiRequest<ServerCharacter[]>('/characters');
    let list = Array.isArray(rows) ? rows.map(toCharacterInfo) : [];
    if (list.length === 0) {
      // Lazy migration. Server-side it's a no-op once any character row
      // exists for the user, so subsequent calls are cheap. Failure just
      // returns [] — newly registered users may not have an ST account.
      try {
        const imported = await apiRequest<ServerCharacter[]>(
          '/characters/import-from-st',
          { method: 'POST' },
        );
        if (Array.isArray(imported) && imported.length > 0) {
          list = imported.map(toCharacterInfo);
        }
      } catch {
        // ignore; surface empty list
      }
    }
    return list;
  },

  async getCharacter(avatarUrl: string): Promise<CharacterInfo> {
    const row = await apiRequest<ServerCharacter>(
      `/characters/${encodeURIComponent(avatarUrl)}`,
    );
    return toCharacterInfo(row);
  },

  async createCharacter(data: CharacterCreateData, avatarFile?: File): Promise<string> {
    const { data: card, tags } = buildCardData(data);
    const avatar = sanitizeAvatarName(data.ch_name) + '.png';
    const payload = {
      avatar,
      name: data.ch_name,
      data: card,
      tags,
      fav: !!data.fav,
      // Selfie safety gate — the origin of this avatar, sent only when one was
      // chosen. Omitted (undefined → not serialized) otherwise. See
      // utils/avatarProvenance.
      avatar_provenance_source: data.avatarProvenance,
    };
    const created = await apiRequest<ServerCharacter>('/characters', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (avatarFile) {
      // PUT the art under the canonical key. Done after the row exists so
      // a server failure to create doesn't leave an orphan blob.
      await putAvatarBlob(created.avatar, avatarFile);
    }
    return created.avatar;
  },

  async deleteCharacter(avatarUrl: string, _deleteChats: boolean = true): Promise<void> {
    // Chat deletion is handled in B2 (chats → DB). For B1, DELETE removes
    // the row + avatar blob; orphaned chats in ST are no longer reachable
    // from the UI but remain on disk until B3 sunsets ST entirely.
    void _deleteChats;
    const resp = await fetch(`/characters/${encodeURIComponent(avatarUrl)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!resp.ok && resp.status !== 204) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || `HTTP ${resp.status}`);
    }
  },

  async listCharacterDrafts(): Promise<CharacterDraft[]> {
    return apiRequest<CharacterDraft[]>('/character-drafts');
  },

  async saveCharacterDraft(
    kind: CharacterDraftKind,
    payload: Record<string, unknown>
  ): Promise<CharacterDraft> {
    return apiRequest<CharacterDraft>(`/character-drafts/${kind}`, {
      method: 'PUT',
      body: JSON.stringify({ payload }),
    });
  },

  async deleteCharacterDraft(kind: CharacterDraftKind): Promise<void> {
    await apiRequest<Record<string, never>>(`/character-drafts/${kind}`, {
      method: 'DELETE',
    });
  },

  async editCharacter(data: CharacterEditData, avatarFile?: File): Promise<void> {
    const { data: card, tags } = buildCardData(data);
    const payload = {
      name: data.ch_name,
      data: card,
      chat: data.chat ?? null,
      tags,
      fav: !!data.fav,
      // Selfie safety gate — present only on a save that replaced the avatar
      // (an upload downgrades a cleared row); undefined on a text-only edit, so
      // the backend preserves the existing provenance. See utils/avatarProvenance.
      avatar_provenance_source: data.avatarProvenance,
    };
    await apiRequest<ServerCharacter>(
      `/characters/${encodeURIComponent(data.avatar_url)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    );
    if (avatarFile) {
      await putAvatarBlob(data.avatar_url, avatarFile);
    }
  },

  // Duplicate a character (server-side)
  async duplicateCharacter(avatarUrl: string): Promise<string> {
    const created = await apiRequest<ServerCharacter>(
      `/characters/${encodeURIComponent(avatarUrl)}/duplicate`,
      { method: 'POST' },
    );
    return created.avatar;
  },

  // --- Global character sharing ---
  //
  // Backed by ggbc-backend's `/characters/{metadata,set-visibility,transfer-ownership}`
  // endpoints — visibility lives on the `characters` row, ownership is the row's
  // user_id. `getCharacterMetadata` returns whatever the caller can see (their
  // own + globals), in the legacy ST shape the ownership store consumes.
  async getCharacterMetadata(): Promise<CharacterMetadataMap> {
    const result = await apiRequest<CharacterMetadataMap>('/characters/metadata', {
      method: 'POST',
    });
    return result && typeof result === 'object' ? result : {};
  },

  async setCharacterVisibility(avatarUrl: string, visibility: CharacterVisibility): Promise<void> {
    await apiRequest('/characters/set-visibility', {
      method: 'POST',
      body: JSON.stringify({ avatar_url: avatarUrl, visibility }),
    });
  },

  async transferCharacterOwnership(avatarUrl: string, newOwnerHandle: string): Promise<void> {
    await apiRequest('/characters/transfer-ownership', {
      method: 'POST',
      body: JSON.stringify({ avatar_url: avatarUrl, new_owner_handle: newOwnerHandle }),
    });
  },

  /**
   * Returns enabled users' handles + display names (excluding the caller),
   * for recipient pickers. Authenticated request, no special permission.
   */
  async listUserHandles(): Promise<UserHandleSummary[]> {
    const result = await apiRequest<UserHandleSummary[]>('/api/users/handles', {
      method: 'POST',
    });
    return Array.isArray(result) ? result : [];
  },

  /** GET /worldinfo/shared — every book other users have set to shared visibility. */
  async listSharedWorldInfoBooks(): Promise<SharedWorldInfoBookDTO[]> {
    const result = await apiRequest<{ books: SharedWorldInfoBookDTO[] }>('/worldinfo/shared');
    return Array.isArray(result?.books) ? result.books : [];
  },

  // -----------------------------------------------------------------
  // Native lorebook CRUD (Phase 3a) — worldInfoStore.ts's system of record
  // for books/entries. Consumed only by worldInfoStore.ts, never directly
  // by components (matches every other store-owned resource in this file).
  // -----------------------------------------------------------------

  /** GET /lorebooks — every book the caller owns, no nested entries. */
  async listLorebooks(): Promise<LorebookDTO[]> {
    const result = await apiRequest<LorebookDTO[]>('/lorebooks');
    return Array.isArray(result) ? result : [];
  },

  /** GET /lorebooks/{id} — one book with its nested entries. */
  async getLorebook(id: string): Promise<LorebookWithEntriesDTO> {
    return apiRequest<LorebookWithEntriesDTO>(`/lorebooks/${encodeURIComponent(id)}`);
  },

  /**
   * POST /lorebooks. `payload.id`, when a genuine UUID, is honored as the
   * row's actual primary key (idempotent on retry — 200 with the existing
   * row rather than a 409 — see create_lorebook's docstring in
   * app/routers/lorebooks.py); apiRequest treats 200 and 201 identically,
   * so no special-casing is needed here for the idempotent-retry status.
   */
  async createLorebook(payload: Record<string, unknown>): Promise<LorebookDTO> {
    return apiRequest<LorebookDTO>('/lorebooks', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  /**
   * PUT /lorebooks/{id} — full replace of name/ownerCharacterAvatar/visibility
   * (no partial-patch semantics server-side; callers must always send all
   * three). Optimistic concurrency via `payload.baseTs`; a stale write
   * throws LorebookConflictError carrying the authoritative current row
   * (apiRequest would otherwise collapse the 409 body into a useless
   * generic Error) — mirrors projectsApi.update exactly.
   */
  async updateLorebook(id: string, payload: Record<string, unknown>): Promise<LorebookDTO> {
    const token = await getCsrfToken();
    const response = await fetch(`/lorebooks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      const detail = (body?.detail ?? body) as Partial<LorebookConflict>;
      throw new LorebookConflictError({
        error: typeof detail?.error === 'string' ? detail.error : 'conflict',
        current_ts: typeof detail?.current_ts === 'number' ? detail.current_ts : 0,
        current: (detail?.current as LorebookDTO | undefined) ?? null,
      });
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error || err?.detail || err?.message || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /** DELETE /lorebooks/{id} — idempotent (a not-found/not-owned id still 204s). */
  async deleteLorebook(id: string): Promise<void> {
    await apiRequest<Record<string, never>>(`/lorebooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /** POST /lorebooks/{id}/entries — same client-id / idempotent-retry contract as createLorebook. */
  async createLorebookEntry(
    lorebookId: string,
    payload: Record<string, unknown>
  ): Promise<LorebookEntryDTO> {
    return apiRequest<LorebookEntryDTO>(
      `/lorebooks/${encodeURIComponent(lorebookId)}/entries`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
  },

  /**
   * PUT /lorebooks/{id}/entries/{entry_id} — full replace of the entry's
   * ~19 extra-JSONB fields (callers must send the complete WorldInfoEntry
   * shape, not a partial patch). Same 409 handling as updateLorebook.
   */
  async updateLorebookEntry(
    lorebookId: string,
    entryId: string,
    payload: Record<string, unknown>
  ): Promise<LorebookEntryDTO> {
    const token = await getCsrfToken();
    const response = await fetch(
      `/lorebooks/${encodeURIComponent(lorebookId)}/entries/${encodeURIComponent(entryId)}`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
        },
        body: JSON.stringify(payload),
      }
    );

    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      const detail = (body?.detail ?? body) as Partial<LorebookEntryConflict>;
      throw new LorebookEntryConflictError({
        error: typeof detail?.error === 'string' ? detail.error : 'conflict',
        current_ts: typeof detail?.current_ts === 'number' ? detail.current_ts : 0,
        current: (detail?.current as LorebookEntryDTO | undefined) ?? null,
      });
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error || err?.detail || err?.message || `HTTP ${response.status}`);
    }
    return response.json();
  },

  /** DELETE /lorebooks/{id}/entries/{entry_id} — idempotent. */
  async deleteLorebookEntry(lorebookId: string, entryId: string): Promise<void> {
    await apiRequest<Record<string, never>>(
      `/lorebooks/${encodeURIComponent(lorebookId)}/entries/${encodeURIComponent(entryId)}`,
      { method: 'DELETE' }
    );
  },

  /**
   * POST /lorebooks/search — ranked hybrid (keyword+semantic+FTS) search
   * over the caller's own visible lorebook entries. Unlike every other
   * lorebook call above, this makes a REAL, non-free OpenAI embeddings
   * call server-side per request (see `_embed_search_query` in
   * app/routers/lorebooks.py) — never call this on every keystroke; gate
   * it behind an explicit, deliberate trigger. Throws (via apiRequest) on
   * any failure, including a 400 when the caller has no OpenAI embeddings
   * key configured at all — callers should treat that as "the feature
   * quietly isn't available right now", not an error worth surfacing
   * loudly, since search is advisory, never required.
   */
  async searchLorebooks(
    query: string,
    opts?: { lorebookIds?: string[]; limit?: number; minScore?: number }
  ): Promise<LorebookSearchHit[]> {
    const result = await apiRequest<{ hits: LorebookSearchHit[] }>('/lorebooks/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        ...(opts?.lorebookIds ? { lorebookIds: opts.lorebookIds } : {}),
        ...(opts?.limit ? { limit: opts.limit } : {}),
        ...(opts?.minScore !== undefined ? { minScore: opts.minScore } : {}),
      }),
    });
    return Array.isArray(result?.hits) ? result.hits : [];
  },

  // -----------------------------------------------------------------
  // Retrieval (server-side lore activation — Phase 2 activation-engine
  // parity, see ggbc-backend's app/routers/retrieval.py). Consumed by
  // src/utils/serverRetrieval.ts, never directly by chatStore.ts.
  // -----------------------------------------------------------------

  /**
   * POST /retrieval/context — pure read, never advances timed-effect state.
   * `entries` is deliberately loosely typed (RetrievalContextEntryDTO):
   * same reasoning as SharedWorldInfoBookDTO above — the caller
   * (serverRetrieval.ts) normalizes into WorldInfoEntry/MatchedEntry;
   * client.ts must not import store types.
   */
  async getRetrievalContext(
    characterAvatar: string,
    fileName: string,
    budgetTokens: number,
    signal?: AbortSignal,
  ): Promise<RetrievalContextDTO> {
    return apiRequest<RetrievalContextDTO>('/retrieval/context', {
      method: 'POST',
      body: JSON.stringify({ characterAvatar, fileName, budgetTokens }),
      signal,
    });
  },

  /**
   * POST /retrieval/context/commit — the only call allowed to advance
   * server-side timed-effect state. Fire-and-forget: 204 No Content, no
   * response body (apiRequest's empty-text branch returns {} as T).
   */
  async commitRetrievalContext(
    characterAvatar: string,
    fileName: string,
    turnNo: number,
    activatedEntryIds: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await apiRequest<unknown>('/retrieval/context/commit', {
      method: 'POST',
      body: JSON.stringify({ characterAvatar, fileName, turnNo, activatedEntryIds }),
      signal,
    });
  },

  /**
   * POST /retrieval/messages — Phase 2 chat-history message recall (see
   * ggbc-backend's app/routers/retrieval.py). Pure read from the caller's
   * point of view. `boundaryId` is the ggbc_id (ChatMessage.id) of the
   * oldest message in the caller's kept raw tail — see
   * src/utils/ragBoundary.ts's computeRagBoundary for how it's derived.
   */
  async getRetrievalMessages(
    characterAvatar: string,
    fileName: string,
    query: string,
    k: number,
    boundaryId: string | null,
    signal?: AbortSignal,
  ): Promise<RetrievalMessagesDTO> {
    return apiRequest<RetrievalMessagesDTO>('/retrieval/messages', {
      method: 'POST',
      body: JSON.stringify({
        characterAvatar,
        fileName,
        query,
        k,
        ...(boundaryId !== null ? { boundaryId } : {}),
      }),
      signal,
    });
  },

  /**
   * POST /retrieval/messages/ensure — enable-time backfill trigger:
   * enqueues a 'chat' embedding job for every chat the caller owns.
   * Meant to be called once per session (session-guarded by the caller,
   * see chatHistoryRagStore.ts), not on every generation turn.
   */
  async ensureMessageEmbeddings(signal?: AbortSignal): Promise<{ queued: number }> {
    return apiRequest<{ queued: number }>('/retrieval/messages/ensure', {
      method: 'POST',
      signal,
    });
  },

  /**
   * GET /retrieval/messages/status — {embedded, pending, failed} counts
   * across every chat the caller owns. Backs the chat-memory section's
   * indexing indicator (EmbeddingsKeySettings.tsx; replaces the old
   * client-side embeddingsByChat counter, which only ever reflected the
   * current session's in-memory cache). `failed` surfaces worker outcomes
   * (typically a missing/invalid OpenAI key) that the old client-side
   * path left silent.
   */
  async getMessageEmbeddingsStatus(): Promise<{ embedded: number; pending: number; failed: number }> {
    return apiRequest<{ embedded: number; pending: number; failed: number }>(
      '/retrieval/messages/status',
      { method: 'GET' }
    );
  },

  /**
   * POST /embeddings/retry-mine — re-enqueues an embedding job for every
   * caller-owned lorebook entry with no embedding (or one produced by a
   * different model than the caller's currently-resolved provider). The
   * self-service half of "I just added a key, now embed my existing
   * lore" — the write-time hooks only fire on content changes, so rows
   * that failed while keyless stay unsearchable without this. Idempotent
   * server-side; safe to call repeatedly.
   */
  async retryMyEmbeddings(): Promise<{ queued: number }> {
    return apiRequest<{ queued: number }>('/embeddings/retry-mine', {
      method: 'POST',
    });
  },

  // -----------------------------------------------------------------
  // One-time migration helpers (session-scoped guards live in
  // serverRetrieval.ts, not here — this file only wraps the wire calls).
  // -----------------------------------------------------------------

  /**
   * POST /lorebooks/import-from-blob — migrates the caller's legacy
   * stm_worldinfo blob into native lorebook tables. Deliberately NO
   * request body: the endpoint reads the caller's own stored blob
   * server-side (a client-POSTed body would be rejected — LorebookImportIn
   * uses extra="forbid"). Idempotent: already-imported books are skipped,
   * never duplicated — safe to call repeatedly.
   */
  async importLorebooksFromBlob(signal?: AbortSignal): Promise<{
    imported: string[];
    skipped: string[];
    entry_count: number;
  }> {
    return apiRequest('/lorebooks/import-from-blob', { method: 'POST', signal });
  },

  /**
   * POST /lorebooks/import-from-databank — migrates the caller's legacy
   * stm_data_bank blob (Data Bank documents) into native lorebooks, one
   * semantic-only entry per chunk. Same no-body / server-reads-its-own-blob
   * contract as importLorebooksFromBlob. Idempotent across separate calls
   * (an already-migrated document is skipped); a same-name collision
   * WITHIN one call gets a numbered suffix rather than being dropped — see
   * the endpoint's own docstring. Returns the created lorebook ids (not
   * just names) so the caller can build its own "which of my books came
   * from Data Bank" registry.
   */
  async importFromDatabank(signal?: AbortSignal): Promise<{
    imported: Array<{ name: string; lorebook_id: string }>;
    skipped: string[];
    entry_count: number;
  }> {
    return apiRequest('/lorebooks/import-from-databank', { method: 'POST', signal });
  },

  /**
   * POST /chats/wi-timers/import — one-time migration of one chat's local
   * WI timer blob (loadWiTimers(chatFile)'s return shape) into
   * lorebook_entry_timed_state. NOTE: unlike the /retrieval/* endpoints
   * above, this body is plain snake_case on the wire (WiTimersImportIn has
   * no camelCase aliases — confirmed by reading app/schemas/chat.py) —
   * matching every other /chats/* endpoint's existing convention in this
   * file (see getChats/getChatWithHeader above), not the aliased
   * convention the newer /retrieval/* and /lorebooks/* routes use.
   * GREATEST-guarded upsert server-side — idempotent, safe to retry.
   */
  async importWiTimers(
    characterAvatar: string,
    fileName: string,
    timers: Record<string, number>,
    signal?: AbortSignal,
  ): Promise<{ updated: number }> {
    return apiRequest('/chats/wi-timers/import', {
      method: 'POST',
      body: JSON.stringify({
        character_avatar: characterAvatar,
        file_name: fileName,
        timers,
      }),
      signal,
    });
  },

  // -----------------------------------------------------------------
  // Chat endpoints — B2: ggbc-backend's /chats (Postgres-backed).
  // ST-style POST-with-body shape preserved so the store wiring above
  // didn't need to change. First call per user lazy-imports from ST.
  // -----------------------------------------------------------------
  async getChats(avatarUrl: string): Promise<{ file_name: string; message_count: number; last_mes: string }[]> {
    const list = await apiRequest<{ file_name: string; message_count: number; last_mes: string }[]>(
      '/chats/list',
      { method: 'POST', body: JSON.stringify({ character_avatar: avatarUrl }) },
    );
    let rows = Array.isArray(list) ? list : [];
    if (rows.length === 0) {
      // Lazy migration. Server-side it's a no-op once any chat row
      // exists for the user; subsequent calls return the count cheaply.
      try {
        await apiRequest('/chats/import-from-st', { method: 'POST' });
      } catch {
        // ignore — surface empty list
      }
      const after = await apiRequest<{ file_name: string; message_count: number; last_mes: string }[]>(
        '/chats/list',
        { method: 'POST', body: JSON.stringify({ character_avatar: avatarUrl }) },
      );
      rows = Array.isArray(after) ? after : [];
    }
    return rows;
  },

  async getChatMessages(
    avatarUrl: string,
    fileName: string
  ): Promise<{ messages: ChatMessage[]; server_ts: number }> {
    const { messages, server_ts } = await api.getChatWithHeader(avatarUrl, fileName);
    return { messages, server_ts };
  },

  // Header-preserving variant of getChatMessages. The header element
  // ({ user_name, character_name, create_date, ... } at index 0) isn't a
  // displayed message and is skipped by getChatMessages to match legacy ST
  // behavior — but it also carries chat-level metadata (author_note,
  // wi_fired telemetry) that some callers need to read back rather than
  // rebuild from scratch. server_ts is the optimistic-concurrency token the
  // caller must echo back as base_ts on the next save.
  async getChatWithHeader(
    avatarUrl: string,
    fileName: string
  ): Promise<{
    header: Record<string, unknown> | null;
    messages: ChatMessage[];
    server_ts: number;
  }> {
    const response = await apiRequest<{ messages: ChatMessage[]; server_ts: number }>(
      '/chats/get',
      {
        method: 'POST',
        body: JSON.stringify({
          character_avatar: avatarUrl,
          file_name: fileName,
        }),
      }
    );
    const raw = response?.messages;
    const arr = Array.isArray(raw) ? raw : [];
    const head = arr[0];
    return {
      header:
        head && typeof head === 'object' && !Array.isArray(head)
          ? (head as unknown as Record<string, unknown>)
          : null,
      messages: arr.slice(1),
      server_ts: typeof response?.server_ts === 'number' ? response.server_ts : 0,
    };
  },

  // Generate message with full context
  async generateMessage(
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
    _characterName: string,
    provider?: string,
    model?: string,
    signal?: AbortSignal,
    generationOptions?: GenerationOptions,
    images?: GenerationImage[],
    /** Phase 10.3: when true, send as text completion (single prompt string). */
    textCompletionMode?: boolean,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const token = await getCsrfToken();

    // Phase 6.1: when the caller passed images, fold them into the LAST
    // user message as OpenAI-style content parts. The SillyTavern backend
    // at /api/backends/chat-completions/generate translates these to
    // each provider's native multimodal format (Claude: base64 source,
    // Gemini: inline_data parts), so we only need to emit one shape here.
    let messagesToSend: unknown[] = messages;
    if (images && images.length > 0) {
      const lastUserIdx = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') return i;
        }
        return -1;
      })();
      if (lastUserIdx >= 0) {
        const target = messages[lastUserIdx];
        const parts: Array<Record<string, unknown>> = [];
        if (target.content) {
          parts.push({ type: 'text', text: target.content });
        }
        for (const img of images) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mimeType};base64,${img.base64}`,
            },
          });
        }
        messagesToSend = messages.map((m, i) =>
          i === lastUserIdx ? { role: m.role, content: parts } : m
        );
      }
    }

    // Build request body with optional sampler params.
    // Unknown fields are ignored by most providers — except newer models that
    // 400 on samplers like `temperature`, which we omit entirely for them.
    const omitSamplers = modelRejectsSamplers(model);
    const body: Record<string, unknown> = {
      stream: true,
      max_tokens: generationOptions?.maxTokens ?? 1024,
      model: model || 'gpt-4o',
    };
    if (!omitSamplers) {
      body.temperature = generationOptions?.temperature ?? 0.9;
    }

    // Phase 10.3: text completion mode sends a single prompt string
    // to a separate backend endpoint.
    let endpoint: string;
    if (textCompletionMode) {
      // In text-completion mode, instruct mode has already flattened
      // messages into a single user message containing the full prompt.
      const prompt = messages.length === 1
        ? messages[0].content
        : messages.map(m => m.content).join('\n');
      body.prompt = prompt;
      endpoint = '/api/backends/text-completions/generate';
    } else {
      body.messages = messagesToSend;
      body.chat_completion_source = provider || 'openai';
      endpoint = '/api/backends/chat-completions/generate';
    }
    // B3a — ggbc-backend's generation proxy is stateless wrt. settings
    // (unlike ST, which looked up custom_url server-side). For
    // chat_completion_source=custom we have to thread the URL through
    // the request body so the proxy knows where to forward.
    if ((body.chat_completion_source || provider) === 'custom') {
      try {
        // Lazy import keeps a circular dependency from forming between
        // api/client.ts and stores/settingsStore.ts at module load.
        const { useSettingsStore } = await import('../stores/settingsStore');
        // A per-call override wins: a saved profile carries its own
        // endpoint, and falling through to the store would send the
        // request to whatever the user last selected instead.
        const customUrl =
          generationOptions?.customUrl || useSettingsStore.getState().customUrl;
        if (customUrl) body.custom_url = customUrl;
      } catch {
        // Best effort; the backend will surface a clear 400 if missing.
      }
    }

    // Sampler params — skipped for models that reject them (see omitSamplers).
    if (generationOptions && !omitSamplers) {
      if (generationOptions.topP !== undefined) body.top_p = generationOptions.topP;
      if (generationOptions.topK !== undefined && generationOptions.topK > 0) {
        body.top_k = generationOptions.topK;
      }
      if (generationOptions.minP !== undefined && generationOptions.minP > 0) {
        body.min_p = generationOptions.minP;
      }
      if (generationOptions.frequencyPenalty !== undefined) {
        body.frequency_penalty = generationOptions.frequencyPenalty;
      }
      if (generationOptions.presencePenalty !== undefined) {
        body.presence_penalty = generationOptions.presencePenalty;
      }
      if (generationOptions.repetitionPenalty !== undefined && generationOptions.repetitionPenalty !== 1.0) {
        body.repetition_penalty = generationOptions.repetitionPenalty;
      }
    }

    // Stop strings aren't samplers and are accepted even by models that reject
    // temperature/top_p, so honor them regardless.
    if (generationOptions?.stopStrings && generationOptions.stopStrings.length > 0) {
      body.stop = generationOptions.stopStrings;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      credentials: 'include',
      signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Generation failed' }));
      // Handle various SillyTavern error formats
      const errorMessage =
        typeof errorData.error === 'string'
          ? errorData.error
          : errorData.message ||
            errorData.error?.message ||
            (errorData.error === true ? 'AI generation failed - check API key configuration' : `HTTP ${response.status}`);
      throw new Error(errorMessage);
    }

    return response.body;
  },

  // Save chat to backend (upsert — creates row on first call, replaces
  // messages on subsequent calls).
  //
  // `baseTs` is the server_ts the client last observed (from getChatMessages
  // or a prior saveChat). The backend rejects the write with 409 if it doesn't
  // match the stored token (a stale/out-of-order save) so a newer message tail
  // can't be clobbered. Pass null/undefined for an unconditional first save.
  //
  // `allowTruncate` must be set when the new array is intentionally shorter
  // than the stored one (delete / edit-and-regenerate / branch reset);
  // otherwise the backend treats a shrinking array as a stale-save race and
  // rejects it.
  //
  // Returns the new server_ts on success; throws ChatConflictError on 409.
  async saveChat(
    avatarUrl: string,
    fileName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chatData: any[],
    baseTs?: number | null,
    allowTruncate = false
  ): Promise<{ server_ts: number }> {
    const token = await getCsrfToken();
    const response = await fetch('/chats/save', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({
        character_avatar: avatarUrl,
        file_name: fileName,
        messages: chatData,
        ...(typeof baseTs === 'number' ? { base_ts: baseTs } : {}),
        ...(allowTruncate ? { allow_truncate: true } : {}),
      }),
    });

    if (response.status === 409) {
      // FastAPI nests the model under `detail`.
      const body = await response.json().catch(() => ({}));
      const detail = (body?.detail ?? body) as Partial<ChatConflict>;
      throw new ChatConflictError({
        error: typeof detail?.error === 'string' ? detail.error : 'conflict',
        current_ts: typeof detail?.current_ts === 'number' ? detail.current_ts : 0,
        current_messages: Array.isArray(detail?.current_messages)
          ? detail.current_messages
          : [],
      });
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error || err?.message || `HTTP ${response.status}`);
    }

    const out = (await response.json().catch(() => ({}))) as { server_ts?: number };
    return { server_ts: typeof out.server_ts === 'number' ? out.server_ts : 0 };
  },

  /**
   * Generate a chat file name. Client-side: the backend creates the row
   * lazily on the first save, so a "create" round-trip would be wasted.
   * Format matches ST's convention so existing chats round-trip cleanly
   * when displayed in the UI.
   */
  async createChat(characterName: string): Promise<string> {
    const timestamp = Date.now();
    const fileName = `${characterName} - ${new Date(timestamp).toISOString().split('T')[0]}@${timestamp}`;
    return fileName;
  },

  async deleteChat(avatarUrl: string, fileName: string): Promise<void> {
    // Always-204 from the backend; treat any thrown error as a real
    // failure rather than silently swallowing.
    await fetch('/chats/delete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character_avatar: avatarUrl,
        file_name: fileName,
      }),
    }).then(async (r) => {
      if (!r.ok && r.status !== 204) {
        throw new Error(await r.text().catch(() => `HTTP ${r.status}`));
      }
    });
  },

  async renameChat(avatarUrl: string, originalFile: string, renamedFile: string): Promise<string> {
    const result = await apiRequest<{ file_name: string }>('/chats/rename', {
      method: 'POST',
      body: JSON.stringify({
        character_avatar: avatarUrl,
        original_file: originalFile,
        renamed_file: renamedFile,
      }),
    });
    return result.file_name;
  },

  /**
   * Import a chat from a JSONL or JSON file uploaded by the user. Parsed
   * client-side and persisted via /chats/save — no separate server
   * import endpoint needed now that storage is just a row write.
   */
  async importChat(
    avatarUrl: string,
    characterName: string,
    file: File,
    userName = 'User'
  ): Promise<string[]> {
    const text = await file.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messages: any[];
    if (file.name.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(text);
      messages = Array.isArray(parsed) ? parsed : (parsed?.messages ?? []);
    } else {
      // .jsonl — one JSON object per line.
      messages = text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Import failed: invalid format');
    }
    // Ensure a header is present so list/preview helpers behave the same
    // as natively-saved chats.
    if (!messages[0]?.user_name && !messages[0]?.character_name) {
      messages.unshift({
        user_name: userName,
        character_name: characterName,
        create_date: new Date().toISOString(),
      });
    }
    const ts = Date.now();
    const fileName = `${characterName} - imported@${ts}`;
    await apiRequest('/chats/save', {
      method: 'POST',
      body: JSON.stringify({
        character_avatar: avatarUrl,
        file_name: fileName,
        messages,
      }),
    });
    return [fileName];
  },
};

interface ChatMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  send_date: number;
  character_avatar?: string; // For group chats
  /** ST extension bag; carries extra.ggbc_id (permanent message identity)
   *  plus images/videos/usage. Passed through opaquely by this client. */
  extra?: Record<string, unknown>;
}

// Admin user management types
export interface AdminUserInfo {
  handle: string;
  name: string;
  avatar: string;
  /** @deprecated Shim derived from groupId. Use `permissions` instead. */
  admin: boolean;
  /** @deprecated Shim derived from groupId. Use `permissions` instead. */
  role: import('../types').UserRole;
  /** Current permission group id. */
  groupId: string | null;
  /** Resolved permission list. */
  permissions?: import('../types').Permission[];
  enabled: boolean;
  created?: number;
  password: boolean;
}

export const adminApi = {
  async getUsers(): Promise<AdminUserInfo[]> {
    return apiRequest('/api/users/get', { method: 'POST' });
  },

  /**
   * @deprecated Use `setUserGroup` instead. Kept so older UI code that still
   *   reads the role dropdown keeps working while the UI is being migrated.
   */
  async setRole(handle: string, role: import('../types').UserRole): Promise<void> {
    await apiRequest('/api/users/set-role', {
      method: 'POST',
      body: JSON.stringify({ handle, role }),
    });
  },

  /** Assigns `handle` to a permission group. */
  async setUserGroup(handle: string, groupId: string): Promise<void> {
    await apiRequest('/api/users/set-group', {
      method: 'POST',
      body: JSON.stringify({ handle, groupId }),
    });
  },

  async enableUser(handle: string): Promise<void> {
    await apiRequest('/api/users/enable', {
      method: 'POST',
      body: JSON.stringify({ handle }),
    });
  },

  async disableUser(handle: string): Promise<void> {
    await apiRequest('/api/users/disable', {
      method: 'POST',
      body: JSON.stringify({ handle }),
    });
  },

  async deleteUser(handle: string, purge = false): Promise<void> {
    await apiRequest('/api/users/delete', {
      method: 'POST',
      body: JSON.stringify({ handle, purge }),
    });
  },
};

// Permission groups API
export const permissionGroupsApi = {
  /** List every permission group (id, name, perms, etc.). */
  async list(): Promise<import('../types').PermissionGroup[]> {
    return apiRequest('/api/permission-groups', { method: 'GET' });
  },

  /** Fetch the master permission vocabulary, grouped by category. */
  async getVocabulary(): Promise<{
    permissions: import('../types').Permission[];
    categories: Record<string, import('../types').Permission[]>;
  }> {
    return apiRequest('/api/permissions', { method: 'GET' });
  },

  async create(input: {
    name: string;
    description: string;
    permissions: import('../types').Permission[];
  }): Promise<import('../types').PermissionGroup> {
    return apiRequest('/api/permission-groups/create', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async update(
    id: string,
    patch: {
      name?: string;
      description?: string;
      permissions?: import('../types').Permission[];
    },
  ): Promise<import('../types').PermissionGroup> {
    return apiRequest('/api/permission-groups/update', {
      method: 'POST',
      body: JSON.stringify({ id, ...patch }),
    });
  },

  async delete(id: string): Promise<void> {
    await apiRequest('/api/permission-groups/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  },
};

// Invitation types
export interface Invitation {
  id: string;
  token: string;
  /** Permission group id to assign on accept. */
  groupId: string;
  /** @deprecated Shim derived from groupId. */
  role?: import('../types').UserRole;
  label: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
  status: 'pending' | 'accepted' | 'revoked';
}

/** ggbc-backend response shape for a single invitation. */
interface BackendInvitation {
  id: string;
  token: string;
  role: import('../types').UserRole;
  created_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_by_id: string;
}

function mapInvitation(invite: BackendInvitation): Invitation {
  let status: Invitation['status'] = 'pending';
  if (invite.revoked_at) status = 'revoked';
  else if (invite.accepted_at) status = 'accepted';
  return {
    id: invite.id,
    token: invite.token,
    groupId: roleToGroupId(invite.role),
    role: invite.role,
    label: '',
    createdBy: invite.created_by_id,
    createdAt: new Date(invite.created_at).getTime(),
    expiresAt: invite.expires_at ? new Date(invite.expires_at).getTime() : null,
    usedBy: null,
    usedAt: invite.accepted_at ? new Date(invite.accepted_at).getTime() : null,
    status,
  };
}

export const invitationsApi = {
  async create(groupId: string, _label?: string, expiresIn?: number): Promise<Invitation> {
    // Frontend has historically taken expiresIn in hours; ggbc-backend takes
    // expires_in_days. Round up so callers asking for "1 hour" still get an
    // invite valid for at least a day.
    const expiresInDays = expiresIn ? Math.max(1, Math.ceil(expiresIn / 24)) : undefined;
    const invite = await apiRequest<BackendInvitation>('/invitations', {
      method: 'POST',
      body: JSON.stringify({
        role: groupIdToRole(groupId),
        expires_in_days: expiresInDays,
      }),
    });
    return mapInvitation(invite);
  },

  async list(): Promise<Invitation[]> {
    const invites = await apiRequest<BackendInvitation[]>('/invitations');
    return invites.map(mapInvitation);
  },

  async revoke(id: string): Promise<Invitation> {
    await apiRequest(`/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    // ggbc-backend returns 204 — fetch the updated row from the list.
    const invites = await this.list();
    const revoked = invites.find((i) => i.id === id);
    if (!revoked) throw new Error('invitation disappeared after revoke');
    return revoked;
  },

  async delete(id: string): Promise<void> {
    // ggbc-backend doesn't expose hard-delete; revoked invites stay in the
    // table for audit. Treat as a no-op for the UI.
    void id;
  },

  async validate(token: string): Promise<{
    valid: boolean;
    groupId?: string;
    groupName?: string;
    role?: string;
    label?: string;
    error?: string;
  }> {
    const result = await apiRequest<{
      valid: boolean;
      role: import('../types').UserRole | null;
      expires_at: string | null;
    }>(`/invitations/validate/${encodeURIComponent(token)}`);
    if (!result.valid || !result.role) return { valid: false };
    return {
      valid: true,
      role: result.role,
      groupId: roleToGroupId(result.role),
      groupName: result.role,
    };
  },

  async accept(token: string, handle: string, name: string, password?: string): Promise<{ handle: string }> {
    // ggbc-backend rolls invitation acceptance into /auth/register.
    return api.register(handle, name, password, token);
  },
};

// Settings types
export interface SecretState {
  id: string;
  label: string;
  active: boolean;
  // value is masked - only last 3 chars shown
}

export interface SecretsResponse {
  [key: string]: SecretState[] | boolean;
}

export const SECRET_KEYS = {
  OPENAI: 'api_key_openai',
  // Data Bank / RAG embeddings. Resolved server-side by the embeddings proxy,
  // which falls back to OPENAI when this isn't set. Never stored in the browser.
  OPENAI_EMBEDDINGS: 'api_key_openai_embeddings',
  CLAUDE: 'api_key_claude',
  GOOGLE: 'api_key_makersuite',
  MISTRAL: 'api_key_mistralai',
  GROQ: 'api_key_groq',
  OPENROUTER: 'api_key_openrouter',
  // Phase 10.2
  COHERE: 'api_key_cohere',
  DEEPSEEK: 'api_key_deepseek',
  PERPLEXITY: 'api_key_perplexity',
  // Phase 10.4 — additional native-routed providers added via the provider catalog.
  XAI: 'api_key_xai',
  AI21: 'api_key_ai21',
  VERTEXAI: 'api_key_vertexai',
  ZEROONEAI: 'api_key_01ai',
  MOONSHOT: 'api_key_moonshot',
  ZHIPU: 'api_key_zhipu',
  NANOGPT: 'api_key_nanogpt',
  BLOCKENTROPY: 'api_key_blockentropy',
  POLLINATIONS: 'api_key_pollinations',
  AIMLAPI: 'api_key_aimlapi',
  ELECTRONHUB: 'api_key_electronhub',
  // Used by the 'custom' chat_completion_source when a user-added provider is active.
  CUSTOM: 'api_key_custom',
} as const;

// PROVIDERS is kept as a getter re-exported from providerCatalog so call sites
// that iterate over `PROVIDERS` (e.g. the global-keys section in
// AISettingsPage) see the full list of native-routed providers without
// caring about the user-added ones. The `custom` entry is appended so the
// existing "Custom / Local" selection path keeps working.
//
// For the full merged list (built-in catalog + user providers), import
// BUILTIN_CATALOG from providerCatalog directly.
import { NATIVE_PROVIDERS as CATALOG_NATIVE_PROVIDERS } from './providerCatalog';
import type { AvatarSource } from '../utils/avatarProvenance';

export const PROVIDERS = [
  ...CATALOG_NATIVE_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    secretKey: p.secretKey,
    models: p.defaultModels as readonly string[],
  })),
  // Custom / local: no secret key required; URL and model are stored directly in oai_settings.
  { id: 'custom', name: 'Custom / Local', secretKey: '', models: [] as readonly string[] },
] as const;

export const settingsApi = {
  // Get current secrets state (masked)
  async getSecrets(): Promise<SecretsResponse> {
    return apiRequest('/api/secrets/read', { method: 'POST' });
  },

  // Write/update a secret
  async writeSecret(key: string, value: string, label?: string): Promise<void> {
    await apiRequest('/api/secrets/write', {
      method: 'POST',
      body: JSON.stringify({ key, value, label }),
    });
  },

  // Delete a secret
  async deleteSecret(key: string, id?: string): Promise<void> {
    await apiRequest('/api/secrets/delete', {
      method: 'POST',
      body: JSON.stringify({ key, id }),
    });
  },

  // Get user settings
  async getSettings(): Promise<{ settings: Record<string, unknown> }> {
    return apiRequest('/api/settings/get', { method: 'POST' });
  },

  // Save user settings
  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    await apiRequest('/api/settings/save', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  },

  // --- Global secrets (owner-managed, shared with all users) ---

  async getGlobalSecrets(): Promise<SecretsResponse> {
    try {
      return await apiRequest('/api/secrets/global/read', { method: 'POST' });
    } catch {
      return {};
    }
  },

  async writeGlobalSecret(key: string, value: string, label?: string): Promise<void> {
    await apiRequest('/api/secrets/global/write', {
      method: 'POST',
      body: JSON.stringify({ key, value, label }),
    });
  },

  async deleteGlobalSecret(key: string, id?: string): Promise<void> {
    await apiRequest('/api/secrets/global/delete', {
      method: 'POST',
      body: JSON.stringify({ key, id }),
    });
  },

  async getGlobalSharingStatus(): Promise<{ enabled: boolean }> {
    try {
      return await apiRequest('/api/secrets/global/status', { method: 'POST' });
    } catch {
      return { enabled: false };
    }
  },

  async setGlobalSharing(enabled: boolean): Promise<void> {
    await apiRequest('/api/secrets/global/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  // ---------------------------------------------------------------------
  // Provider catalog — backend helper for docs-URL extraction (Phase 10.4).
  //
  // The backend endpoint is served from the sammygallo/sillytavern fork.
  // On backends that don't have the route yet, this throws a 404 and the
  // caller should feature-detect and hide the AI mode in the UI.
  // ---------------------------------------------------------------------

  async extractProviderFromUrl(
    url: string,
  ): Promise<{ ok: true; provider: ExtractedProvider } | { ok: false; error: string }> {
    try {
      const response = await apiRequest<{ ok?: boolean; provider?: ExtractedProvider; error?: string }>(
        '/api/providers/extract',
        {
          method: 'POST',
          body: JSON.stringify({ url }),
        },
      );
      if (response.ok && response.provider) {
        return { ok: true, provider: response.provider };
      }
      return { ok: false, error: response.error || 'Extraction failed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  },

  /** Probe whether the /api/providers/extract helper endpoint exists. */
  async providerExtractorSupported(): Promise<boolean> {
    try {
      // Cheap GET-style probe: a HEAD request against the POST route returns
      // 405 (Method Not Allowed) if the route exists, 404 if it doesn't.
      const token = await getCsrfToken();
      const res = await fetch('/api/providers/extract', {
        method: 'OPTIONS',
        headers: { 'X-CSRF-Token': token },
        credentials: 'include',
      });
      return res.status !== 404;
    } catch {
      return false;
    }
  },
};

/** Shape returned by /api/providers/extract. Mirror of UserProvider from providerCatalog. */
export interface ExtractedProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModels: string[];
  modelListEndpoint?: string;
  docsUrl?: string;
  description?: string;
}

// Sprites/Expressions API
export interface SpriteInfo {
  label: string;
  path: string;
}

export const spritesApi = {
  // Get all sprites for a character
  async getSprites(characterName: string): Promise<SpriteInfo[]> {
    return apiRequest(`/api/sprites/get?name=${encodeURIComponent(characterName)}`, {
      method: 'GET',
    });
  },

  // Upload a single sprite
  async uploadSprite(characterName: string, label: string, file: File): Promise<{ ok: boolean }> {
    const token = await getCsrfToken();
    const formData = new FormData();
    // Field names must match what SillyTavern server expects:
    // - 'name': character/folder name
    // - 'label': expression label (e.g., 'joy', 'sadness')
    // - 'avatar': the image file (NOT 'file')
    formData.append('name', characterName);
    formData.append('label', label);
    formData.append('avatar', file);

    console.log('[Sprites] Uploading:', { characterName, label, fileName: file.name });

    const response = await fetch('/api/sprites/upload', {
      method: 'POST',
      headers: {
        'X-CSRF-Token': token,
      },
      credentials: 'include',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Sprites] Upload failed:', { status: response.status, error: errorText });
      throw new Error(`Failed to upload sprite: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log('[Sprites] Upload success:', result);
    return result;
  },

  // Delete a sprite
  async deleteSprite(characterName: string, label: string): Promise<void> {
    await apiRequest('/api/sprites/delete', {
      method: 'POST',
      body: JSON.stringify({ name: characterName, label }),
    });
  },
};

// ---------------------------------------------------------------------------
// Projects ("Works") — productization step 1
//
// A Project is the persistent creative workspace above chats: it groups
// chats + characters and accumulates toward a typed deliverable. Members
// are referenced by the same string identity the rest of the app keys on
// (character `avatar`; chat `(character_avatar, file_name)`), so refs can
// dangle after a delete/rename — callers reconcile against the live
// character/chat lists on display.
// ---------------------------------------------------------------------------

export type ProjectDeliverableType = 'freeform' | 'novel' | 'comic' | 'video_series';
export type ProjectStatus = 'active' | 'archived';

export interface ProjectChatRef {
  character_avatar: string;
  file_name: string;
}

export interface ProjectListItem {
  id: string;
  name: string;
  description: string;
  deliverable_type: ProjectDeliverableType;
  status: ProjectStatus;
  character_count: number;
  chat_count: number;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  deliverable_type: ProjectDeliverableType;
  status: ProjectStatus;
  characters: string[];
  chats: ProjectChatRef[];
  story_state: Record<string, unknown>;
  server_ts: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  deliverable_type?: ProjectDeliverableType;
  status?: ProjectStatus;
  characters?: string[];
  chats?: ProjectChatRef[];
  story_state?: Record<string, unknown>;
  base_ts?: number;
}

/** 409 from PATCH /projects/{id} — carries the winning state so the caller
 * can adopt it and re-apply, mirroring putSection's SectionConflictError. */
export class ProjectConflictError extends Error {
  currentTs: number;
  current: Project | null;

  constructor(currentTs: number, current: Project | null) {
    super('project write conflict');
    this.name = 'ProjectConflictError';
    this.currentTs = currentTs;
    this.current = current;
  }
}

export const projectsApi = {
  async list(): Promise<ProjectListItem[]> {
    return apiRequest<ProjectListItem[]>('/projects');
  },

  async get(id: string): Promise<Project> {
    return apiRequest<Project>(`/projects/${id}`);
  },

  async create(data: {
    name: string;
    description?: string;
    deliverable_type?: ProjectDeliverableType;
  }): Promise<Project> {
    return apiRequest<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /** PATCH with optimistic concurrency. Include `base_ts` in the patch to
   * detect cross-device races; a stale write throws ProjectConflictError
   * (apiRequest would collapse the 409 body into a useless generic Error). */
  async update(id: string, patch: ProjectPatch): Promise<Project> {
    const token = await getCsrfToken();
    const response = await fetch(`/projects/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify(patch),
    });

    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      const detail = (body?.detail ?? body) as {
        current_ts?: number;
        current?: Project;
      };
      throw new ProjectConflictError(
        typeof detail?.current_ts === 'number' ? detail.current_ts : 0,
        detail?.current ?? null
      );
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error || err?.detail || err?.message || `HTTP ${response.status}`);
    }
    return response.json();
  },

  async remove(id: string): Promise<void> {
    await apiRequest<Record<string, never>>(`/projects/${id}`, { method: 'DELETE' });
  },
};

// ---------------------------------------------------------------------------
// Story bible — productization step 2 (sub-resource of a Project)
//
// The bible is stored decomposed server-side (sections / scenes /
// append-only fact + edit logs), NOT in the legacy `story_state` blob,
// which is now frozen at `{}` and 422s on a non-empty write.
//
// Two contracts differ from the rest of this client and matter to every
// caller: section writes REQUIRE `base_ts` (0 = "should not exist yet";
// there is no unconditional-overwrite path, because five ingestion
// passes and the user write concurrently), and the log endpoints are
// append-only — re-posting a known id returns the stored row rather than
// updating it.
// ---------------------------------------------------------------------------

export interface StorySectionSummary {
  section: string;
  server_ts: number;
  bytes: number;
  updated_at: string;
}

export interface StoryManifest {
  project_id: string;
  sections: StorySectionSummary[];
  scene_count: number;
  fact_count: number;
  edit_count: number;
}

export interface StorySectionOut {
  section: string;
  data: Record<string, unknown>;
  server_ts: number;
  updated_at: string;
}

export interface StorySceneSummary {
  id: string;
  sequence: number;
  title: string;
  summary: string;
  server_ts: number;
  updated_at: string;
}

export interface StoryScenePage {
  items: StorySceneSummary[];
  /** Keyset cursor: BOTH halves must be echoed back. `sequence` alone is
   *  not unique and paging on it silently drops tied scenes. */
  next_after_sequence: number | null;
  next_after_id: string | null;
  has_more: boolean;
}

/** GET /story/scenes/full — whole scene rows rather than the list
 *  projection, for the callers that need `data` on every scene (the
 *  annotate pass, and step 3's context assembler and exporter).
 *
 *  Its own route and its own page type, not a flag on `listScenes`: a
 *  response model is per-route, so full rows returned through
 *  `StoryScenePage`'s shape would be silently stripped of `data` rather
 *  than erroring. */
export interface StoryFullScenePage {
  items: StorySceneOut[];
  next_after_sequence: number | null;
  next_after_id: string | null;
  has_more: boolean;
  /** True when the server's byte budget ended this page before its row
   *  limit did. The cursor points at the last row INCLUDED, so resuming
   *  picks up the first row the cut dropped. */
  truncated_by_bytes: boolean;
}

/** Closed vocabularies, DB CHECK + Pydantic `Literal` on the backend —
 *  a value outside these is a 422, not a silently stored string. */
export type StoryRenderFormat = 'novel' | 'screenplay';
/** A RUN's lifecycle and nothing else. Staleness is orthogonal and lives
 *  in `stale_bible`: a finished run whose bible was restored underneath it
 *  is still `complete`. */
export type StoryRenderStatus =
  | 'running'
  | 'paused'
  | 'complete'
  | 'aborted'
  | 'error';
/** One unit's outcome. `truncated` is load-bearing rather than cosmetic:
 *  prose has no parser, so a response cut at the token ceiling — or a
 *  stream that ended carrying no terminal signal at all — is
 *  indistinguishable from a finished one by its text. */
export type StoryRenderUnitStatus = 'pending' | 'complete' | 'truncated' | 'error';

export interface StoryRenderSummary {
  id: string;
  format: StoryRenderFormat;
  status: StoryRenderStatus;
  stale_bible: boolean;
  scene_id_start: string;
  scene_id_end: string;
  model: string | null;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  lock_client_id: string | null;
  lock_heartbeat_at: string | null;
  /** Derived in SQL against the DATABASE clock, never a pod's — so a
   *  client with a skewed clock cannot mis-read a live lock as stale. */
  lock_is_stale: boolean;
  unit_count: number;
  complete_unit_count: number;
  server_ts: number;
  created_at: string;
  updated_at: string;
}

export interface StoryRenderOut extends StoryRenderSummary {
  /** The hints SNAPSHOT the run was created with, resolved server-side
   *  against `narrative`'s defaults. A later hints edit therefore cannot
   *  reinterpret finished prose. */
  hints: Record<string, unknown>;
}

export interface StoryRenderUnit {
  scene_id: string;
  sequence: number;
  prose: string;
  status: StoryRenderUnitStatus;
  source_scene_ts: number;
  continuity: Record<string, unknown> | null;
  server_ts: number;
  created_at: string;
  updated_at: string;
}

export interface StoryRenderUnitSummary {
  scene_id: string;
  sequence: number;
  status: StoryRenderUnitStatus;
  source_scene_ts: number;
  prose_bytes: number;
  has_continuity: boolean;
  /** The scene still exists but has been written since this prose was
   *  rendered from it. A cosmetic retitle counts — false-stale is cheap,
   *  false-fresh is not. */
  is_stale: boolean;
  /** The scene this prose was rendered from no longer exists. */
  is_orphaned: boolean;
  server_ts: number;
  created_at: string;
  updated_at: string;
}

export interface StoryRenderPage {
  items: StoryRenderSummary[];
  next_after_created_at: string | null;
  next_after_id: string | null;
  has_more: boolean;
}

export interface StoryRenderUnitPage {
  items: StoryRenderUnitSummary[];
  next_after_sequence: number | null;
  next_after_scene_id: string | null;
  has_more: boolean;
}

export interface StoryRenderProsePage {
  items: StoryRenderUnit[];
  next_after_sequence: number | null;
  next_after_scene_id: string | null;
  has_more: boolean;
}

export interface StoryLogEntry {
  /** Per-project cursor, dense and commit-ordered. */
  seq: number;
  id: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface StoryLogPage {
  items: StoryLogEntry[];
  next_after_seq: number | null;
  has_more: boolean;
}

/** What triggered an archive snapshot (phase 9) — informational only,
 *  shown in the archive list so a reset and a source-chat change are
 *  distinguishable. `restore_backup` is the safety snapshot a restore
 *  takes of whatever it's about to overwrite. */
export type StoryArchiveReason =
  | 'reset'
  | 'change_source_chat'
  | 'reingest'
  | 'restore_backup';

/** The subset of StoryArchiveReason a client is allowed to pass to
 *  POST /story/reset. `restore_backup` is reserved for the tag a restore
 *  applies to its own safety snapshot — the backend rejects it here with
 *  a 422 (`StoryResetIn.reason` uses this same narrowed type), so this
 *  keeps a caller from mislabeling an ordinary reset that way. */
export type StoryResetReason = Exclude<StoryArchiveReason, 'restore_backup'>;

/** One row of GET /story/archives — never the snapshot payload itself,
 *  same "list is a projection" principle as StorySectionSummary. */
export interface StoryArchiveSummary {
  id: string;
  reason: StoryArchiveReason;
  source_label: string | null;
  scene_count: number;
  fact_count: number;
  edit_count: number;
  size_bytes: number;
  created_at: string;
}

/** Keyset page, newest first. The cursor is the (created_at, id) PAIR —
 *  `created_at` is not unique (a coarse clock, or two archive-producing
 *  calls in one tick), and a cursor on the non-unique half alone drops
 *  every archive tied with the one that ended the previous page. */
export interface StoryArchiveListOut {
  archives: StoryArchiveSummary[];
  next_after_created_at: string | null;
  next_after_id: string | null;
  has_more: boolean;
}

export interface StoryRestoreOut {
  sections_restored: number;
  scenes_restored: number;
  facts_restored: number;
  edits_restored: number;
  /** The safety snapshot restore took of whatever it just overwrote —
   *  null when there was nothing to protect (the bible was empty). */
  pre_restore_archive_id: string | null;
}

/** 409 from a story write — carries the winning row so the caller can
 *  adopt it and retry, mirroring ProjectConflictError. `current` is null
 *  when the loser tried to create something that doesn't exist yet. */
export class StoryConflictError extends Error {
  currentTs: number;
  current: StorySectionOut | null;

  constructor(currentTs: number, current: StorySectionOut | null) {
    super('story write conflict');
    this.name = 'StoryConflictError';
    this.currentTs = currentTs;
    this.current = current;
  }
}

/** 409 from a restore — the bible changed since the client's last
 *  manifest. Carries a FRESH manifest (not a section) since restore's
 *  guard spans the whole bible, not one row. */
export class StoryRestoreConflictError extends Error {
  current: StoryManifest | null;

  constructor(current: StoryManifest | null) {
    super('story restore conflict — the bible changed since your last view');
    this.name = 'StoryRestoreConflictError';
    this.current = current;
  }
}

/** 413 from a story write. Names the cap AND the overage, because "too
 *  big" without a number can't tell a client what to drop. */
export class StoryTooLargeError extends Error {
  capBytes: number;
  actualBytes: number;
  overBy: number;

  constructor(capBytes: number, actualBytes: number, overBy: number) {
    super(`story payload exceeds ${capBytes} bytes by ${overBy}`);
    this.name = 'StoryTooLargeError';
    this.capBytes = capBytes;
    this.actualBytes = actualBytes;
    this.overBy = overBy;
  }
}

/** 409 from POST /scenes/bulk — lists EVERY conflicting row, not just the
 *  first, since the caller (the transcript walk) is replanning a whole
 *  chunk's batch and needs every stale id in one round-trip. */
export class SceneBulkConflictError extends Error {
  conflicts: { id: string; currentTs: number }[];

  constructor(conflicts: { id: string; currentTs: number }[]) {
    super('scene bulk write conflict');
    this.name = 'SceneBulkConflictError';
    this.conflicts = conflicts;
  }
}

/**
 * Another device holds the project's render lock, LIVE (423).
 *
 * The lock is per project and across formats, so `holderRenderId` may name
 * a different run than the one the request was about — the backend says so
 * explicitly, and this type keeps that legible rather than flattening it
 * into "locked".
 *
 * `takeable` is the whole reason this is a typed error rather than a
 * message: a holder whose heartbeat has aged out still 423s, and only a
 * deliberate `takeover: true` wins. That keeps a background retry from
 * ping-ponging the lock during a network hiccup, and makes taking it a
 * decision the user makes.
 */
export class RenderLockedError extends Error {
  currentTs: number;
  holderRenderId: string | null;
  holderClientId: string | null;
  holderHeartbeatAt: string | null;
  takeable: boolean;
  retryAfterSeconds: number;
  constructor(detail: {
    current_ts?: number;
    holder_render_id?: string | null;
    holder_client_id?: string | null;
    holder_heartbeat_at?: string | null;
    takeable?: boolean;
    retry_after_seconds?: number;
  }) {
    super('render locked');
    this.name = 'RenderLockedError';
    this.currentTs = detail.current_ts ?? 0;
    this.holderRenderId = detail.holder_render_id ?? null;
    this.holderClientId = detail.holder_client_id ?? null;
    this.holderHeartbeatAt = detail.holder_heartbeat_at ?? null;
    this.takeable = detail.takeable ?? false;
    this.retryAfterSeconds = detail.retry_after_seconds ?? 0;
  }
}

async function storyWrite<T>(
  path: string,
  method: 'PUT' | 'POST' | 'DELETE',
  body: unknown
): Promise<T> {
  const token = await getCsrfToken();
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    const parsed = await response.json().catch(() => ({}));
    const detail = (parsed?.detail ?? parsed) as {
      current_ts?: number;
      current?: StorySectionOut | null;
    };
    throw new StoryConflictError(
      typeof detail?.current_ts === 'number' ? detail.current_ts : 0,
      detail?.current ?? null
    );
  }
  // 423 is the render lock, and it carries far more than "denied": who
  // holds it, whether their heartbeat aged out, and how long to wait. A
  // caller that only saw a status code could not draw the "Take over"
  // affordance the backend is describing.
  if (response.status === 423) {
    const parsed = await response.json().catch(() => ({}));
    throw new RenderLockedError((parsed?.detail ?? parsed) ?? {});
  }
  if (response.status === 413) {
    const parsed = await response.json().catch(() => ({}));
    const detail = (parsed?.detail ?? parsed) as {
      cap_bytes?: number;
      actual_bytes?: number;
      over_by?: number;
    };
    throw new StoryTooLargeError(
      detail?.cap_bytes ?? 0,
      detail?.actual_bytes ?? 0,
      detail?.over_by ?? 0
    );
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    // A 422 body carries pydantic's field errors; surface the first one
    // rather than a bare "HTTP 422" an ingestion agent can't act on.
    const fieldError = Array.isArray(err?.detail?.errors)
      ? err.detail.errors[0]?.msg
      : null;
    throw new Error(
      fieldError || err?.detail?.error || err?.detail || err?.message ||
      `HTTP ${response.status}`
    );
  }
  // DELETE /scenes/{id} answers 204 — still base_ts-guarded (hence this
  // helper and not apiRequest), but with nothing to parse.
  if (response.status === 204) return {} as T;
  return response.json();
}

/** All-or-nothing scene batch write. Distinct from `storyWrite` because a
 *  bulk 409 lists every conflicting row (`SceneBulkConflictError`), not a
 *  single current/current_ts pair — the transcript walk (phase 7) is
 *  replanning a whole chunk's batch and needs every stale id at once. */
async function sceneBulkPost(
  projectId: string,
  scenes: { id: string; data: Record<string, unknown>; base_ts: number }[]
): Promise<{ written: number; scenes: StorySceneOut[] }> {
  const token = await getCsrfToken();
  const response = await fetch(`/projects/${projectId}/story/scenes/bulk`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({ scenes }),
  });

  if (response.status === 409) {
    const parsed = await response.json().catch(() => ({}));
    const detail = (parsed?.detail ?? parsed) as {
      conflicts?: { id: string; current_ts: number }[];
    };
    throw new SceneBulkConflictError(
      (detail?.conflicts ?? []).map((c) => ({ id: c.id, currentTs: c.current_ts }))
    );
  }
  if (response.status === 413) {
    const parsed = await response.json().catch(() => ({}));
    const detail = (parsed?.detail ?? parsed) as {
      cap_bytes?: number;
      actual_bytes?: number;
      over_by?: number;
    };
    throw new StoryTooLargeError(
      detail?.cap_bytes ?? 0,
      detail?.actual_bytes ?? 0,
      detail?.over_by ?? 0
    );
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const fieldError = Array.isArray(err?.detail?.errors)
      ? err.detail.errors[0]?.msg
      : null;
    throw new Error(
      fieldError || err?.detail?.error || err?.detail || err?.message ||
      `HTTP ${response.status}`
    );
  }
  return response.json();
}

/** Runtime check for a 409 body's `current` — it crosses the network
 *  boundary as `unknown`, and a TS cast alone doesn't stop a malformed or
 *  differently-shaped error body (version skew, a proxy rewrite) from
 *  being adopted straight into store state and crashing on the next
 *  `hasBible()`/`.sections` access. Treat anything that doesn't look like
 *  a real manifest as absent rather than trusting it. */
export function isStoryManifestShape(value: unknown): value is StoryManifest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.sections) &&
    typeof v.scene_count === 'number' &&
    typeof v.fact_count === 'number' &&
    typeof v.edit_count === 'number'
  );
}

/** Restore's 409 body shape (`{error, current: StoryManifest}`) has no
 *  `current_ts`, so it can't reuse storyWrite's StoryConflictError path
 *  without lying about what "current" means. */
async function storyRestoreCall(path: string, body: unknown): Promise<StoryRestoreOut> {
  const token = await getCsrfToken();
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    const parsed = await response.json().catch(() => ({}));
    const detail = (parsed?.detail ?? parsed) as { current?: unknown };
    const current = detail?.current;
    throw new StoryRestoreConflictError(isStoryManifestShape(current) ? current : null);
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const fieldError = Array.isArray(err?.detail?.errors)
      ? err.detail.errors[0]?.msg
      : null;
    throw new Error(
      fieldError || err?.detail?.error || err?.detail || err?.message ||
      `HTTP ${response.status}`
    );
  }
  return response.json();
}

export interface StorySceneOut {
  id: string;
  sequence: number;
  data: Record<string, unknown>;
  server_ts: number;
  updated_at: string;
}

export const storyApi = {
  /** What the bible contains — sizes and counts, no payloads. Cheap
   *  enough to call on every Story-tab open. */
  async manifest(projectId: string): Promise<StoryManifest> {
    return apiRequest<StoryManifest>(`/projects/${projectId}/story`);
  },

  /** Throws (404) when the section hasn't been written yet — an empty
   *  bible is an absence of rows, not a row full of defaults. */
  async getSection(projectId: string, name: string): Promise<StorySectionOut> {
    return apiRequest<StorySectionOut>(
      `/projects/${projectId}/story/sections/${name}`
    );
  },

  async putSection(
    projectId: string,
    name: string,
    data: Record<string, unknown>,
    baseTs: number
  ): Promise<StorySectionOut> {
    return storyWrite<StorySectionOut>(
      `/projects/${projectId}/story/sections/${name}`,
      'PUT',
      { data, base_ts: baseTs }
    );
  },

  /** Throws (404) when the scene doesn't exist. Used by the transcript
   *  walk (phase 7) to reconstruct an in-progress scene's full state
   *  (sequence, summary-so-far, message range) when resuming after a
   *  closed tab — the checkpoint only carries the scene's id. */
  async getScene(projectId: string, sceneId: string): Promise<StorySceneOut> {
    return apiRequest<StorySceneOut>(
      `/projects/${projectId}/story/scenes/${sceneId}`
    );
  },

  /** All-or-nothing batch write — the transcript walk's throughput path.
   *  `baseTs: 0` creates; otherwise it must be the scene's last known
   *  `server_ts`. Throws `SceneBulkConflictError` listing every stale row
   *  on a 409, `StoryTooLargeError` on a 413. */
  async bulkWriteScenes(
    projectId: string,
    scenes: { id: string; data: Record<string, unknown>; baseTs: number }[]
  ): Promise<{ written: number; scenes: StorySceneOut[] }> {
    return sceneBulkPost(
      projectId,
      scenes.map((s) => ({ id: s.id, data: s.data, base_ts: s.baseTs }))
    );
  },

  /** Append-only: re-posting a known fact id is a no-op that returns the
   *  stored row (the walk relies on this for safe chunk retries). */
  async appendFact(
    projectId: string,
    fact: Record<string, unknown>
  ): Promise<StoryLogEntry> {
    return storyWrite<StoryLogEntry>(
      `/projects/${projectId}/story/facts`,
      'POST',
      { data: fact }
    );
  },

  /** Tombstone one fact (phase 10). No body and no base_ts: facts carry no
   *  version token, and the tombstone is idempotent so none is needed. 204
   *  whether it tombstoned the row or found it already tombstoned; 404 only
   *  when the id never existed. Deliberately NOT storyWrite — there is no
   *  409 or 413 on this route, and apiRequest already returns `{}` for a
   *  204. */
  async deleteFact(projectId: string, factId: string): Promise<void> {
    await apiRequest<Record<string, never>>(
      `/projects/${projectId}/story/facts/${factId}`,
      { method: 'DELETE' }
    );
  },

  /** Append one edit-log row. Idempotent by `data.id` exactly like
   *  appendFact, which is why callers mint the id BEFORE the POST — a
   *  transport retry then re-sends the same id instead of double-logging
   *  the same user action. */
  async appendEdit(
    projectId: string,
    edit: Record<string, unknown>
  ): Promise<StoryLogEntry> {
    return storyWrite<StoryLogEntry>(
      `/projects/${projectId}/story/edits`,
      'POST',
      { data: edit }
    );
  },

  /** Single-scene full replace. The bulk path is for a walk chunk writing
   *  many scenes at once; this is for one scene edited by hand, where a
   *  bulk 409's per-row conflict list would be noise. */
  async putScene(
    projectId: string,
    sceneId: string,
    data: Record<string, unknown>,
    baseTs: number
  ): Promise<StorySceneOut> {
    return storyWrite<StorySceneOut>(
      `/projects/${projectId}/story/scenes/${sceneId}`,
      'PUT',
      { data, base_ts: baseTs }
    );
  },

  /** Delete one scene. Carries a base_ts BODY on a DELETE verb — dropping a
   *  scene another pass just rewrote is as lossy as overwriting it, so the
   *  same CAS applies. 409 throws StoryConflictError like any other guarded
   *  write. */
  async deleteScene(
    projectId: string,
    sceneId: string,
    baseTs: number
  ): Promise<void> {
    await storyWrite<Record<string, never>>(
      `/projects/${projectId}/story/scenes/${sceneId}`,
      'DELETE',
      { base_ts: baseTs }
    );
  },

  async listScenes(
    projectId: string,
    opts: { afterSequence?: number; afterId?: string; limit?: number } = {}
  ): Promise<StoryScenePage> {
    const q = new URLSearchParams();
    if (opts.afterSequence !== undefined) {
      q.set('after_sequence', String(opts.afterSequence));
    }
    if (opts.afterId) q.set('after_id', opts.afterId);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return apiRequest<StoryScenePage>(
      `/projects/${projectId}/story/scenes${qs ? `?${qs}` : ''}`
    );
  },

  /** Whole scene rows in bulk — the N+1 killer. `listScenes` returns a
   *  SQL projection with no `data`; this returns `SceneOut` rows, under a
   *  tighter row limit (max 100) AND a server-side byte budget that can
   *  end a page early. Callers must page until `has_more` is false rather
   *  than assuming one call covers the bible. */
  async listScenesFull(
    projectId: string,
    opts: { afterSequence?: number; afterId?: string; limit?: number } = {}
  ): Promise<StoryFullScenePage> {
    const q = new URLSearchParams();
    if (opts.afterSequence !== undefined) {
      q.set('after_sequence', String(opts.afterSequence));
    }
    if (opts.afterId) q.set('after_id', opts.afterId);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return apiRequest<StoryFullScenePage>(
      `/projects/${projectId}/story/scenes/full${qs ? `?${qs}` : ''}`
    );
  },

  // --- Renders (step 3) ---------------------------------------------
  //
  // The lock is PER PROJECT and across formats, so every call below that
  // takes a `clientId` is participating in one project-wide claim, not a
  // per-run one. That is what stops two devices double-spending the
  // user's key on the same bible in two different formats.

  /** Create a run. Idempotent on `id`: a transport retry re-sends the
   *  same id and gets 200 with the existing row rather than a second run.
   *  The hints snapshot is built SERVER-side from `rendering_hints` plus
   *  `narrative`'s defaults, so it is deliberately not in the body. */
  async createRender(
    projectId: string,
    body: {
      id: string;
      format: StoryRenderFormat;
      sceneIdStart: string;
      sceneIdEnd: string;
      clientId: string;
      takeover?: boolean;
      model?: string | null;
      promptVersion?: string;
    }
  ): Promise<StoryRenderOut> {
    return storyWrite<StoryRenderOut>(
      `/projects/${projectId}/story/renders`,
      'POST',
      {
        id: body.id,
        format: body.format,
        scene_id_start: body.sceneIdStart,
        scene_id_end: body.sceneIdEnd,
        client_id: body.clientId,
        takeover: body.takeover ?? false,
        model: body.model ?? null,
        prompt_version: body.promptVersion ?? '',
      }
    );
  },

  async getRender(projectId: string, renderId: string): Promise<StoryRenderOut> {
    return apiRequest<StoryRenderOut>(
      `/projects/${projectId}/story/renders/${renderId}`
    );
  },

  async listRenders(
    projectId: string,
    opts: { status?: StoryRenderStatus; limit?: number } = {}
  ): Promise<StoryRenderPage> {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return apiRequest<StoryRenderPage>(
      `/projects/${projectId}/story/renders${qs ? `?${qs}` : ''}`
    );
  },

  /** Acquire the lock OR heartbeat it — one endpoint for both, since the
   *  holder refreshing is just the case where `lock_client_id` already
   *  equals `clientId`.
   *
   *  `baseTs` is what makes this more than a ping: restore bumps every
   *  run's `server_ts` when it marks them stale, so a worker rendering
   *  against a bible that was replaced underneath it 409s here. */
  async acquireRenderLock(
    projectId: string,
    renderId: string,
    body: { clientId: string; baseTs: number; takeover?: boolean }
  ): Promise<StoryRenderOut> {
    return storyWrite<StoryRenderOut>(
      `/projects/${projectId}/story/renders/${renderId}/lock`,
      'POST',
      {
        client_id: body.clientId,
        base_ts: body.baseTs,
        takeover: body.takeover ?? false,
      }
    );
  },

  async releaseRenderLock(
    projectId: string,
    renderId: string,
    body: { clientId: string; baseTs: number }
  ): Promise<void> {
    await storyWrite<Record<string, never>>(
      `/projects/${projectId}/story/renders/${renderId}/lock`,
      'DELETE',
      { client_id: body.clientId, base_ts: body.baseTs }
    );
  },

  async setRenderStatus(
    projectId: string,
    renderId: string,
    body: { status: StoryRenderStatus; baseTs: number }
  ): Promise<StoryRenderOut> {
    return storyWrite<StoryRenderOut>(
      `/projects/${projectId}/story/renders/${renderId}/status`,
      'PUT',
      { status: body.status, base_ts: body.baseTs }
    );
  },

  /** Write one scene's prose — the endpoint that banks the model call,
   *  and the only render route whose failure costs money. Throws
   *  `RenderLockedError` (423) when another client holds the lock LIVE;
   *  a null or stale lock never blocks, keeping this advisory. */
  async putRenderUnit(
    projectId: string,
    renderId: string,
    sceneId: string,
    body: {
      clientId: string;
      baseTs: number;
      sequence: number;
      prose: string;
      status: StoryRenderUnitStatus;
      sourceSceneTs: number;
      continuity?: Record<string, unknown> | null;
      inputTokensDelta?: number;
      outputTokensDelta?: number;
    }
  ): Promise<StoryRenderUnit> {
    return storyWrite<StoryRenderUnit>(
      `/projects/${projectId}/story/renders/${renderId}/units/${sceneId}`,
      'PUT',
      {
        client_id: body.clientId,
        base_ts: body.baseTs,
        sequence: body.sequence,
        prose: body.prose,
        status: body.status,
        source_scene_ts: body.sourceSceneTs,
        continuity: body.continuity ?? null,
        input_tokens_delta: body.inputTokensDelta ?? 0,
        output_tokens_delta: body.outputTokensDelta ?? 0,
      }
    );
  },

  async listRenderUnits(
    projectId: string,
    renderId: string,
    opts: { afterSequence?: number; afterSceneId?: string; limit?: number } = {}
  ): Promise<StoryRenderUnitPage> {
    const q = new URLSearchParams();
    if (opts.afterSequence !== undefined) {
      q.set('after_sequence', String(opts.afterSequence));
    }
    if (opts.afterSceneId) q.set('after_scene_id', opts.afterSceneId);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return apiRequest<StoryRenderUnitPage>(
      `/projects/${projectId}/story/renders/${renderId}/units${qs ? `?${qs}` : ''}`
    );
  },

  /** Prose bodies, not the projection — the reader's and exporter's path.
   *  Paged small (25) because each item is a whole chapter. */
  async readRenderProse(
    projectId: string,
    renderId: string,
    opts: { afterSequence?: number; afterSceneId?: string; limit?: number } = {}
  ): Promise<StoryRenderProsePage> {
    const q = new URLSearchParams();
    if (opts.afterSequence !== undefined) {
      q.set('after_sequence', String(opts.afterSequence));
    }
    if (opts.afterSceneId) q.set('after_scene_id', opts.afterSceneId);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return apiRequest<StoryRenderProsePage>(
      `/projects/${projectId}/story/renders/${renderId}/prose${qs ? `?${qs}` : ''}`
    );
  },

  async deleteRender(
    projectId: string,
    renderId: string,
    body: { clientId: string; baseTs: number }
  ): Promise<void> {
    await storyWrite<Record<string, never>>(
      `/projects/${projectId}/story/renders/${renderId}`,
      'DELETE',
      { client_id: body.clientId, base_ts: body.baseTs }
    );
  },

  async listFacts(
    projectId: string,
    opts: { afterSeq?: number; limit?: number; sceneId?: string } = {}
  ): Promise<StoryLogPage> {
    const q = new URLSearchParams();
    if (opts.afterSeq !== undefined) q.set('after_seq', String(opts.afterSeq));
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.sceneId) q.set('scene_id', opts.sceneId);
    const qs = q.toString();
    return apiRequest<StoryLogPage>(
      `/projects/${projectId}/story/facts${qs ? `?${qs}` : ''}`
    );
  },

  async listEdits(
    projectId: string,
    opts: { afterSeq?: number; limit?: number } = {}
  ): Promise<StoryLogPage> {
    const q = new URLSearchParams();
    if (opts.afterSeq !== undefined) q.set('after_seq', String(opts.afterSeq));
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return apiRequest<StoryLogPage>(
      `/projects/${projectId}/story/edits${qs ? `?${qs}` : ''}`
    );
  },

  /** Drops every section, scene, fact and edit for this Work — but a
   *  snapshot is taken first (phase 9), addressable via listArchives /
   *  restoreArchive. `reason` distinguishes a raw reset from a
   *  change-source-chat discard in the archive list; callers must
   *  confirm first regardless. */
  async reset(
    projectId: string,
    reason: StoryResetReason = 'reset'
  ): Promise<void> {
    await storyWrite<Record<string, unknown>>(
      `/projects/${projectId}/story/reset`,
      'POST',
      { confirm: true, reason }
    );
  },

  /** Newest first — never the snapshot payload (see StoryArchiveSummary).
   *  Paged like listScenes/listFacts: one archive is minted per reset,
   *  source-chat change and restore, so a long-lived Work accumulates
   *  them without bound. */
  async listArchives(
    projectId: string,
    opts: { afterCreatedAt?: string; afterId?: string; limit?: number } = {}
  ): Promise<StoryArchiveListOut> {
    const q = new URLSearchParams();
    if (opts.afterCreatedAt) q.set('after_created_at', opts.afterCreatedAt);
    if (opts.afterId) q.set('after_id', opts.afterId);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return apiRequest<StoryArchiveListOut>(
      `/projects/${projectId}/story/archives${qs ? `?${qs}` : ''}`
    );
  },

  /** Replaces the live bible with a past snapshot. `expected` must be
   *  built from the manifest the caller last fetched — a stale value
   *  throws StoryRestoreConflictError rather than silently clobbering a
   *  fresher write (base_ts-guarded at bible granularity; see the
   *  backend's StoryRestoreIn docstring). A safety snapshot of whatever
   *  gets overwritten is taken automatically first. */
  async restoreArchive(
    projectId: string,
    archiveId: string,
    expected: {
      sections: Record<string, number>;
      sceneCount: number;
      factCount: number;
      editCount: number;
    }
  ): Promise<StoryRestoreOut> {
    return storyRestoreCall(
      `/projects/${projectId}/story/archives/${archiveId}/restore`,
      {
        confirm: true,
        expected_sections: expected.sections,
        expected_scene_count: expected.sceneCount,
        expected_fact_count: expected.factCount,
        expected_edit_count: expected.editCount,
      }
    );
  },
};
