import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, GraduationCap, Loader2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { showToastGlobal } from '../ui/Toast';
import {
  fetchLoraStatus,
  LORA_INFLIGHT_STATUSES,
  startLoraTraining,
  type LoraTrainingStatus,
} from '../../api/loraTraining';
import { useLoraStatus, useLoraStore } from '../../hooks/useLoraStatus';

/**
 * TrainLoraModal — kicks off Studio-tier LoRA training for a character
 * (Phase C1, docs/character-selfies-lora-tier.md). Adapted from
 * LivePortraitSetup, with one deliberate inversion: closing this modal is
 * ALWAYS safe. Training runs in a backend worker against a DB row — the
 * modal is a window onto it, not its owner. Reopen (or reload, or another
 * device) and `useLoraStatus` rejoins the same training.
 */

interface TrainLoraModalProps {
  /** Character avatar filename — the status store key. */
  avatar: string;
  characterName: string;
  /** Character's avatar URL — shown as the training source. */
  imageUrl: string;
  isOpen: boolean;
  onClose: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  pending: 'queued — the worker picks it up within seconds…',
  bootstrapping: 'synthesizing ~12 training views from the avatar…',
  submitting: 'submitting the training set to fal…',
  training: 'training on fal (typically minutes; can take longer)…',
};

export function TrainLoraModal({
  avatar,
  characterName,
  imageUrl,
  isOpen,
  onClose,
}: TrainLoraModalProps) {
  const status = useLoraStatus(isOpen ? avatar : null, characterName);
  const [isKicking, setIsKicking] = useState(false);
  const [kickError, setKickError] = useState<string | null>(null);

  // A stale kickoff error from a previous open must not greet the user as if
  // it just happened (2026-08-20 review).
  useEffect(() => {
    if (isOpen) setKickError(null);
  }, [isOpen]);

  const state: LoraTrainingStatus = status?.status ?? 'none';
  const inflight = LORA_INFLIGHT_STATUSES.includes(state);

  async function handleTrain() {
    setIsKicking(true);
    setKickError(null);
    try {
      await startLoraTraining(characterName);
      showToastGlobal('Training started — it keeps running if you close this.', 'success');
    } catch (err) {
      setKickError(err instanceof Error ? err.message : 'Training kickoff failed');
      setIsKicking(false);
      return;
    }
    setIsKicking(false);
    // Refresh immediately so the stage label appears without waiting a poll.
    // Kickoff already SUCCEEDED — a refresh failure here must not render as
    // a kickoff error (2026-08-20 review); the poll converges on its own.
    try {
      const fresh = await fetchLoraStatus(characterName);
      useLoraStore.getState().setStatus(avatar, fresh);
    } catch {
      /* the useLoraStatus poll picks it up */
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Train this character (Studio)" size="md">
      <div className="space-y-3">
        <p className="text-xs text-[var(--color-text-secondary)]">
          Teach the image model this exact character. A one-time training (~$3.30 on
          your own keys: ~12 synthetic views via Replicate + fal, then fal's $2
          trainer) unlocks the <span className="font-medium">Studio</span> selfie
          mode — signature-perfect fidelity in any scene, at ~$0.04 per image.
          Training runs on the server; closing this dialog never cancels it.
        </p>

        <div className="flex gap-4 items-start">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-text-secondary)] mb-1">
              training source
            </p>
            <img
              src={imageUrl}
              alt={characterName}
              className="block max-h-[200px] rounded select-none"
              draggable={false}
            />
          </div>
        </div>

        {kickError && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-400">{kickError}</p>
          </div>
        )}

        {state === 'failed' && !kickError && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-400">
              Last training failed: {status?.error || 'unknown error'}. You can try again.
            </p>
          </div>
        )}

        {inflight && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <Loader2 size={12} className="animate-spin" />
            <span>{STAGE_LABELS[state] ?? 'working…'}</span>
          </div>
        )}

        {state === 'succeeded' && (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle2 size={14} />
            <span>
              Trained. The Studio selfie mode that uses it arrives with the next
              update — retraining now would replace this result.
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-[var(--color-border)]">
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleTrain}
            disabled={isKicking || inflight}
          >
            {isKicking || inflight ? (
              <>
                <Loader2 size={14} className="animate-spin mr-1.5" />
                {inflight ? 'Training…' : 'Starting…'}
              </>
            ) : (
              <>
                <GraduationCap size={14} className="mr-1.5" />
                {state === 'succeeded' || state === 'failed' ? 'Retrain' : 'Train character'}
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
