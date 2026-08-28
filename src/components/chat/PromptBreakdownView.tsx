/**
 * Renders a `BreakdownViewModel` (E2-S2 task 3) — no store access of its own.
 * Pure props-in: `PromptBreakdownSheet` and `UsagePage` each resolve their
 * own `BreakdownViewModel` from `useGenerationStore` and hand it down, so
 * this file never imports chatStore and never decides whose turn it is
 * showing.
 *
 * Chart: dataviz skill, "the reference palette" — the 8-hue dark-surface
 * categorical order, validated with
 * `node scripts/validate_palette.js "<8 hex>" --mode dark --surface #1a1a1a`
 * (this app's `--color-bg-secondary`), all checks passing. `system` reuses
 * `character`'s slot rather than taking a 9th hue: the two buckets are
 * mutually exclusive (`system` is group-only, `character` solo-only — see
 * `breakdownBuckets.ts`), so no rendered bar ever shows both at once.
 */
import { useState } from 'react';
import { formatTokens } from '../../stores/usageStore';
import {
  BUCKET_ORDER,
  FULL_PROMPT_LABEL,
  type BreakdownViewModel,
  type BucketId,
  type BucketRow,
  type DrillDownSlice,
} from '../../utils/breakdownBuckets';

const BUCKET_COLORS: Record<BucketId, string> = {
  character: '#3987e5',
  system: '#3987e5', // never co-present with `character` — see file doc.
  persona: '#d95926',
  world_info: '#199e70',
  chat_recall: '#c98500',
  summary_notes: '#d55181',
  instructions: '#008300',
  chat_history: '#9085e9',
  your_message: '#e66767',
};

const OVERHEAD_COLOR = 'var(--color-border)';

// Row-1's label is mode-dependent (TRIMMED_METER_LABEL vs PRE_STAGE_C_LABEL
// — review round 3, R3-B/F4), so it comes from the view model
// (`reconciliation.stageC.meterRowLabel`) rather than a view-local constant.
// FULL_PROMPT_LABEL never varies by mode (it names row 2 in both the
// Stage-C branch and the group/else branch below), so it stays a single
// import shared with the notes that self-label against it
// (breakdownBuckets.ts — round 3, R3-A).

function n(x: number): string {
  return x.toLocaleString();
}

