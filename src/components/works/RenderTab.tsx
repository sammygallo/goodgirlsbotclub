import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CircleAlert, Download, Sparkles, Trash2 } from 'lucide-react';
import { useStoryStore } from '../../stores/storyStore';
import { useStoryIngestStore } from '../../stores/storyIngestStore';
import {
  ingestionBlocksRender,
  RENDER_CLIENT_ID,
  useStoryRenderStore,
} from '../../stores/storyRenderStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useConnectionProfileStore } from '../../stores/connectionProfileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorldInfoStore } from '../../stores/worldInfoStore';
import { makeLlmCall, makeDetailedLlmCall } from '../../utils/storyIngest/llmBridge';
import { estimateAnnotateTokens } from '../../utils/storyIngest/annotate';
import {
  estimateRenderRun,
  type RenderEstimate,
} from '../../utils/storyRender/estimate';
import { collectRunForExport } from '../../utils/storyRender/exportRun';
import {
  blockerMessage,
  type ExportBlocker,
} from '../../utils/storyRender/exportMarkdown';
import { booksForChat, gatherIngestInputs, replayEntriesFrom } from './ingestSources';
import { IngestProgressCard } from './IngestProgressCard';
import { RenderHintsEditor } from './RenderHintsEditor';
import { RenderProgressCard } from './RenderProgressCard';
import { RenderReader } from './RenderReader';
import { StartIngestModal } from './StartIngestModal';
import { StartRenderModal } from './StartRenderModal';
import { Button, ConfirmDialog, Modal } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import {
  storyApi,
  type Project,
  type StoryRenderSummary,
  type StorySceneOut,
} from '../../api/client';
import type {
  EntitiesSection,
  MetaSection,
  NarrativeSection,
  RenderingHintsSection,
  Scene,
  UserVoiceSection,
  WorldSection,
} from '../../types/storyBible';
import type { ReplayEntry } from '../../utils/storyIngest/wiReplay';
import type { IngestMessage } from '../../utils/storyIngest/types';

/**
 * Render tab of the Works panel — productization step 3, phase 5.
 *
 * This is the ONLY thing that can invoke the render path: phases 1–4 built
 * the tables, the engine and the store, and none of it had a caller until
 * here.
 *
 * **It owns gathering the engine's inputs.** §4's phase-4 row said the store
 * would, and the store deliberately does not — `gatherIngestInputs` and
 * `booksForChat` compose four client-side stores and live in this layer, and
 * no store in this codebase imports from `components/`. So the tab does what
 * `StoryTab` already does for a build, from the same two helpers.
 *
 * **Its disabled state is its OWN predicate**, per §3.3: `canManage` plus the
 * build-active term, deliberately NOT `writesDisabled`, which also carries
 * `canonLocked`. Step 3 narrows the lock invariant to user-authored bible
 * edits — a locked bible is exactly the state §1 describes rendering FROM, so
 * inheriting that gate would disable the tab in its primary case. The
 * build-active half comes from the store's own exported
 * `ingestionBlocksRender`, so the button and the store cannot disagree about
 * what blocks a run.
 */
