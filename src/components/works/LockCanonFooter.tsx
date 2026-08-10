import { useState } from 'react';
import { CircleAlert, Lock, LockOpen, ShieldCheck } from 'lucide-react';
import { useStoryStore, isCanonLocked } from '../../stores/storyStore';
import { capturedAt } from '../../utils/storyBible/sourceRefs';
import {
  checkCanon,
  cleanupFactRefs,
  cleanupSceneRefs,
  planCanonFixes,
} from '../../utils/storyBible/canonCheck';
import type { LiveRefs } from '../../utils/storyBible/sourceRefs';
import { Button, ConfirmDialog, Modal } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import type { StorySectionOut } from '../../api/client';
import type {
  Contradiction,
  ContradictionResolution,
  MetaSection,
  StorySectionName,
} from '../../types/storyBible';

/**
 * Lock canon footer (story-state phase 10, §6.6).
 *
 * The bottom of the review checkpoint: how much is still undecided, a
 * one-click way to stop deciding, and the lock itself. Locking is the
 * moment the bible stops being a draft, so the gate in front of it is
 * the plan's (§3.2) and not a softer one — every contradiction must be
 * resolved or deferred, and the referential check must have had its say.
 *
 * The check itself lives in `canonCheck.ts` because it is the ONLY
 * referential validation in the whole system (the server is shape-only,
 * by decision) — far too load-bearing to live inline in JSX where
 * nothing can fixture-test it. This file's job is to make sure the check
 * runs against COMPLETE state, show what it found, and hand the fixes
 * back to the store actions that know how to write them.
 */

/** How many example messages to show per finding class before collapsing
 *  the rest into a count — the dialog summarises, it is not a report. */
const EXAMPLES_PER_CLASS = 3;

/**
 * Which resolution statuses count as "dealt with" for the lock gate.
 *
 * Deliberately a total map over the union rather than a `status !==
 * 'unresolved'` test: adding a status to `ContradictionResolution` will
 * fail to compile here until someone decides whether it may pass the
 * gate. The `=== true` is the runtime half of the same caution — a
 * status that only exists on the wire (a newer client wrote it) reads as
 * `undefined` and blocks, rather than sliding through as truthy.
 */
const SETTLED: Record<ContradictionResolution['status'], boolean> = {
  unresolved: false,
  user_chose: true,
  agent_resolved: true,
  deferred: true,
};

function isSettled(entry: Contradiction): boolean {
  return SETTLED[entry.resolution.status] === true;
}

/** What this footer reads off a canon finding. `canonCheck` owns the real
 *  types; reading them structurally means a new finding class shows up
 *  here — grouped and counted — without touching this file. */
interface FindingLike {
  kind: string;
  message: string;
}

interface FindingGroup {
  kind: string;
  count: number;
  examples: string[];
}

function groupByKind(findings: readonly FindingLike[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const group = groups.get(finding.kind);
    if (group) {
      group.count += 1;
      if (group.examples.length < EXAMPLES_PER_CLASS) {
        group.examples.push(finding.message);
      }
    } else {
      groups.set(finding.kind, {
        kind: finding.kind,
        count: 1,
        examples: [finding.message],
      });
    }
  }
  return [...groups.values()];
}

/** `missing_fact_source` -> "Missing fact source". The kinds are a closed
 *  slug enum, so humanising beats a label map this file would have to
 *  keep in step with a module it does not own. */
function humanizeKind(kind: string): string {
  const spaced = kind.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Other';
}

function formatLockDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