function ProvenanceHeader({
  view,
  variant,
}: {
  view: BreakdownViewModel;
  variant: 'compact' | 'full';
}) {
  const { mode, chatFile, publishedAt, profile } = view.provenance;
  const when = new Date(publishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--color-text-secondary)] ${
        variant === 'full' ? 'text-xs' : 'text-[11px]'
      }`}
    >
      <span className="uppercase tracking-wide font-semibold text-[var(--color-text-primary)]">
        {mode === 'solo' ? 'Solo' : 'Group'}
      </span>
      <span>{chatFile ?? 'no chat file'}</span>
      <span>built {when}</span>
      <span className="opacity-70">tokenizer: {profile}</span>
    </div>
  );
}

function BarSegment({
  bucket,
  widthPct,
  expanded,
  onToggle,
}: {
  bucket: BucketRow;
  widthPct: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="h-full transition-opacity hover:opacity-80 focus:outline-none"
      style={{
        width: `${widthPct}%`,
        backgroundColor: BUCKET_COLORS[bucket.id],
        opacity: expanded ? 1 : 0.92,
        minWidth: widthPct > 0 ? '2px' : 0,
      }}
      title={`${bucket.label}: ${n(bucket.tokens)} tokens`}
      aria-label={`${bucket.label}: ${n(bucket.tokens)} tokens`}
    />
  );
}

function DrillDownRow({ slice }: { slice: DrillDownSlice }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
      <span className="text-[var(--color-text-secondary)] truncate">
        {slice.label}
        {slice.badge && (
          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--color-warning)]">
            {slice.badge}
          </span>
        )}
      </span>
      <span className="tabular-nums text-[var(--color-text-primary)] flex-shrink-0">
        {n(slice.tokens)}
      </span>
    </div>
  );
}

function BucketRowView({
  bucket,
  expanded,
  onToggle,
}: {
  bucket: BucketRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasStageC = (bucket.stageCSlices?.length ?? 0) > 0;
  return (
    <div className="border-t border-[var(--color-border)]/40 first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 py-1.5 text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: BUCKET_COLORS[bucket.id] }}
          />
          <span className="text-sm text-[var(--color-text-primary)] truncate">{bucket.label}</span>
        </span>
        <span className="tabular-nums text-sm text-[var(--color-text-secondary)] flex-shrink-0">
          {n(bucket.tokens)}
          {hasStageC && (
            <span className="ml-1 text-[10px] text-[var(--color-warning)]">
              +{n(bucket.stageCTokens ?? 0)} after history
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="pl-4 pb-2 space-y-0">
          {bucket.slices.map((s, i) => (
            <DrillDownRow key={i} slice={s} />
          ))}
          {bucket.stageCSlices?.map((s, i) => (
            <DrillDownRow key={`c${i}`} slice={s} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PromptBreakdownView({
  view,
  provenanceVariant = 'compact',
}: {
  view: BreakdownViewModel;
  provenanceVariant?: 'compact' | 'full';
}) {
  const [expanded, setExpanded] = useState<BucketId | null>(null);
  const toggle = (id: BucketId) => setExpanded((cur) => (cur === id ? null : id));

  const { reconciliation, badges, wi, reserved, attachments, callSite, emptySystemNote } = view;
  const overheadTotal = reconciliation.overhead.total;
  // Guaranteed by computeBreakdownView's own reconciliation identity
  // (breakdownBuckets.test.ts), never re-derived here — the bar's total
  // width is the SAME number the segments are checked to sum to.
  const barTotal = reconciliation.bucketsTotal + overheadTotal;
  const pct = (tokens: number) => (barTotal > 0 ? (tokens / barTotal) * 100 : 0);

  // Ordered the same way BUCKET_ORDER names them, in case a caller ever
  // hands in `view.buckets` out of order (it never does today — but the bar
  // and the legend below it must not silently disagree on order).
  const orderedBuckets = BUCKET_ORDER.map((id) => view.buckets.find((b) => b.id === id)).filter(
    (b): b is BucketRow => !!b
  );

  return (
    <div className="space-y-3">
      <ProvenanceHeader view={view} variant={provenanceVariant} />

      {/* The bar: canonical-order bucket segments + one Overhead segment,
          summing exactly to `reconciliation.target`. Reserved (solo-with-trim
          only) is a separate chip after a divider, not part of this scale —
          it is what the trim SET ASIDE, not what the request in the bar
          spent. */}
      <div className="flex items-stretch gap-2">
        <div className="flex-1 h-6 rounded-md overflow-hidden flex bg-[var(--color-bg-tertiary)]" style={{ gap: '2px' }}>
          {orderedBuckets.map((b) => (
            <BarSegment
              key={b.id}
              bucket={b}
              widthPct={pct(b.tokens)}
              expanded={expanded === b.id}
              onToggle={() => toggle(b.id)}
            />
          ))}
          <div
            className="h-full"
            style={{ width: `${pct(overheadTotal)}%`, backgroundColor: OVERHEAD_COLOR, minWidth: overheadTotal > 0 ? '2px' : 0 }}
            title={`Overhead: ${n(overheadTotal)} tokens`}
          />
        </div>
        {reserved && (
          <>
            <div className="w-px bg-[var(--color-border)]" aria-hidden="true" />
            <div
              className="h-6 min-w-[2.5rem] px-2 rounded-md flex items-center justify-center text-[10px] tabular-nums text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] border border-dashed border-[var(--color-border)]"
              title={`Reserved for the response: ${n(reserved.tokens)} tokens`}
            >
              {formatTokens(reserved.tokens)}
            </div>
          </>
        )}
      </div>

      {/* Legend / drill-down list, in the same order as the bar. */}
      <div>
        {orderedBuckets.map((b) => (
          <BucketRowView key={b.id} bucket={b} expanded={expanded === b.id} onToggle={() => toggle(b.id)} />
        ))}
      </div>

      {/* Reconciliation */}
      <div className="text-xs text-[var(--color-text-secondary)] space-y-0.5 pt-1 border-t border-[var(--color-border)]/40">
        <div className="flex justify-between">
          <span>Buckets</span>
          <span className="tabular-nums">{n(reconciliation.bucketsTotal)}</span>
        </div>
        {reconciliation.overhead.separatorRounding !== undefined && (
          <div className="flex justify-between pl-2">
            <span>Separator + rounding</span>
            <span className="tabular-nums">{n(reconciliation.overhead.separatorRounding)}</span>
          </div>
        )}
        <div className="flex justify-between pl-2">
          <span>Message overhead</span>
          <span className="tabular-nums">{n(reconciliation.overhead.messageOverhead)}</span>
        </div>
        <div className="flex justify-between pl-2">
          <span>Conversation priming</span>
          <span className="tabular-nums">{n(reconciliation.overhead.conversationPriming)}</span>
        </div>
        {emptySystemNote && <p className="text-[11px] italic pl-2">{emptySystemNote}</p>}
        {reconciliation.stageC ? (
          <>
            <div className="flex justify-between font-medium text-[var(--color-text-primary)]">
              <span>{reconciliation.stageC.meterRowLabel}</span>
              <span className="tabular-nums">{n(reconciliation.target)}</span>
            </div>
            <div className="flex justify-between">
              <span>+ sent after the history (Stage C)</span>
              <span className="tabular-nums">{n(reconciliation.stageC.tokens)}</span>
            </div>
            <div className="flex justify-between pl-2">
              <span>After-history overhead</span>
              <span className="tabular-nums">{n(reconciliation.stageC.afterHistoryOverhead)}</span>
            </div>
            <div className="flex justify-between font-medium text-[var(--color-text-primary)]">
              <span>{FULL_PROMPT_LABEL}</span>
              <span className="tabular-nums">{n(reconciliation.stageC.assembledTotal)}</span>
            </div>
            {/* Review round 3, R3-B/F4: no trim-anchored note when no trim
                ran (Message Count mode) — there is nothing true to say about
                what "the trim" measures. */}
            {reconciliation.stageC.trimmedMeterNote && (
              <p className="text-[11px] italic">{reconciliation.stageC.trimmedMeterNote}</p>
            )}
            <p className="text-[11px] italic">{reconciliation.stageC.fullPromptNote}</p>
          </>
        ) : (
          <div className="flex justify-between font-medium text-[var(--color-text-primary)]">
            <span>{FULL_PROMPT_LABEL}</span>
            <span className="tabular-nums">{n(reconciliation.target)}</span>
          </div>
        )}
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
          {badges.history}
        </span>
        {badges.droppedFromHistory !== undefined && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-warning)]">
            {badges.droppedFromHistory} message{badges.droppedFromHistory === 1 ? '' : 's'} dropped by the trim
          </span>
        )}
      </div>

      {/* World info summary */}
      <div className="text-xs bg-[var(--color-bg-tertiary)] rounded-md p-2 space-y-0.5">
        <div className="flex justify-between">
          <span className="text-[var(--color-text-secondary)]">In the prompt (post-macro, incl. attribution wrappers)</span>
          <span className="tabular-nums">{n(wi.emittedTokens)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--color-text-secondary)]">Charged by the WI budget (raw entry text, pre-macro)</span>
          <span className="tabular-nums">{n(wi.rawTokens)}</span>
        </div>
        <p className="text-[11px] text-[var(--color-text-secondary)] italic">{wi.gapExplanation}</p>
        {wi.unavailableNote ? (
          <p className="text-[11px] text-[var(--color-warning)]">{wi.unavailableNote}</p>
        ) : (
          <div className="flex justify-between text-[11px] text-[var(--color-text-secondary)]">
            <span>Budget {n(wi.budget ?? 0)}</span>
            <span>{wi.evictedCount ?? 0} evicted</span>
          </div>
        )}
      </div>

      {/* Call-site turns, outside both the bar and the reconciliation. */}
      {callSite.length > 0 && (
        <div className="text-xs space-y-0.5">
          {callSite.map((c, i) => (
            <div key={i} className="flex justify-between text-[var(--color-text-secondary)]">
              <span>
                {c.label} <span className="italic">({c.note})</span>
              </span>
              <span className="tabular-nums text-[var(--color-text-primary)]">{n(c.tokens)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Attachments — never in the bar, never counted in any total. */}
      {attachments && (
        <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
          <span className="px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)]">
            {attachments.count} attachment{attachments.count === 1 ? '' : 's'} · {(attachments.bytes / 1024).toFixed(1)} KB · not counted anywhere
          </span>
        </div>
      )}
    </div>
  );
}
