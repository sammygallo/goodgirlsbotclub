import { getCsrfToken } from './client';

/**
 * Scene-video generation client — talks to the backend's
 * `/api/scene-video/*` route family, which renders Replicate
 * wan-2.7-r2v segments (character avatar as the identity reference,
 * scene prompt from the transcript summarizer) and concatenates them
 * into a ~30s MP4.
 *
 * The backend handles auth, secrets, segment rendering, and saving the
 * resulting MP4 into user_blobs; this module just kicks off a job and
 * polls until it's done. Three 10s segments at minutes each means a
 * full scene can take a while, so callers should surface the progress
 * callback rather than block the UI.
 */

export interface SceneJobStatus {
  status: 'queued' | 'running' | 'completed' | 'error';
  progress: number;
  videoUrl: string | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 5000;
// Generous — matches the backend's 10-min-per-segment budget (×3) + concat.
const POLL_TIMEOUT_MS = 35 * 60 * 1000;

/**
 * Kick off a scene-video job. Returns the jobId; the caller polls via
 * {@link pollSceneJob} or {@link generateSceneVideo}.
 */
export async function startSceneGenerate(
  characterName: string,
  prompt: string,
): Promise<string> {
  const token = await getCsrfToken();
  const res = await fetch('/api/scene-video/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    credentials: 'include',
    body: JSON.stringify({ characterName, prompt }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.error || `Scene generation kickoff failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.jobId) throw new Error('No jobId returned from /api/scene-video/generate');
  return data.jobId;
}

/** Poll a single status snapshot. */
export async function pollSceneJob(jobId: string): Promise<SceneJobStatus> {
  const res = await fetch(`/api/scene-video/status/${encodeURIComponent(jobId)}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || err.error || `Status poll failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * One-shot helper: kick off a job, poll until done, return the served
 * video URL (`/blobs/scene-video/...`). Surfaces incremental progress
 * via the optional callback.
 */
export async function generateSceneVideo(
  characterName: string,
  prompt: string,
  onProgress?: (state: SceneJobStatus) => void,
): Promise<string> {
  const jobId = await startSceneGenerate(characterName, prompt);
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const state = await pollSceneJob(jobId);
    onProgress?.(state);
    if (state.status === 'completed') {
      if (!state.videoUrl) throw new Error('Scene completed but no video URL returned');
      return state.videoUrl;
    }
    if (state.status === 'error') throw new Error(state.error || 'Scene generation errored');
  }
  throw new Error('Scene generation timed out');
}
