/**
 * `[selfie: …]` inline-command parsing — the trigger half of the in-chat
 * character-selfie feature (docs/character-selfies-design.md §4).
 *
 * Mirrors the `[lovense: …]` machinery (utils/lovense.ts): a fully-closed-tag
 * regex (so a half-streamed tag never matches), a cheap presence check, and a
 * strip-for-display function. The character emits `[selfie: <comma-separated
 * descriptors>]` in-narrative; the client owns the actual generation (see
 * stores/selfieStore), the model only requests it — generation stays gated on
 * our rules (provenance + permission + one-per-message), not the model's whim.
 *
 * v1 uses the FIRST tag in a message only (one selfie per message). The raw tag
 * is kept in the stored message and stripped at render time, exactly like
 * lovense, so the post-completion dispatcher can still read it.
 */

// Only a fully-closed [selfie: …] tag matches (no unterminated half-stream).
const SELFIE_TAG_RE = /\[selfie\s*:\s*([^\]]*)\]/gi;

/** Cheap presence check — avoids running the full parse on every stream tick. */
export function hasSelfieTag(text: string): boolean {
  return /\[selfie\s*:/i.test(text);
}

/**
 * The descriptor string of the FIRST `[selfie: …]` tag in `text`, trimmed, or
 * null if there is none. An empty-but-present tag (`[selfie:]`) returns '' (a
 * valid request — the backend has a fixed identity/framing anchor and treats
 * empty descriptors fine).
 */
export function parseSelfieDirective(text: string): string | null {
  SELFIE_TAG_RE.lastIndex = 0; // reset — the regex is global/stateful
  const m = SELFIE_TAG_RE.exec(text);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/** Remove [selfie: …] tags from text for display (raw stays in the store). */
export function stripSelfieTags(text: string): string {
  return text.replace(SELFIE_TAG_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');
}

/**
 * Whether a pending (async) selfie still targets the chat that requested it.
 * generateSelfie can take a while (job/poll under the hood — a cold Replicate
 * boot routinely takes minutes) and the user can navigate away meanwhile, so the
 * dispatcher must drop — never misattribute — the result unless BOTH the selected
 * character's avatar AND the open chat file are unchanged since fire time. A
 * same-character switch to a different chat FILE moves it too, hence both checks.
 */
export function selfieTargetUnchanged(
  selectedAvatar: string | null | undefined,
  originAvatar: string,
  currentChatFile: string | null,
  originChatFile: string | null,
): boolean {
  return selectedAvatar === originAvatar && currentChatFile === originChatFile;
}
