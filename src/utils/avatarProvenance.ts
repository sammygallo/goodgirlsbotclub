/**
 * Avatar provenance — the client half of the character-selfie safety gate.
 *
 * See `docs/character-selfies-design.md` §7. Character selfies are avatar-
 * conditioned (FLUX Kontext reproduces the avatar's identity), so the backend
 * only generates them for avatars known to depict a FICTIONAL character — never
 * a real person's uploaded photo (the NCII red line).
 *
 * The frontend's job (Phase 0): record how each avatar came to be, at the moment
 * the avatar is set, and send it to the backend as the EXPLICIT
 * `avatar_provenance_source` field on create/edit — in-app generation →
 * 'generated' (clears an avatar automatically), user upload → 'uploaded'
 * (blocked), imported card → 'imported' (blocked, never trusts an embedded
 * card stamp). Phase 3: a user can additionally attest a freshly-uploaded
 * image is fictional/AI-generated (an explicit, logged checkbox at upload
 * time — see CharacterCreation/CharacterEdit/InterviewAvatarStep), sending
 * 'fictional-declared' instead of 'uploaded' — this is the ONLY way an
 * upload clears the gate; the choice is never inferred or defaulted on.
 *
 * Crucially this is sent ONLY when a new avatar is chosen this save. A text-only
 * edit sends nothing, so the backend preserves the existing value; an avatar
 * *swap* to an upload sends 'uploaded' and downgrades a previously-cleared row.
 * It is deliberately NOT written into the card `data` blob — a stamp that
 * round-trips through every save could be re-trusted on a later innocent edit and
 * silently reopen the gate (the import→edit bypass this design avoids).
 */

export type AvatarSource = 'generated' | 'uploaded' | 'imported' | 'fictional-declared';

/**
 * The backend-side provenance column values (`CharacterInfo.avatar_provenance`,
 * read-only from the server) that CLEAR an avatar for selfie generation. Mirror
 * of the backend's SELFIE_ALLOWED set. Anything else — 'uploaded', 'unknown',
 * undefined, or an unrecognized value — is blocked. Note this vocabulary differs
 * from the outbound `AvatarSource` write side (the backend maps 'imported' →
 * 'uploaded', and 'grandfathered' is a backend-only backfill value).
 */
const SELFIE_CLEARED_PROVENANCE = new Set(['generated', 'fictional-declared', 'grandfathered']);

/** Whether a character's server-side `avatar_provenance` clears it for selfies. */
export function avatarProvenanceAllowsSelfies(provenance: string | null | undefined): boolean {
  return provenance != null && SELFIE_CLEARED_PROVENANCE.has(provenance);
}
