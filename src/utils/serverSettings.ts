/**
 * Shared helpers for server-synced store pattern.
 *
 * Each store that syncs to the server:
 *   1. Calls getSettingsBlob() to read the full settings object.
 *   2. Calls patchServerKey() to write a named section with a _ts timestamp.
 *   3. Uses makeLocalTsKey() to derive its localStorage timestamp key so that
 *      fetchPrefs can detect unconfirmed mutations (localTs > server._ts).
 *
 * Sync contract (same as displayPreferencesStore / speechPreferencesStore):
 *   - markDirty() stamps localStorage with Date.now() BEFORE the network call.
 *   - patchServerKey() stamps _ts into the server blob and ONLY advances
 *     localTs on success. A network failure leaves localTs > server._ts, so
 *     the next login's fetchPrefs re-uploads the pending local state.
 */

import { settingsApi } from '../api/client';

export async function getSettingsBlob(): Promise<Record<string, unknown>> {
  const response = await settingsApi.getSettings();
  if (typeof response.settings === 'string') {
    try { return JSON.parse(response.settings); } catch { return {}; }
  }
  return (response.settings as Record<string, unknown>) || {};
}

export function makeLocalTsKey(serverKey: string): string {
  return `stm:${serverKey}-local-ts`;
}

/**
 * Read-modify-write one key in the server settings blob.
 * Embeds _ts in the value and, only on success, advances localTsKey.
 * Throws on network failure — callers should .catch(() => {}).
 */
export async function patchServerKey(
  serverKey: string,
  value: Record<string, unknown>,
  localTsKey: string,
): Promise<void> {
  const ts = Date.now();
  const settings = await getSettingsBlob();
  settings[serverKey] = { ...value, _ts: ts };
  await settingsApi.saveSettings(settings);
  try { localStorage.setItem(localTsKey, String(ts)); } catch { /* ignore */ }
}
