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
 * 'generated' (the only value that clears an avatar going forward), user upload →
 * 'uploaded', imported card → 'imported' (both blocked server-side).
 *
 * Crucially this is sent ONLY when a new avatar is chosen this save. A text-only
 * edit sends nothing, so the backend preserves the existing value; an avatar
 * *swap* to an upload sends 'uploaded' and downgrades a previously-cleared row.
 * It is deliberately NOT written into the card `data` blob — a stamp that
 * round-trips through every save could be re-trusted on a later innocent edit and
 * silently reopen the gate (the import→edit bypass this design avoids).
 */

export type AvatarSource = 'generated' | 'uploaded' | 'imported';
