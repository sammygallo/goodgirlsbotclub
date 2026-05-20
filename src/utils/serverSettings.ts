/**
 * Shared helpers for server-synced store pattern.
 *
 * Each store calls getSettingsBlob() / patchServerKey() / makeLocalTsKey()
 * and is otherwise unaware of where the data lives. After A2 those helpers
 * talk to ggbc-backend's per-section /sync API instead of the old single-
 * blob /api/settings/{get,save} on ST.
 *
 * Sync contract (unchanged, only the wire format moved):
 *   - markDirty() stamps localStorage with Date.now() BEFORE the network call.
 *   - patchServerKey() PUTs the new value, and ONLY advances localTs on a
 *     successful 2xx. A network failure leaves localTs ahead of server, so
 *     the next login's fetchPrefs re-uploads the pending local state.
 *
 * Migration: on first call per browser, sections that ggbc-backend doesn't
 * yet have are lazily imported from ST's old settings.json (still reachable
 * via the proxy). Once the sentinel is set, ST is no longer consulted.
 */

import { apiRequest } from '../api/client';

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

/**
 * PUT one section's value. Strips any in-band _ts (server tracks it for us)
 * and advances localTsKey only on a successful write — so a network failure
 * leaves localTs ahead, and the next fetchPrefs re-uploads.
 *
 * Throws on unrecoverable failure; callers typically .catch(() => {}).
 */
export async function patchServerKey(
  serverKey: string,
  value: Record<string, unknown>,
  localTsKey: string,
): Promise<void> {
  const ts = Date.now();
  const cleanValue = { ...value };
  delete cleanValue._ts;
  await apiRequest(`/sync/section/${serverKey}`, {
    method: 'PUT',
    body: JSON.stringify({ data: cleanValue }),
  });
  try { localStorage.setItem(localTsKey, String(ts)); } catch { /* ignore */ }
}
