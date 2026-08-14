import { useState } from 'react';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useConnectionProfileStore } from '../../stores/connectionProfileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { isWeakModel } from '../../utils/storyIngest/modelStrength';
import { Button, Modal } from '../ui';
import type { RenderEstimate } from '../../utils/storyRender/estimate';

/**
 * Pre-flight for a render run (productization step 3, phase 5).
 *
 * Plan §6's first mitigation, and the one that matters most here: per-render
 * spend is user-visible and LARGER than ingestion's, so nothing about a run
 * is allowed to be a surprise discovered halfway through it.
 *
 * Three things this shows that the ingest preflight does not have to:
 *
 *  - **A range, priced.** The user picked scenes; the figure is for those
 *    scenes and says how many.
 *  - **An input/output split.** Output is a CEILING — both calls cap their
 *    generation and prose routinely stops short — while input is what will
 *    actually be sent. Quoting one number would make the honest half look
 *    like the guess.
 *  - **What the run already knows it will leave out.** §3.5 forbids a
 *    silent drop, and a preflight is the earliest point at which a cap
 *    trim or an outright refusal can be said out loud instead of appearing
 *    in a continuity note after the money is spent.
 */
export function StartRenderModal({
  estimate,
  sceneRangeLabel,
  onStart,
  onClose,
  busy,
}: {
  estimate: RenderEstimate;
  /** Human label for the chosen range, e.g. "Scenes 3–17". */
  sceneRangeLabel: string;
  onStart: (profileId: string | null) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const { profiles, activeProfileId } = useConnectionProfileStore();
  const [profileId, setProfileId] = useState<string | null>(activeProfileId);
  const settingsActiveModel = useSettingsStore((s) => s.activeModel);

  const selectedModel = profileId
    ? (profiles.find((p) => p.id === profileId)?.model ?? null)
    : settingsActiveModel;
  const weakModel = isWeakModel(selectedModel);

  /** Every scene refuses. Starting would create a run, hold the project
   *  lock and produce nothing at all, so the confirm is withheld rather
   *  than merely warned about. */
  const allRefused = estimate.scenes > 0 && estimate.refusedScenes === estimate.scenes;

  return (
    <Modal isOpen onClose={onClose} title="Render this story">
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          This writes {sceneRangeLabel.toLowerCase()} out as novel prose, one
          chapter per scene, and checks each chapter against the story's
          established facts. It runs on your own API key.
        </p>

        {profiles.length > 0 && (
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
              Connection
            </span>
            <select
              value={profileId ?? ''}
              onChange={(e) => setProfileId(e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)]"
            >
              <option value="">Current connection</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </select>
          </label>
        )}

        {weakModel && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>
              This looks like a smaller/cheaper model. Prose quality varies
              more between models than any other pass here — a stronger one
              will generally read better, but this one can still run now.
            </span>
          </p>
        )}

        <div className="rounded-lg bg-[var(--color-bg-secondary)] p-3 space-y-1">
          <p className="text-sm text-[var(--color-text-primary)]">
            ~{estimate.inputTokens.toLocaleString()} tokens sent, up to{' '}
            {estimate.maxOutputTokens.toLocaleString()} written back
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {estimate.scenes} {estimate.scenes === 1 ? 'scene' : 'scenes'}, two
            model calls each. A rough figure from our own tokenizer, not your
            provider's count. The written-back half is the most it can be —
            chapters usually stop well short of their limit, so the real total
            is normally lower.
          </p>
        </div>

        {estimate.refusedScenes > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
            <CircleAlert size={13} className="shrink-0 mt-0.5" />
            <span>
              {estimate.refusedScenes}{' '}
              {estimate.refusedScenes === 1 ? 'scene is' : 'scenes are'} too
              large to render even after trimming, and{' '}
              {estimate.refusedScenes === 1 ? 'it' : 'they'} will be skipped.
              Splitting {estimate.refusedScenes === 1 ? 'it' : 'them'} in the
              Story tab is the fix.
            </span>
          </p>
        )}

        {estimate.scenesWithDrops > 0 && (
          <p className="text-xs text-[var(--color-text-secondary)]">
            {estimate.scenesWithDrops} of these scenes carry more context than
            fits, so some of it is left out. Each chapter records exactly what
            was dropped.
          </p>
        )}

        {estimate.scenesWithoutWindow > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
            <CircleAlert size={13} className="shrink-0 mt-0.5" />
            <span>
              {estimate.scenesWithoutWindow}{' '}
              {estimate.scenesWithoutWindow === 1 ? 'scene' : 'scenes'} can no
              longer be located in the chat, so only always-on lorebook entries
              reach {estimate.scenesWithoutWindow === 1 ? 'it' : 'them'}. They
              will still render.
            </span>
          </p>
        )}

        <p className="text-xs text-[var(--color-text-secondary)]">
          Whatever your story contains goes to your chosen provider, under
          their terms — the same as any message you send from a chat.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onStart(profileId)}
            disabled={busy || allRefused || estimate.scenes === 0}
          >
            {busy ? 'Starting…' : 'Render'}
          </Button>
        </div>
        {allRefused && (
          <p className="text-xs text-[var(--color-warning)] text-right">
            Nothing in this range can be rendered as it stands.
          </p>
        )}
      </div>
    </Modal>
  );
}
