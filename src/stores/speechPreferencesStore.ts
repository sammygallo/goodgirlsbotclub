/**
 * Server-synced speech & TTS preferences store.
 *
 * Initialises from localStorage (instant first render), then hydrates from
 * the user's server-side settings blob after login so preferences follow the
 * user across devices.  Every mutation writes to localStorage immediately and
 * patches the server in the background.
 *
 * Server settings blob key: `stm_speech`
 *
 * Sync strategy — gap 1 fix (failed patch recovery):
 *   LOCAL_TS_KEY is stamped with Date.now() on every mutation.
 *   patchServer embeds the same timestamp as _ts in the blob and, only on
 *   success, updates LOCAL_TS_KEY to match.  A failed patch therefore leaves
 *   LOCAL_TS_KEY > server._ts.  fetchPrefs detects this and re-uploads the
 *   full local state rather than overwriting it with the stale server copy.
 *
 * Not synced:
 *   - speechPermission — browser-level mic grant state; device-specific
 */

import { create } from 'zustand';
import { settingsApi } from '../api/client';
import {
  getSpeechLanguage,
  setSpeechLanguage as lsSetSpeechLang,
  getTtsVoiceUri,
  setTtsVoiceUri as lsSetTtsVoice,
  getTtsRate,
  setTtsRate as lsSetTtsRate,
  getTtsPitch,
  setTtsPitch as lsSetTtsPitch,
  getTtsAutoRead,
  setTtsAutoRead as lsSetTtsAutoRead,
} from '../hooks/speechLanguage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpeechPrefsState {
  speechLang: string;
  /** Voice URI from the Web Speech API — empty string means system default. */
  ttsVoiceUri: string;
  ttsRate: number;
  ttsPitch: number;
  ttsAutoRead: boolean;

  /** Fetch from server after login and apply. No-op if no server data yet. */
  fetchPrefs: () => Promise<void>;
  setSpeechLang: (lang: string) => void;
  setTtsVoiceUri: (uri: string) => void;
  setTtsRate: (rate: number) => void;
  setTtsPitch: (pitch: number) => void;
  setTtsAutoRead: (on: boolean) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** localStorage key tracking the timestamp of the last local mutation. */
const LOCAL_TS_KEY = 'stm:speech-local-ts';

function markLocalDirty(): void {
  try { localStorage.setItem(LOCAL_TS_KEY, String(Date.now())); } catch { /* ignore */ }
}

async function getSettingsBlob(): Promise<Record<string, unknown>> {
  const response = await settingsApi.getSettings();
  if (typeof response.settings === 'string') {
    try { return JSON.parse(response.settings); } catch { return {}; }
  }
  return (response.settings as Record<string, unknown>) || {};
}

/**
 * Read-modify-write the stm_speech section of the settings blob.
 * Embeds _ts in the patch and, only on success, advances LOCAL_TS_KEY
 * to match — so a network failure leaves LOCAL_TS_KEY > server._ts.
 */
async function patchServer(patch: Record<string, unknown>): Promise<void> {
  const ts = Date.now();
  const settings = await getSettingsBlob();
  const speech = (settings.stm_speech as Record<string, unknown>) || {};
  Object.assign(speech, patch, { _ts: ts });
  settings.stm_speech = speech;
  await settingsApi.saveSettings(settings); // throws on failure — LOCAL_TS_KEY not updated
  try { localStorage.setItem(LOCAL_TS_KEY, String(ts)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSpeechPreferencesStore = create<SpeechPrefsState>((set, get) => ({
  speechLang: getSpeechLanguage(),
  ttsVoiceUri: getTtsVoiceUri(),
  ttsRate: getTtsRate(),
  ttsPitch: getTtsPitch(),
  ttsAutoRead: getTtsAutoRead(),

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const speech = settings.stm_speech as Record<string, unknown> | undefined;
      const localTs = Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
      const serverTs = Number(speech?._ts || 0);

      if (localTs > serverTs) {
        // Local has mutations that never confirmed to the server — re-upload them.
        const s = get();
        patchServer({
          speechLang: s.speechLang,
          ttsVoiceUri: s.ttsVoiceUri,
          ttsRate: s.ttsRate,
          ttsPitch: s.ttsPitch,
          ttsAutoRead: s.ttsAutoRead,
        }).catch(() => {});
        return; // keep local values — they are newer
      }

      if (!speech) return; // No server prefs and no local changes — keep defaults.

      // Server is current or newer — apply server values and write back to localStorage.
      const speechLang = typeof speech.speechLang === 'string' ? speech.speechLang : getSpeechLanguage();
      const ttsVoiceUri = typeof speech.ttsVoiceUri === 'string' ? speech.ttsVoiceUri : getTtsVoiceUri();
      const ttsRate = typeof speech.ttsRate === 'number' ? speech.ttsRate : getTtsRate();
      const ttsPitch = typeof speech.ttsPitch === 'number' ? speech.ttsPitch : getTtsPitch();
      const ttsAutoRead = typeof speech.ttsAutoRead === 'boolean' ? speech.ttsAutoRead : getTtsAutoRead();

      lsSetSpeechLang(speechLang);
      lsSetTtsVoice(ttsVoiceUri);
      lsSetTtsRate(ttsRate);
      lsSetTtsPitch(ttsPitch);
      lsSetTtsAutoRead(ttsAutoRead);

      // Advance LOCAL_TS_KEY so a future fetchPrefs doesn't re-upload stale local state.
      try { localStorage.setItem(LOCAL_TS_KEY, String(serverTs)); } catch { /* ignore */ }

      set({ speechLang, ttsVoiceUri, ttsRate, ttsPitch, ttsAutoRead });
    } catch { /* non-fatal — localStorage values remain active */ }
  },

  setSpeechLang: (lang) => {
    lsSetSpeechLang(lang);
    set({ speechLang: lang });
    markLocalDirty();
    patchServer({ speechLang: lang }).catch(() => {});
  },

  setTtsVoiceUri: (uri) => {
    lsSetTtsVoice(uri);
    set({ ttsVoiceUri: uri });
    markLocalDirty();
    patchServer({ ttsVoiceUri: uri }).catch(() => {});
  },

  setTtsRate: (rate) => {
    lsSetTtsRate(rate);
    set({ ttsRate: rate });
    markLocalDirty();
    patchServer({ ttsRate: rate }).catch(() => {});
  },

  setTtsPitch: (pitch) => {
    lsSetTtsPitch(pitch);
    set({ ttsPitch: pitch });
    markLocalDirty();
    patchServer({ ttsPitch: pitch }).catch(() => {});
  },

  setTtsAutoRead: (on) => {
    lsSetTtsAutoRead(on);
    set({ ttsAutoRead: on });
    markLocalDirty();
    patchServer({ ttsAutoRead: on }).catch(() => {});
  },
}));
