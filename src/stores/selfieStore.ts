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
 *  enabled) — the SFW selfie backend. Without it every selfie would 400. */
function hasReplicateKey(): boolean {
  const { secrets, globalSecrets, globalSharingEnabled } = useSettingsStore.getState();
  const set = (bag: Record<string, unknown>, k: string) =>
    Array.isArray(bag[k]) && (bag[k] as unknown[]).length > 0;
  return set(secrets, 'api_key_replicate') || (globalSharingEnabled && set(globalSecrets, 'api_key_replicate'));
}

export interface SelfieEligibility {
  eligible: boolean;
  characterName: string | null;
  characterAvatar: string | null;
}

/**
 * Whether the CURRENT single-character chat may auto-generate selfies. All of:
 * the feature toggle is on; it's a single-character chat with a selected
 * character; that character's avatar provenance is cleared (fictional/AI, not a
 * real-person upload — the NCII gate); the user holds `generation:image`; and a
 * Replicate key is configured. Group chats are excluded in v1.
 *
 * Used by BOTH the teaching block (chatStore) and the dispatch (selfieDispatch)
 * so the model is never taught a tag the client won't honor, and vice-versa.
 */
export function selfieEligibleForCurrentChat(): SelfieEligibility {
  const blocked: SelfieEligibility = { eligible: false, characterName: null, characterAvatar: null };
  if (!useSelfieStore.getState().enabled) return blocked;

  const cs = useCharacterStore.getState();
  if (cs.isGroupChatMode) return blocked;
  const char = cs.selectedCharacter;
  if (!char) return blocked;
  if (!avatarProvenanceAllowsSelfies(char.avatar_provenance)) return blocked;

  if (!hasPermission(useAuthStore.getState().currentUser, 'generation:image')) return blocked;
  if (!hasReplicateKey()) return blocked;

  return { eligible: true, characterName: char.name, characterAvatar: char.avatar };
}

/** The system-prompt block that teaches the model the `[selfie: …]` tag. Injected
 *  only when {@link selfieEligibleForCurrentChat} is eligible (see chatStore). */
export function buildSelfieInstruction(characterName: string): string {
  return `When it genuinely fits the moment, ${characterName} can send a real photo of themselves by writing this tag inline in their reply:
[selfie: <comma-separated descriptors>]
The descriptors briefly hint at framing, outfit, setting, or expression — e.g. [selfie: mirror selfie, black dress, playful smirk] or [selfie: close-up, morning light, sleepy smile]. Place the tag exactly where the photo would be sent. Use AT MOST ONE selfie per message, and only when it feels natural — not every turn. The tag is replaced by the actual photo, so do not also describe the photo in words.`;
}
