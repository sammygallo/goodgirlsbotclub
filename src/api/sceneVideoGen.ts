import { getCsrfToken } from './client';

/**
 * Scene-video generation client — talks to the backend's
 * `/api/scene-video/*` route family, which builds a FLUX Kontext keyframe
 * from the character avatar, animates it through one wan-2.2 clip per motion
 * beat (scene prompt + beats from the transcript summarizer), and
 * concatenates them into a ~15s MP4.
 *
 * The backend handles auth, secrets, segment rendering, and saving the
 * resulting MP4 into user_blobs; this module just kicks off a job and polls
 * until it's done. Each clip renders in minutes, so a full scene can take a
 * while — callers should surface the progress callback rather than block
 * the UI.
 */

export interface SceneJobStatus {
  status: 'queued' | 'running' | 'completed' | 'error';
  progress: number;
  videoUrl: string | null;
  keyframeUrl?: string | null;
  error: string | null;
}

/** One entry of the curated motion menu (self-hosted Wan-Animate path). */
export interface SceneDriver {
  id: string;
  label: string;
}

const POLL_INTERVAL_MS = 5000;
// Generous — must cover the self-hosted animate path, where one serverless
// job absorbs a full cold start + render (backend's own budget is 40 min).
const POLL_TIMEOUT_MS = 45 * 60 * 1000;

/** Extract a HUMAN-READABLE message from an error body. FastAPI's own
 *  HTTPExceptions put a string in `detail`, but Pydantic validation failures
 *  422 with an ARRAY of error objects there — and `new Error(array)` renders
 *  as "[object Object]" in the toast. Only trust string fields; otherwise
 *  fall back to the caller's generic message. Same per-module helper shape as
 *  livePortraitGen.ts / selfieGen.ts / loraTraining.ts (2026-08-24 hardening —
 *  this module had never been guarded, unlike its siblings). */
function errorMessage(err: Record<string, unknown>, fallback: string): string {
  if (typeof err.detail === 'string') return err.detail;
  if (typeof err.error === 'string') return err.error;
  return fallback;
}

/**
 * The motion menu for the Generate Scene modal. Empty on the Replicate
 * path (backend env unset) — callers fall back to the beats flow. Errors
 * degrade to [] so the modal never blocks on this call.
 */
export async function fetchSceneDrivers(): Promise<SceneDriver[]> {
  try {
    const res = await fetch('/api/scene-video/drivers', { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Kick off a scene-video job. Returns the jobId; the caller polls via
 * {@link pollSceneJob} or {@link generateSceneVideo}.
 */
export async function startSceneGenerate(
  characterName: string,
  prompt: string,
  beats: string[] = [],
  driverId?: string,
): Promise<string> {
  const token = await getCsrfToken();
  const res = await fetch('/api/scene-video/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    credentials: 'include',
    body: JSON.stringify({
      characterName,
      prompt,
      beats,
      ...(driverId ? { driverId } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, `Scene generation kickoff failed (HTTP ${res.status})`));
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
    throw new Error(errorMessage(err, `Status poll failed (HTTP ${res.status})`));
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
  beats: string[] = [],
  driverId?: string,
  onProgress?: (state: SceneJobStatus) => void,
): Promise<string> {
  const jobId = await startSceneGenerate(characterName, prompt, beats, driverId);
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
