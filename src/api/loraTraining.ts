import { getCsrfToken } from './client';

/**
 * Studio-tier LoRA training client (Phase C1 —
 * docs/character-selfies-lora-tier.md). Talks to the backend's
 * `/api/selfie/lora/*` routes.
 *
 * Deliberately NOT a jobId/poll-loop client like selfieGen/sceneVideoGen:
 * training is a 20-minute-class PAID job whose state lives in the backend's
 * DB (a lifespan worker drives it), and the status endpoint is keyed by
 * CHARACTER — so any device, any reload, can rejoin the poll. The frontend
 * never holds a jobId; `useLoraStatus` just re-fetches this status.
 *
 * The kickoff spends ~$3.30 of the user's own keys (bootstrap views + the
 * fal trainer), so a duplicate request while one is in flight is a 409 the
 * UI surfaces as information, never a silent second spend.
 */

export type LoraTrainingStatus =
  | 'none'
  | 'pending'
  | 'bootstrapping'
  | 'submitting'
  | 'training'
  | 'succeeded'
  | 'failed';

export interface LoraStatus {
  status: LoraTrainingStatus;
  error: string | null;
  updatedAt: string | null;
}

/** Statuses that mean a training is actively in flight (worth polling). */
export const LORA_INFLIGHT_STATUSES: readonly LoraTrainingStatus[] = [
  'pending',
  'bootstrapping',
  'submitting',
  'training',
];

/** Only trust STRING detail/error fields — FastAPI validation failures put
 *  an ARRAY in `detail`, which would render as "[object Object]" (the Phase A
 *  review lesson, same helper shape as selfieGen's). */
function errorMessage(err: Record<string, unknown>, fallback: string): string {
  if (typeof err.detail === 'string') return err.detail;
  if (typeof err.error === 'string') return err.error;
  return fallback;
}

/** Kick off a training for `characterName`. Resolves on accepted (the worker
 *  takes it from there); throws with the backend's message otherwise —
 *  including the 409 "already in progress" case. `steps` (Phase C3, backend
 *  bounds 250–2000) tunes the trainer's step count; omitted → the server
 *  default 1000. fal prices the run linearly in steps (~$2 at 1000). */
export async function startLoraTraining(
  characterName: string,
  steps?: number,
): Promise<void> {
  const token = await getCsrfToken();
  const res = await fetch('/api/selfie/lora/train', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    credentials: 'include',
    body: JSON.stringify(
      steps === undefined ? { characterName } : { characterName, steps },
    ),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, `Training kickoff failed (HTTP ${res.status})`));
  }
}

/** What the backend's delete actually did (Phase C3). The provider-side
 *  half is best-effort by construction: fal's payload-deletion API wants an
 *  admin-scoped key (most BYO keys aren't), and the durable weights/zip are
 *  plain uploads fal has no delete API for — `unresolvedRequestIds` lists
 *  what wasn't confirmed removed; those files remain in the user's own fal
 *  dashboard. */
export interface LoraDeleteResult {
  deletedRows: number;
  blobsDeleted: number;
  providerPayloadsDeleted: number;
  providerPayloadsUnauthorized: number;
  providerPayloadsFailed: number;
  unresolvedRequestIds: string[];
}

/** Delete `characterName`'s Studio training: every training row, the local
 *  bootstrap cache, and (best-effort) the fal-side request payloads.
 *  Generated selfies are kept. 409 while a training is in flight. */
export async function deleteLoraTraining(
  characterName: string,
): Promise<LoraDeleteResult> {
  const token = await getCsrfToken();
  const res = await fetch(
    `/api/selfie/lora/${encodeURIComponent(characterName)}`,
    {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': token },
      credentials: 'include',
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, `Delete failed (HTTP ${res.status})`));
  }
  return res.json();
}

/** Fetch the character-keyed training status. `status: "none"` means the
 *  character has never been trained. */
export async function fetchLoraStatus(characterName: string): Promise<LoraStatus> {
  const res = await fetch(
    `/api/selfie/lora/status/${encodeURIComponent(characterName)}`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorMessage(err, `Status fetch failed (HTTP ${res.status})`));
  }
  return res.json();
}