export function RenderTab({
  project,
  canManage,
}: {
  project: Project;
  canManage: boolean;
}) {
  const manifest = useStoryStore((s) => s.manifest);
  const sections = useStoryStore((s) => s.sections);
  const loadAllScenesFull = useStoryStore((s) => s.loadAllScenesFull);
  const loadAllFactsById = useStoryStore((s) => s.loadAllFactsById);
  const load = useStoryStore((s) => s.load);

  const checkpoint = useStoryIngestStore((s) => s.checkpoint);
  const runAnnotate = useStoryIngestStore((s) => s.runAnnotate);
  const ingestRunning = useStoryIngestStore((s) => s.isRunning);
  const loadCheckpoint = useStoryIngestStore((s) => s.loadCheckpoint);

  const renderRunning = useStoryRenderStore((s) => s.isRunning);
  const renderState = useStoryRenderStore((s) => s.render);
  const lockedBy = useStoryRenderStore((s) => s.lockedBy);
  const startRender = useStoryRenderStore((s) => s.start);
  const resumeRender = useStoryRenderStore((s) => s.resume);
  const rerenderScene = useStoryRenderStore((s) => s.rerenderScene);
  const clearRender = useStoryRenderStore((s) => s.clear);

  const characters = useCharacterStore((s) => s.characters);
  const wiScanDepth = useWorldInfoStore((s) => s.scanDepth);

  const [fullScenes, setFullScenes] = useState<StorySceneOut[] | null>(null);
  const [renders, setRenders] = useState<StoryRenderSummary[]>([]);
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(null);
  /** Null means "not chosen" and resolves to the whole story below. Held as
   *  null rather than seeded by an effect because the seed depends on a
   *  fetch: an effect would have to write state the moment scenes land, and
   *  a scene list that changes underneath (an annotate run, a re-walk) would
   *  then need a second effect to notice its own selection went stale. */
  const [rangeStartPick, setRangeStartPick] = useState<string | null>(null);
  const [rangeEndPick, setRangeEndPick] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<RenderEstimate | null>(null);
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StoryRenderSummary | null>(null);
  /** The run an export is currently reading, so its button can say so and
   *  a second click cannot start a second read of the same run. */
  const [exportingId, setExportingId] = useState<string | null>(null);
  /** Decision 1's refusal, held as state rather than toasted: it lists
   *  every blocked chapter AND offers the re-render that fixes each one,
   *  which a toast cannot do. */
  const [exportRefusal, setExportRefusal] = useState<{
    renderId: string;
    blockers: ExportBlocker[];
  } | null>(null);
  /** Bumped whenever a run ends, so the reader and the render list re-read
   *  instead of showing the state from before it. */
  const [reloadToken, setReloadToken] = useState(0);

  const meta = sections.meta?.data as unknown as MetaSection | undefined;
  const sourceChat = meta?.source?.chat?.ref ?? null;

  // --- gating ----------------------------------------------------------

  /** §3.6's cross-gate, read through the store's own exported copy. */
  const buildBlocks = ingestionBlocksRender(checkpoint);
  const renderDisabled = !canManage || buildBlocks || ingestRunning || renderRunning;

  /** Annotate's gate, unchanged from where it lived in the Story tab: it
   *  mirrors `runAnnotate`'s own refusal rather than inventing one, because
   *  the store is the choke point and a button that opens a modal the store
   *  will refuse is just a slower toast. */
  const annotateBlocked =
    checkpoint?.status === 'running' ||
    (checkpoint?.current_pass != null &&
      checkpoint.current_pass !== 'annotate' &&
      checkpoint.current_pass !== 'review');

  // --- reading what the tab renders from -------------------------------

  useEffect(() => {
    // Loaded HERE, not inherited. Only one Works tab is mounted at a time
    // and `StoryTab` clears the story store on its own unmount, so a switch
    // from Story to Render arrives with an empty manifest — which this tab
    // would render as "nothing to write out yet" on a fully built bible.
    //
    // `load` brings `narrative` and `rendering_hints` with it as of step 3
    // phase 5, and it has to: both are load-bearing here (one supplies the
    // POV/tense defaults, the other IS the hints editor's stored state), and
    // fetching them alongside `load` rather than inside it was a race whose
    // loser was always the lazy fetch — see the note on `load`'s own list.
    //
    // The checkpoint matters for a different reason: §3.6's cross-gate is
    // evaluated against it, and an absent checkpoint reads as "no build
    // running" whether or not one is.
    void load(project.id);
    void loadCheckpoint(project.id);
  }, [load, loadCheckpoint, project.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await loadAllScenesFull();
      if (!cancelled && rows) setFullScenes(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAllScenesFull, project.id, reloadToken]);

  const refreshRenders = useCallback(async () => {
    try {
      const page = await storyApi.listRenders(project.id, { limit: 25 });
      return page.items ?? [];
    } catch {
      // A render list that cannot be read is not worth a toast on open —
      // every action below has its own error path, and the empty-state copy
      // is honest either way.
      return [];
    }
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const items = await refreshRenders();
      if (cancelled) return;
      setRenders(items);
      setSelectedRenderId((current) => {
        if (current && items.some((r) => r.id === current)) return current;
        // Newest first from the server; default to the most recent run so a
        // returning user lands on what they were reading.
        return items[0]?.id ?? null;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshRenders, reloadToken]);

  const sceneOptions = useMemo(() => fullScenes ?? [], [fullScenes]);

  /** The effective range: the user's pick when it still names a scene that
   *  exists, otherwise the whole story. Defaulting to the WHOLE story is the
   *  only defensible default — any narrower one would be us choosing part of
   *  the user's book for them. Falling back when the pick no longer resolves
   *  is what keeps a re-walk (which mints new scene ids) from leaving the
   *  picker pointing at nothing. */
  const rangeStart =
    sceneOptions.find((s) => s.id === rangeStartPick)?.id ??
    sceneOptions[0]?.id ??
    '';
  const rangeEnd =
    sceneOptions.find((s) => s.id === rangeEndPick)?.id ??
    sceneOptions[sceneOptions.length - 1]?.id ??
    '';

  // The store keeps a run alive across a tab switch on purpose, so clearing
  // on unmount would orphan it. `clear()` refuses while something is
  // genuinely in flight; this is the "tidy up a finished run's error banner"
  // case only.
  useEffect(() => {
    return () => {
      clearRender();
    };
  }, [clearRender, project.id]);

  const scenesAnnotated = useMemo(() => {
    if (!fullScenes) return null;
    return fullScenes.filter((row) => (row.data as unknown as Scene)?.function).length;
  }, [fullScenes]);

  /** §3.3's "annotate first" default: with no scene annotated, the beat and
   *  compression the renderer reads simply do not exist yet. Stated as a
   *  recommendation rather than enforced — a user who wants raw prose from an
   *  un-annotated bible is allowed to have it. */
  const needsAnnotate =
    scenesAnnotated !== null && fullScenes !== null && fullScenes.length > 0 &&
    scenesAnnotated === 0;

  // --- gathering the engine's inputs -----------------------------------

  const chatRef = useRef<{
    key: string;
    messages: IngestMessage[];
    wiEntries: ReplayEntry[];
  } | null>(null);

  /** Read the source chat once per visit. The transcript is needed by the
   *  rule selector for EVERY scene, and by the preflight before any spend,
   *  so fetching it per action would mean the same download twice for one
   *  Render press. */
  const chatInputs = useCallback(async () => {
    if (!sourceChat) return null;
    const key = `${sourceChat.character_avatar}\u0000${sourceChat.file_name}`;
    if (chatRef.current?.key === key) return chatRef.current;
    const { messages } = await gatherIngestInputs(sourceChat);
    const wiEntries = replayEntriesFrom(
      booksForChat(sourceChat.character_avatar, sourceChat.file_name)
    );
    chatRef.current = { key, messages, wiEntries };
    return chatRef.current;
  }, [sourceChat]);

  const bibleInputs = useMemo(() => {
    const entities = sections.entities?.data as unknown as EntitiesSection | undefined;
    const world = sections.world?.data as unknown as WorldSection | undefined;
    const hints = sections.rendering_hints?.data as
      | unknown as RenderingHintsSection
      | undefined;
    return {
      characters: entities?.characters ?? [],
      worldRules: world?.rules ?? [],
      userVoice: (sections.user_voice?.data as unknown as UserVoiceSection) ?? null,
      hints: hints?.novel ?? null,
      narrative: (sections.narrative?.data as unknown as NarrativeSection) ?? null,
    };
  }, [sections]);

  const factRowsRef = useRef<Awaited<ReturnType<typeof loadAllFactsById>> | null>(null);
  const factRows = useCallback(async () => {
    const index = factRowsRef.current ?? (await loadAllFactsById());
    factRowsRef.current = index;
    return index ? Array.from(index.values()) : [];
  }, [loadAllFactsById]);

  /** Everything both the preflight and the run need, in one place so the
   *  estimate and the run can never be computed from different inputs. */
  const gatherSources = useCallback(async () => {
    if (!fullScenes) return null;
    const chat = await chatInputs();
    if (!chat) return null;
    return {
      scenes: fullScenes,
      factRows: await factRows(),
      ...bibleInputs,
      messages: chat.messages,
      wiEntries: chat.wiEntries,
      wiScanDepth,
    };
  }, [fullScenes, chatInputs, factRows, bibleInputs, wiScanDepth]);

  const characterName = useMemo(() => {
    if (!sourceChat) return 'Story';
    const found = characters.find((c) => c.avatar === sourceChat.character_avatar);
    return found?.name || sourceChat.character_avatar.replace(/\.(png|webp|jpe?g)$/i, '');
  }, [characters, sourceChat]);

  const llmFor = useCallback(
    (profileId: string | null) => {
      const profile = profileId
        ? useConnectionProfileStore.getState().getProfile(profileId)
        : null;
      const settings = useSettingsStore.getState();
      const provider = profile?.provider ?? settings.activeProvider;
      const model = profile?.model ?? settings.activeModel;
      // A saved custom profile points at its OWN endpoint; falling back to
      // the settings URL would send this run somewhere else entirely.
      const customUrl = profile
        ? profile.customUrl
        : (settings as unknown as { customEndpointUrl?: string }).customEndpointUrl;
      return { provider, model, customUrl };
    },
    []
  );

  // --- actions ----------------------------------------------------------

  const openPreflight = async () => {
    if (!rangeStart || !rangeEnd) return;
    setPreparing(true);
    try {
      const sources = await gatherSources();
      if (!sources) {
        showToastGlobal('Could not read the story to render', 'error');
        return;
      }
      const estimate = estimateRenderRun({
        ...sources,
        sceneIdStart: rangeStart,
        sceneIdEnd: rangeEnd,
      });
      if (!estimate) {
        showToastGlobal('That scene range could not be resolved', 'error');
        return;
      }
      setPreflight(estimate);
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Could not prepare the render',
        'error'
      );
    } finally {
      setPreparing(false);
    }
  };

  const beginRender = async (profileId: string | null) => {
    setPreflight(null);
    setPreparing(true);
    try {
      const sources = await gatherSources();
      if (!sources) return;
      const { provider, model, customUrl } = llmFor(profileId);
      const ok = await startRender({
        ...sources,
        projectId: project.id,
        format: 'novel',
        sceneIdStart: rangeStart,
        sceneIdEnd: rangeEnd,
        llm: makeDetailedLlmCall({ provider, model, customUrl, characterName }),
        model,
      });
      if (ok) {
        // Land the reader on the run that was just produced.
        const id = useStoryRenderStore.getState().render?.id ?? null;
        if (id) setSelectedRenderId(id);
      }
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'The render failed to start',
        'error'
      );
    } finally {
      setPreparing(false);
      setReloadToken((n) => n + 1);
    }
  };

  /**
   * Continue or take over an existing run.
   *
   * `takeover` is NEVER implicit. The store carries the flag straight to the
   * backend, which refuses an expired foreign lock without it — that refusal
   * is what stops a retrying client from ping-ponging the lock away from a
   * device that is actively spending the user's key. So the tab asks (via
   * the progress card's Take over button) and this just carries the answer.
   */
  const continueRender = async (renderId: string, takeover: boolean) => {
    setPreparing(true);
    try {
      const sources = await gatherSources();
      if (!sources) return;
      const { provider, model, customUrl } = llmFor(null);
      await resumeRender({
        ...sources,
        projectId: project.id,
        renderId,
        takeover,
        llm: makeDetailedLlmCall({ provider, model, customUrl, characterName }),
        model,
      });
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Could not continue the render',
        'error'
      );
    } finally {
      setPreparing(false);
      setReloadToken((n) => n + 1);
    }
  };

  const renderOneScene = async (renderId: string, sceneId: string) => {
    setPreparing(true);
    try {
      const sources = await gatherSources();
      if (!sources) return;
      const { provider, model, customUrl } = llmFor(null);
      await rerenderScene({
        ...sources,
        projectId: project.id,
        renderId,
        sceneId,
        llm: makeDetailedLlmCall({ provider, model, customUrl, characterName }),
        model,
      });
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Could not write that chapter again',
        'error'
      );
    } finally {
      setPreparing(false);
      setReloadToken((n) => n + 1);
    }
  };

  const startAnnotate = async (profileId: string | null) => {
    const { provider, model, customUrl } = llmFor(profileId);
    setPreparing(true);
    try {
      setAnnotateOpen(false);
      await runAnnotate({
        projectId: project.id,
        llm: makeLlmCall({ provider, model, customUrl, characterName }),
        model,
      });
      // The pass rewrites scene rows and may add the `narrative` section;
      // `load` re-reads the manifest first, so a section this run created is
      // in `present` by the time its fetch list is filtered.
      await load(project.id);
      setReloadToken((n) => n + 1);
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to annotate',
        'error'
      );
    } finally {
      setPreparing(false);
    }
  };

  const deleteRender = async (summary: StoryRenderSummary) => {
    setPendingDelete(null);
    try {
      await storyApi.deleteRender(project.id, summary.id, {
        clientId: RENDER_CLIENT_ID,
        baseTs: summary.server_ts,
      });
      showToastGlobal('Render deleted', 'success');
      setSelectedRenderId((current) => (current === summary.id ? null : current));
      setReloadToken((n) => n + 1);
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Could not delete that render',
        'error'
      );
    }
  };

  /**
   * Export a run to Markdown (phase 6).
   *
   * Read-only — no lock, no `preparing` gate, and deliberately allowed
   * while another run is in flight: taking a copy of a finished book costs
   * nothing and blocks nothing. `exportingId` exists only to stop a second
   * click re-reading the same run.
   *
   * The DOM half lives here because the collector is pure; everything
   * above the download is testable in plain node.
   */
  const exportRender = async (summary: StoryRenderSummary) => {
    if (exportingId || !fullScenes) return;
    setExportingId(summary.id);
    try {
      const result = await collectRunForExport(
        {
          projectId: project.id,
          renderId: summary.id,
          sceneIdStart: summary.scene_id_start,
          sceneIdEnd: summary.scene_id_end,
        },
        fullScenes,
        // Read at call time, NOT from this render's closure. Clicking
        // Export blurs a chapter-title field, which fires its save — so
        // the closure's `sections` is one write behind precisely when the
        // user has just edited a title and immediately exported it.
        (
          useStoryStore.getState().sections.rendering_hints?.data as unknown as
            | RenderingHintsSection
            | undefined
        )?.novel ?? null,
        project.name
      );

      if (!result.ok) {
        if (result.emptyRun) {
          showToastGlobal('That render has no chapters to export yet.', 'warning');
          return;
        }
        setExportRefusal({ renderId: summary.id, blockers: result.blockers });
        return;
      }

      const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Could not export that render',
        'error'
      );
    } finally {
      setExportingId(null);
    }
  };

  // --- render -----------------------------------------------------------

  if (!manifest || (manifest.scene_count ?? 0) === 0) {
    return (
      <div className="flex flex-col items-center text-center gap-3 py-8">
        <BookOpen size={32} className="text-[var(--color-text-secondary)]" />
        <div>
          <p className="text-sm text-[var(--color-text-primary)]">
            Nothing to write out yet
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Build the story in the Story tab first — the renderer works from
            the scenes it finds there.
          </p>
        </div>
      </div>
    );
  }

  const rangeLabel = describeRange(sceneOptions, rangeStart, rangeEnd);
  const selectedRender = renders.find((r) => r.id === selectedRenderId) ?? null;
  const liveRender =
    renderState && renderState.id === selectedRenderId ? renderState : selectedRender;
  const parked =
    liveRender?.status === 'paused' || liveRender?.status === 'error';

  /**
   * WHICH run a takeover would take over.
   *
   * `lockedBy.holderRenderId` first, and the fallback is second for a
   * reason: the lock is per PROJECT and across formats, so the holder can be
   * a different run than the one the request was about — the API client says
   * so where the error is defined. Taking over `liveRender` instead meant
   * "Take over" pointed at whatever the user happened to be READING, which
   * is not necessarily the run holding the lock, and the request would 423
   * again against the real holder.
   */
  const takeoverRenderId = lockedBy?.holderRenderId ?? liveRender?.id ?? null;

  return (
    <div className="space-y-6">
      {buildBlocks && (
        <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
          <CircleAlert size={13} className="shrink-0 mt-0.5" />
          <span>
            The story is still being built. Finish or clear that build before
            rendering — a build in progress replaces the very scenes a render
            reads.
          </span>
        </p>
      )}

      {/* Annotate. Moved here from the Story tab, where phase 2 parked it as
          explicitly temporary scaffolding: this is the tab that knows whether
          annotation is missing, and §3.3's mitigation for the extra pass is
          exactly that this tab defaults to asking for it. */}
      {canManage && !ingestRunning && (
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm text-[var(--color-text-primary)]">
                {needsAnnotate ? 'Annotate the scenes first' : 'Annotate the scenes'}
              </h3>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                {needsAnnotate
                  ? // Not "flatter" — that claim was wrong, and a calibration
                    // render on 2026-08-15 showed the opposite. Unannotated
                    // prose came back LONGER than annotated (357 words vs 275)
                    // and invented a named character the story does not
                    // contain, because nothing told it how much to keep or
                    // what the scene was for. The honest pitch is control, not
                    // quality.
                    'Nothing is annotated yet. This records each scene’s beat, tension and how tightly to tell it. Without it the renderer has nothing to hold it to length or to the point, so chapters run long and invent detail your story doesn’t have.'
                  : `Records each scene’s beat, tension and how tightly to tell it.${
                      scenesAnnotated !== null && fullScenes
                        ? ` ${scenesAnnotated} of ${fullScenes.length} done.`
                        : ''
                    } Runs on your API key; scenes already annotated are skipped.`}
              </p>
            </div>
            <Button
              variant={needsAnnotate ? 'primary' : 'secondary'}
              onClick={() => setAnnotateOpen(true)}
              disabled={preparing || annotateBlocked || renderRunning}
            >
              <Sparkles size={16} />
              {preparing ? 'Starting…' : 'Annotate'}
            </Button>
          </div>
          {annotateBlocked && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Finish or clear the story build first — annotating now would lose
              its progress.
            </p>
          )}
        </section>
      )}

      {/* The annotate pass's own progress, Stop and token subtotal. Mounted
          HERE because this tab is now the only place that starts one — the
          section above unmounts the moment `ingestRunning` goes true, so
          without this the run it just started would report nothing and could
          not be stopped. The card self-hides when idle. */}
      <IngestProgressCard />

      <RenderHintsEditor
        // Re-seed the form's drafts when the stored row advances, rather than
        // showing the user their own pre-save text as if it were saved.
        key={`hints:${sections.rendering_hints?.server_ts ?? 0}`}
        disabled={!canManage || renderRunning}
      />

      {/* Range picker. Two anchors rather than a checklist: a render is a
          contiguous span by construction — the run row stores exactly
          `scene_id_start` and `scene_id_end`, and prose reads in order. */}
      {canManage && (
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
          <div>
            <h3 className="text-sm text-[var(--color-text-primary)]">
              What to write out
            </h3>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              One chapter per scene, in order. Rendering a shorter stretch
              first is the cheap way to see how it reads.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
                From
              </span>
              <select
                value={rangeStart}
                disabled={renderDisabled || sceneOptions.length === 0}
                onChange={(e) => setRangeStartPick(e.target.value)}
                className={SELECT_CLASS}
              >
                {sceneOptions.map((row, i) => (
                  <option key={row.id} value={row.id}>
                    {i + 1}. {(row.data as unknown as Scene)?.title || 'Untitled'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
                To
              </span>
              <select
                value={rangeEnd}
                disabled={renderDisabled || sceneOptions.length === 0}
                onChange={(e) => setRangeEndPick(e.target.value)}
                className={SELECT_CLASS}
              >
                {sceneOptions.map((row, i) => (
                  <option key={row.id} value={row.id}>
                    {i + 1}. {(row.data as unknown as Scene)?.title || 'Untitled'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {rangeLabel === null ? (
            <p className="text-xs text-[var(--color-warning)]">
              “To” comes before “From” — pick a range that runs forwards.
            </p>
          ) : (
            <p className="text-xs text-[var(--color-text-secondary)]">{rangeLabel}</p>
          )}
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => void openPreflight()}
              disabled={
                renderDisabled ||
                preparing ||
                rangeLabel === null ||
                sceneOptions.length === 0
              }
            >
              <Sparkles size={16} />
              {preparing ? 'Preparing…' : 'Write it out'}
            </Button>
          </div>
        </section>
      )}

      <RenderProgressCard
        canManage={canManage}
        parked={parked}
        status={liveRender?.status ?? null}
        onResume={
          parked && liveRender
            ? () => void continueRender(liveRender.id, false)
            : undefined
        }
        onTakeOver={
          takeoverRenderId
            ? () => {
                // Follow the run that was actually taken over, so the reader
                // is not left showing a different one's chapters.
                setSelectedRenderId(takeoverRenderId);
                void continueRender(takeoverRenderId, true);
              }
            : undefined
        }
      />

      {/* Past runs. Kept as a list rather than folded into the reader because
          a run is the unit `stale_bible` and the format attach to — and
          because deleting one has to be reachable without opening it. */}
      {renders.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Renders
          </h3>
          <ul className="space-y-1">
            {renders.map((r) => (
              <li
                key={r.id}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                  r.id === selectedRenderId
                    ? 'border-[var(--color-accent)] bg-[var(--color-bg-tertiary)]'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedRenderId(r.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <span className="block text-sm text-[var(--color-text-primary)] truncate">
                    {new Date(r.created_at).toLocaleString()} ·{' '}
                    {r.complete_unit_count} of {r.unit_count} chapters
                  </span>
                  <span className="block text-xs text-[var(--color-text-secondary)]">
                    {RENDER_STATUS_LABEL[r.status] ?? r.status}
                    {/* Staleness is orthogonal to the run's lifecycle and
                        lives in its own column precisely so a finished run
                        stays `complete` — so it is reported alongside the
                        status, never instead of it. */}
                    {r.stale_bible ? ' · the story was restored since' : ''}
                    {r.model ? ` · ${r.model}` : ''}
                  </span>
                </button>
                {/* Export is a READ. It takes `project:view` like the
                    reader does, so it is offered without `canManage` and
                    stays available while another run is in flight. */}
                <button
                  type="button"
                  onClick={() => void exportRender(r)}
                  disabled={exportingId !== null || !fullScenes}
                  aria-label="Export this render as Markdown"
                  title="Export as Markdown"
                  className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                >
                  <Download size={14} />
                </button>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(r)}
                    disabled={renderRunning}
                    aria-label="Delete this render"
                    className="p-1 rounded text-[var(--color-text-secondary)] hover:text-red-400 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {selectedRenderId && fullScenes && (
        <RenderReader
          projectId={project.id}
          renderId={selectedRenderId}
          scenes={fullScenes}
          canManage={canManage}
          disabled={renderDisabled || preparing}
          onRerender={(sceneId) => void renderOneScene(selectedRenderId, sceneId)}
          reloadToken={reloadToken}
        />
      )}

      {renders.length === 0 && (
        <p className="text-sm text-[var(--color-text-secondary)]">
          Nothing written out yet.
        </p>
      )}

      {preflight && (
        <StartRenderModal
          estimate={preflight}
          sceneRangeLabel={rangeLabel ?? ''}
          onStart={(profileId) => void beginRender(profileId)}
          onClose={() => setPreflight(null)}
          busy={preparing}
        />
      )}

      {annotateOpen && (
        <StartIngestModal
          mode="annotate"
          estimatedTokens={estimateAnnotateTokens(manifest?.scene_count ?? 0)}
          onStart={(profileId) => void startAnnotate(profileId)}
          onClose={() => setAnnotateOpen(false)}
          busy={preparing}
        />
      )}

      {/* Decision 1's refusal. It names every blocked chapter and offers
          the fix for each, because "some chapters aren't finished" without
          saying which is a guessing loop. */}
      {exportRefusal && (
        <Modal
          isOpen
          onClose={() => setExportRefusal(null)}
          title="This story isn’t finished yet"
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {exportRefusal.blockers.length === 1
                ? 'One chapter is not ready, so exporting now would produce a file that reads as a finished book with a gap in it.'
                : `${exportRefusal.blockers.length} chapters are not ready, so exporting now would produce a file that reads as a finished book with gaps in it.`}
            </p>
            <ul className="space-y-1">
              {exportRefusal.blockers.map((b) => (
                <li
                  key={b.sceneId}
                  className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2"
                >
                  <span className="flex-1 min-w-0 text-sm text-[var(--color-text-primary)] truncate">
                    {b.title}{' '}
                    <span className="text-[var(--color-text-secondary)]">
                      — {blockerMessage(b.reason)}
                    </span>
                  </span>
                  {/* `missing` has no unit to replace, so the fix is
                      continuing the run, not re-rendering one chapter. */}
                  {canManage && b.reason !== 'missing' && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setExportRefusal(null);
                        void renderOneScene(exportRefusal.renderId, b.sceneId);
                      }}
                      disabled={renderDisabled || preparing}
                    >
                      Write it again
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setExportRefusal(null)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title="Delete this render?"
        message="Every chapter it produced is deleted. The story itself — scenes, facts, notes — is untouched, but the writing is not kept anywhere and can only be got back by rendering again, which spends your key."
        confirmLabel="Delete"
        danger
        onConfirm={() => pendingDelete && void deleteRender(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

const SELECT_CLASS =
  'w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)] disabled:opacity-50';

const RENDER_STATUS_LABEL: Record<string, string> = {
  running: 'Writing',
  paused: 'Stopped — can be continued',
  complete: 'Finished',
  aborted: 'Discarded',
  error: 'Failed — can be continued',
};

/** A human label for the chosen span, or null when it runs backwards.
 *  Exported-shaped as a pure function so the tab has exactly one place that
 *  decides whether a range is usable. */
function describeRange(
  scenes: StorySceneOut[],
  startId: string,
  endId: string
): string | null {
  const startIdx = scenes.findIndex((s) => s.id === startId);
  const endIdx = scenes.findIndex((s) => s.id === endId);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return null;
  const count = endIdx - startIdx + 1;
  if (count === scenes.length) {
    return `The whole story — ${count} ${count === 1 ? 'scene' : 'scenes'}`;
  }
  return count === 1
    ? `Scene ${startIdx + 1}`
    : `Scenes ${startIdx + 1}–${endIdx + 1} (${count} scenes)`;
}
