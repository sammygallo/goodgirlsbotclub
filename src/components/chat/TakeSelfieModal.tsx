/**
 * TakeSelfieModal — manual trigger for the character-selfie feature
 * (docs/character-selfies-design.md Phase 2.5). Mirrors GenerateSceneModal's
 * styling/conventions but with none of its async-summarization complexity:
 * a selfie needs only optional descriptors and (for owners) a tier choice —
 * no transcript, no LLM call, no multi-phase flow.
 *
 * The `sfw`/`nsfw` tier choice only renders when `canNsfw` is true (the
 * caller gates this on `hasPermission(currentUser, 'generation:video')`,
 * mirroring scene-video's own owner-only containment) — without it the tier
 * is implicitly `sfw` with no choice shown, matching how the in-chat
 * auto-trigger already behaves.
 */
import { useEffect, useState } from 'react';
import { Camera } from 'lucide-react';
import { Modal, Button, TextArea } from '../ui';
import type { SelfieTier } from '../../api/selfieGen';

interface TakeSelfieModalProps {
  isOpen: boolean;
  onClose: () => void;
  characterName: string;
  canNsfw: boolean;
  onGenerate: (descriptors: string, tier: SelfieTier) => void;
}

export function TakeSelfieModal({
  isOpen,
  onClose,
  characterName,
  canNsfw,
  onGenerate,
}: TakeSelfieModalProps) {
  const [descriptors, setDescriptors] = useState('');
  const [tier, setTier] = useState<SelfieTier>('sfw');

  // Reset on each open so a stale draft/tier from a previous use doesn't
  // silently carry over — an nsfw selection in particular must never persist
  // across opens.
  useEffect(() => {
    if (isOpen) {
      setDescriptors('');
      setTier('sfw');
    }
  }, [isOpen]);

  const handleGenerate = () => {
    onGenerate(descriptors.trim(), tier);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Take a selfie" size="md">
      <div className="space-y-4">
        <TextArea
          label="Descriptors (optional)"
          value={descriptors}
          onChange={(e) => setDescriptors(e.target.value)}
          placeholder="mirror selfie, black dress, playful smirk"
          rows={3}
        />

        {canNsfw && (
          <div>
            <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">
              Tier
            </div>
            <div className="flex gap-2">
              {(['sfw', 'nsfw'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium uppercase transition-colors ${
                    tier === t
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/15 text-[var(--color-text-primary)]'
                      : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]/60'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] leading-relaxed">
          Builds a still selfie from {characterName}'s own portrait
          {tier === 'nsfw' ? " via GGBC's self-hosted worker" : ' via Replicate'}. Usually
          renders in seconds, but a cold start can take a few minutes — you can keep
          chatting while it runs.
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleGenerate}>
            <Camera size={16} className="mr-2" />
            Generate
          </Button>
        </div>
      </div>
    </Modal>
  );
}
