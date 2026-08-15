import { create } from 'zustand';
import {
  storyApi,
  StoryConflictError,
  StoryRestoreConflictError,
  type ProjectChatRef,
  type StoryArchiveSummary,
  type StoryResetReason,
  type StoryLogEntry,
  type StoryManifest,
  type StorySceneOut,
  type StorySceneSummary,
  type StorySectionOut,
} from '../api/client';
import { showToastGlobal } from '../components/ui/Toast';
import {
  STORY_SCHEMA_VERSION,
  emptyRenderingHintsSection,
  isFactTombstone,
  STALE_ANNOTATION_FLAG,
  type Contradiction,
  type RenderingHintsSection,
  type SceneFunction,
  type SceneTransformations,
  type ContinuitySection,
  type Edit,
  type EditClassification,
  type EditTarget,
  type IngestWatermark,
  type MetaSection,
  type SamplePassage,
  type Scene,
  type StorySectionName,
  type UserVoiceSection,
} from '../types/storyBible';
import {
  bibleUuid,
  capturedAt,
  characterSourceRef,
  chatSourceRef,
  userAnnotationSourceRef,
} from '../utils/storyBible/sourceRefs';
// The delete-time cleanup and the lock-canon auto-fix apply the SAME
// mechanical rules, so they share one pure implementation rather than two
// that can disagree about what "cleaned" means.
import { cleanupFactRefs } from '../utils/storyBible/canonCheck';

/**
 * Story bible state for the Works panel's Story tab (step 2, phase 5).
 *
 * Read-mostly for now: this phase can designate a source chat (writing
 * the `meta` section) and display what exists. The ingestion passes that
 * fill the rest arrive in phases 6–8.
 *
 * NOTE (module-init hazard): this store must never statically import
 * `chatStore` — `lovenseStore` subscribes to it at module scope, and a
 * static edge from here would re-enter that cycle and throw a TDZ
 * "Cannot access 'useChatStore' before initialization". Everything this
 * store needs about chats comes from the Project row instead.
 */

interface StoryState {
  projectId: string | null;
  manifest: StoryManifest | null;
  /** Loaded sections by name; a section absent here may simply not have
   *  been fetched yet — check the manifest for what exists. */
  sections: Partial<Record<StorySectionName, StorySectionOut>>;
  scenes: StorySceneSummary[];
  scenesHasMore: boolean;
  facts: StoryLogEntry[];
  factsCursor: number | null;
  factsHasMore: boolean;
  /** Archive summaries (phase 9) — loaded lazily, only when the Story
   *  tab's archive panel is actually opened, not on every load(). */
  archives: StoryArchiveSummary[];
  archivesLoaded: boolean;
  /** Keyset cursor for the next archive page — the (created_at, id) pair
   *  the last page ended on. Null when there is no further page. */
  archivesCursor: { createdAt: string; id: string } | null;
  archivesHasMore: boolean;

  isLoading: boolean;
  isSaving: boolean;
  error: string | null;

  /** Load (or reload) everything the Story tab shows for a project. */
  load: (projectId: string) => Promise<void>;
  clear: () => void;
  loadSection: (name: StorySectionName) => Promise<void>;
  loadMoreFacts: () => Promise<void>;
  loadMoreScenes: () => Promise<void>;
  /** Designate the bible's single source chat, creating `meta`. */
  designateSourceChat: (
    chat: ProjectChatRef,
    opts?: {
      characters?: { avatar: string; name?: string }[];
      title?: string;
      /** The Work this designation is FOR. Any caller with an await
       *  between deciding and calling — confirmChange resets first, then
       *  designates — must pass it: a mismatch aborts instead of writing
       *  into whatever Work happens to be current by then. */
      projectId?: string;
    }
  ) => Promise<boolean>;
  resetBible: (reason?: StoryResetReason) => Promise<boolean>;
  /** Fetch the FIRST archive page — safe to call repeatedly, just
   *  re-fetches from the top (and resets any paging in progress). */
  loadArchives: () => Promise<void>;
  /** Append the next archive page. */
  loadMoreArchives: () => Promise<void>;
  /** Replace the live bible with a past snapshot. Builds its guard from
   *  the manifest already in state, so callers must have a fresh one
   *  (the Story tab always does — it's loaded on open). */
  restoreArchive: (archiveId: string) => Promise<boolean>;

  // --- Review checkpoint (phase 10) ------------------------------------

  /** Every fact row by id, tombstones included — the review surface needs
   *  arbitrary facts by id and the paged `facts` list can't answer that.
   *  Lazily built on first use, cleared by `clear()` and patched in place
   *  by `deleteFact`. Null means "not built yet", not "empty". */
  factIndex: Map<string, StoryLogEntry> | null;
  /** Page the whole fact log into `factIndex`. Cheap to call repeatedly —
   *  returns the cached map unless it's been invalidated. */
  loadAllFactsById: () => Promise<Map<string, StoryLogEntry> | null>;
  /** Every scene with its FULL payload, paged to exhaustion.
   *
   *  The lock-canon check reads scene ref fields (participants,
   *  continuity_facts_established, pov_character) that list summaries
   *  don't carry, so this is a fetch per scene on top of the paging.
   *  Deliberately not cached and not held in state: it runs once, on an
   *  explicit user action, against scene counts the plan calls small. */
  loadAllScenesWithData: () => Promise<StorySceneOut[] | null>;
  /**
   * The same whole-scene set, read through `GET /scenes/full` (step 3
   * phase 1) instead of a summary page plus a GET per scene.
   *
   * A second reader rather than a rewrite of the one above, because the
   * two have different failure appetites. Lock-canon and drift call that
   * one on an explicit click over "scene counts the plan calls small"; the
   * render path calls this one before every run, every preflight estimate
   * and every reader open, and the step-3 plan is explicit that this step
   * must not promote an N+1 to a hot path.
   *
   * A short page is NOT a last page — the server ends one early on its own
   * byte budget and points the cursor at the last row INCLUDED — so only
   * `has_more` terminates the loop.
   */
  loadAllScenesFull: () => Promise<StorySceneOut[] | null>;

  // --- Beat map (step 3 phase 2) ----------------------------------------

  /** The annotate pass's output for every scene, in sequence order. Null
   *  means "not loaded", which is NOT the same as "no scenes annotated" —
   *  it is fetched only when the beat map is opened, since the scene-list
   *  projection carries no `data` and reading it means pulling whole
   *  rows. Invalidated by `load()` and `clear()`. */
  beatMap: BeatMapEntry[] | null;
  beatMapLoading: boolean;
  /** Page every scene's annotation into `beatMap`. Cheap to call
   *  repeatedly — returns immediately once loaded. */
  loadBeatMap: () => Promise<void>;
  /** The one continuity writer for resolution-shaped changes. `patchFn`
   *  is pure and re-run against the winner's entries on conflict, so the
   *  user's intent survives a 409 instead of being merged away or blindly
   *  overwriting. Returning null from it is an explicit no-op. */
  patchContinuity: (
    patchFn: (entries: Contradiction[]) => Contradiction[] | null,
    editMeta: EditMeta
  ) => Promise<boolean>;
  /** Tombstone a fact, then mechanically clean up every contradiction
   *  that cited it. */
  deleteFact: (factId: string) => Promise<boolean>;
  /** Full-replace one scene through a pure patch of its `data`. */
  patchScene: (
    sceneId: string,
    patchFn: (data: Scene) => Scene | null,
    editMeta: EditMeta,
    opts?: ScenePatchOptions
  ) => Promise<boolean>;
  /** Fold a scene into its predecessor in the loaded ordering. */
  mergeSceneIntoPrevious: (sceneId: string) => Promise<boolean>;
  /** Add a user-written passage to `user_voice.sample_passages`. */
  appendSamplePassage: (text: string) => Promise<boolean>;
  /**
   * Write the Render tab's novel hints (step 3 phase 5).
   *
   * Patches `rendering_hints.novel` and leaves the other three renderer
   * groups verbatim — the section is a single full-replace row, so writing
   * only what the editor knows about would delete `screenplay`,
   * `graphic_novel` and `storyboard` on every save.
   *
   * Deliberately permitted while canon is LOCKED. §3.3 narrows the lock
   * invariant to user-authored *bible* edits and exempts the render path;
   * a locked bible is precisely the state §1 describes a user rendering
   * from, so refusing here would make the whole tab unusable in its
   * primary case. The build gate still applies: cold start full-replaces
   * this section, and a save landing mid-walk would be clobbered.
   */
  saveNovelHints: (
    patch: Partial<RenderingHintsSection['novel']>
  ) => Promise<boolean>;
  /** Point the bible at the same roleplay under a new identity, keeping
   *  the capture snapshot and the ingest watermark untouched. */
  relinkSourceChat: (chat: ProjectChatRef) => Promise<boolean>;
  lockCanon: () => Promise<boolean>;
  unlockCanon: () => Promise<boolean>;

  // --- Incremental re-ingestion (phase 11) ------------------------------

