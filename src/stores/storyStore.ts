import { create } from 'zustand';
import {
  storyApi,
  StoryConflictError,
  type ProjectChatRef,
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
  resetBible: () => Promise<boolean>;
}

/** Reload only while the store is still pointed at this project.
 *
 *  `load()` sets `projectId`, so calling it unconditionally after an
 *  await would drag the store BACK to a Work the user already left —
 *  and every later write (which reads `projectId`) would then hit the
 *  wrong bible. */
async function reloadIfStillCurrent(
  get: () => StoryState,
  projectId: string
): Promise<void> {
  if (get().projectId !== projectId) return;
  await get().load(projectId);
}

const FACT_PAGE = 50;
const SCENE_PAGE = 100;

/** True when the manifest says `meta` exists — i.e. a source chat has
 *  been designated and the bible has begun. */
export function hasBible(manifest: StoryManifest | null): boolean {
  return !!manifest?.sections.some((s) => s.section === 'meta');
}

export const useStoryStore = create<StoryState>((set, get) => ({
  projectId: null,
  manifest: null,
  sections: {},
  scenes: [],
  scenesHasMore: false,
  facts: [],
  factsCursor: null,
  factsHasMore: false,
  isLoading: false,
  isSaving: false,
  error: null,

  clear: () =>
    set({
      projectId: null,
      manifest: null,
      // Cleared here too: an in-flight load() returns early once the
      // project changes, so whoever cancels it owns resetting this.
      isLoading: false,
      sections: {},
      scenes: [],
      scenesHasMore: false,
      facts: [],
      factsCursor: null,
      factsHasMore: false,
      error: null,
    }),

  load: async (projectId) => {
    set({ projectId, isLoading: true, error: null });
    try {
      const manifest = await storyApi.manifest(projectId);
      // Guard before EVERY write, not just the final one: the user can
      // switch Works mid-flight, and a late manifest landing on the new
      // Work shows one story's counts under another's name.
      if (get().projectId !== projectId) return;
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
      if (get().projectId !== projectId) return;
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
      if (get().projectId !== projectId) return;
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load story',
      });
    }
  },

  loadSection: async (name) => {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const section = await storyApi.getSection(projectId, name);
      if (get().projectId !== projectId) return;
      set((s) => ({ sections: { ...s.sections, [name]: section } }));
    } catch {
      // A missing section is an expected state, not an error worth a toast.
    }
  },

  loadMoreFacts: async () => {
    const { projectId, factsCursor, factsHasMore } = get();
    if (!projectId || !factsHasMore || factsCursor === null) return;
    try {
      const page = await storyApi.listFacts(projectId, {
        afterSeq: factsCursor,
        limit: FACT_PAGE,
      });
      // Re-read state AFTER the await: appending onto the pre-await
      // snapshot would resurrect facts a concurrent reset just cleared.
      const live = get();
      if (live.projectId !== projectId || live.factsCursor !== factsCursor) return;
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
      if (live.projectId !== projectId) return;
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
      set((s) => ({ sections: { ...s.sections, meta: section } }));
      return section;
    };

    try {
      const current = get().sections.meta;
      await write(
        current?.server_ts ?? 0,
        (current?.data as unknown as MetaSection) ?? null
      );
      await reloadIfStillCurrent(get, projectId);
      set({ isSaving: false });
      return true;
    } catch (error) {
      if (error instanceof StoryConflictError) {
        // Another device wrote meta first. Adopt it and retry once — the
        // same adopt-winner path projectStore uses.
        try {
          const winnerData = error.current?.data as unknown as MetaSection | undefined;
          await write(error.currentTs, winnerData ?? null);
          await reloadIfStillCurrent(get, projectId);
          set({ isSaving: false });
          showToastGlobal(
            'Story was updated on another device — changes merged',
            'warning'
          );
          return true;
        } catch {
          set({ isSaving: false });
          showToastGlobal(
            'Failed to set the source chat — it changed on another device',
            'error'
          );
          return false;
        }
      }
      set({ isSaving: false });
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to set the source chat',
        'error'
      );
      return false;
    }
  },

  resetBible: async () => {
    const { projectId } = get();
    if (!projectId) return false;
    set({ isSaving: true });
    try {
      await storyApi.reset(projectId);
      set({
        sections: {},
        scenes: [],
        scenesHasMore: false,
        facts: [],
        factsCursor: null,
        factsHasMore: false,
        isSaving: false,
      });
      await reloadIfStillCurrent(get, projectId);
      showToastGlobal('Story reset', 'success');
      return true;
    } catch (error) {
      set({ isSaving: false });
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to reset the story',
        'error'
      );
      return false;
    }
  },
}));
