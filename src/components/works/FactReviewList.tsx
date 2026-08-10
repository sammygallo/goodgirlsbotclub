import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useStoryStore } from '../../stores/storyStore';
import { isFactTombstone } from '../../types/storyBible';
import { Button, ConfirmDialog } from '../ui';
import type { StoryLogEntry, StorySceneSummary } from '../../api/client';
import type { BibleFact, Confidence } from '../../types/storyBible';

/**
 * The established-facts accordion (story-state phase 10, §6.3).
 *
 * Replaces the flat read-only list: the loaded facts grouped by
 * confidence, each fact carrying its category, the scene it was
 * established in (looked up from the scenes already loaded — this
 * surface never fetches), and a delete behind a confirm that states
 * what delete actually costs.
 *
 * Deleted facts stay in the list, struck through. They are on the wire
 * regardless — the backend tombstones the row rather than removing it
 * (§3 decision 1) — and quietly dropping them turns "where did my fact
 * go" into a support question. A tombstone's `data` is exactly
 * `{id, deleted_at}`, so there is no text, category or scene left to
 * render: the row is drawn from those two fields alone.
 */

/** Confidence buckets, plus the two a `confidence` value can't name:
 *  tombstones (no confidence survives a delete) and anything whose
 *  confidence isn't one of the three the schema allows. Both exist so
 *  that no loaded fact can fall out of the list unrendered. */
type GroupKey = Confidence | 'other' | 'deleted';

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'contested', label: 'Contested' },
  { key: 'inferred', label: 'Inferred' },
  { key: 'explicit', label: 'Explicit' },
  { key: 'other', label: 'Unlabelled' },
  { key: 'deleted', label: 'Deleted' },
];

const CONFIDENCES: Confidence[] = ['contested', 'inferred', 'explicit'];

interface FactRow {
  /** React key: the log row id, unique per row even across a delete. */
  rowKey: string;
  /** What `deleteFact` is called with. Resolved exactly the way the
   *  store resolves it — `data.id` when the payload carries one, the row
   *  id otherwise — because a mismatch here deletes the wrong fact. */
  factId: string;
  deletedAt: string | null;
  text: string;
  category: string;
  establishedIn: string | null;
  group: GroupKey;
}

function readRow(entry: StoryLogEntry): FactRow {
  const data = entry.data as Partial<BibleFact> | undefined;
  const factId = typeof data?.id === 'string' ? data.id : entry.id;
  const base = {
    rowKey: entry.id,
    factId,
    text: '',
    category: '',
    establishedIn: null,
  };

  if (isFactTombstone(entry.data)) {
    return { ...base, deletedAt: entry.data.deleted_at, group: 'deleted' };
  }

  const confidence = String(data?.confidence ?? '') as Confidence;
  return {
    ...base,
    deletedAt: null,
    text: String(data?.text ?? ''),
    category: String(data?.category ?? ''),
    establishedIn:
      typeof data?.established_in === 'string' ? data.established_in : null,
    group: CONFIDENCES.includes(confidence) ? confidence : 'other',
  };
}

/** `world_rule` -> "world rule". The enum values are snake_case and the
 *  chip is prose, not a field name. */
function humanizeCategory(category: string): string {
  return category.replace(/_/g, ' ');
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** The two consequences of a delete, in the user's terms (§3 decision
 *  1): the text leaves the live story completely, and every snapshot
 *  older than this moment still holds it. Both matter — the first is
 *  what they asked for, the second is why this isn't erasure. */
function deleteMessage(text: string): string {
  const subject = text.trim() ? `“${clamp(text.trim(), 120)}”` : 'This fact';
  return (
    `${subject} is removed from the story everywhere — every list, and ` +
    `every contradiction that cites it. Snapshots taken before now still ` +
    `contain it, so restoring one of those brings it back.`
  );
}

function formatWhen(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : when.toLocaleString();
}

/** Which groups start open: contested when it has anything, inferred
 *  when contested is empty, everything else shut. Recomputed from the
 *  loaded rows rather than frozen at mount, so a contested fact arriving
 *  from "Load more" opens its own group — until the user has an opinion,
 *  at which point their toggle wins (see `overrides`). */
function defaultOpen(key: GroupKey, counts: Record<GroupKey, number>): boolean {
  if (key === 'contested' || key === 'other') return counts[key] > 0;
  if (key === 'inferred') return counts.contested === 0 && counts.inferred > 0;
  return false;
}

