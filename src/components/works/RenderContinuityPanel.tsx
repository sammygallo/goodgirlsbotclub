import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, ShieldCheck } from 'lucide-react';
import { pageProse } from '../../utils/storyRender/exportRun';
import { readUnitNotes } from '../../utils/storyRender/unitNotes';
import type { ContinuityVerdict } from '../../utils/storyRender/types';

/**
 * Every continuity verdict in a run, as a set (step 3, phase 6).
 *
 * The per-chapter notes in `RenderReader` answer "what is wrong with this
 * chapter". They cannot answer "does this book contradict itself, and
 * where", because that means opening all forty chapters in turn. This is
 * that answer, and per the phase-6 plan's Decision 5 it lives with the RUN
 * rather than in the Story tab: these verdicts are about the OUTPUT, and
 * are fixed by re-rendering a chapter. Phase 10's contradiction review is
 * about the BIBLE and is fixed by editing canon. Same word, different
 * things, different remedies.
 *
 * **It reads every chapter on mount**, not just the ones the reader has
 * paged in. A count over the first 25 chapters of a 40-chapter book is
 * worse than no count: it reads as a verdict on the book. The read is
 * `project:view` and costs no key, and the prose it pulls is the same the
 * reader will pull as the user scrolls.
 *
 * `unreadable` chapters are counted as UNVERIFIED and never folded into the
 * clean total — the rule `unitNotes` states for one chapter, applied to the
 * aggregate. A book whose checks did not parse has not been checked.
 */
export function RenderContinuityPanel({
  projectId,
  renderId,
  reloadToken,
  titleFor,
  onOpenChapter,
}: {
  projectId: string;
  renderId: string;
  reloadToken: number;
  titleFor: (sceneId: string) => string;
  onOpenChapter: (sceneId: string) => void;
}) {
  const [rows, setRows] = useState<
    { sceneId: string; sequence: number; verdicts: ContinuityVerdict[]; unreadable: boolean }[]
  >([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const run = async () => {
      try {
        const bodies = await pageProse(projectId, renderId);
        if (cancelled) return;
        setRows(
          bodies
            .map((b) => {
              const notes = readUnitNotes(b.continuity);
              return {
                sceneId: b.scene_id,
                sequence: b.sequence,
                verdicts: notes.verdicts,
                unreadable: notes.unreadable,
              };
            })
            .sort((a, b) => a.sequence - b.sequence)
        );
        setState('ready');
      } catch {
        if (cancelled) return;
        // Silent by design: the reader above already toasts its own read
        // failure from the same endpoint, and two toasts for one outage is
        // noise. The panel says it could not check instead.
        setState('failed');
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId, renderId, reloadToken]);

  const { flagged, unverified, total } = useMemo(() => {
    const flaggedRows = rows.filter((r) => r.verdicts.length > 0);
    return {
      flagged: flaggedRows,
      unverified: rows.filter((r) => r.unreadable).length,
      total: flaggedRows.reduce((n, r) => n + r.verdicts.length, 0),
    };
  }, [rows]);

  if (state === 'loading') return null;

  if (state === 'failed') {
    return (
      <p className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]">
        <CircleAlert size={13} className="shrink-0 mt-0.5" />
        <span>Couldn’t read the continuity checks for this render.</span>
      </p>
    );
  }

  const clean = total === 0 && unverified === 0;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={16} className="shrink-0 text-[var(--color-text-secondary)]" />
        ) : (
          <ChevronRight size={16} className="shrink-0 text-[var(--color-text-secondary)]" />
        )}
        {clean ? (
          <ShieldCheck size={14} className="shrink-0 text-[var(--color-text-secondary)]" />
        ) : (
          <CircleAlert size={14} className="shrink-0 text-[var(--color-warning)]" />
        )}
        {/* The counts are on the CLOSED header on purpose: "does this book
            contradict itself" is answerable without expanding anything. */}
        <span className="text-sm text-[var(--color-text-primary)]">
          Continuity
          <span className="text-[var(--color-text-secondary)]">
            {' · '}
            {total === 0
              ? 'nothing flagged'
              : `${total} ${total === 1 ? 'thing' : 'things'} flagged across ${flagged.length} ${
                  flagged.length === 1 ? 'chapter' : 'chapters'
                }`}
            {/* Never folded into the clean count. A chapter whose check did
                not parse has not been checked. */}
            {unverified > 0
              ? `, ${unverified} ${unverified === 1 ? 'chapter' : 'chapters'} unverified`
              : ''}
          </span>
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-[var(--color-border)] pt-3">
          {clean && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Every chapter was checked against the story’s established facts
              and nothing came back contradicting them.
            </p>
          )}

          {flagged.map((row) => (
            <div key={row.sceneId} className="space-y-1">
              <button
                type="button"
                onClick={() => onOpenChapter(row.sceneId)}
                className="text-xs text-[var(--color-text-primary)] hover:underline"
              >
                {titleFor(row.sceneId) || 'Untitled scene'}
              </button>
              <ul className="space-y-1">
                {[...row.verdicts]
                  // Major first: a contradiction that breaks the story is
                  // not the same kind of note as a shade-of-detail one.
                  .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
                  .map((v, i) => (
                    <li
                      key={`${row.sceneId}:${i}`}
                      className="rounded bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-xs"
                    >
                      <span className="block text-[var(--color-text-primary)]">
                        {v.claim}
                      </span>
                      <span className="block text-[var(--color-text-secondary)]">
                        against: {v.canon}
                        {v.severity ? ` · ${v.severity}` : ''}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}

          {unverified > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-[var(--color-text-secondary)]">
              <CircleAlert size={13} className="shrink-0 mt-0.5" />
              <span>
                {unverified} {unverified === 1 ? 'chapter' : 'chapters'} could not
                be checked — the check didn’t run or its answer didn’t parse.
                That is not the same as clean.
              </span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function severityRank(severity: string | null | undefined): number {
  if (severity === 'major') return 0;
  if (severity === 'minor') return 2;
  return 1;
}
