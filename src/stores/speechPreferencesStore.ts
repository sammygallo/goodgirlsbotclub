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

async function getSettingsBlob(): Promise<Record<string, unknown>> {
  const response = await settingsApi.getSettings();
  if (typeof response.settings === 'string') {
    try { return JSON.parse(response.settings); } catch { return {}; }
  }
  return (response.settings as Record<string, unknown>) || {};
}

async function patchServer(patch: Record<string, unknown>): Promise<void> {
  const settings = await getSettingsBlob();
  const speech = (settings.stm_speech as Record<string, unknown>) || {};
  Object.assign(speech, patch);
  settings.stm_speech = speech;
  await settingsApi.saveSettings(settings);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSpeechPreferencesStore = create<SpeechPrefsState>((set) => ({
  speechLang: getSpeechLanguage(),
  ttsVoiceUri: getTtsVoiceUri(),
  ttsRate: getTtsRate(),
  ttsPitch: getTtsPitch(),
  ttsAutoRead: getTtsAutoRead(),

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const speech = settings.stm_speech as Record<string, unknown> | undefined;
      if (!speech) return;

      const speechLang = typeof speech.speechLang === 'string' ? speech.speechLang : getSpeechLanguage();
      const ttsVoiceUri = typeof speech.ttsVoiceUri === 'string' ? speech.ttsVoiceUri : getTtsVoiceUri();
      const ttsRate = typeof speech.ttsRate === 'number' ? speech.ttsRate : getTtsRate();
      const ttsPitch = typeof speech.ttsPitch === 'number' ? speech.ttsPitch : getTtsPitch();
      const ttsAutoRead = typeof speech.ttsAutoRead === 'boolean' ? speech.ttsAutoRead : getTtsAutoRead();

      // Write back to localStorage so the next cold load is still instant.
      lsSetSpeechLang(speechLang);
      lsSetTtsVoice(ttsVoiceUri);
      lsSetTtsRate(ttsRate);
      lsSetTtsPitch(ttsPitch);
      lsSetTtsAutoRead(ttsAutoRead);

      set({ speechLang, ttsVoiceUri, ttsRate, ttsPitch, ttsAutoRead });
    } catch { /* non-fatal — localStorage values remain active */ }
  },

  setSpeechLang: (lang) => {
    lsSetSpeechLang(lang);
    set({ speechLang: lang });
    patchServer({ speechLang: lang }).catch(() => {});
  },

  setTtsVoiceUri: (uri) => {
    lsSetTtsVoice(uri);
    set({ ttsVoiceUri: uri });
    patchServer({ ttsVoiceUri: uri }).catch(() => {});
  },

  setTtsRate: (rate) => {
    lsSetTtsRate(rate);
    set({ ttsRate: rate });
    patchServer({ ttsRate: rate }).catch(() => {});
  },

  setTtsPitch: (pitch) => {
    lsSetTtsPitch(pitch);
    set({ ttsPitch: pitch });
    patchServer({ ttsPitch: pitch }).catch(() => {});
  },

  setTtsAutoRead: (on) => {
    lsSetTtsAutoRead(on);
    set({ ttsAutoRead: on });
    patchServer({ ttsAutoRead: on }).catch(() => {});
  },
}));
