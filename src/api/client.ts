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

/** Build the v2 spec `data` object from the legacy CharacterCreateData shape. */
function buildCardData(input: CharacterCreateData & { avatar_url?: string }): {
  data: Record<string, unknown>;
  tags: string[];
} {
  const tags = splitTags(input.tags);
  const data: Record<string, unknown> = {
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

  const extensions: Record<string, unknown> = {};
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
}

export interface CharacterEditData extends CharacterCreateData {
  avatar_url: string;
  chat?: string;
  create_date?: string;
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

  async editCharacter(data: CharacterEditData, avatarFile?: File): Promise<void> {
    const { data: card, tags } = buildCardData(data);
    const payload = {
      name: data.ch_name,
      data: card,
      chat: data.chat ?? null,
      tags,
      fav: !!data.fav,
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
    // Skip the header element to match the legacy ST behavior — header
    // is { user_name, character_name, create_date, ... } and isn't a
    // displayed message. server_ts is the optimistic-concurrency token the
    // caller must echo back as base_ts on the next save.
    const messages = response?.messages;
    return {
      messages: Array.isArray(messages) ? messages.slice(1) : [],
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
        const customUrl = useSettingsStore.getState().customUrl;
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
