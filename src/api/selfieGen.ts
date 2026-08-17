import { getCsrfToken } from './client';

/**
 * Character-selfie generation client — talks to the backend's
 * `POST /api/selfie/generate`, which feeds the character's own avatar to FLUX
 * Kontext and returns a still "selfie" (identity-preserving, reframed as a phone
 * selfie). Unlike scene-video this is SYNCHRONOUS — the SFW tier renders in
 * seconds on Replicate, so there is no job/poll; the call returns the served
 * blob URL directly.
 *
 * Safety: the backend gates on the character's avatar provenance (only
 * generated/fictional-declared/grandfathered avatars) and on permissions
 * (`generation:image`; the nsfw tier additionally needs `generation:video`).
 * The in-chat auto-trigger only ever requests `sfw` (see stores/selfieStore).
 */

export type SelfieTier = 'sfw' | 'nsfw';

/**
 * Generate a selfie for `characterName` (the character's display name, matching
 * how scene-video keys it). `descriptors` are the free-text hints from the
 * `[selfie: …]` tag (outfit/setting/expression). Returns the served image URL
 * (e.g. `/blobs/selfie/…png`). Throws on any backend error so the caller can
 * degrade gracefully.
 */
export async function generateSelfie(
  characterName: string,
  descriptors: string,
  tier: SelfieTier = 'sfw',
): Promise<string> {
  const token = await getCsrfToken();
  const res = await fetch('/api/selfie/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    credentials: 'include',
    body: JSON.stringify({ characterName, prompt: descriptors, tier }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.detail || err.error || `Selfie generation failed (HTTP ${res.status})`,
    );
  }
  const data = await res.json();
  if (!data.imageUrl) throw new Error('No imageUrl returned from /api/selfie/generate');
  return data.imageUrl as string;
}
