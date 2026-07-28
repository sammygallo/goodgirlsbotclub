// User types
/** @deprecated Use `permissions` array + `groupId` instead. Kept for backward compat during transition. */
export type UserRole = 'owner' | 'admin' | 'contributor' | 'end_user';

/** A permission string matching the backend vocabulary in `ggbc-backend/app/security/permissions.py`. */
export type Permission = string;

export interface PermissionGroup {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** True for the four seeded default groups. Cannot be deleted. */
  system: boolean;
  /** True for exactly one group (the Owner default). Perm set locked to full vocabulary. */
  systemOwner: boolean;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Included on list responses when the caller has `admin:users:view`. */
  memberCount?: number;
  enabledMemberCount?: number;
}

export interface User {
  handle: string;
  name: string;
  avatar?: string;
  /** Current permission group id. Source of truth for authorization. */
  groupId?: string;
  /** Resolved permission list from the user's group, included in /me responses. */
  permissions?: Permission[];
  /** @deprecated Shim derived from groupId. Use `permissions` instead. */
  admin?: boolean;
  /** @deprecated Shim derived from groupId. Use `permissions` instead. */
  role?: UserRole;
}

// Character types
export interface Character {
  name: string;
  avatar: string;
  description?: string;
  personality?: string;
  first_mes?: string;
  scenario?: string;
  create_date?: string;
}

// Chat types
export interface ChatMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  send_date: number;
  swipes?: string[];
  swipe_id?: number;
  extra?: {
    /** Story-state phase 1: permanent message identity (UUID), minted
     *  client-side and healed/backfilled server-side from phase 2 on. */
    ggbc_id?: string;
    gen_id?: string;
    api?: string;
    model?: string;
  };
  character_avatar?: string;
}

export interface Chat {
  user_name: string;
  character_name: string;
  create_date: string;
  chat_metadata: Record<string, unknown>;
}

// API Response types
export interface ApiError {
  error: string;
  message?: string;
}

export interface LoginResponse {
  handle: string;
  name: string;
}

export interface CharacterListResponse {
  characters: string[];
}
