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
  type StorySceneSummary,
  type StorySectionOut,
} from '../api/client';
import { showToastGlobal } from '../components/ui/Toast';
import {
  STORY_SCHEMA_VERSION,
  type MetaSection,
  type StorySectionName,
} from '../types/storyBible';
import {
  bibleUuid,
  capturedAt,
  characterSourceRef,
  chatSourceRef,
} from '../utils/storyBible/sourceRefs';

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
    opts?: { characters?: { avatar: string; name?: string }[]; title?: string }
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
}

const FACT_PAGE = 50;
const SCENE_PAGE = 100;
const ARCHIVE_PAGE = 25;

/** True when the manifest says `meta` exists — i.e. a source chat has
 *  been designated and the bible has begun. */
export function hasBible(manifest: StoryManifest | null): boolean {
  return !!manifest?.sections.some((s) => s.section === 'meta');
}

export const useStoryStore = create<StoryState>((set, get) => {
  // Closure-private, not store state: loadArchives() bumps this on every
  // call and only applies its response if it's still the latest one in
  // flight, so an overlapping earlier call resolving late can't revert a
  // fresher archive list (review finding — the projectId guard alone
  // doesn't order two calls for the SAME project against each other).
  let archivesFetchSeq = 0;

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
  isLoading: false,
  isSaving: false,
  error: null,

  clear: () => {
    // Ends the current visit: anything still in flight that captured the
    // old epoch stops being allowed to write, even if the user comes
    // straight back to the same Work.
    storeEpoch++;
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
      const wanted: StorySectionName[] = ['meta', 'world', 'entities', 'ingestion'];
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
        manifest.fact_count > 0
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
        isLoading: false,
      });
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
      if (stillCurrent) showToastGlobal('Story reset', 'success');
      return stillCurrent;
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
      if (stillCurrent) showToastGlobal('Story restored', 'success');
      return stillCurrent;
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
  };
});
