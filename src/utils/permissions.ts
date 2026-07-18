import type { Permission, User, UserRole } from '../types';

/**
 * Frontend permission utility.
 *
 * The backend is the source of truth for the permission vocabulary; the
 * constants exported here must match `SillyTavern/src/permissions.js`. The
 * PermissionGroupEditor renders its checkboxes from the server-returned
 * vocabulary (`GET /api/permissions`), so new backend permissions flow
 * through without requiring a frontend update — this list exists only for
 * type hints and legacy shim mapping.
 */

/** The canonical permission vocabulary. Keep in sync with the backend. */
export const PERMISSIONS = [
  // Chat & generation
  'chat:read',
  'chat:write',
  'chat:delete',
  'chat:import_export',
  'generation:use',
  'generation:image',
  'generation:audio',
  // Owner-only by default (absent from LEGACY_PERM_MIN_LEVEL on purpose —
  // unknown permissions resolve owner-only in legacy mode).
  'generation:video',

  // Characters
  'character:view',
  'character:create',
  'character:edit',
  'character:delete',
  'character:import_export',
  'character:set_global',

  // Groups & Personas
  'character_group:view',
  'character_group:manage',
  'persona:view',
  'persona:manage',

  // World Info
  'worldinfo:view',
  'worldinfo:manage',

  // Projects (Works)
  'project:view',
  'project:manage',

  // Settings
  'settings:view',
  'settings:connection',
  'settings:api_keys',
  'settings:generation',
  'settings:appearance',
  'settings:global_secrets',

  // Extensions
  'extension:view',
  'extension:manage_personal',
  'extension:manage_global',

  // Data Bank
  'databank:view',
  'databank:manage',
  'databank:manage_global',

  // Automation
  'automation:quickreplies:manage',
  'automation:regex:manage',
  'automation:prompts:manage',

  // Administration
  'admin:users:view',
  'admin:users:manage',
  'admin:users:reset_password',
  'admin:users:set_group',
  'admin:invitations:manage',
  'admin:groups:manage',
  'admin:data_maid:manage',
  'admin:content_import',

  // System
  'system:backup:self',
  'system:backup:others',
] as const;

/**
 * Checks whether the user holds the given permission.
 *
 * If the user has no `permissions` array yet (very old client talking to an
 * even older server), we fall back to the legacy `admin`/`role` shim fields —
 * this keeps the UI functional during the transition window.
 */
export function hasPermission(
  user: Pick<User, 'permissions' | 'admin' | 'role'> | null | undefined,
  perm: Permission,
): boolean {
  if (!user) return false;
  if (Array.isArray(user.permissions)) {
    return user.permissions.includes(perm);
  }
  // Legacy shim path: approximate the new permission from the old role.
  return legacyRoleHas(user.role, user.admin, perm);
}

/** Does the user hold every listed permission? */
export function hasAllPermissions(
  user: Pick<User, 'permissions' | 'admin' | 'role'> | null | undefined,
  perms: Permission[],
): boolean {
  return perms.every(p => hasPermission(user, p));
}

/** Does the user hold any of the listed permissions? */
export function hasAnyPermission(
  user: Pick<User, 'permissions' | 'admin' | 'role'> | null | undefined,
  perms: Permission[],
): boolean {
  return perms.some(p => hasPermission(user, p));
}

/**
 * Legacy compatibility: map the old 4-tier role to an approximate permission
 * check. This is only used when the server hasn't returned a `permissions`
 * array on `/me`, i.e. when the frontend is talking to a pre-groups backend.
 */
function legacyRoleHas(role: UserRole | undefined, admin: boolean | undefined, perm: Permission): boolean {
  const effectiveRole: UserRole = role ?? (admin ? 'admin' : 'end_user');
  const level = LEGACY_ROLE_LEVEL[effectiveRole] ?? 0;
  const min = LEGACY_PERM_MIN_LEVEL[perm];
  if (min === undefined) {
    // Unknown permission in legacy mode: owner-only by default (safe).
    return effectiveRole === 'owner';
  }
  return level >= min;
}

const LEGACY_ROLE_LEVEL: Record<UserRole, number> = {
  end_user: 0,
  contributor: 1,
  admin: 2,
  owner: 3,
};

/**
 * Approximate legacy mapping from each permission back to the minimum 4-tier
 * role that would have held it. Used only when the server doesn't yet return
 * `permissions` on /me.
 */
const LEGACY_PERM_MIN_LEVEL: Record<string, number> = {
  // end_user level
  'chat:read': 0, 'chat:write': 0,
  'character:view': 0, 'persona:view': 0, 'persona:manage': 0,
  'databank:view': 0, 'settings:view': 0,
  'generation:use': 0, 'system:backup:self': 0,
  'settings:api_keys': 0,
  'project:view': 0, 'project:manage': 0,

  // contributor level
  'chat:delete': 1, 'chat:import_export': 1,
  'generation:image': 1, 'generation:audio': 1,
  'character:create': 1, 'character:edit': 1, 'character:delete': 1,
  'character:import_export': 1,
  'character_group:view': 1, 'character_group:manage': 1,
  'worldinfo:view': 1, 'worldinfo:manage': 1,
  'extension:view': 1, 'extension:manage_personal': 1,
  'databank:manage': 1,
  'automation:quickreplies:manage': 1, 'automation:regex:manage': 1, 'automation:prompts:manage': 1,

  // admin level
  'settings:connection': 2, 'settings:generation': 2, 'settings:appearance': 2,
  'admin:users:view': 2, 'admin:users:manage': 2, 'admin:users:set_group': 2,
  'admin:invitations:manage': 2, 'admin:data_maid:manage': 2,

  // owner-only
  'character:set_global': 3,
  'extension:manage_global': 3,
  'databank:manage_global': 3,
  'settings:global_secrets': 3,
  'admin:users:reset_password': 3,
  'admin:groups:manage': 3,
  'admin:content_import': 3,
  'system:backup:others': 3,
};

// ---------------------------------------------------------------------------
// Legacy shims — map the old action/role API to the new permission check.
// Kept so any component that still calls `can(role, 'character:edit')` keeps
// working during the transition. Remove in a follow-up cleanup.
// ---------------------------------------------------------------------------

/** @deprecated Old action type. */
export type Action =
  | 'chat'
  | 'character:view'
  | 'character:create'
  | 'character:edit'
  | 'character:delete'
  | 'settings:view'
  | 'settings:personal'
  | 'settings:api_keys'
  | 'admin:panel';

const ACTION_TO_PERMISSION: Record<Action, Permission> = {
  'chat': 'chat:write',
  'character:view': 'character:view',
  'character:create': 'character:create',
  'character:edit': 'character:edit',
  'character:delete': 'character:delete',
  'settings:view': 'settings:view',
  'settings:personal': 'settings:view',
  'settings:api_keys': 'settings:api_keys',
  'admin:panel': 'admin:users:view',
};

/**
 * @deprecated Use `hasPermission(user, perm)` with the new permission
 *   vocabulary. This shim maps the old `can(role, action)` API into a
 *   permission lookup against a pseudo-user carrying only the legacy role.
 */
export function can(role: UserRole | undefined, action: Action): boolean {
  const perm = ACTION_TO_PERMISSION[action];
  return legacyRoleHas(role, role === 'admin' || role === 'owner', perm);
}

/** @deprecated Use `hasPermission` or `RequirePermission` instead. */
export function hasMinRole(role: UserRole | undefined, minRole: UserRole): boolean {
  if (!role) return false;
  return (LEGACY_ROLE_LEVEL[role] ?? 0) >= (LEGACY_ROLE_LEVEL[minRole] ?? 0);
}
