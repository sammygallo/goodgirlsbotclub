/**
 * Shared helpers for server-synced store pattern.
 *
 * Each store calls getSettingsBlob() / patchServerKey() / makeLocalTsKey()
 * and is otherwise unaware of where the data lives. After A2 those helpers
 * talk to ggbc-backend's per-section /sync API instead of the old single-
 * blob /api/settings/{get,save} on ST.
 *
 * Sync contract:
 *   - The `*-local-ts` key holds the last server_ts we confirmed for a section
 *     (the backend's monotonic counter), NOT a wall-clock time. A separate
 *     `*-local-ts:dirty` flag records "this section has local edits not yet
 *     confirmed to the server", independent of the version token.
 *   - markSectionDirty() sets that flag when a section is edited locally.
 *   - patchServerKey() PUTs the value with base_ts = the confirmed server_ts.
 *     On success it adopts the server's new server_ts and clears dirty. On a
 *     409 it merges local on top of the server's current data and retries once.
 *     On any other failure it leaves the dirty flag set, so the next focus /
 *     login fetchPrefs re-uploads the pending local state.
 *   - shouldReuploadSection() is the fetchPrefs decision: re-upload only when
 *     we have pending local edits AND no other device has advanced past our
 *     confirmed token; otherwise accept the server. Both sides now compare in
 *     the same server_ts counter space (the pre-A2 regression was comparing a
 *     Date.now() epoch against a small counter, so the local device always won).
 *
 * Migration: on first call per browser, sections that ggbc-backend doesn't
 * yet have are lazily imported from ST's old settings.json (still reachable
 * via the proxy). Once the sentinel is set, ST is no longer consulted.
 */

import { apiRequest, putSection, SectionConflictError } from '../api/client';

const KNOWN_SECTIONS = [
  'stm_display',
  'stm_speech',
  'stm_personas',
  'stm_connection_profiles',
  'stm_generation',
  'stm_rag_settings',
  'stm_theme',
] as const;

const ST_IMPORT_SENTINEL = 'stm:settings-migrated-to-ggbc-v1';

interface SectionResponse {
  section: string;
  data: Record<string, unknown> | unknown[] | null;
  server_ts: number;
  updated_at: string;
}

/**
 * Run once per browser: pull each known section out of ST's old settings.json
 * blob and seed it into ggbc-backend for sections ggbc hasn't seen yet.
 *
 * Safe to call repeatedly — it short-circuits via the sentinel and never
 * overwrites a section ggbc-backend already has, so a second device or a
 * fresh cache won't clobber newer cross-device state.
 */