export function FactReviewList({
  facts,
  scenes,
  canManage,
  disabled,
  disabledReason,
  hasMore,
  onLoadMore,
  onOpenScene,
}: {
  facts: StoryLogEntry[];
  scenes: StorySceneSummary[];
  canManage: boolean;
  /** Canon locked, or a build running/resumable — §3 decisions 2 and 3.
   *  Delete renders, disabled; nothing here hides. */
  disabled: boolean;
  /** Why, in the caller's words ("Canon is locked — unlock to edit" /
   *  "Finish or clear the build first"). Shown only while disabled. */
  disabledReason?: string;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Optional: makes the scene line a link. Without it the scene is
   *  still named, just not clickable. */
  onOpenScene?: (sceneId: string) => void;
}) {
  const deleteFact = useStoryStore((s) => s.deleteFact);
  const isSaving = useStoryStore((s) => s.isSaving);
  const [overrides, setOverrides] = useState<Partial<Record<GroupKey, boolean>>>(
    {}
  );
  const [pending, setPending] = useState<FactRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const sceneById = useMemo(
    () => new Map(scenes.map((scene) => [scene.id, scene])),
    [scenes]
  );

  const grouped = useMemo(() => {
    const buckets: Record<GroupKey, FactRow[]> = {
      contested: [],
      inferred: [],
      explicit: [],
      other: [],
      deleted: [],
    };
    for (const entry of facts) {
      const row = readRow(entry);
      buckets[row.group].push(row);
    }
    return buckets;
  }, [facts]);

  const counts = useMemo(() => {
    const out = {} as Record<GroupKey, number>;
    for (const { key } of GROUPS) out[key] = grouped[key].length;
    return out;
  }, [grouped]);

  if (facts.length === 0) return null;

  const busy = deletingId !== null || isSaving;

  const runDelete = async (row: FactRow): Promise<void> => {
    setDeletingId(row.factId);
    try {
      // Toasts its own outcome, success and failure both — no second
      // toast from here.
      const ok = await deleteFact(row.factId);
      // Open the deleted group on the way out, so the struck-through row
      // the user just made is somewhere they can see it.
      if (ok) setOverrides((o) => ({ ...o, deleted: true }));
    } finally {
      setDeletingId(null);
    }
  };

  const renderScene = (sceneId: string) => {
    const scene = sceneById.get(sceneId);
    // Unresolved means the scene isn't loaded (or was merged away). Say
    // nothing rather than guess, and never fetch to find out.
    if (!scene) return null;
    const label = scene.title || `Scene ${scene.sequence + 1}`;
    if (!onOpenScene) return <span>Established in {label}</span>;
    return (
      <button
        type="button"
        onClick={() => onOpenScene(scene.id)}
        className="text-[var(--color-accent)] hover:underline"
      >
        Established in {label}
      </button>
    );
  };

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
        Established facts
      </h3>

      <div className="space-y-2">
        {GROUPS.map(({ key, label }) => {
          const rows = grouped[key];
          if (rows.length === 0) return null;
          const open = overrides[key] ?? defaultOpen(key, counts);
          return (
            <div key={key}>
              <button
                type="button"
                onClick={() =>
                  setOverrides((o) => ({ ...o, [key]: !open }))
                }
                aria-expanded={open}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] text-xs uppercase tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                <span className="flex-1 text-left">
                  {label} ({rows.length})
                </span>
                {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>

              {open && (
                <ul className="space-y-1 mt-1">
                  {rows.map((row) => (
                    <li
                      key={row.rowKey}
                      className="px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <p
                            title={row.deletedAt ? row.factId : undefined}
                            className={`text-sm ${
                              row.deletedAt
                                ? 'line-through text-[var(--color-text-secondary)]'
                                : 'text-[var(--color-text-primary)]'
                            }`}
                          >
                            {row.deletedAt
                              ? // All a tombstone has left. The full id is
                                // on the title, for matching against the
                                // edit log.
                                `Fact ${row.factId.slice(0, 8)}`
                              : row.text || '(no text)'}
                          </p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                            {row.deletedAt ? (
                              <>
                                <span className="px-2 py-0.5 rounded-full bg-[var(--color-bg-tertiary)]">
                                  deleted
                                </span>
                                <span>{formatWhen(row.deletedAt)}</span>
                              </>
                            ) : (
                              <>
                                {row.category && (
                                  <span className="px-2 py-0.5 rounded-full bg-[var(--color-bg-tertiary)]">
                                    {humanizeCategory(row.category)}
                                  </span>
                                )}
                                {row.establishedIn &&
                                  renderScene(row.establishedIn)}
                              </>
                            )}
                          </div>
                        </div>

                        {canManage && !row.deletedAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            title={disabled ? disabledReason : undefined}
                            disabled={disabled || busy}
                            onClick={() => setPending(row)}
                          >
                            <Trash2 size={13} className="mr-1.5" />
                            {deletingId === row.factId
                              ? 'Deleting…'
                              : 'Delete'}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex items-center gap-3 mt-2">
          <Button variant="secondary" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
          {/* Counted off the list, never off `manifest.fact_count` — the
              manifest counts live facts only while this list also holds
              tombstones, so the two legitimately disagree. */}
          <p className="text-xs text-[var(--color-text-secondary)]">
            Showing the first {facts.length} — the counts above cover what's
            loaded.
          </p>
        </div>
      )}

      {canManage && disabled && disabledReason && (
        <p className="text-xs text-[var(--color-text-secondary)] mt-2">
          {disabledReason}
        </p>
      )}

      <ConfirmDialog
        isOpen={pending !== null}
        title="Delete this fact?"
        message={pending ? deleteMessage(pending.text) : ''}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => {
          // ConfirmDialog calls onClose immediately after onConfirm, and
          // onClose clears `pending` — so capture the row first.
          const row = pending;
          if (row) void runDelete(row);
        }}
        onClose={() => setPending(null)}
      />
    </section>
  );
}
