import { useChatStore } from './chatStore';
import { useCharacterStore } from './characterStore';
import { useImageGenStore } from './imageGenStore';
import { generateSelfie, type SelfieMode, type SelfieTier } from '../api/selfieGen';
import { hasSelfieTag, parseSelfieDirective, selfieTargetUnchanged } from '../utils/selfie';
import { selfieEligibleForCurrentChat, useSelfieStore } from './selfieStore';

/**
 * In-chat selfie DISPATCH — the finish-edge side of the `[selfie: …]` feature
 * (docs/character-selfies-design.md Phase 2). Mirrors the Lovense reaction seam
 * (stores/lovenseStore.ts): a single module-level `useChatStore.subscribe` that,
 * when a message finishes streaming, fires the selfie generation exactly once.
 *
 * Kept in its own module (imported by ChatView at runtime, NOT by chatStore) so
 * the subscription below can't register during chatStore's own init — see the
 * note in ./selfieStore. The client owns the trigger; the model only requests
 * it, and every generation re-checks eligibility here (never trust the tag alone).
 *
 * The tag-driven auto-dispatch below always requests `sfw` — NSFW is
 * deliberately not model-triggered in chat (keeps NSFW generation on our
 * rules, not the model's). {@link triggerSelfie} is the shared generation
 * path, also used directly by the manual "Take selfie" message action
 * (ChatView.tsx), which DOES let the user pick `nsfw` (gated on
 * `generation:video` — see ChatView's `canSelfieNsfw`).
 */

function activeAiMessage(state: ReturnType<typeof useChatStore.getState>) {
  const msgs = state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.isUser || m.isSystem) continue;
    return m;
  }
  return null;
}

export interface TriggerSelfieOptions {
  characterName: string;
  descriptors: string;
  characterAvatar: string;
  tier: SelfieTier;
  /** 'closeup' (default — the Kontext edit-in-place) | 'scene' (the fal.ai
   *  reference-conditioned generator; manual-only per the scene-mode doc's
   *  decision 2 — the auto-dispatch below never sets this). */
  mode?: SelfieMode;
  /** Called on generation failure. Omit to degrade silently (the auto-dispatch's
   *  behavior — the model's own narration already covers it, see design §8); a
   *  manual trigger should pass this to surface a toast, since a user who
   *  explicitly asked for a selfie needs to see it fail, not silence. */
  onError?: (err: Error) => void;
}

/**
 * Generate one selfie and, on success, insert it as a new image message.
 * Shared by the tag-driven auto-dispatch (below) and the manual "Take
 * selfie" message action.
 */
export async function triggerSelfie({
  characterName,
  descriptors,
  characterAvatar,
  tier,
  mode = 'closeup',
  onError,
}: TriggerSelfieOptions): Promise<void> {
  const { setGeneratingFor } = useSelfieStore.getState();
  // Snapshot the origin chat at fire time. generateSelfie can take a while (a
  // cold Replicate boot; see api/selfieGen.ts), and the user can navigate away
  // meanwhile — insertImageMessage always targets the LIVE messages/
  // currentChatFile, so without this the selfie would land in (and persist
  // to) whatever chat is open when it resolves.
  const originChatFile = useChatStore.getState().currentChatFile;
  setGeneratingFor(characterName);
  try {
    const imageUrl = await generateSelfie(characterName, descriptors, tier, mode);
    const character = useCharacterStore.getState().selectedCharacter;
    // Drop (don't misattribute) unless we're STILL on the exact character + chat
    // file that requested it — see selfieTargetUnchanged.
    if (
      !character ||
      !selfieTargetUnchanged(
        character.avatar,
        characterAvatar,
        useChatStore.getState().currentChatFile,
        originChatFile,
      )
    ) {
      return;
    }
    // Empty caption — the image speaks for itself; the reply already narrated it.
    await useChatStore
      .getState()
      .insertImageMessage(imageUrl, '', characterName, characterAvatar, character);
    // Gallery save is a convenience — never let it break the chat insert.
    try {
      useImageGenStore.getState().addToGallery({
        id: crypto.randomUUID(),
        dataUrl: imageUrl,
        prompt: descriptors || 'selfie',
        backend: 'selfie',
        timestamp: Date.now(),
        character: characterName,
      });
    } catch {
      /* gallery is localStorage-only convenience */
    }
  } catch (err) {
    if (onError) {
      onError(err instanceof Error ? err : new Error(String(err)));
    } else {
      // Graceful degrade (design §8): no dead bubble — the model's own narration
      // ("*sends a selfie*") stands, and the stripped tag left the text clean.
      console.warn('[selfie] generation failed; leaving the narrated reply as-is:', err);
    }
  } finally {
    setGeneratingFor(null);
  }
}

// Stream-start snapshot: the reaction target + its length when streaming began,
// so we react only to a message that actually GREW this stream (skips
// Impersonate, whose stream goes to the input box) and only scan the NEWLY added
// text (so `continue` doesn't re-fire a tag from earlier in the message).
let _prevStreaming = false;
let _streamStart: { id: string; swipeId: number; len: number } | null = null;
let _firedThisStream = false;

useChatStore.subscribe((state) => {
  const streaming = state.isStreaming;
  const wasStreaming = _prevStreaming;
  _prevStreaming = streaming;

  if (streaming && !wasStreaming) {
    const m = activeAiMessage(state);
    _streamStart = m ? { id: m.id, swipeId: m.swipeId, len: m.content.length } : null;
    _firedThisStream = false;
    return;
  }

  // Only act on the true→false finish edge, once per stream.
  const finished = wasStreaming && !streaming;
  if (!finished || _firedThisStream) return;

  const msg = activeAiMessage(state);
  if (!msg) return;

  // Growth gate: same message that started this stream, and it grew.
  const grew =
    !!_streamStart &&
    msg.id === _streamStart.id &&
    msg.swipeId === _streamStart.swipeId &&
    msg.content.length > _streamStart.len;
  if (!grew) return;

  // Consider only text added THIS stream (so continue ignores earlier tags).
  const newText = msg.content.slice(_streamStart!.len);
  if (!hasSelfieTag(newText)) return;

  const { eligible, characterName, characterAvatar } = selfieEligibleForCurrentChat();
  if (!eligible || !characterName || !characterAvatar) return;

  const descriptors = parseSelfieDirective(newText);
  if (descriptors === null) return;

  _firedThisStream = true; // claim before the async call so a re-entry can't double-fire
  // tier + mode are HARDCODED here: the model-triggered path is Close-up + SFW
  // only (scene-mode doc, decision 2 — no surprise fal spend, no key
  // assumption). Scene is a deliberate manual choice in TakeSelfieModal.
  void triggerSelfie({ characterName, descriptors, characterAvatar, tier: 'sfw', mode: 'closeup' });
});
