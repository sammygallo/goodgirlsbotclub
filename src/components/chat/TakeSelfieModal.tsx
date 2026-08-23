/**
 * TakeSelfieModal — manual trigger for the character-selfie feature
 * (docs/character-selfies-design.md Phase 2.5 + docs/character-selfies-scene-mode.md
 * Phase A). Mirrors GenerateSceneModal's styling/conventions but with none of
 * its async-summarization complexity: a selfie needs only descriptors, a mode,
 * and (for owners) a tier choice — no transcript, no LLM call, no multi-phase flow.
 *
 * Three modes (scene-mode doc §2 + lora-tier doc §1 — fidelity ↔ freedom ↔
 * memorization):
 *   • Close-up (default) — the Kontext edit-in-place: pixel-perfect avatar
 *     fidelity, the avatar's own framing/setting. Descriptors are optional hints.
 *   • Scene — the fal.ai reference-conditioned generator: brand-new
 *     setting/pose/framing, identity + art style held. The prompt IS the
 *     request, so it's required.
 *   • Studio — FLUX + the character's TRAINED LoRA (Phase C2): Scene's full
 *     freedom with the identity memorized in the weights. Requires a trained
 *     model (`studioTrained` — the server-computed `lora_status`) on top of
 *     the fal key Scene already needs; the prompt is required like Scene's.
 *
 * Close-up/Scene are gated on their keys (`canCloseup` = Replicate,
 * `canScene` = fal — ChatView computes both); Studio additionally needs
 * `studioTrained`. A blocked mode renders disabled with teaching copy, so
 * it's discoverable rather than silently absent — Studio's untrained state
 * doubles as the upsell ("train them in Character → Edit"). The default mode
 * on open is whichever base mode is available (a fal-only user lands on
 * Scene; Studio is never the silent default — it's the premium pick).
 *
 * The `sfw`/`nsfw` tier choice only renders when `canNsfw` is true (the
 * caller gates this on `hasPermission(currentUser, 'generation:video')`,
 * mirroring scene-video's own owner-only containment) — without it the tier
 * is implicitly `sfw` with no choice shown, matching how the in-chat
 * auto-trigger already behaves. Scene and Studio force `sfw`: NSFW for both
 * waits on Phase B's output-side gate (the backend 400s them), so selecting
 * either resets the tier and disables the nsfw button rather than letting
 * the user build a request the server will reject.
 */
import { useEffect, useState } from 'react';
import { Camera } from 'lucide-react';
import { Modal, Button, TextArea } from '../ui';
import type { SelfieMode, SelfieTier } from '../../api/selfieGen';

interface TakeSelfieModalProps {
  isOpen: boolean;
  onClose: () => void;
  characterName: string;
  canNsfw: boolean;
  canScene: boolean;
  canCloseup: boolean;
  // Server-computed: the character has servable trained weights for their
  // CURRENT avatar (CharacterInfo.lora_status === 'succeeded').
  studioTrained: boolean;
  onGenerate: (descriptors: string, tier: SelfieTier, mode: SelfieMode) => void;
}