async function maybeImportFromST(): Promise<void> {
  try {
    if (localStorage.getItem(ST_IMPORT_SENTINEL)) return;
  } catch {
    // localStorage unavailable — fall through and re-import each load.
  }

  let existing: Record<string, SectionResponse> = {};
  try {
    existing = await apiRequest<Record<string, SectionResponse>>('/sync/sections');
  } catch {
    // ggbc-backend unreachable; bail and retry next call.
    return;
  }

  let oldBlob: Record<string, unknown> = {};
  try {
    const stResp = await apiRequest<{ settings?: string | Record<string, unknown> }>(
      '/api/settings/get',
      { method: 'POST', body: JSON.stringify({}) },
    );
    const raw = stResp.settings;
    if (typeof raw === 'string') {
      try { oldBlob = JSON.parse(raw) as Record<string, unknown>; } catch { oldBlob = {}; }
    } else if (raw && typeof raw === 'object') {
      oldBlob = raw as Record<string, unknown>;
    }
  } catch {
    // ST proxy didn't answer (or this is a fresh install); nothing to import.
    try { localStorage.setItem(ST_IMPORT_SENTINEL, '1'); } catch { /* ignore */ }
    return;
  }

  for (const name of KNOWN_SECTIONS) {
    if (existing[name]) continue;
    const oldSection = oldBlob[name];
    if (!oldSection || typeof oldSection !== 'object') continue;
    const data = { ...(oldSection as Record<string, unknown>) };
    delete data._ts;
    try {
      await apiRequest(`/sync/section/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ data }),
      });
    } catch {
      // Skip this section; we'll get another chance next call because we
      // don't set the sentinel below if any section threw.
    }
  }

  try { localStorage.setItem(ST_IMPORT_SENTINEL, '1'); } catch { /* ignore */ }
}

/**
 * Read every section the current user has stored on the server.
 * Shape matches the old ST-blob format ({ [section]: { ...data, _ts } })
 * so existing stores keep working unchanged.
 */
export async function getSettingsBlob(): Promise<Record<string, unknown>> {
  await maybeImportFromST();
  let sections: Record<string, SectionResponse>;
  try {
    sections = await apiRequest<Record<string, SectionResponse>>('/sync/sections');
  } catch {
    return {};
  }
  const blob: Record<string, unknown> = {};
  for (const [name, section] of Object.entries(sections)) {
    if (section.data && typeof section.data === 'object' && !Array.isArray(section.data)) {
      blob[name] = { ...(section.data as Record<string, unknown>), _ts: section.server_ts };
    } else {
      // Non-object sections (arrays, scalars) — preserve shape, _ts riding alongside.
      blob[name] = section.data;
    }
  }
  return blob;
}

export function makeLocalTsKey(serverKey: string): string {
  return `stm:${serverKey}-local-ts`;
}

/** The dirty-flag companion key for a section's version-token key. */
function dirtyKeyFor(localTsKey: string): string {
  return `${localTsKey}:dirty`;
}

/**
 * Mark a section as having local edits not yet confirmed to the server. The
 * version-token key now holds the server's counter, so "is there unsynced
 * local work" is tracked separately here rather than by bumping a timestamp.
 */
export function markSectionDirty(localTsKey: string): void {
  try { localStorage.setItem(dirtyKeyFor(localTsKey), '1'); } catch { /* ignore */ }
}

/** True if the section has local edits not yet confirmed to the server. */
export function isSectionDirty(localTsKey: string): boolean {
  try { return localStorage.getItem(dirtyKeyFor(localTsKey)) === '1'; } catch { return false; }
}

/**
 * Record that we've accepted the server's state for a section: store its
 * server_ts as our confirmed version token and clear the dirty flag. Call this
 * after applying server values in fetchPrefs (and patchServerKey calls it on a
 * successful write).
 */
export function recordServerTs(localTsKey: string, serverTs: number): void {
  try {
    localStorage.setItem(localTsKey, String(serverTs));
    localStorage.removeItem(dirtyKeyFor(localTsKey));
  } catch { /* ignore */ }
}

/** Drop a section's version token and its dirty flag — used by store
 *  resetUser() on logout/user-switch so the next account starts from a clean
 *  slate (no stale token that would re-upload the previous user's snapshot). */
export function clearLocalTs(localTsKey: string): void {
  try {
    localStorage.removeItem(localTsKey);
    localStorage.removeItem(dirtyKeyFor(localTsKey));
  } catch { /* ignore */ }
}

/** Prefixes for every localStorage key this app owns. Anything under these is
 *  per-user data (caches, version tokens, dirty flags, secrets) that must not
 *  survive a logout or leak into the next account on a shared browser.
 *  Covers the `stm:` / `sillytavern_` keyspaces plus the zustand-persist store
 *  names (`st-mobile-*`, `quick-reply-store`, `live-portrait`,
 *  `portrait-position`, `ggbc-lovense`) — including their `_<handle>` scoped
 *  variants. */
const APP_STORAGE_PREFIXES = [
  'stm:',
  'sillytavern_',
  'st-mobile-',
  'quick-reply-store',
  'live-portrait',
  'portrait-position',
  // Intimate-hardware preferences (keyword reactions, per-toy trims) must not
  // survive into the next account on a shared browser.
  'ggbc-lovense',
] as const;

/**
 * Remove every app-owned localStorage key. This is the catch-all isolation
 * guarantee for logout / user-switch: rather than relying on each store to
 * enumerate its keys (fragile — a forgotten key, like the per-section `:dirty`
 * flags, is exactly how cross-account leakage happens), wipe the whole
 * app-owned keyspace and let each store re-hydrate from its own server data.
 * Keys outside these prefixes (e.g. the `ggbc:` active-handle marker) are left
 * intact.
 */
export function clearAllAppStorage(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && APP_STORAGE_PREFIXES.some((p) => key.startsWith(p))) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch { /* ignore */ }
}

/**
 * fetchPrefs decision: re-upload local state only when we have pending local
 * edits AND our confirmed token is at least the server's (i.e. no other device
 * has advanced past us). Otherwise accept the server. Both operands are now in
 * the server_ts counter space.
 */
export function shouldReuploadSection(localTsKey: string, serverTs: number): boolean {
  let localToken = 0;
  try { localToken = Number(localStorage.getItem(localTsKey) || 0); } catch { localToken = 0; }
  return isSectionDirty(localTsKey) && localToken >= serverTs;
}

/**
 * PUT one section's value with optimistic concurrency. Strips any in-band _ts
 * (the server tracks it for us), sends base_ts = the last confirmed server_ts,
 * and on success adopts the server's new server_ts and clears the dirty flag.
 *
 * On a 409 (another device wrote first) it merges our value on top of the
 * server's current data and retries once against the new base_ts — never a
 * silent overwrite. On any other failure it leaves the dirty flag set so the
 * next focus/login fetchPrefs re-uploads, logs the failure, and rethrows.
 *
 * Callers typically .catch(() => {}); the dirty flag + central log mean a
 * swallowed rejection is still recoverable and visible.
 */
export async function patchServerKey(
  serverKey: string,
  value: Record<string, unknown>,
  localTsKey: string,
): Promise<void> {
  const cleanValue = { ...value };
  delete cleanValue._ts;

  // Always send a numeric base_ts (default 0). Sending base_ts=0 makes the
  // backend create a brand-new section but 409 if a row already exists — so an
  // unsynced device can never silently clobber another device's first write.
  let baseTs = 0;
  try { baseTs = Number(localStorage.getItem(localTsKey) || 0); } catch { baseTs = 0; }
  if (!Number.isFinite(baseTs)) baseTs = 0;

  let payloadData: Record<string, unknown> = cleanValue;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await putSection(serverKey, payloadData, baseTs);
      recordServerTs(localTsKey, out.server_ts);
      return;
    } catch (err) {
      if (err instanceof SectionConflictError && attempt === 0) {
        // Reconcile: re-apply our local section on top of the server's current
        // data, then retry against the authoritative ts.
        const current =
          err.conflict.current_data &&
          typeof err.conflict.current_data === 'object' &&
          !Array.isArray(err.conflict.current_data)
            ? (err.conflict.current_data as Record<string, unknown>)
            : {};
        payloadData = { ...current, ...cleanValue };
        baseTs = err.conflict.current_ts;
        continue;
      }
      // Network error, or a second consecutive conflict: keep the section dirty
      // for the next fetchPrefs and surface the failure instead of swallowing it.
      markSectionDirty(localTsKey);
      console.warn(`[sync] section "${serverKey}" failed to save; will retry on next sync`, err);
      throw err;
    }
  }
}
