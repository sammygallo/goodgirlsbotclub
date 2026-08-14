import { CircleAlert, Loader2 } from 'lucide-react';
import { useStoryRenderStore } from '../../stores/storyRenderStore';
import { Button } from '../ui';

/**
 * Live progress for a render run (productization step 3, phase 5).
 *
 * Deliberately the same shape as `IngestProgressCard` — bar, subtotal,
 * Stop, and a card that STAYS VISIBLE after a stop or failure, because
 * hiding it also hides the only route back into the run.
 *
 * Two things it shows that ingestion has no equivalent of:
 *
 *  - **A truncated count, separate from an errored one.** A cut chapter is
 *    not a failed one: it has prose, it cost money, and §3.4 blocks it from
 *    export. Folding them into one "problems" figure would tell a user
 *    their chapter is missing when it is merely unfinished.
 *  - **A lock holder with a takeover offer.** `RenderLockedError` carries
 *    `takeable`, and that flag is the difference between "wait" and "this
 *    is your own abandoned tab". The offer is never taken implicitly — the
 *    store requires an explicit `takeover: true`, which is what stops a
 *    retry loop from ping-ponging the lock between two live devices.
 */
export function RenderProgressCard({
  onTakeOver,
  onResume,
  canManage,
}: {
  /** Retry the same action carrying `takeover: true`. Absent when there is
   *  nothing sensible to take over into. */
  onTakeOver?: () => void;
  /** Continue a run this tab parked. */
  onResume?: () => void;
  canManage: boolean;
}) {
  const { isRunning, progress, render, currentSceneId, error, lockedBy, cancel } =
    useStoryRenderStore();

  const parked = render?.status === 'paused' || render?.status === 'error';
  if (!isRunning && !error && !lockedBy && !parked) return null;

  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const spent = (render?.input_tokens ?? 0) + (render?.output_tokens ?? 0);

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          {isRunning
            ? 'Writing the story'
            : lockedBy
              ? 'Rendering elsewhere'
              : render?.status === 'paused'
                ? 'Render stopped'
                : 'Render failed'}
        </h3>
        {isRunning && (
          <Button variant="secondary" onClick={cancel}>
            Stop
          </Button>
        )}
      </div>

      {total > 0 && (
        <div
          className="h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <div
            className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
            style={{ width: `${Math.round((done / Math.max(1, total)) * 100)}%` }}
          />
        </div>
      )}

      {total > 0 && (
        <p className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
          {isRunning ? (
            <Loader2 size={14} className="animate-spin shrink-0" />
          ) : (
            <span className="w-3.5 h-3.5 rounded-full border border-[var(--color-border)] shrink-0" />
          )}
          <span>
            {done} of {total} {total === 1 ? 'chapter' : 'chapters'}
            {isRunning && currentSceneId ? ' — writing the next one' : ''}
          </span>
        </p>
      )}

      {/* Counted and named separately on purpose — see the class comment. */}
      {(progress?.truncated ?? 0) > 0 && (
        <p className="text-xs text-[var(--color-warning)]">
          {progress?.truncated} {progress?.truncated === 1 ? 'chapter' : 'chapters'}{' '}
          came back cut short. They're saved, but they can't be exported until
          they're rendered again.
        </p>
      )}
      {(progress?.errored ?? 0) > 0 && (
        <p className="text-xs text-[var(--color-warning)]">
          {progress?.errored} {progress?.errored === 1 ? 'chapter' : 'chapters'}{' '}
          couldn't be written. Continuing the render tries them again.
        </p>
      )}

      {spent > 0 && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          ~{spent.toLocaleString()} tokens used so far (estimated)
        </p>
      )}

      {!isRunning && parked && !lockedBy && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          Everything already written is saved. Continuing picks up from the
          first chapter that isn't finished — nothing is paid for twice.
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 text-sm text-[var(--color-error)]">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {canManage && !isRunning && (
        <div className="flex flex-wrap gap-2">
          {/* Only when the server says the holder's heartbeat has aged out.
              A LIVE holder is another device actively spending the user's
              key, and offering to displace it there is offering to pay
              twice for the same chapters. */}
          {lockedBy?.takeable && onTakeOver && (
            <Button variant="secondary" onClick={onTakeOver}>
              Take over
            </Button>
          )}
          {parked && !lockedBy && onResume && (
            <Button variant="primary" onClick={onResume}>
              Continue render
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