  /** Stamp `annotations.stale_source` on scenes whose source no longer
   *  matches upstream. One `patchScene` per scene with INDEPENDENT
   *  failure — a flag is advisory, so partial success beats an
   *  all-or-nothing batch that a single concurrent edit could roll back.
   *  Already-flagged scenes are a no-op (no PUT, no `server_ts` churn),
   *  which is what makes re-running free. */
  flagScenesStale: (sceneIds: readonly string[]) => Promise<StaleFlagResult>;
  /** Clear the flag on one scene — the user's "this is fine" escape
   *  hatch from the review surface. */
  clearSceneStale: (sceneId: string) => Promise<boolean>;
  /** Advance `meta.ingest_watermark` after a walk pass completed.
   *
   *  Lives here because `meta` is this store's section, and is called
   *  from `storyIngestStore` through a lazy import for the same
   *  no-static-store-edges reason `isBuildActiveNow` exists. Ungated on
   *  purpose: the walk that calls it IS the active build, so
   *  `refuseIfGated` would refuse against its own checkpoint. */
  advanceIngestWatermark: (
    watermark: IngestWatermark,
    opts?: { projectId?: string }
  ) => Promise<boolean>;
}

/** Escape hatches for callers that are not a user editing one scene. */
export interface ScenePatchOptions {
  /** Permit the write while a build is running/paused/error. Only for
   *  writes that cannot race the walk's own scene writes — phase 11's
   *  stale flagging qualifies because flagging is deliberately kept OUT
   *  of the walk (plan §5.6) and `stale_source` is annotation state no
   *  pass reads. */
  allowWhileBuilding?: boolean;
  /** Skip the edit-log row. `recordEdit` stamps `actor: 'user'`, which is
   *  a lie for a machine-driven annotation; a derived flag is not
   *  authorship. */
  skipEdit?: boolean;
  /** Suppress the merged-on-another-device toast. A bulk flagging pass
   *  would otherwise stack one toast per scene. */
  quiet?: boolean;
}

export interface StaleFlagResult {
  flagged: number;
  alreadyFlagged: number;
  failed: number;
}

/** What an action tells `recordEdit` about the change it just made. The
 *  id, timestamp, actor and surface are the helper's to stamp. */
export interface EditMeta {
  target: EditTarget;
  classification: EditClassification;
  diff?: string;
}

const FACT_PAGE = 50;
const SCENE_PAGE = 100;
const ARCHIVE_PAGE = 25;
/** The server's own maximum. The review index pages the whole log, so it
 *  wants the biggest page it can get, unlike the tab's lazy list. */
const FACT_INDEX_PAGE = 500;
/** Backstop on the index's paging loop — a runaway cursor is a hang, not
 *  an error, and this is the same shape the ingest store's pager uses. */
const MAX_FACT_INDEX_PAGES = 500;
/** Same backstop for the scene pager behind the lock-canon check. */
const MAX_SCENE_INDEX_PAGES = 200;
/** Rows per `/scenes/full` page for the beat map. Below the server's own
 *  ceiling of 100, since a full page is whole scene bodies rather than
 *  the list projection. */
const BEAT_MAP_PAGE = 50;
/** Same page size, same reason, for the render path's whole-scene read.
 *  Deliberately its own constant: the beat map wants annotations and the
 *  renderer wants summaries, so a future tuning of one is not a silent
 *  retuning of the other. */
const FULL_SCENE_PAGE = 50;
/** Backend `EDIT_MAX_BYTES` is 16 KiB on the normalized row; the diff is
 *  the only free-form field, so it gets a clamp with headroom to spare. */
const EDIT_DIFF_MAX = 2000;
/** `SamplePassage.text` has no server cap of its own, but the section
 *  does (256 KiB) and a pasted novel chapter would eat it. */
const SAMPLE_PASSAGE_MAX = 4000;
/** Keeps the voice section from growing without bound; walk-captured
 *  passages are never evicted, only user-added ones. */
const MAX_USER_PASSAGES = 10;
/** `SCENE_MAX_BYTES`. Checked client-side before a merge writes, because
 *  a 413 landing after a partial merge is the unrecoverable shape. */
const SCENE_MAX_BYTES = 64 * 1024;

/** True when the manifest says `meta` exists — i.e. a source chat has
 *  been designated and the bible has begun. */
export function hasBible(manifest: StoryManifest | null): boolean {
  return !!manifest?.sections.some((s) => s.section === 'meta');
}

/** True while the bible is locked and every mutating review action must
 *  refuse. Read from the meta section rather than store state — the lock
 *  is bible content, not client state, so it survives a reload and is
 *  visible to every device. */
export function isCanonLocked(
  sections: Partial<Record<StorySectionName, StorySectionOut>>
): boolean {
  const meta = sections.meta?.data as unknown as MetaSection | undefined;
  return !!meta?.canon_locked_at;
}

/** The deleted fact's text, for the edit row's diff. Looked up from
 *  whatever is already loaded — this runs AFTER the tombstone landed, so
 *  it is best-effort by nature and an empty string is an honest answer. */
function factTextFor(
  index: Map<string, StoryLogEntry> | null,
  facts: StoryLogEntry[],
  factId: string
): string {
  const row =
    index?.get(factId) ??
    facts.find(
      (f) => (typeof f.data?.id === 'string' ? f.data.id : f.id) === factId
    );
  if (!row || isFactTombstone(row.data)) return '(text unavailable)';
  return String(row.data?.text ?? '').slice(0, 200);
}

/**
 * One scene's annotate-pass output, flattened for display.
 *
 * A view model, deliberately not `Scene`: the beat map holds every scene
 * at once, and keeping whole rows in state would park the detailed
 * summaries and message ranges of a 200-scene bible in memory to render
 * four short fields.
 */
export interface BeatMapEntry {
  id: string;
  sequence: number;
  title: string;
  /** Null when this scene has not been annotated. */
  beat: SceneFunction['beat'] | null;
  tension: number | null;
  mood: string;
  stakes: string;
  compression: SceneTransformations['compression_recommendation'] | null;
  compressionRatio: number | null;
  pacingNotes: string;
  /** The scene grew after it was annotated, so its beat and compression
   *  target were read from less material than it now holds (§3.9a). */
  stale: boolean;
}

function beatMapEntry(row: StorySceneOut): BeatMapEntry {
  const data = row.data as unknown as Partial<Scene> | undefined;
  const fn = data?.function ?? null;
  const tr = data?.transformations ?? null;
  return {
    id: row.id,
    sequence: row.sequence,
    title: typeof data?.title === 'string' ? data.title : '',
    beat: fn?.beat ?? null,
    tension: typeof fn?.tension === 'number' ? fn.tension : null,
    mood: fn?.mood ?? '',
    stakes: fn?.stakes ?? '',
    compression: tr?.compression_recommendation ?? null,
    compressionRatio:
      typeof tr?.compression_ratio_target === 'number'
        ? tr.compression_ratio_target
        : null,
    pacingNotes: tr?.pacing_notes ?? '',
    stale: (data?.annotations?.flagged_issues ?? []).includes(
      STALE_ANNOTATION_FLAG
    ),
  };
}

/** Fold `victim` into `survivor`, which precedes it.
 *
 *  Pure so the byte-budget check and the tests can run it without
 *  touching the network. The survivor keeps its own identity fields
 *  (title, setting, pov, user notes) — a merge is "this scene absorbed
 *  the next one", not "these two became a third thing".
 *
 *  Its `function` and `transformations` are the exception, and they are
 *  DROPPED rather than kept (step-3 plan §3.9c). The spread used to carry
 *  them through while the range below was rewritten to span both scenes,
 *  so the survivor's beat, tension and compression target described
 *  roughly half the material it ended up holding — and a render re-read
 *  that stale annotation as canon. One rule covers this and the walk's
 *  re-emission: a widened scene loses its annotation. The walk PRESERVES
 *  its annotation under a stale marker instead, because it re-emits every
 *  continuing scene and dropping there would make preservation pointless;
 *  a merge is a one-off user action, so the honest answer is to re-run
 *  annotate on the survivor. */
export function mergeScenes(survivor: Scene, victim: Scene): Scene {
  const join = (a: string, b: string): string =>
    [a?.trim(), b?.trim()].filter(Boolean).join(' ');
  const union = (a: string[] = [], b: string[] = []): string[] =>
    Array.from(new Set([...a, ...b]));
  return {
    ...survivor,
    summary: join(survivor.summary, victim.summary),
    detailed_summary: join(survivor.detailed_summary, victim.detailed_summary),
    participants: union(survivor.participants, victim.participants),
    function: null,
    transformations: null,
    // The scene→fact index IS healed by this union; the fact→scene back
    // pointer (`established_in` on the victim's facts) dangles forever,
    // because facts are append-only and there is nothing to heal them
    // with. That is a lock-canon warning, by design.
    continuity_facts_established: union(
      survivor.continuity_facts_established,
      victim.continuity_facts_established
    ),
    source: {
      ...survivor.source,
      message_range: {
        start: survivor.source.message_range.start,
        end: victim.source.message_range.end,
      },
      total_messages:
        (survivor.source.total_messages ?? 0) +
        (victim.source.total_messages ?? 0),
      swipe_resolutions: [
        ...(survivor.source.swipe_resolutions ?? []),
        ...(victim.source.swipe_resolutions ?? []),
      ],
      excluded_segments: [
        ...(survivor.source.excluded_segments ?? []),
        ...(victim.source.excluded_segments ?? []),
      ],
    },
    annotations: {
      ...survivor.annotations,
      // The stale-annotation marker goes with the annotation it describes:
      // with `function`/`transformations` nulled above, a surviving marker
      // would be a flag about nothing, and `needsAnnotation` already reads
      // the null.
      flagged_issues: [
        ...(survivor.annotations?.flagged_issues ?? []),
        ...(victim.annotations?.flagged_issues ?? []),
      ].filter((f) => f !== STALE_ANNOTATION_FLAG),
    },
  };
}

