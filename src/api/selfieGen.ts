import { getCsrfToken } from './client';

/**
 * Character-selfie generation client — talks to the backend's
 * `/api/selfie/*` route family, which feeds the character's own avatar to
 * FLUX Kontext (or, nsfw tier, the self-hosted scene-worker) and returns a
 * still "selfie" (identity-preserving, reframed as a phone selfie).
 *
 * Async job/poll (2026-08-17 fix — mirrors sceneVideoGen.ts): generation used
 * to be a single blocking POST, on the assumption the sfw/Replicate tier
 * "renders in seconds." A cold Replicate boot can take several minutes
 * instead (observed ~5m06s), and the reverse proxy in front of this app has a
 * 60s default timeout on anything that isn't this shape — so a slow-but-
 * otherwise-successful generation surfaced as a 504 to the user well before
 * the backend gave up. `POST /api/selfie/generate` now returns a `jobId`
 * immediately and `GET /api/selfie/status/{jobId}` is polled until terminal,
 * so no single request is held open long enough to hit that ceiling.
 *
 * `generateSelfie`'s signature is unchanged from the old synchronous version
 * (still `Promise<string>` resolving to the served image URL) — the poll
 * loop is entirely internal, so existing callers (stores/selfieDispatch)
 * needed no changes.
 *
 * Safety: the backend gates on the character's avatar provenance (only
 * generated/fictional-declared/grandfathered avatars) and on permissions
 * (`generation:image`; the nsfw tier additionally needs `generation:video`).
 * The in-chat auto-trigger only ever requests `sfw` (see stores/selfieStore).
 *
 * Scene mode (docs/character-selfies-scene-mode.md, Phase A): `mode: 'scene'`
 * routes to the fal.ai reference-conditioned generator (BYO `api_key_fal`) —
 * brand-new setting/pose, identity + art style held — instead of the Kontext
 * edit-in-place. Phase A is SFW-only (the backend 400s `scene`+`nsfw`), and
 * the auto-trigger never requests it (decision 2: Scene is manual-only).
 *
 * Studio mode (docs/character-selfies-lora-tier.md, Phase C2): `mode: 'lora'`
 * serves the character's TRAINED per-character LoRA via fal.ai flux-lora
 * (same `api_key_fal`, ~$0.04/image) — full scene freedom like Scene, but the
 * identity is memorized in the weights. Requires a succeeded training
 * (`CharacterInfo.lora_status === 'succeeded'`); the backend's serve gate
 * additionally re-checks the avatar bytes' hash and provenance. SFW-only like
 * Scene (the backend 400s `lora`+`nsfw`), manual-only like Scene.
 */

export type SelfieTier = 'sfw' | 'nsfw';
export type SelfieMode = 'closeup' | 'scene' | 'lora';

interface SelfieJobStatus {
  status: 'queued' | 'running' | 'completed' | 'error';
  imageUrl: string | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 3000;
// Padded past the backend's own worst-case budget (8min Replicate cold-boot
// poll, 15min RunPod cold-boot poll — see selfie.py's _SFW_TIMEOUT_SEC /
// RUNPOD_KEYFRAME_TIMEOUT_SEC), PLUS extra slack for the RunPod path's own
// HTTP round-trips: _render_keyframe_only's 15min budget only bounds time
// between submit and the final poll, not the submit/poll HTTP calls
// themselves, each separately capped at the shared httpx client's 120s
// timeout (adversarial review finding, 2026-08-17) — so worst-case real
// elapsed time is closer to 15min + ~4min of HTTP latency than a clean 15min.
// 25 minutes leaves real margin over that, mirroring how generously
// sceneVideoGen.ts's POLL_TIMEOUT_MS (45min) pads its own worst case.
const POLL_TIMEOUT_MS = 25 * 60 * 1000;

/** Extract a HUMAN-READABLE message from an error body. FastAPI's own
 *  HTTPExceptions put a string in `detail`, but Pydantic validation failures
 *  (e.g. a >400-char prompt) 422 with an ARRAY of error objects there — and
 *  `new Error(array)` renders as "[object Object]" in the toast. Only trust
 *  string fields; otherwise fall back to the caller's generic message. */
function errorMessage(err: Record<string, unknown>, fallback: string): string {
  if (typeof err.detail === 'string') return err.detail;
  if (typeof err.error === 'string') return err.error;
  return fallback;
}

async function startSelfieGenerate(
  characterName: string,
  descriptors: string,
  tier: SelfieTier,
  mode: SelfieMode,
): Promise<string> {
  const token = await getCsrfToken();
  const res = await fetch('/api/selfie/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    credentials: 'include',
    body: JSON.stringify({ characterName, prompt: descriptors, tier, mode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, `Selfie generation kickoff failed (HTTP ${res.status})`));
  }
  const data = await res.json();
  if (!data.jobId) throw new Error('No jobId returned from /api/selfie/generate');
  return data.jobId as string;
}

async function pollSelfieJob(jobId: string): Promise<SelfieJobStatus> {
  const res = await fetch(`/api/selfie/status/${encodeURIComponent(jobId)}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, `Status poll failed (HTTP ${res.status})`));
  }
  return res.json();
}

/**
 * Generate a selfie for `characterName` (the character's display name, matching
 * how scene-video keys it). `descriptors` are the free-text hints from the
 * `[selfie: …]` tag (outfit/setting/expression). Returns the served image URL
 * (e.g. `/blobs/selfie/…png`). Throws on any backend error, a job-reported
 * error, or a client-side poll timeout, so the caller can degrade gracefully.
 */
export async function generateSelfie(
  characterName: string,
  descriptors: string,
  tier: SelfieTier = 'sfw',
  mode: SelfieMode = 'closeup',
): Promise<string> {
  const jobId = await startSelfieGenerate(characterName, descriptors, tier, mode);
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const state = await pollSelfieJob(jobId);
    if (state.status === 'completed') {
      if (!state.imageUrl) throw new Error('Selfie completed but no imageUrl returned');
      return state.imageUrl;
    }
    if (state.status === 'error') throw new Error(state.error || 'Selfie generation errored');
  }
  throw new Error('Selfie generation timed out');
}
