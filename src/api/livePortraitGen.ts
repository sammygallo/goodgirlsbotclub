import { getCsrfToken } from './client';
import type { EmotionClips } from '../stores/livePortraitStore';

/**
 * Live Portrait clip generation client — talks to the SillyTavern backend's
 * `/api/live-portrait/*` route family which proxies to Replicate's
 * wan-video/wan-2.2-i2v-fast model.
 *
 * The backend handles auth, secrets, avatar upload, and saving the resulting
 * MP4s into the character data dir; this module just kicks off a job and polls
 * until it's done. Generation takes ~30–60s per emotion clip. We surface a
 * progress callback so the setup modal can show a progress bar.
 */

interface JobStatus {
  status: 'queued' | 'running' | 'completed' | 'error';
  progress: number;
  clips: EmotionClips;
  error: string | null;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes total — leaves headroom over backend's per-clip timeout

/**
 * Fetch existing clip URLs for a character (any clips already generated
 * server-side). Lets clients auto-populate their local store on character
 * load so users see Live Portrait everywhere — not just on the device
 * that ran generation.
 *
 * B3c-assets — clips moved into user_blobs under
 * `live-portrait/{avatar}/{emotion}.mp4`. We list the user's blobs and
 * filter by the per-character prefix instead of hitting ST's
 * `/api/live-portrait/list/{name}` route.
 */
export async function fetchExistingClips(characterAvatar: string): Promise<EmotionClips> {
  const r = await fetch('/blobs', { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const rows: Array<{ key: string }> = await r.json();
  const prefix = `live-portrait/${characterAvatar}/`;
  const clips: EmotionClips = {};
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    const filename = row.key.slice(prefix.length);
    const emotion = filename.replace(/\.[^/.]+$/, '');
    if (!emotion) continue;
    clips[emotion] = `/blobs/${encodeURI(row.key)}`;
  }
  return clips;
}

/**
 * Fetch the list of emotions the backend's Replicate client supports. Cached
 * for the session.
 */
let _emotionsCache: string[] | null = null;
export async function fetchSupportedEmotions(): Promise<string[]> {
  if (_emotionsCache) return _emotionsCache;
  const r = await fetch('/api/live-portrait/emotions', { credentials: 'include' });
  if (!r.ok) throw new Error(`Could not fetch supported emotions: HTTP ${r.status}`);
  const data = await r.json();
  _emotionsCache = data.emotions ?? [];
  return _emotionsCache!;
}

/**
 * Kick off a clip-generation job for one character. Returns the jobId; the
 * caller polls via {@link pollJob} or {@link generateClips}.
 */
export async function startGenerate(
  characterName: string,
  emotions: string[],
): Promise<string> {
  const token = await getCsrfToken();
  const res = await fetch('/api/live-portrait/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    credentials: 'include',
    body: JSON.stringify({ characterName, emotions }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Generation kickoff failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.jobId) throw new Error('No jobId returned from /api/live-portrait/generate');
  return data.jobId;
}

/** Poll a single status snapshot. */
export async function pollJob(jobId: string): Promise<JobStatus> {
  const res = await fetch(`/api/live-portrait/status/${encodeURIComponent(jobId)}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Status poll failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * One-shot helper: kick off a job, poll until done, return the clip URL map.
 * Surfaces incremental progress via the optional callback.
 */
export async function generateClips(
  characterName: string,
  emotions: string[],
  onProgress?: (state: JobStatus) => void,
): Promise<EmotionClips> {
  const jobId = await startGenerate(characterName, emotions);
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const state = await pollJob(jobId);
    onProgress?.(state);
    if (state.status === 'completed') return state.clips;
    if (state.status === 'error') throw new Error(state.error || 'Generation errored');
  }
  throw new Error('Generation timed out');
}