export const useStoryStore = create<StoryState>((set, get) => {
  // Closure-private, not store state: loadArchives() bumps this on every
  // call and only applies its response if it's still the latest one in
  // flight, so an overlapping earlier call resolving late can't revert a
  // fresher archive list (review finding — the projectId guard alone
  // doesn't order two calls for the SAME project against each other).
  let archivesFetchSeq = 0;
  // Same shape as archivesFetchSeq: orders a loadAllFactsById paging run
  // against ANY other write to factIndex (load()'s reset, deleteFact's
  // patch, clear()). Without it a slow paging run can trail a fresh
  // load() and stamp its stale map over new rows.
  let factIndexSeq = 0;
  // Same shape as factIndexSeq, for the beat map's own paging run.
  let beatMapSeq = 0;

  // Bumped by clear(), which the Story tab calls whenever it unmounts or
  // switches Works. `projectId` alone can't see a leave-and-return: the
  // user can navigate away from Work A and back to Work A while a
  // reset/restore/designate is still in flight, and by the time it
  // resolves `projectId` reads 'A' again — so the guard passes and the
  // stale call wipes the freshly reloaded state and stomps whatever save
  // the SECOND visit has in progress. Comparing the epoch too makes
  // "same project" mean "same visit".
  let storeEpoch = 0;

  /** True when the store is still on the same visit to the same project
   *  that an action captured when it started. */
  const stillOn = (projectId: string, epoch: number): boolean =>
    get().projectId === projectId && storeEpoch === epoch;

  /** Reload only while the store is still on the same visit to this
   *  project.
   *
   *  `load()` sets `projectId`, so calling it unconditionally after an
   *  await would drag the store BACK to a Work the user already left —
   *  and every later write (which reads `projectId`) would then hit the
   *  wrong bible. */
  const reloadIfStillOn = async (
    projectId: string,
    epoch: number
  ): Promise<void> => {
    if (!stillOn(projectId, epoch)) return;
    await get().load(projectId);
  };

  /** True while the bible is locked. Read from the meta section rather
   *  than a memoized flag: the lock is server state that any device can
   *  set or clear, and this call runs right before a write, so it needs
   *  the freshest value the store has. */
  const isLockedNow = (): boolean => {
    const meta = get().sections.meta?.data as unknown as MetaSection | undefined;
    return !!meta?.canon_locked_at;
  };

  /** True while a walk is running or resumable (plan §3.3). Read via a
   *  LAZY import so this store keeps its "never statically edge to
   *  another store" rule — static cycles here are how TDZ crashes at
   *  boot start. The dynamic import is cached by the module loader, so
   *  a hot mutating path pays the resolution once. */
  const isBuildActiveNow = async (): Promise<boolean> => {
    try {
      const mod = await import('./storyIngestStore');
      const status = mod.useStoryIngestStore.getState().checkpoint?.status;
      return status === 'running' || status === 'paused' || status === 'error';
    } catch {
      // The import failing (rare — code split, offline reload) must
      // never block writes: fail open, matching every other guard here.
      return false;
    }
  };

  /** Toast + refuse pattern shared by every gated action. `toastKind` is
   *  the reason so the user sees why the click did nothing. */
  const refuseIfGated = async (opts: {
    allowWhileLocked?: boolean;
    allowWhileBuilding?: boolean;
  }): Promise<boolean> => {
    if (!opts.allowWhileLocked && isLockedNow()) {
      showToastGlobal('Canon is locked — unlock to edit', 'warning');
      return true;
    }
    if (!opts.allowWhileBuilding && (await isBuildActiveNow())) {
      showToastGlobal('Finish or clear the build first', 'warning');
      return true;
    }
    return false;
  };

  /** Append one edit-log row for a change that has ALREADY landed.
   *
   *  Best-effort and deliberately swallowing: the primary mutation is
   *  committed by the time this runs, so a failed edit append must never
   *  roll anything back, block the UI, or turn a successful action into a
   *  reported failure. It toasts once and moves on.
   *
   *  The id is minted BEFORE the POST so a transport retry re-sends the
   *  same id and the server's `(project_id, id)` idempotency absorbs it —
   *  one user action can never become two history rows. */
  const recordEdit = async (
    projectId: string,
    epoch: number,
    meta: EditMeta
  ): Promise<void> => {
    const edit: Edit = {
      id: bibleUuid(),
      occurred_at: capturedAt(),
      actor: 'user',
      surface: 'bible_direct',
      target: meta.target,
      diff: (meta.diff ?? '').slice(0, EDIT_DIFF_MAX),
      classification: meta.classification,
      // These ARE bible-direct edits by construction — the user changed
      // the bible itself, not a rendered output awaiting propagation.
      propagated_to_bible: true,
      propagation_notes: '',
    };
    try {
      await storyApi.appendEdit(
        projectId,
        edit as unknown as Record<string, unknown>
      );
    } catch (error) {
      if (stillOn(projectId, epoch)) {
        showToastGlobal(
          error instanceof Error
            ? `Change saved, but the history entry failed: ${error.message}`
            : 'Change saved, but the history entry failed',
          'warning'
        );
      }
    }
  };

  /** Set or clear `meta.canon_locked_at`. Shared by lock and unlock
   *  because they differ only in the value written and the words used —
   *  everything else (read-spread-PUT, one adopt-retry, the edit row) is
   *  identical, and duplicating it is how the two drift apart. */
  const setCanonLock = async (locked: boolean): Promise<boolean> => {
    const { projectId } = get();
    if (!projectId) return false;
    // Unlock (locked=false) must still work while the bible is locked —
    // that IS the point of unlock. Lock (locked=true) has to refuse
    // while another device already locked (no-op UX), and both refuse
    // during an active build (§3.3): the build's own writes would race
    // a lock stamp.
    if (await refuseIfGated({ allowWhileLocked: !locked })) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;

    const write = async (
      current: StorySectionOut | null,
      baseTs: number
    ): Promise<void> => {
      const existing = (current?.data ?? null) as unknown as MetaSection | null;
      if (!existing) throw new Error('No story to lock yet');
      const section = await storyApi.putSection(
        projectId,
        'meta',
        {
          ...existing,
          updated_at: capturedAt(),
          canon_locked_at: locked ? capturedAt() : null,
        } as unknown as Record<string, unknown>,
        baseTs
      );
      if (stillOn(projectId, epoch)) {
        set((s) => ({ sections: { ...s.sections, meta: section } }));
      }
    };

    const editMeta: EditMeta = {
      target: { type: 'meta' },
      classification: 'substantive',
      diff: locked ? 'canon locked' : 'canon unlocked',
    };

    try {
      const current = get().sections.meta ?? null;
      await write(current, current?.server_ts ?? 0);
      await recordEdit(projectId, epoch, editMeta);
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) {
        set({ isSaving: false });
        showToastGlobal(locked ? 'Canon locked' : 'Canon unlocked', 'success');
      }
      return stillCurrentNow;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        try {
          await write(error.current ?? null, error.currentTs);
          await recordEdit(projectId, epoch, editMeta);
          const stillCurrentNow = stillOn(projectId, epoch);
          if (stillCurrentNow) {
            set({ isSaving: false });
            showToastGlobal(
              locked
                ? 'Canon locked (merged with another device)'
                : 'Canon unlocked (merged with another device)',
              'warning'
            );
          }
          return stillCurrentNow;
        } catch {
          if (stillOn(projectId, epoch)) {
            set({ isSaving: false });
            showToastGlobal(
              'The story changed on another device — try again',
              'error'
            );
          }
          return false;
        }
      }
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof Error
            ? error.message
            : locked
              ? 'Failed to lock canon'
              : 'Failed to unlock canon',
          'error'
        );
      }
      return false;
    }
  };

  return {
  projectId: null,
  manifest: null,
  sections: {},
  scenes: [],
  scenesHasMore: false,
  facts: [],
  factsCursor: null,
  factsHasMore: false,
  archives: [],
  archivesLoaded: false,
  archivesCursor: null,
  archivesHasMore: false,
  factIndex: null,
  beatMap: null,
  beatMapLoading: false,
  isLoading: false,
  isSaving: false,
  error: null,

  clear: () => {
    // Ends the current visit: anything still in flight that captured the
    // old epoch stops being allowed to write, even if the user comes
    // straight back to the same Work.
    storeEpoch++;
    // And any factIndex paging that captured the old seq stops being
    // allowed to write too — the epoch check alone doesn't order two
    // calls within the same visit.
    factIndexSeq++;
    beatMapSeq++;
    set({
      projectId: null,
      manifest: null,
      // Cleared here too: an in-flight load() returns early once the
      // project changes, so whoever cancels it owns resetting this.
      isLoading: false,
      // Same reasoning: leaving a Work while a save/reset/restore is
      // still in flight must not strand the NEXT Work's tab thinking a
      // mutation is permanently in progress (resetBible/restoreArchive's
      // re-entrancy guard would otherwise refuse to ever run again).
      isSaving: false,
      sections: {},
      scenes: [],
      scenesHasMore: false,
      facts: [],
      factsCursor: null,
      factsHasMore: false,
      archives: [],
      archivesLoaded: false,
      archivesCursor: null,
      archivesHasMore: false,
      // The epoch bump alone doesn't drop this — a cached index would
      // otherwise show one Work's facts inside the next Work's cards.
      factIndex: null,
      // Same reasoning, and the same failure if it is missed: one Work's
      // beats rendered under the next Work's scene titles.
      beatMap: null,
      beatMapLoading: false,
      error: null,
    });
  },

  load: async (projectId) => {
    set({ projectId, isLoading: true, error: null });
    const epoch = storeEpoch;
    try {
      const manifest = await storyApi.manifest(projectId);
      // Guard before EVERY write, not just the final one: the user can
      // switch Works mid-flight, and a late manifest landing on the new
      // Work shows one story's counts under another's name.
      if (!stillOn(projectId, epoch)) return;
      set({ manifest });

      // Only fetch what exists. A 404 here would be normal-but-noisy for
      // an untouched Work, so the manifest gates the reads.
      const present = new Set(manifest.sections.map((s) => s.section));
      const wanted: StorySectionName[] = [
        'meta',
        'world',
        'entities',
        'continuity',
        'ingestion',
        // Phase 10's voice meter reads this, and appendSamplePassage
        // read-spread-PUTs it — both need it in state, not a lazy GET.
        'user_voice',
      ];
      const loaded: Partial<Record<StorySectionName, StorySectionOut>> = {};
      await Promise.all(
        wanted
          .filter((name) => present.has(name))
          .map(async (name) => {
            loaded[name] = await storyApi.getSection(projectId, name);
          })
      );

      const [scenePage, factPage] = await Promise.all([
        manifest.scene_count > 0
          ? storyApi.listScenes(projectId, { limit: SCENE_PAGE })
          : Promise.resolve(null),
        // NOT gated on fact_count: since phase 10 that number counts LIVE
        // facts only, so a bible whose facts were all deleted reports 0
        // while GET /facts still returns the tombstone rows the review
        // list must render struck through. Gate on the bible existing at
        // all instead — one empty page for a young bible is cheaper than
        // silently hiding every deleted fact.
        manifest.sections.length > 0
          ? storyApi.listFacts(projectId, { limit: FACT_PAGE })
          : Promise.resolve(null),
      ]);

      // Guard against a slow load landing after the user switched Works.
      if (!stillOn(projectId, epoch)) return;
      set({
        sections: loaded,
        scenes: scenePage?.items ?? [],
        scenesHasMore: scenePage?.has_more ?? false,
        facts: factPage?.items ?? [],
        factsCursor: factPage?.next_after_seq ?? null,
        factsHasMore: factPage?.has_more ?? false,
        // A reload can change the whole log (restore, reset, a finished
        // walk), so the index is invalidated rather than reconciled; the
        // next card that needs it re-pages. The seq bump keeps a paging
        // run that started before this reload from stamping its stale
        // map after the null lands.
        factIndex: null,
        // Same invalidation, and this is the load that matters most for
        // it: an annotate run ends by calling load(), so dropping the
        // cache here is what makes a re-run's new beats visible without
        // the beat map needing its own invalidation hook.
        beatMap: null,
        beatMapLoading: false,
        isLoading: false,
      });
      factIndexSeq++;
      beatMapSeq++;
    } catch (error) {
      if (!stillOn(projectId, epoch)) return;
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load story',
      });
    }
  },

  loadSection: async (name) => {
    const { projectId } = get();
    if (!projectId) return;
    const epoch = storeEpoch;
    try {
      const section = await storyApi.getSection(projectId, name);
      if (!stillOn(projectId, epoch)) return;
      set((s) => ({ sections: { ...s.sections, [name]: section } }));
    } catch {
      // A missing section is an expected state, not an error worth a toast.
    }
  },

  loadMoreFacts: async () => {
    const { projectId, factsCursor, factsHasMore } = get();
    if (!projectId || !factsHasMore || factsCursor === null) return;
    const epoch = storeEpoch;
    try {
      const page = await storyApi.listFacts(projectId, {
        afterSeq: factsCursor,
        limit: FACT_PAGE,
      });
      // Re-read state AFTER the await: appending onto the pre-await
      // snapshot would resurrect facts a concurrent reset just cleared.
      const live = get();
      if (!stillOn(projectId, epoch) || live.factsCursor !== factsCursor) return;
      set({
        facts: [...live.facts, ...page.items],
        factsCursor: page.next_after_seq,
        factsHasMore: page.has_more,
      });
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to load facts',
        'error'
      );
    }
  },

  loadMoreScenes: async () => {
    const { projectId, scenes, scenesHasMore } = get();
    if (!projectId || !scenesHasMore || scenes.length === 0) return;
    const last = scenes[scenes.length - 1];
    const epoch = storeEpoch;
    try {
      // Both cursor halves: `sequence` is not unique, and paging on it
      // alone drops every scene tied with the one that ended the page.
      const page = await storyApi.listScenes(projectId, {
        afterSequence: last.sequence,
        afterId: last.id,
        limit: SCENE_PAGE,
      });
      // Post-await re-read, same reasoning as loadMoreFacts.
      const live = get();
      if (!stillOn(projectId, epoch)) return;
      if (live.scenes[live.scenes.length - 1]?.id !== last.id) return;
      set({
        scenes: [...live.scenes, ...page.items],
        scenesHasMore: page.has_more,
      });
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to load scenes',
        'error'
      );
    }
  },

  designateSourceChat: async (chat, opts = {}) => {
    const { projectId } = get();
    if (!projectId) return false;
    // Checked BEFORE claiming isSaving — bailing after would strand the
    // flag on a Work this call has no business touching.
    if (opts.projectId && opts.projectId !== projectId) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;

    const build = (existing: MetaSection | null): MetaSection => {
      const now = capturedAt();
      return {
        // A section PUT is a FULL REPLACE and the server materializes
        // defaults, so anything not resent is reset to its default.
        // Spread what we read first and override only what this action
        // owns — otherwise re-designating (or losing the create race and
        // retrying) silently wipes content_rating, derivative_flags,
        // canon_locked_at, word counts and any lorebook ids a later
        // ingestion pass wrote.
        ...(existing ?? {}),
        schema_version: existing?.schema_version ?? STORY_SCHEMA_VERSION,
        bible_id: existing?.bible_id ?? bibleUuid(),
        created_at: existing?.created_at ?? now,
        updated_at: now,
        source: {
          ...(existing?.source ?? {}),
          platform: 'ggbc',
          chat: chatSourceRef(chat),
          characters: (opts.characters ?? []).map((c) =>
            characterSourceRef(c.avatar, c.name)
          ),
        },
        title: opts.title ?? existing?.title ?? '',
        // Deliberately zeroed: the watermark counts messages ingested
        // FROM the source chat, so pointing at a different chat makes
        // any previous count meaningless.
        ingest_watermark: { message_count: 0, last_msg: null },
      };
    };

    const write = async (baseTs: number, existing: MetaSection | null) => {
      const section = await storyApi.putSection(
        projectId,
        'meta',
        build(existing) as unknown as Record<string, unknown>,
        baseTs
      );
      // The user may have switched to a different Work while this PUT
      // was in flight — meta belongs to whichever project is CURRENT, so
      // writing it unconditionally would clobber a different Work's live
      // state (same class of bug reviewed and fixed in resetBible).
      if (stillOn(projectId, epoch)) {
        set((s) => ({ sections: { ...s.sections, meta: section } }));
      }
      return section;
    };

    try {
      const current = get().sections.meta;
      await write(
        current?.server_ts ?? 0,
        (current?.data as unknown as MetaSection) ?? null
      );
      await reloadIfStillOn(projectId, epoch);
      const stillCurrent = stillOn(projectId, epoch);
      if (stillCurrent) set({ isSaving: false });
      // A caller acting on this return value (e.g. confirmChange calling
      // designate() after resetBible()) must not treat a remotely
      // successful write against an abandoned project as success.
      return stillCurrent;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        // Another device wrote meta first. Adopt it and retry once — the
        // same adopt-winner path projectStore uses.
        try {
          const winnerData = error.current?.data as unknown as MetaSection | undefined;
          await write(error.currentTs, winnerData ?? null);
          await reloadIfStillOn(projectId, epoch);
          const stillCurrent = stillOn(projectId, epoch);
          if (stillCurrent) {
            set({ isSaving: false });
            showToastGlobal(
              'Story was updated on another device — changes merged',
              'warning'
            );
          }
          return stillCurrent;
        } catch {
          if (stillOn(projectId, epoch)) {
            set({ isSaving: false });
            showToastGlobal(
              'Failed to set the source chat — it changed on another device',
              'error'
            );
          }
          return false;
        }
      }
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to set the source chat',
          'error'
        );
      }
      return false;
    }
  },

  resetBible: async (reason) => {
    const { projectId, isSaving } = get();
    if (!projectId || isSaving) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;
    try {
      await storyApi.reset(projectId, reason);
      // The user may have switched to a different Work while the reset
      // was in flight — every field below (including isSaving, the
      // success toast, and the return value a caller acts on) belongs
      // to whichever project is CURRENT, so clearing/reporting it
      // unconditionally would wipe a different Work's live state, stomp
      // its own isSaving flag, and lie to a caller (e.g. confirmChange's
      // designate-after-reset) about which project actually succeeded.
      // "Still current" means the same VISIT, not just the same id — see
      // storeEpoch: leaving Work A and coming straight back to it must
      // not let this stale call wipe the second visit's fresh state.
      const stillCurrent = stillOn(projectId, epoch);
      if (stillCurrent) {
        set({
          sections: {},
          scenes: [],
          scenesHasMore: false,
          facts: [],
          factsCursor: null,
          factsHasMore: false,
          isSaving: false,
        });
      }
      await reloadIfStillOn(projectId, epoch);
      // Reset just took a snapshot — refresh an already-open archive list
      // so it shows up without the user having to close and reopen it.
      if (stillOn(projectId, epoch) && get().archivesLoaded) {
        await get().loadArchives();
      }
      // Recomputed AFTER the two trailing awaits. `stillCurrent` above is
      // sampled right after the network call, which is correct for the
      // state writes it guards — but the user can switch Works during
      // reloadIfStillOn or loadArchives, and a stale `true` returned here
      // is exactly what lets confirmChange's
      // `if (await resetBible(...)) await designate(chat)` write the OLD
      // Work's chat into the NEW Work's bible.
      //
      // Deliberate consequence: switching away during the reload
      // suppresses the success toast for a reset that DID succeed
      // remotely. That is right — the toast would otherwise pop over the
      // wrong Work's tab.
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) showToastGlobal('Story reset', 'success');
      return stillCurrentNow;
    } catch (error) {
      const stillCurrent = stillOn(projectId, epoch);
      if (stillCurrent) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to reset the story',
          'error'
        );
      }
      return false;
    }
  },

  loadArchives: async () => {
    const { projectId } = get();
    if (!projectId) return;
    // A slower earlier call resolving after a faster later one (e.g. two
    // reset/restore success hooks firing close together) must not revert
    // the list to stale data — the projectId check alone only guards
    // against a DIFFERENT project, not two calls for the SAME one.
    const seq = ++archivesFetchSeq;
    const epoch = storeEpoch;
    try {
      const page = await storyApi.listArchives(projectId, { limit: ARCHIVE_PAGE });
      if (!stillOn(projectId, epoch) || seq !== archivesFetchSeq) return;
      set({
        archives: page.archives,
        archivesLoaded: true,
        archivesCursor:
          page.has_more && page.next_after_created_at && page.next_after_id
            ? { createdAt: page.next_after_created_at, id: page.next_after_id }
            : null,
        archivesHasMore: page.has_more,
      });
    } catch (error) {
      // A stale/superseded call (wrong project, or an older call whose
      // result a newer one already replaced) failing must not pop an
      // error toast over a list that's already showing correct, fresher
      // data — same staleness check as the success path above.
      if (!stillOn(projectId, epoch) || seq !== archivesFetchSeq) return;
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to load archives',
        'error'
      );
    }
  },

  loadMoreArchives: async () => {
    const { projectId, archivesCursor, archivesHasMore } = get();
    if (!projectId || !archivesHasMore || !archivesCursor) return;
    // Shares archivesFetchSeq with loadArchives on purpose: a reset or
    // restore firing loadArchives() mid-page must win, and this appended
    // page must not land on top of that fresh first page.
    const seq = ++archivesFetchSeq;
    const epoch = storeEpoch;
    try {
      const page = await storyApi.listArchives(projectId, {
        afterCreatedAt: archivesCursor.createdAt,
        afterId: archivesCursor.id,
        limit: ARCHIVE_PAGE,
      });
      // Post-await re-read, same reasoning as loadMoreFacts: appending
      // onto the pre-await snapshot would resurrect rows a concurrent
      // reload just replaced.
      const live = get();
      if (!stillOn(projectId, epoch) || seq !== archivesFetchSeq) return;
      if (live.archivesCursor?.id !== archivesCursor.id) return;
      set({
        archives: [...live.archives, ...page.archives],
        archivesCursor:
          page.has_more && page.next_after_created_at && page.next_after_id
            ? { createdAt: page.next_after_created_at, id: page.next_after_id }
            : null,
        archivesHasMore: page.has_more,
      });
    } catch (error) {
      if (!stillOn(projectId, epoch) || seq !== archivesFetchSeq) return;
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to load archives',
        'error'
      );
    }
  },

  restoreArchive: async (archiveId) => {
    const { projectId, manifest, isSaving } = get();
    // No manifest means the Story tab hasn't loaded this project yet —
    // there is nothing to build the staleness guard from.
    if (!projectId || !manifest || isSaving) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;
    const expected = {
      sections: Object.fromEntries(
        manifest.sections.map((s) => [s.section, s.server_ts])
      ),
      sceneCount: manifest.scene_count,
      factCount: manifest.fact_count,
      editCount: manifest.edit_count,
    };
    try {
      await storyApi.restoreArchive(projectId, archiveId, expected);
      // See resetBible: a switched-away project's state (including its
      // OWN isSaving, the success toast, and the return value a caller
      // acts on) must not be clobbered or misreported by this call — and
      // "same project" here means the same VISIT (see storeEpoch), so a
      // leave-and-return to the same Work invalidates this too.
      const stillCurrent = stillOn(projectId, epoch);
      if (stillCurrent) {
        set({
          sections: {},
          scenes: [],
          scenesHasMore: false,
          facts: [],
          factsCursor: null,
          factsHasMore: false,
          isSaving: false,
        });
      }
      await reloadIfStillOn(projectId, epoch);
      // Restore itself took a safety snapshot — refresh the list.
      if (stillOn(projectId, epoch) && get().archivesLoaded) {
        await get().loadArchives();
      }
      // See resetBible: recomputed after the trailing awaits, because the
      // sample taken before them can report success for a Work the user
      // has since left.
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) showToastGlobal('Story restored', 'success');
      return stillCurrentNow;
    } catch (error) {
      const stillCurrent = stillOn(projectId, epoch);
      if (stillCurrent) set({ isSaving: false });
      if (error instanceof StoryRestoreConflictError) {
        // Adopt the fresh manifest the 409 carried so the next attempt's
        // guard is built from current state, not the stale one that just
        // got rejected. `error.current` is already runtime-validated at
        // the client.ts boundary (isStoryManifestShape), so this can't
        // adopt a malformed shape and crash hasBible()/sections reads.
        if (error.current && stillCurrent) {
          set({ manifest: error.current });
        }
        if (stillCurrent) {
          showToastGlobal(
            'The story changed since this list was loaded — try again',
            'warning'
          );
        }
        return false;
      }
      if (stillCurrent) {
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to restore the story',
          'error'
        );
      }
      return false;
    }
  },

  // --- Review checkpoint (phase 10) --------------------------------------

  loadAllFactsById: async () => {
    const { projectId, factIndex } = get();
    if (!projectId) return null;
    if (factIndex) return factIndex;
    const epoch = storeEpoch;
    // Claimed BEFORE the first fetch so a load() that runs during the
    // paging bumps this and the stale index we build never lands.
    const seq = ++factIndexSeq;
    try {
      const index = new Map<string, StoryLogEntry>();
      let afterSeq: number | undefined;
      for (let page = 0; page < MAX_FACT_INDEX_PAGES; page++) {
        const res = await storyApi.listFacts(projectId, {
          afterSeq,
          limit: FACT_INDEX_PAGE,
        });
        for (const row of res.items) {
          // Tombstones are kept: a card citing a deleted fact must be
          // able to say "(deleted fact)" rather than render a blank.
          const id = typeof row.data?.id === 'string' ? row.data.id : row.id;
          index.set(id, row);
        }
        if (!res.has_more || res.next_after_seq === null) break;
        afterSeq = res.next_after_seq;
      }
      if (!stillOn(projectId, epoch) || seq !== factIndexSeq) return null;
      set({ factIndex: index });
      return index;
    } catch (error) {
      if (stillOn(projectId, epoch) && seq === factIndexSeq) {
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to load facts',
          'error'
        );
      }
      return null;
    }
  },

  loadAllScenesWithData: async () => {
    const { projectId } = get();
    if (!projectId) return null;
    const epoch = storeEpoch;
    try {
      const summaries: StorySceneSummary[] = [];
      let cursor: { sequence: number; id: string } | null = null;
      for (let page = 0; page < MAX_SCENE_INDEX_PAGES; page++) {
        const res = await storyApi.listScenes(projectId, {
          ...(cursor
            ? { afterSequence: cursor.sequence, afterId: cursor.id }
            : {}),
          limit: SCENE_PAGE,
        });
        summaries.push(...res.items);
        if (
          !res.has_more ||
          res.next_after_sequence === null ||
          res.next_after_id === null
        ) {
          break;
        }
        cursor = { sequence: res.next_after_sequence, id: res.next_after_id };
      }
      const full = await Promise.all(
        summaries.map((s) => storyApi.getScene(projectId, s.id))
      );
      if (!stillOn(projectId, epoch)) return null;
      return full;
    } catch (error) {
      if (stillOn(projectId, epoch)) {
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to load scenes',
          'error'
        );
      }
      return null;
    }
  },

  loadAllScenesFull: async () => {
    const { projectId } = get();
    if (!projectId) return null;
    const epoch = storeEpoch;
    try {
      const rows: StorySceneOut[] = [];
      let cursor: { sequence: number; id: string } | null = null;
      for (let page = 0; page < MAX_SCENE_INDEX_PAGES; page++) {
        const res = await storyApi.listScenesFull(projectId, {
          ...(cursor ? { afterSequence: cursor.sequence, afterId: cursor.id } : {}),
          limit: FULL_SCENE_PAGE,
        });
        rows.push(...(res.items ?? []));
        if (
          !res.has_more ||
          res.next_after_sequence === null ||
          res.next_after_sequence === undefined ||
          res.next_after_id === null ||
          res.next_after_id === undefined
        ) {
          break;
        }
        cursor = { sequence: res.next_after_sequence, id: res.next_after_id };
      }
      if (!stillOn(projectId, epoch)) return null;
      return rows;
    } catch (error) {
      if (stillOn(projectId, epoch)) {
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to load scenes',
          'error'
        );
      }
      return null;
    }
  },

  // --- Beat map (step 3 phase 2 — reading the annotate pass's output) ----

  loadBeatMap: async () => {
    const { projectId, beatMap } = get();
    if (!projectId) return;
    // Cached until the next load()/clear(), like factIndex. An annotate
    // run ends with a load(), so a re-run's output is picked up without
    // this needing its own invalidation.
    if (beatMap) return;
    const epoch = storeEpoch;
    const seq = ++beatMapSeq;
    set({ beatMapLoading: true });
    try {
      const rows: BeatMapEntry[] = [];
      let cursor: { sequence: number; id: string } | null = null;
      for (let page = 0; page < MAX_SCENE_INDEX_PAGES; page++) {
        // `/scenes/full` (backend step-3 phase 1), NOT
        // `loadAllScenesWithData` — that one is a summary page plus a GET
        // per scene, and the step-3 plan is explicit that this step must
        // not promote that N+1 to a hot path. One request per 50 scenes
        // instead of one per scene.
        const res = await storyApi.listScenesFull(projectId, {
          ...(cursor ? { afterSequence: cursor.sequence, afterId: cursor.id } : {}),
          limit: BEAT_MAP_PAGE,
        });
        for (const row of res.items ?? []) {
          rows.push(beatMapEntry(row));
        }
        // A short page is NOT a last page: the server can end one early on
        // its own byte budget, and the cursor then points at the last row
        // INCLUDED so the next request resumes at the first row it
        // dropped. Only `has_more` decides.
        if (
          !res.has_more ||
          res.next_after_sequence === null ||
          res.next_after_sequence === undefined ||
          res.next_after_id === null ||
          res.next_after_id === undefined
        ) {
          break;
        }
        cursor = { sequence: res.next_after_sequence, id: res.next_after_id };
      }
      if (!stillOn(projectId, epoch) || seq !== beatMapSeq) return;
      set({ beatMap: rows, beatMapLoading: false });
    } catch (error) {
      if (!stillOn(projectId, epoch) || seq !== beatMapSeq) return;
      set({ beatMapLoading: false });
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to load the beat map',
        'error'
      );
    }
  },

  patchContinuity: async (patchFn, editMeta) => {
    const { projectId } = get();
    if (!projectId) return false;
    // Resolutions are safe against reconcile (existing-wins was designed
    // exactly for this concurrency), so §3.3's build carve-out applies
    // here — but locking still blocks by §3.2.
    if (await refuseIfGated({ allowWhileBuilding: true })) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;

    /** Apply the caller's intent to one server-read section and write it
     *  back. Returns false for a no-op (nothing to write, no server_ts
     *  churn) — reconcile's own discipline. */
    const applyTo = async (
      current: StorySectionOut | null,
      baseTs: number
    ): Promise<'written' | 'noop'> => {
      const data = (current?.data ?? null) as unknown as ContinuitySection | null;
      const entries = data?.contradictions;
      // A missing or malformed section is nothing to patch — never
      // overwrite a shape we don't understand with one we invented.
      if (!Array.isArray(entries)) return 'noop';
      const patched = patchFn(entries);
      if (patched === null) return 'noop';
      const section = await storyApi.putSection(
        projectId,
        'continuity',
        // Spread the READ data, not a fresh object: a PUT is a full
        // replace, so any field this phase doesn't know about would be
        // erased by rebuilding from scratch.
        {
          ...(current?.data ?? {}),
          contradictions: patched,
        } as unknown as Record<string, unknown>,
        baseTs
      );
      if (stillOn(projectId, epoch)) {
        set((s) => ({ sections: { ...s.sections, continuity: section } }));
      }
      return 'written';
    };

    try {
      const current = get().sections.continuity ?? null;
      const outcome = await applyTo(current, current?.server_ts ?? 0);
      if (outcome === 'noop') {
        if (stillOn(projectId, epoch)) set({ isSaving: false });
        return stillOn(projectId, epoch);
      }
      await recordEdit(projectId, epoch, editMeta);
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) set({ isSaving: false });
      return stillCurrentNow;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        // Apply-intent-on-winner: re-run the SAME pure patch against the
        // winner's entries, so a resolution written in another tab and
        // this one both survive. Merging detections (writeContinuityMerged)
        // would silently drop this resolution instead.
        try {
          const outcome = await applyTo(error.current ?? null, error.currentTs);
          if (outcome !== 'noop') await recordEdit(projectId, epoch, editMeta);
          const stillCurrentNow = stillOn(projectId, epoch);
          if (stillCurrentNow) {
            set({ isSaving: false });
            showToastGlobal(
              'Story was updated on another device — changes merged',
              'warning'
            );
          }
          return stillCurrentNow;
        } catch {
          if (stillOn(projectId, epoch)) {
            set({ isSaving: false });
            showToastGlobal(
              'That change collided with another device — try again',
              'error'
            );
          }
          return false;
        }
      }
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to save the change',
          'error'
        );
      }
      return false;
    }
  },

  deleteFact: async (factId) => {
    const { projectId } = get();
    if (!projectId) return false;
    if (await refuseIfGated({})) return false;
    const epoch = storeEpoch;

    try {
      await storyApi.deleteFact(projectId, factId);
    } catch (error) {
      // A 404 means it's already gone (another tab, a double-click) —
      // that is the outcome the user asked for, not a failure.
      const message = error instanceof Error ? error.message : '';
      if (!/fact not found/i.test(message)) {
        if (stillOn(projectId, epoch)) {
          showToastGlobal(message || 'Failed to delete the fact', 'error');
        }
        return false;
      }
    }

    // Read the fact's text BEFORE we tombstone it locally — otherwise
    // the diff below would look it up on the just-installed tombstone
    // and land as "deleted: (text unavailable)" for every user delete.
    const originalText = factTextFor(get().factIndex, get().facts, factId);

    // Mark it locally so the list can strike it through immediately; the
    // row stays, because the wire keeps returning it and hiding it makes
    // "where did my fact go" a support question.
    if (stillOn(projectId, epoch)) {
      const tombstone = { id: factId, deleted_at: capturedAt() };
      set((s) => ({
        facts: s.facts.map((row) =>
          (typeof row.data?.id === 'string' ? row.data.id : row.id) === factId &&
          !isFactTombstone(row.data)
            ? { ...row, data: tombstone }
            : row
        ),
        factIndex: s.factIndex
          ? new Map(s.factIndex).set(factId, {
              ...(s.factIndex.get(factId) ?? {
                seq: 0,
                id: factId,
                created_at: tombstone.deleted_at,
              }),
              data: tombstone,
            })
          : null,
      }));
    }

    await recordEdit(projectId, epoch, {
      target: { type: 'fact', id: factId },
      classification: 'substantive',
      diff: `deleted: ${originalText}`,
    });

    // Mechanical cleanup of every contradiction that cited it. Runs
    // through patchContinuity so it inherits the conflict handling.
    const cleaned = await get().patchContinuity(
      (entries) => cleanupFactRefs(entries, new Set([factId])),
      {
        target: { type: 'contradiction' },
        classification: 'contradiction',
        diff: `cleaned contradiction references to deleted fact ${factId}`,
      }
    );
    if (!cleaned && stillOn(projectId, epoch)) {
      // The delete DID happen — never report otherwise. Both the
      // lock-canon auto-fix and reconcile's next prune are downstream
      // nets for the references left behind.
      showToastGlobal(
        "Fact deleted — some contradiction references couldn't be cleaned; Lock canon will fix them",
        'warning'
      );
    }

    await reloadIfStillOn(projectId, epoch);
    return stillOn(projectId, epoch);
  },

  patchScene: async (sceneId, patchFn, editMeta, opts) => {
    const { projectId } = get();
    if (!projectId) return false;
    if (await refuseIfGated({ allowWhileBuilding: opts?.allowWhileBuilding }))
      return false;
    set({ isSaving: true });
    const epoch = storeEpoch;

    const applyTo = async (
      data: Scene,
      baseTs: number
    ): Promise<'written' | 'noop'> => {
      const patched = patchFn(data);
      if (patched === null) return 'noop';
      const written = await storyApi.putScene(
        projectId,
        sceneId,
        patched as unknown as Record<string, unknown>,
        baseTs
      );
      if (stillOn(projectId, epoch)) {
        // The list holds server-TRUNCATED projections, so refresh the row
        // from what we just wrote rather than from the full payload.
        set((s) => ({
          scenes: s.scenes.map((row) =>
            row.id === sceneId
              ? {
                  ...row,
                  sequence: written.sequence,
                  title: String(patched.title ?? row.title).slice(0, 200),
                  summary: String(patched.summary ?? row.summary).slice(0, 500),
                  server_ts: written.server_ts,
                  updated_at: written.updated_at,
                }
              : row
          ),
        }));
      }
      return 'written';
    };

    try {
      // Summaries carry no `data`, so the full row is always fetched —
      // PUTting a list projection would write back truncated text.
      const full = await storyApi.getScene(projectId, sceneId);
      const outcome = await applyTo(
        full.data as unknown as Scene,
        full.server_ts
      );
      if (outcome === 'noop') {
        if (stillOn(projectId, epoch)) set({ isSaving: false });
        return stillOn(projectId, epoch);
      }
      if (!opts?.skipEdit) await recordEdit(projectId, epoch, editMeta);
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) set({ isSaving: false });
      return stillCurrentNow;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        try {
          // Re-fetch rather than trusting the 409 body: StoryConflictError
          // types `current` as a section, but a scene conflict puts a
          // scene dump there — a re-read is the honest way to get the
          // winner's shape.
          const fresh = await storyApi.getScene(projectId, sceneId);
          const outcome = await applyTo(
            fresh.data as unknown as Scene,
            fresh.server_ts
          );
          if (outcome !== 'noop' && !opts?.skipEdit) {
            await recordEdit(projectId, epoch, editMeta);
          }
          const stillCurrentNow = stillOn(projectId, epoch);
          if (stillCurrentNow) {
            set({ isSaving: false });
            if (!opts?.quiet) {
              showToastGlobal(
                'That scene was updated on another device — changes merged',
                'warning'
              );
            }
          }
          return stillCurrentNow;
        } catch {
          if (stillOn(projectId, epoch)) {
            set({ isSaving: false });
            if (!opts?.quiet) {
              showToastGlobal(
                'That scene changed on another device — try again',
                'error'
              );
            }
          }
          return false;
        }
      }
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        if (!opts?.quiet) {
          showToastGlobal(
            error instanceof Error ? error.message : 'Failed to save the scene',
            'error'
          );
        }
      }
      return false;
    }
  },

  mergeSceneIntoPrevious: async (sceneId) => {
    const { projectId, scenes, isSaving } = get();
    if (!projectId || isSaving) return false;
    if (await refuseIfGated({})) return false;
    const ordered = [...scenes].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)
    );
    const index = ordered.findIndex((s) => s.id === sceneId);
    if (index < 1) {
      // The first scene has no predecessor to merge into, and an unloaded
      // scene has no known ordering — both are refusals, not errors.
      showToastGlobal('That scene has nothing before it to merge into', 'error');
      return false;
    }
    const survivorId = ordered[index - 1].id;
    set({ isSaving: true });
    const epoch = storeEpoch;

    try {
      const [survivor, victim] = await Promise.all([
        storyApi.getScene(projectId, survivorId),
        storyApi.getScene(projectId, sceneId),
      ]);
      const merged = mergeScenes(
        survivor.data as unknown as Scene,
        victim.data as unknown as Scene
      );

      // Checked BEFORE either write: a 413 landing between the PUT and
      // the DELETE is the unrecoverable shape — content duplicated into
      // the survivor with the victim still present and no way to retry
      // cleanly.
      const size = new TextEncoder().encode(JSON.stringify(merged)).length;
      if (size > SCENE_MAX_BYTES) {
        if (stillOn(projectId, epoch)) {
          set({ isSaving: false });
          showToastGlobal(
            'Those two scenes are too large to merge — trim one first',
            'error'
          );
        }
        return false;
      }

      // PUT the survivor FIRST, then delete the victim. This order fails
      // safe: a crash between them duplicates content (visible, and
      // retryable), where delete-first would destroy the victim with no
      // archive — scene writes don't snapshot.
      await storyApi.putScene(
        projectId,
        survivorId,
        merged as unknown as Record<string, unknown>,
        survivor.server_ts
      );
      await storyApi.deleteScene(projectId, sceneId, victim.server_ts);

      await recordEdit(projectId, epoch, {
        target: { type: 'scene', id: survivorId },
        classification: 'substantive',
        diff: `merged scene ${sceneId} (${victim.data?.title ?? ''}) into this one`,
      });
      await reloadIfStillOn(projectId, epoch);
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) {
        set({ isSaving: false });
        showToastGlobal('Scenes merged', 'success');
      }
      return stillCurrentNow;
    } catch (error) {
      // No blind retry of a compound operation: reload so the user sees
      // exactly which half landed, and let them decide.
      await reloadIfStillOn(projectId, epoch);
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof StoryConflictError
            ? 'Those scenes changed on another device — reloaded, try again'
            : error instanceof Error
              ? error.message
              : 'Failed to merge the scenes',
          'error'
        );
      }
      return false;
    }
  },

  appendSamplePassage: async (text) => {
    const { projectId } = get();
    if (!projectId) return false;
    const trimmed = text.trim().slice(0, SAMPLE_PASSAGE_MAX);
    // `SamplePassage.text` is min_length=1 server-side — a whitespace-only
    // paste is a 422 worth catching here.
    if (!trimmed) return false;
    if (await refuseIfGated({})) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;

    let evicted = false;
    const build = (existing: UserVoiceSection): UserVoiceSection => {
      const passage: SamplePassage = {
        text: trimmed,
        source: userAnnotationSourceRef(),
      };
      const passages = [...(existing.sample_passages ?? []), passage];
      // Evict the OLDEST user-added passage only — a walk-captured one is
      // evidence the user never supplied and can't recreate.
      const userIdx = passages
        .map((p, i) => (p.source?.kind === 'user_annotation' ? i : -1))
        .filter((i) => i >= 0);
      if (userIdx.length > MAX_USER_PASSAGES) {
        passages.splice(userIdx[0], 1);
        evicted = true;
      }
      return {
        ...existing,
        sample_passages: passages,
        // `confidence` is deliberately untouched: it is the model's own
        // self-assessment, and fabricating a bump would defeat the meter.
      };
    };

    const write = async (
      current: StorySectionOut | null,
      baseTs: number
    ): Promise<void> => {
      const existing = (current?.data ?? null) as unknown as UserVoiceSection | null;
      if (!existing) {
        throw new Error('No voice profile yet — run a build first');
      }
      const section = await storyApi.putSection(
        projectId,
        'user_voice',
        build(existing) as unknown as Record<string, unknown>,
        baseTs
      );
      if (stillOn(projectId, epoch)) {
        set((s) => ({ sections: { ...s.sections, user_voice: section } }));
      }
    };

    try {
      const current = get().sections.user_voice ?? null;
      await write(current, current?.server_ts ?? 0);
      await recordEdit(projectId, epoch, {
        target: { type: 'voice' },
        classification: 'voice_shift',
        diff: `added a writing sample (${trimmed.length} chars)`,
      });
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) {
        set({ isSaving: false });
        showToastGlobal(
          evicted
            ? 'Writing sample added — the oldest one you added was dropped'
            : 'Writing sample added',
          'success'
        );
      }
      return stillCurrentNow;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        try {
          // Additive, so re-pushing onto the winner is safe — exactly once.
          evicted = false;
          await write(error.current ?? null, error.currentTs);
          await recordEdit(projectId, epoch, {
            target: { type: 'voice' },
            classification: 'voice_shift',
            diff: `added a writing sample (${trimmed.length} chars)`,
          });
          const stillCurrentNow = stillOn(projectId, epoch);
          if (stillCurrentNow) {
            set({ isSaving: false });
            showToastGlobal(
              'Writing sample added (merged with another device)',
              'warning'
            );
          }
          return stillCurrentNow;
        } catch {
          if (stillOn(projectId, epoch)) {
            set({ isSaving: false });
            showToastGlobal(
              'Your voice profile changed on another device — try again',
              'error'
            );
          }
          return false;
        }
      }
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to add the sample',
          'error'
        );
      }
      return false;
    }
  },

  saveNovelHints: async (patch) => {
    const { projectId } = get();
    if (!projectId) return false;
    // `allowWhileLocked` — see the interface doc. The build term is NOT
    // waived: cold start full-replaces this section.
    if (await refuseIfGated({ allowWhileLocked: true })) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;

    /** Fold the patch over whatever the server currently holds. Pure, and
     *  re-run against the WINNER on a 409 — the user chose a POV, not a
     *  whole section, so replaying their intent is right where replaying a
     *  stale snapshot would revert a concurrent edit to another field. */
    const build = (existing: unknown): RenderingHintsSection => {
      const base =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? (existing as unknown as RenderingHintsSection)
          : emptyRenderingHintsSection();
      const defaults = emptyRenderingHintsSection();
      return {
        // The three groups this step does not own, kept verbatim. A
        // missing group falls back to its default rather than to
        // `undefined`, which the section model rejects outright.
        screenplay: base.screenplay ?? defaults.screenplay,
        graphic_novel: base.graphic_novel ?? defaults.graphic_novel,
        storyboard: base.storyboard ?? defaults.storyboard,
        novel: { ...defaults.novel, ...(base.novel ?? {}), ...patch },
      };
    };

    const write = async (
      current: StorySectionOut | null,
      baseTs: number
    ): Promise<void> => {
      const section = await storyApi.putSection(
        projectId,
        'rendering_hints',
        build(current?.data ?? null) as unknown as Record<string, unknown>,
        baseTs
      );
      if (stillOn(projectId, epoch)) {
        set((s) => ({ sections: { ...s.sections, rendering_hints: section } }));
      }
    };

    const diff = Object.keys(patch).join(', ') || 'no change';
    try {
      const current = get().sections.rendering_hints ?? null;
      await write(current, current?.server_ts ?? 0);
      await recordEdit(projectId, epoch, {
        target: { type: 'hints' },
        classification: 'substantive',
        diff: `render hints: ${diff}`,
      });
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) set({ isSaving: false });
      return stillCurrentNow;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        try {
          await write(error.current ?? null, error.currentTs);
          await recordEdit(projectId, epoch, {
            target: { type: 'hints' },
            classification: 'substantive',
            diff: `render hints: ${diff}`,
          });
          const stillCurrentNow = stillOn(projectId, epoch);
          if (stillCurrentNow) {
            set({ isSaving: false });
            showToastGlobal(
              'Render settings saved (merged with another device)',
              'warning'
            );
          }
          return stillCurrentNow;
        } catch {
          if (stillOn(projectId, epoch)) {
            set({ isSaving: false });
            showToastGlobal(
              'Render settings changed on another device — try again',
              'error'
            );
          }
          return false;
        }
      }
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to save render settings',
          'error'
        );
      }
      return false;
    }
  },

  relinkSourceChat: async (chat) => {
    const { projectId } = get();
    if (!projectId) return false;
    if (await refuseIfGated({})) return false;
    set({ isSaving: true });
    const epoch = storeEpoch;

    let previous = '';
    const build = (existing: MetaSection): MetaSection => {
      previous = existing.source?.chat?.ref?.file_name ?? '';
      return {
        ...existing,
        updated_at: capturedAt(),
        source: {
          ...existing.source,
          chat: {
            // Only the POINTER moves. The snapshot records what was true
            // at capture time and stays verbatim, and `captured_at` is
            // when that capture happened — neither is re-stamped, which
            // is the whole difference between a relink and a designate.
            ...existing.source.chat,
            ref: chat,
          },
        },
        // Deliberately NOT rebuilt: `source.characters` (relink asserts
        // the same roleplay), and NOT zeroed: `ingest_watermark` —
        // resetting it would make phase 11 re-walk the chat from zero.
      };
    };

    const write = async (
      current: StorySectionOut | null,
      baseTs: number
    ): Promise<void> => {
      const existing = (current?.data ?? null) as unknown as MetaSection | null;
      if (!existing?.source?.chat) {
        throw new Error('No source chat to relink yet');
      }
      const section = await storyApi.putSection(
        projectId,
        'meta',
        build(existing) as unknown as Record<string, unknown>,
        baseTs
      );
      if (stillOn(projectId, epoch)) {
        set((s) => ({ sections: { ...s.sections, meta: section } }));
      }
    };

    try {
      const current = get().sections.meta ?? null;
      await write(current, current?.server_ts ?? 0);
      await recordEdit(projectId, epoch, {
        target: { type: 'meta' },
        classification: 'cosmetic',
        diff: `source chat relinked: ${previous} → ${chat.file_name}`,
      });
      const stillCurrentNow = stillOn(projectId, epoch);
      if (stillCurrentNow) {
        set({ isSaving: false });
        showToastGlobal('Source chat relinked', 'success');
      }
      return stillCurrentNow;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        try {
          await write(error.current ?? null, error.currentTs);
          await recordEdit(projectId, epoch, {
            target: { type: 'meta' },
            classification: 'cosmetic',
            diff: `source chat relinked: ${previous} → ${chat.file_name}`,
          });
          const stillCurrentNow = stillOn(projectId, epoch);
          if (stillCurrentNow) {
            set({ isSaving: false });
            showToastGlobal(
              'Source chat relinked (merged with another device)',
              'warning'
            );
          }
          return stillCurrentNow;
        } catch {
          if (stillOn(projectId, epoch)) {
            set({ isSaving: false });
            showToastGlobal(
              'The story changed on another device — try again',
              'error'
            );
          }
          return false;
        }
      }
      if (stillOn(projectId, epoch)) {
        set({ isSaving: false });
        showToastGlobal(
          error instanceof Error ? error.message : 'Failed to relink',
          'error'
        );
      }
      return false;
    }
  },

  lockCanon: async () => setCanonLock(true),
  unlockCanon: async () => setCanonLock(false),

  // --- Incremental re-ingestion (phase 11) --------------------------------

  flagScenesStale: async (sceneIds) => {
    const result: StaleFlagResult = { flagged: 0, alreadyFlagged: 0, failed: 0 };
    const { projectId } = get();
    if (!projectId || sceneIds.length === 0) return result;
    const epoch = storeEpoch;

    for (const sceneId of sceneIds) {
      // Bail the moment the user leaves: this loop can outlive the visit,
      // and every remaining PUT would land on a bible they walked away
      // from. The scenes already flagged stay flagged, which is correct —
      // the flag is idempotent and re-running is a no-op.
      if (!stillOn(projectId, epoch)) break;

      let skipped = false;
      const ok = await get().patchScene(
        sceneId,
        (data) => {
          if (data.annotations?.stale_source) {
            skipped = true;
            // Explicit no-op: no PUT, no `server_ts` churn, no edit row.
            return null;
          }
          return {
            ...data,
            annotations: { ...data.annotations, stale_source: true },
          };
        },
        {
          target: { type: 'scene', id: sceneId },
          classification: 'cosmetic',
          diff: 'source marked stale',
        },
        // Divergence PARKS the checkpoint in error (storyIngestStore's
        // diverged branch) or paused, and `isBuildActiveNow` counts both
        // as build-active — so the default gate would refuse flagging in
        // exactly the state that produces the need for it. Safe to allow:
        // flagging is deliberately outside the walk (plan §5.6) and no
        // pass reads `stale_source`.
        { allowWhileBuilding: true, skipEdit: true, quiet: true }
      );

      if (skipped) result.alreadyFlagged++;
      else if (ok) result.flagged++;
      else result.failed++;
    }

    if (stillOn(projectId, epoch) && result.failed > 0) {
      showToastGlobal(
        result.flagged > 0
          ? `Flagged ${result.flagged} scene(s); ${result.failed} could not be updated`
          : `Could not flag ${result.failed} scene(s)`,
        'warning'
      );
    }
    return result;
  },

  clearSceneStale: async (sceneId) =>
    get().patchScene(
      sceneId,
      (data) =>
        data.annotations?.stale_source
          ? {
              ...data,
              annotations: { ...data.annotations, stale_source: false },
            }
          : null,
      {
        target: { type: 'scene', id: sceneId },
        classification: 'cosmetic',
        diff: 'source no longer marked stale',
      },
      // Dismissing IS a user judgement, so this one keeps its edit row.
      // It still tolerates a parked build for the same reason flagging
      // does: the user must be able to clear a flag without first
      // clearing a wedged checkpoint.
      { allowWhileBuilding: true }
    ),

  advanceIngestWatermark: async (watermark, opts) => {
    const projectId = opts?.projectId ?? get().projectId;
    if (!projectId) return false;
    // Deliberately NOT gated. The caller is the walk itself, so
    // `refuseIfGated` would refuse against the very build doing the
    // work. The lock is not a concern either: a build cannot start while
    // canon is locked, and a lock landing mid-walk is the pre-existing
    // race documented in the plan's §10, not something a refusal here
    // would fix.
    const epoch = storeEpoch;

    const write = async (
      current: StorySectionOut | null,
      baseTs: number
    ): Promise<void> => {
      const existing = (current?.data ?? null) as unknown as MetaSection | null;
      // No meta section means no bible — nothing to watermark, and
      // minting one here would invent a bible out of a walk's tail.
      if (!existing) throw new Error('No story to watermark yet');
      const section = await storyApi.putSection(
        projectId,
        'meta',
        {
          ...existing,
          updated_at: capturedAt(),
          ingest_watermark: watermark,
        } as unknown as Record<string, unknown>,
        baseTs
      );
      if (stillOn(projectId, epoch)) {
        set((s) => ({ sections: { ...s.sections, meta: section } }));
      }
    };

    try {
      // The walk may be running against a Work the store has never
      // loaded (or has since left), so `sections.meta` can be stale or
      // absent. Read through when we have nothing local rather than
      // PUTting at base_ts 0 and 409ing on every incremental run.
      const local = stillOn(projectId, epoch) ? (get().sections.meta ?? null) : null;
      const current = local ?? (await storyApi.getSection(projectId, 'meta'));
      await write(current, current?.server_ts ?? 0);
      return true;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        try {
          await write(error.current ?? null, error.currentTs);
          return true;
        } catch {
          // Fall through to the shared failure path below.
        }
      }
      // Never fatal to the run. The watermark not advancing costs the
      // user a redundant re-walk next time — annoying and expensive, but
      // recoverable — whereas failing the walk here would throw away a
      // pass they already paid for.
      if (stillOn(projectId, epoch)) {
        showToastGlobal(
          'Story built, but the read position could not be saved — the next build may re-read the chat',
          'warning'
        );
      }
      return false;
    }
  },
  };
});