export function LockCanonFooter({
  contradictions,
  sections,
  liveRefs,
  canManage,
  disabled,
}: {
  /** Already shape-checked by the tab — this surface counts them and
   *  defers them, it does not re-validate the wire. */
  contradictions: Contradiction[];
  sections: Partial<Record<StorySectionName, StorySectionOut>>;
  /** For the source-chat badge in the referential check. Omitted reads
   *  as `live`, per `resolveRefState`'s own can't-tell rule. */
  liveRefs?: LiveRefs;
  canManage: boolean;
  /** A build is running or resumable (§3.3): scene edits are off, so the
   *  lock — whose auto-fix writes scenes — is off with them. Deferring
   *  stays live; resolutions were always safe against reconcile. */
  disabled: boolean;
}) {
  const manifest = useStoryStore((s) => s.manifest);
  const isSaving = useStoryStore((s) => s.isSaving);
  const patchContinuity = useStoryStore((s) => s.patchContinuity);
  const patchScene = useStoryStore((s) => s.patchScene);
  const lockCanon = useStoryStore((s) => s.lockCanon);
  const unlockCanon = useStoryStore((s) => s.unlockCanon);

  const [checking, setChecking] = useState(false);
  const [locking, setLocking] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  /** The findings dialog IS this state — non-null means "checked, showing
   *  what we found". Kept as the module's own return type so no finding
   *  type name is duplicated here. */
  const [report, setReport] = useState<ReturnType<typeof checkCanon> | null>(
    null
  );

  // §6.6's visibility rule. The manifest is the authority on what exists;
  // `sections` only says what has been FETCHED, and half of them are
  // lazy, so an empty `sections` is not an empty bible.
  const startedBeyondMeta = !!manifest?.sections.some(
    (s) => s.section !== 'meta'
  );
  if (!startedBeyondMeta) return null;

  const meta = sections.meta?.data as unknown as MetaSection | undefined;
  const locked = isCanonLocked(sections);
  const lockedOn = formatLockDate(meta?.canon_locked_at);

  const unsettled = contradictions.filter((entry) => !isSettled(entry));
  const deferrable = contradictions.filter(
    (entry) => entry.resolution.status === 'unresolved'
  );
  const busy = checking || locking || deferring || isSaving;

  /** Defer everything still sitting at `unresolved`.
   *
   *  Note the asymmetry with `isSettled`: the gate blocks on any status
   *  it does not recognise, but this only rewrites the one status it
   *  understands. Failing closed in both directions — we neither lock
   *  past something unknown nor stamp a resolution onto it. */
  const deferTheRest = async () => {
    setDeferring(true);
    try {
      const resolvedAt = capturedAt();
      await patchContinuity(
        (entries) => {
          let changed = false;
          const next = entries.map((entry) => {
            if (entry.resolution.status !== 'unresolved') return entry;
            changed = true;
            return {
              ...entry,
              resolution: {
                ...entry.resolution,
                status: 'deferred' as const,
                // Deferring is explicitly NOT a choice — a stale winner
                // left here would read as one.
                canonical_choice: null,
                resolved_at: resolvedAt,
              },
            };
          });
          // Null is the store's explicit no-op: nothing to write, no
          // server_ts churn, no edit row for a change that didn't happen.
          return changed ? next : null;
        },
        {
          target: { type: 'contradiction' },
          classification: 'contradiction',
          diff: `deferred ${deferrable.length} unresolved contradiction${
            deferrable.length === 1 ? '' : 's'
          }`,
        }
      );
    } finally {
      setDeferring(false);
    }
  };

  /**
   * Bring every input the check reads up to date, then check.
   *
   * `checkCanon` is pure and sees only what is loaded, so anything not
   * yet paged in reads to it as *missing* — the exact input that
   * manufactures a false error. Hence: full fact index, scenes to
   * exhaustion, and the two sparse sections the warning checks want,
   * loaded here at check time rather than on the tab's hot path.
   */
  const runCheck = async () => {
    const projectId = useStoryStore.getState().projectId;
    if (!projectId) return;
    setChecking(true);
    try {
      // Failures here already toasted inside the store. A null index
      // means we cannot tell a deleted fact from an unloaded one, and
      // guessing is how a "fix" deletes live references.
      const index = await useStoryStore.getState().loadAllFactsById();
      if (!index) return;

      // The tab's scene list holds SUMMARIES, which carry none of the ref
      // fields checked below — so the full rows are fetched here rather
      // than paged into state. A null result is a failed fetch, and
      // checking against a partial scene set would invent errors.
      const scenes = await useStoryStore.getState().loadAllScenesWithData();
      if (!scenes) return;

      await Promise.all([
        useStoryStore.getState().loadSection('narrative'),
        useStoryStore.getState().loadSection('rendering_hints'),
      ]);

      // Read state fresh: everything above awaited, so this component's
      // props and any pre-await snapshot are a render behind by
      // construction — and being a render behind is precisely what the
      // loading above was for.
      const live = useStoryStore.getState();
      if (live.projectId !== projectId) return;
      // `checkCanon` propagates `readContinuitySection`'s throw for a
      // malformed contradictions payload (canonCheck's own contract),
      // because the caller's very next move is a destructive full
      // replace — no dialog, no fix, no lock. Catch here and toast so
      // the click doesn't vanish into an unhandled rejection.
      try {
        setReport(
          checkCanon({
            facts: index,
            scenes,
            continuity: live.sections.continuity?.data ?? null,
            meta: live.sections.meta?.data ?? null,
            entities: live.sections.entities?.data ?? null,
            narrative: live.sections.narrative?.data ?? null,
            renderingHints: live.sections.rendering_hints?.data ?? null,
            liveRefs,
          })
        );
      } catch (error) {
        showToastGlobal(
          error instanceof Error
            ? `Can't check canon: ${error.message}`
            : "Can't check canon — the contradictions section looks malformed",
          'error'
        );
      }
    } finally {
      setChecking(false);
    }
  };

  /** Apply the auto-fixes the errors describe, then lock. Each fix goes
   *  through the §5 store actions, so each appends its own edit row and
   *  inherits the conflict handling — this file never writes a section. */
  const applyAndLock = async () => {
    if (!report) return;
    setLocking(true);
    // Drop the stale report the moment a fix fails: the dialog would
    // otherwise still show the pre-attempt counts even though partial
    // fixes have landed, and the user could re-click "Fix and lock" on
    // findings that no longer describe reality. A re-run is honest.
    const bail = () => setReport(null);
    try {
      const plan = planCanonFixes(report.errors);

      // Continuity first: the pure cleanup and the patchFn shape are
      // exactly what deleteFact uses, sharing one implementation instead
      // of two that could disagree about what "cleaned" means.
      if (plan.deadFactIds.size > 0) {
        const ok = await patchContinuity(
          (entries) => cleanupFactRefs(entries, plan.deadFactIds),
          {
            target: { type: 'contradiction' },
            classification: 'contradiction',
            diff: 'lock canon: cleaned contradiction references to missing facts',
          }
        );
        // Stop at the first failure. The store has already said what
        // went wrong; locking over a fix that did not land is how the
        // lock stops meaning anything.
        if (!ok) return bail();
      }

      for (const [sceneId, dead] of plan.scenes) {
        const ok = await patchScene(
          sceneId,
          // patchScene passes a typed Scene, but cleanupSceneRefs is
          // intentionally on the raw payload so `patchScene`'s full
          // replace preserves anything this phase doesn't know about.
          (data) =>
            cleanupSceneRefs(
              data as unknown as Record<string, unknown>,
              dead
            ) as unknown as typeof data,
          {
            target: { type: 'scene', id: sceneId },
            classification: 'substantive',
            diff: 'lock canon: stripped references to missing facts and characters',
          }
        );
        if (!ok) return bail();
      }

      if (await lockCanon()) setReport(null);
      else bail();
    } finally {
      setLocking(false);
    }
  };

  const errorGroups = groupByKind(report?.errors ?? []);
  const warningGroups = groupByKind(report?.warnings ?? []);
  const errorCount = report?.errors.length ?? 0;
  const warningCount = report?.warnings.length ?? 0;

  const renderGroups = (groups: FindingGroup[]) => (
    <ul className="space-y-2">
      {groups.map((group) => (
        <li key={group.kind}>
          <p className="text-sm text-[var(--color-text-primary)]">
            {humanizeKind(group.kind)}{' '}
            <span className="text-[var(--color-text-secondary)]">
              × {group.count}
            </span>
          </p>
          <ul className="mt-1 space-y-0.5">
            {group.examples.map((message, i) => (
              <li
                key={`${group.kind}-${i}`}
                className="text-xs text-[var(--color-text-secondary)]"
              >
                {message}
              </li>
            ))}
            {group.count > group.examples.length && (
              <li className="text-xs text-[var(--color-text-secondary)]">
                +{group.count - group.examples.length} more
              </li>
            )}
          </ul>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {/* Sticky, but only just: toasts sit at z-200 and modals at z-100,
          and a footer that covers either is a footer that eats its own
          error messages. */}
      <section className="sticky bottom-0 z-10 bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          {locked ? (
            <p className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
              <Lock size={14} className="shrink-0 text-[var(--color-success)]" />
              <span>
                Canon locked{lockedOn ? ` ${lockedOn}` : ''} — editing is off
                until you unlock.
              </span>
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
              {unsettled.length > 0 ? (
                <CircleAlert
                  size={14}
                  className="shrink-0 text-[var(--color-warning)]"
                />
              ) : (
                <ShieldCheck
                  size={14}
                  className="shrink-0 text-[var(--color-success)]"
                />
              )}
              <span>
                {contradictions.length === 0
                  ? 'No contradictions to settle.'
                  : unsettled.length === 0
                    ? `All ${contradictions.length} contradictions resolved or deferred.`
                    : `${unsettled.length} of ${contradictions.length} contradictions still need a decision.`}
              </span>
            </p>
          )}
          {!locked && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Locking freezes the story so the writing passes can rely on
              it. You can unlock at any time.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!locked && canManage && deferrable.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void deferTheRest()}
              disabled={busy}
            >
              {deferring ? 'Deferring…' : 'Defer the rest'}
            </Button>
          )}
          {canManage &&
            (locked ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setUnlockOpen(true)}
                disabled={busy}
              >
                <LockOpen size={14} className="mr-1.5" />
                Unlock
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void runCheck()}
                disabled={busy || disabled || unsettled.length > 0}
                title={
                  disabled
                    ? 'Finish or clear the build first'
                    : unsettled.length > 0
                      ? 'Resolve or defer every contradiction first'
                      : undefined
                }
              >
                {checking ? 'Checking…' : 'Lock canon'}
              </Button>
            ))}
        </div>
      </section>

      {/* Bespoke rather than a ConfirmDialog: its `message` is a plain
          string, and the whole point of this dialog is the per-class
          breakdown underneath the sentence. */}
      {report && (
        <Modal
          isOpen
          onClose={() => setReport(null)}
          title="Lock canon"
          size="md"
        >
          <div className="space-y-4">
            {errorCount === 0 && warningCount === 0 && (
              <p className="text-sm text-[var(--color-text-secondary)]">
                Everything checks out — nothing in the story points at
                anything missing.
              </p>
            )}

            {errorCount > 0 && (
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3 space-y-2">
                <p className="flex items-start gap-1.5 text-sm text-[var(--color-error)]">
                  <CircleAlert size={14} className="shrink-0 mt-0.5" />
                  <span>
                    {errorCount} reference{errorCount === 1 ? '' : 's'} to
                    something that no longer exists. Locking cleans{' '}
                    {errorCount === 1 ? 'it' : 'them'} up first.
                  </span>
                </p>
                {renderGroups(errorGroups)}
              </div>
            )}

            {warningCount > 0 && (
              <div className="rounded-lg bg-[var(--color-bg-tertiary)] p-3 space-y-2">
                <p className="text-sm text-[var(--color-warning)]">
                  {warningCount} thing{warningCount === 1 ? '' : 's'} worth
                  knowing. {warningCount === 1 ? 'It does' : 'They do'} not
                  block locking and nothing here changes them.
                </p>
                {renderGroups(warningGroups)}
              </div>
            )}

            <p className="text-xs text-[var(--color-text-secondary)]">
              While canon is locked, building, scene edits, fact deletes,
              resolutions and pasted samples are all disabled. Unlocking
              puts them back.
            </p>

            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setReport(null)}
                disabled={locking || isSaving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void applyAndLock()}
                disabled={locking || isSaving}
              >
                {locking
                  ? errorCount > 0
                    ? 'Fixing…'
                    : 'Locking…'
                  : errorCount > 0
                    ? 'Fix and lock'
                    : 'Lock canon'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        isOpen={unlockOpen}
        title="Unlock canon?"
        message="The story becomes editable again. Nothing you've written is lost — this only lifts the freeze, and you can lock it again whenever you like."
        confirmLabel="Unlock"
        busy={isSaving}
        onConfirm={() => void unlockCanon()}
        onClose={() => setUnlockOpen(false)}
      />
    </>
  );
}
