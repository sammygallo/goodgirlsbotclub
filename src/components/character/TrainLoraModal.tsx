import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, GraduationCap, Loader2, Trash2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { showToastGlobal } from '../ui/Toast';
import {
  deleteLoraTraining,
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

/** Phase C3 step presets. fal prices the trainer linearly in steps (~$2 at
 *  the 1000-step default); the bootstrap views add ~$1.30 on a first train
 *  (cached for retrains on unchanged art). */
const STEP_PRESETS = [
  { steps: 500, label: 'Fast' },
  { steps: 1000, label: 'Standard' },
  { steps: 1500, label: 'Thorough' },
] as const;
const BOOTSTRAP_COST = 1.3;

function trainerCost(steps: number): number {
  return (2 * steps) / 1000;
}

function dollars(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

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
  const [steps, setSteps] = useState<number>(1000);
  const [confirmRetrain, setConfirmRetrain] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // A stale kickoff error from a previous open must not greet the user as if
  // it just happened (2026-08-20 review). Steps reset with it — a per-open
  // choice, not a sticky preference.
  useEffect(() => {
    if (isOpen) {
      setKickError(null);
      setSteps(1000);
    }
  }, [isOpen]);

  const state: LoraTrainingStatus = status?.status ?? 'none';
  const inflight = LORA_INFLIGHT_STATUSES.includes(state);

  async function handleTrain() {
    setIsKicking(true);
    setKickError(null);
    try {
      await startLoraTraining(characterName, steps);
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

  async function handleDelete() {
    setIsDeleting(true);
    setKickError(null);
    try {
      const result = await deleteLoraTraining(characterName);
      // The live store is what gates Studio in chat (it wins over the stale
      // character-row value) — flip it to 'none' immediately.
      useLoraStore
        .getState()
        .setStatus(avatar, { status: 'none', error: null, updatedAt: null });
      showToastGlobal(
        result.unresolvedRequestIds.length > 0
          ? 'Training deleted. Some provider-side files could not be removed ' +
              'with your key — they remain in your fal dashboard.'
          : 'Training deleted.',
        'success',
      );
    } catch (err) {
      setKickError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Train this character (Studio)" size="md">
      <div className="space-y-3">
        <p className="text-xs text-[var(--color-text-secondary)]">
          Teach the image model this exact character. A one-time training
          (~{dollars(BOOTSTRAP_COST + trainerCost(steps))} on your own keys: ~12
          synthetic views via Replicate + fal at ~{dollars(BOOTSTRAP_COST)}, then
          fal's ~{dollars(trainerCost(steps))} trainer) unlocks the{' '}
          <span className="font-medium">Studio</span> selfie mode —
          signature-perfect fidelity in any scene, at ~$0.04 per image.
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

        <div>
          <p className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-text-secondary)] mb-1">
            training steps
          </p>
          <div className="flex gap-2">
            {STEP_PRESETS.map((preset) => (
              <button
                key={preset.steps}
                type="button"
                disabled={isKicking || inflight}
                onClick={() => setSteps(preset.steps)}
                className={`px-2.5 py-1.5 rounded text-xs border transition-colors disabled:opacity-50 ${
                  steps === preset.steps
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {preset.label} · {preset.steps} · ~{dollars(trainerCost(preset.steps))}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
            More steps memorize the character harder (and cost more); 1000 is
            fal's default and a good fit for most illustrated characters.
          </p>
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
              Trained
              {status?.updatedAt
                ? ` on ${new Date(status.updatedAt).toLocaleDateString()}`
                : ''}
              . Pick the Studio mode in the "Take a selfie" dialog to use it —
              retraining replaces this model for the current art.
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-[var(--color-border)]">
          {(state === 'succeeded' || state === 'failed') && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-red-400 hover:text-red-300"
              onClick={() => setConfirmDelete(true)}
              disabled={isDeleting || isKicking || inflight}
            >
              {isDeleting ? (
                <Loader2 size={14} className="animate-spin mr-1.5" />
              ) : (
                <Trash2 size={14} className="mr-1.5" />
              )}
              Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => (state === 'succeeded' ? setConfirmRetrain(true) : void handleTrain())}
            disabled={isKicking || inflight || isDeleting}
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

      <ConfirmDialog
        isOpen={confirmRetrain}
        onClose={() => setConfirmRetrain(false)}
        onConfirm={() => void handleTrain()}
        title={`Retrain ${characterName}?`}
        message={
          `This replaces ${characterName}'s current Studio model. If the ` +
          `avatar art is unchanged, cached views make it ~${dollars(trainerCost(steps))} ` +
          `(trainer only); if the art changed, the full ` +
          `~${dollars(BOOTSTRAP_COST + trainerCost(steps))}.`
        }
        confirmLabel="Retrain"
      />
      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void handleDelete()}
        title="Delete Studio training?"
        message={
          `Removes ${characterName}'s trained model and its training files ` +
          `from this server, and asks fal to delete what it can (with a ` +
          `non-admin fal key, provider-side copies remain in your fal ` +
          `dashboard). Generated selfies are kept. Training again later ` +
          `costs the full amount unless the art is unchanged.`
        }
        confirmLabel="Delete"
        danger
        busy={isDeleting}
      />
    </Modal>
  );
}