export function TakeSelfieModal({
  isOpen,
  onClose,
  characterName,
  canNsfw,
  canScene,
  canCloseup,
  studioTrained,
  onGenerate,
}: TakeSelfieModalProps) {
  const [descriptors, setDescriptors] = useState('');
  const [tier, setTier] = useState<SelfieTier>('sfw');
  const [mode, setMode] = useState<SelfieMode>('closeup');

  // Reset on each open so a stale draft/tier/mode from a previous use doesn't
  // silently carry over — an nsfw selection in particular must never persist
  // across opens, and neither should Scene (it spends the user's fal credits;
  // scene-mode doc decision 2's "no surprise spend" applies here too). The
  // default mode is whichever backend the user actually has a key for — a
  // fal-only user lands on Scene, not on a dead Close-up.
  useEffect(() => {
    if (isOpen) {
      setDescriptors('');
      setTier('sfw');
      setMode(canCloseup ? 'closeup' : 'scene');
    }
  }, [isOpen, canCloseup]);

  // Studio = Scene's fal key + a trained model for the current avatar.
  const canStudio = canScene && studioTrained;

  const selectMode = (m: SelfieMode) => {
    setMode(m);
    // NSFW Scene/Studio is Phase B — the backend rejects both, so never let
    // the combination be assembled client-side.
    if (m !== 'closeup') setTier('sfw');
  };

  // In Scene/Studio mode the prompt IS the request (the backend 400s an
  // empty one); Close-up keeps descriptors optional.
  const needsPrompt = mode !== 'closeup' && descriptors.trim().length === 0;

  const handleGenerate = () => {
    if (needsPrompt) return;
    onGenerate(descriptors.trim(), tier, mode);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Take a selfie" size="md">
      <div className="space-y-4">
        <div>
          <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">
            Mode
          </div>
          <div className="flex gap-2">
            {(
              [
                { m: 'closeup' as const, label: 'Close-up' },
                { m: 'scene' as const, label: 'Scene' },
                { m: 'lora' as const, label: 'Studio' },
              ]
            ).map(({ m, label }) => {
              const disabledByMode: Record<SelfieMode, boolean> = {
                closeup: !canCloseup,
                scene: !canScene,
                lora: !canStudio,
              };
              const disabled = disabledByMode[m];
              return (
                <button
                  key={m}
                  type="button"
                  disabled={disabled}
                  onClick={() => selectMode(m)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    mode === m
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/15 text-[var(--color-text-primary)]'
                      : disabled
                        ? 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] opacity-50 cursor-not-allowed'
                        : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]/60'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {!canScene && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-1.5">
              Scene and Studio modes put {characterName} in brand-new settings and
              poses — add a fal.ai key under Settings → AI → Media Generation to
              unlock them.
            </p>
          )}
          {!canCloseup && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-1.5">
              Close-up selfies render on Replicate — add a Replicate key under
              Settings → AI → Media Generation to unlock them.
            </p>
          )}
          {canScene && !studioTrained && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-1.5">
              Studio serves a model trained on {characterName} for maximum
              fidelity in any scene — train them under Character → Edit →
              Studio to unlock it.
            </p>
          )}
        </div>

        <TextArea
          label={mode !== 'closeup' ? 'Scene / pose' : 'Descriptors (optional)'}
          value={descriptors}
          onChange={(e) => setDescriptors(e.target.value)}
          placeholder={
            mode !== 'closeup'
              ? 'full-body mirror selfie in her penthouse overlooking Manhattan at dusk'
              : 'mirror selfie, black dress, playful smirk'
          }
          rows={3}
          // Mirrors the backend's _MAX_DESCRIPTOR_CHARS — past it, Pydantic
          // 422s with an array detail the toast can't render, and the modal's
          // reset-on-open would have already discarded the user's draft.
          maxLength={400}
        />

        {canNsfw && (
          <div>
            <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">
              Tier
            </div>
            <div className="flex gap-2">
              {(['sfw', 'nsfw'] as const).map((t) => {
                const disabled = t === 'nsfw' && mode !== 'closeup';
                return (
                  <button
                    key={t}
                    type="button"
                    disabled={disabled}
                    onClick={() => setTier(t)}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium uppercase transition-colors ${
                      tier === t
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/15 text-[var(--color-text-primary)]'
                        : disabled
                          ? 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] opacity-50 cursor-not-allowed'
                          : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]/60'
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            {mode !== 'closeup' && (
              <p className="text-xs text-[var(--color-text-secondary)] mt-1.5">
                NSFW {mode === 'scene' ? 'Scene' : 'Studio'} selfies aren't available
                yet — coming in a later phase.
              </p>
            )}
          </div>
        )}

        <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] leading-relaxed">
          {mode === 'lora' ? (
            <>
              Generates {characterName} from their trained Studio model — any
              setting, pose, and framing, with their exact look memorized in the
              weights — via fal.ai (~$0.04/image). Usually renders in seconds.
            </>
          ) : mode === 'scene' ? (
            <>
              Composes a brand-new image of {characterName} — new setting, pose, and
              framing, identity and art style preserved — from their portrait via
              fal.ai (~$0.15/image). Usually renders in seconds.
            </>
          ) : (
            <>
              Builds a still selfie from {characterName}'s own portrait
              {tier === 'nsfw' ? " via GGBC's self-hosted worker" : ' via Replicate'}. Usually
              renders in seconds, but a cold start can take a few minutes — you can keep
              chatting while it runs.
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleGenerate} disabled={needsPrompt}>
            <Camera size={16} className="mr-2" />
            Generate
          </Button>
        </div>
      </div>
    </Modal>
  );
}
