import { Check, CircleAlert, Loader2 } from 'lucide-react';
import {
  INGEST_PASSES,
  PASS_LABELS,
  useStoryIngestStore,
} from '../../stores/storyIngestStore';
import { Button } from '../ui';

/**
 * Live progress for a bible build (story-state phase 6).
 *
 * Shows the pass checklist, the running token subtotal, and an abort.
 * The token figure is deliberately labelled "estimated" — it comes from
 * a tokenizer profile, not the provider's usage report, and quoting an
 * estimate as if it were a bill is how a fuel gauge loses trust.
 */
export function IngestProgressCard() {
  const { isRunning, currentPass, completed, annotateProgress, checkpoint, error, cancel } =
    useStoryIngestStore();

  const usage = checkpoint?.token_usage;
  const spent = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);

  // Stays visible after a stop or failure: hiding it also hides the
  // reset hatch and the token subtotal, which is exactly when the user
  // needs both. Only a never-started or cleanly-complete build hides.
  const stopped =
    checkpoint?.status === 'paused' || checkpoint?.status === 'error';
  if (!isRunning && !error && !stopped) return null;

  // Annotate (step 3) is a separate entry point, not a step of the build
  // pipeline, so it is deliberately absent from INGEST_PASSES — rendering
  // it through the pass checklist would show four build passes with none
  // of them current, and stall the bar. It gets a scene counter instead.
  const annotating =
    currentPass === 'annotate' ||
    (!isRunning && checkpoint?.current_pass === 'annotate');
  const done = annotating ? (annotateProgress?.done ?? 0) : completed.length;
  const total = annotating
    ? (annotateProgress?.total ?? 0)
    : INGEST_PASSES.length;

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          {isRunning
            ? annotating
              ? 'Annotating scenes'
              : 'Building the story'
            : checkpoint?.status === 'paused'
              ? annotating
                ? 'Annotation stopped'
                : 'Build stopped'
              : annotating
                ? 'Annotation failed'
                : 'Build failed'}
        </h3>
        {isRunning && (
          <Button variant="secondary" onClick={cancel}>
            Stop
          </Button>
        )}
      </div>

      {isRunning && total > 0 && (
        <div
          className="h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <div
            className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
            style={{ width: `${Math.round((done / total) * 100)}%` }}
          />
        </div>
      )}

      {annotating && (
        <p className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
          {isRunning ? (
            <Loader2 size={14} className="animate-spin shrink-0" />
          ) : (
            <span className="w-3.5 h-3.5 rounded-full border border-[var(--color-border)] shrink-0" />
          )}
          <span>
            {PASS_LABELS.annotate}
            {total > 0 ? ` — ${done} of ${total}` : ''}
          </span>
        </p>
      )}

      <ul className={annotating ? 'hidden' : 'space-y-1'}>
        {INGEST_PASSES.map((pass) => {
          const isDone = completed.includes(pass);
          const isCurrent = currentPass === pass;
          return (
            <li
              key={pass}
              className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]"
            >
              {isDone ? (
                <Check size={14} className="text-[var(--color-success)] shrink-0" />
              ) : isCurrent ? (
                <Loader2 size={14} className="animate-spin shrink-0" />
              ) : (
                <span className="w-3.5 h-3.5 rounded-full border border-[var(--color-border)] shrink-0" />
              )}
              <span
                className={
                  isDone || isCurrent ? 'text-[var(--color-text-primary)]' : ''
                }
              >
                {PASS_LABELS[pass]}
              </span>
            </li>
          );
        })}
      </ul>

      {spent > 0 && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          ~{spent.toLocaleString()} tokens used so far (estimated)
        </p>
      )}

      {!isRunning && stopped && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {/* These branches must stay in lockstep with run()'s
              `resumableReconcile`, `resumableWalk` and `incrementalWalk`
              predicates. When reconcile shipped, only the walk branch
              existed, so a paused reconcile — the one state where the
              ENTIRE chat is already paid for and durable — was told
              "starts from the beginning", right beside the button that
              would have made it true. */}
          {checkpoint?.current_pass === 'annotate'
            ? // Annotate's durable progress record is the scene rows
              // themselves — an annotated scene is skipped on the next
              // run — so a stopped pass genuinely resumes, and a Build
              // press does NOT restart the pipeline (resumableAnnotate).
              'Annotating again picks up where it stopped — scenes already annotated are skipped.'
            : checkpoint?.current_pass === 'transcript_walk' &&
          checkpoint.chunk_plan.length > 0
            ? // The transcript walk (phase 7) checkpoints every chunk, so
              // this genuinely continues rather than starting over. Keyed
              // on chunk_plan, NOT chunk_index, to stay in lockstep with
              // run()'s resumableWalk gate — at index 0 the walk still
              // re-plans, but cold-start and world-info are skipped, so
              // "starts from the beginning" would be a lie. Phase 11 also
              // extends the pinned plan here, so anything added while the
              // build was stopped is picked up in the same press.
              'Building again picks up where it stopped, including anything you’ve added since.'
            : checkpoint?.current_pass === 'reconcile'
              ? // Everything upstream of reconcile is durable on the
                // server. Phase 11 narrowed `resumableReconcile` with a
                // "nothing new upstream" conjunct, so this is only true
                // when the chat hasn't grown — hence the qualifier rather
                // than the old flat promise.
                'Building again re-checks for contradictions, and reads any new messages first.'
              : checkpoint && checkpoint.chunk_plan.length > 0
                ? // A finished walk that can still be continued: phase
                  // 11's incremental path reuses the pinned plan instead
                  // of re-reading (and re-billing) the whole chat.
                  'Building again reads only what you’ve added since.'
                : // Honest about the limit: cold-start/world-info always
                  // restart from the beginning — they are cheap enough
                  // that resuming them isn't worth the complexity.
                  'Building again starts from the beginning.'}
        </p>
      )}

      {(error || checkpoint?.error) && (
        <div className="flex items-start gap-2 text-sm text-[var(--color-error)]">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{error || checkpoint?.error}</span>
        </div>
      )}
    </section>
  );
}
