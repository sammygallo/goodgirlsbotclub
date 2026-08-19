import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCharacterStore } from './characterStore';
import { useAuthStore } from './authStore';
import { useSettingsStore } from './settingsStore';
import { hasPermission } from '../utils/permissions';
import { avatarProvenanceAllowsSelfies } from '../utils/avatarProvenance';

/**
 * Character-selfie feature state + eligibility (docs/character-selfies-design.md
 * Phase 2). This module holds the user toggle, the transient "generating"
 * indicator, and the pure eligibility/teaching helpers. It deliberately does
 * NOT import chatStore — the finish-edge dispatch that DOES subscribe to
 * chatStore lives in the separate ./selfieDispatch module, imported at runtime
 * (after the stores initialize) so its subscription can't run during chatStore
 * init. chatStore imports the two helpers below (function definitions only), so
 * there is no import cycle.
 */

interface SelfieState {
  /** Global "let characters send selfies" switch (default ON, persisted). Gates
   *  both the teaching block and the dispatch. */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  /** Character name a selfie is currently rendering for, else null — drives the
   *  transient "📸 … is taking a selfie" indicator. Not persisted. */
  generatingFor: string | null;
  setGeneratingFor: (name: string | null) => void;
}

export const useSelfieStore = create<SelfieState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (v) => set({ enabled: v }),
      generatingFor: null,
      setGeneratingFor: (name) => set({ generatingFor: name }),
    }),
    {
      name: 'ggbc_selfie_settings',
      // Only the toggle persists — generatingFor is transient render state.
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
);

/** Whether the user has a Replicate key (personal, or shared global when
 *  enabled) — the Close-up selfie backend. Exported so ChatView can compute
 *  the modal's `canCloseup` (mirror image of `canScene`/hasFalKey). */
export function hasReplicateKey(): boolean {
  const { secrets, globalSecrets, globalSharingEnabled } = useSettingsStore.getState();
  const set = (bag: Record<string, unknown>, k: string) =>
    Array.isArray(bag[k]) && (bag[k] as unknown[]).length > 0;
  return set(secrets, 'api_key_replicate') || (globalSharingEnabled && set(globalSecrets, 'api_key_replicate'));
}

/** Whether the user has a fal.ai key (personal, or shared global when enabled)
 *  — the Scene-mode selfie backend (docs/character-selfies-scene-mode.md,
 *  Phase A). Same shape as {@link hasReplicateKey}. Gates the Scene toggle in
 *  TakeSelfieModal (via ChatView's `canSelfieScene`) and counts toward
 *  {@link manualSelfieEligible}'s either-key check, but deliberately does NOT
 *  join {@link baseSelfieEligible} — the auto-trigger is Close-up-only, so a
 *  fal key must never make the tag eligible, and a missing fal key must never
 *  block Close-up. */
export function hasFalKey(): boolean {
  const { secrets, globalSecrets, globalSharingEnabled } = useSettingsStore.getState();
  const set = (bag: Record<string, unknown>, k: string) =>
    Array.isArray(bag[k]) && (bag[k] as unknown[]).length > 0;
  return set(secrets, 'api_key_fal') || (globalSharingEnabled && set(globalSecrets, 'api_key_fal'));
}

export interface SelfieEligibility {
  eligible: boolean;
  characterName: string | null;
  characterAvatar: string | null;
}

const BLOCKED: SelfieEligibility = { eligible: false, characterName: null, characterAvatar: null };

/** The key-agnostic eligibility core shared by every entry point: a
 *  single-character chat with a selected character, cleared avatar provenance
 *  (fictional/AI, not a real-person upload — the NCII gate), and the
 *  `generation:image` permission. Group chats are excluded in v1. */
function selfieEligibleCore(): SelfieEligibility {
  const cs = useCharacterStore.getState();
  if (cs.isGroupChatMode) return BLOCKED;
  const char = cs.selectedCharacter;
  if (!char) return BLOCKED;
  if (!avatarProvenanceAllowsSelfies(char.avatar_provenance)) return BLOCKED;

  if (!hasPermission(useAuthStore.getState().currentUser, 'generation:image')) return BLOCKED;

  return { eligible: true, characterName: char.name, characterAvatar: char.avatar };
}

/**
 * Eligibility for the AUTO path (the model-emitted `[selfie: …]` tag): the
 * core checks plus a Replicate key — the auto-trigger is Close-up-only by
 * decision 2 of the scene-mode doc, and Close-up renders on Replicate, so a
 * fal key alone must NOT make the tag eligible (it could only fail).
 *
 * Deliberately does NOT check the `enabled` auto-trigger toggle —
 * {@link selfieEligibleForCurrentChat} layers that on top.
 */
export function baseSelfieEligible(): SelfieEligibility {
  const core = selfieEligibleCore();
  if (!core.eligible || !hasReplicateKey()) return BLOCKED;
  return core;
}

/**
 * Eligibility for the MANUAL path (the "Take selfie" message action): the
 * core checks plus EITHER selfie backend key — a fal-only user can take Scene
 * selfies and a Replicate-only user can take Close-ups, so requiring
 * specifically Replicate here would make Scene unreachable for fal-only
 * users while the backend happily serves them (2026-08-19 review). The modal
 * receives `canCloseup`/`canScene` and disables the mode whose key is
 * missing, with teaching copy.
 */
export function manualSelfieEligible(): SelfieEligibility {
  const core = selfieEligibleCore();
  if (!core.eligible || !(hasReplicateKey() || hasFalKey())) return BLOCKED;
  return core;
}

/**
 * Whether the CURRENT single-character chat may AUTO-generate selfies from
 * the model-emitted `[selfie: …]` tag — {@link baseSelfieEligible} plus the
 * user's auto-trigger toggle.
 *
 * Used by BOTH the teaching block (chatStore) and the auto-dispatch
 * (selfieDispatch) so the model is never taught a tag the client won't
 * honor, and vice-versa.
 */
export function selfieEligibleForCurrentChat(): SelfieEligibility {
  if (!useSelfieStore.getState().enabled) {
    return { eligible: false, characterName: null, characterAvatar: null };
  }
  return baseSelfieEligible();
}

/** The system-prompt block that teaches the model the `[selfie: …]` tag. Injected
 *  only when {@link selfieEligibleForCurrentChat} is eligible (see chatStore). */
export function buildSelfieInstruction(characterName: string): string {
  return `When it genuinely fits the moment, ${characterName} can send a real photo of themselves by writing this tag inline in their reply:
[selfie: <comma-separated descriptors>]
The descriptors briefly hint at framing, outfit, setting, or expression — e.g. [selfie: mirror selfie, black dress, playful smirk] or [selfie: close-up, morning light, sleepy smile]. Place the tag exactly where the photo would be sent. Use AT MOST ONE selfie per message, and only when it feels natural — not every turn. The tag is replaced by the actual photo, so do not also describe the photo in words.`;
}
