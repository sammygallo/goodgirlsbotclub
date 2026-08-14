import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  CircleAlert,
  History,
  Link2Off,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useStoryStore, hasBible, isCanonLocked } from '../../stores/storyStore';
import { api } from '../../api/client';
import {
  estimateColdStartTokens,
  hasUnreadableChecksNote,
  useStoryIngestStore,
} from '../../stores/storyIngestStore';
import { useCharacterStore } from '../../stores/characterStore';
import { usePersonaStore } from '../../stores/personaStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useConnectionProfileStore } from '../../stores/connectionProfileStore';
import { useWorldInfoStore } from '../../stores/worldInfoStore';
import { useChatLoreConfigStore } from '../../stores/chatLoreConfigStore';
import { resolveEffectiveBooks } from '../../utils/worldInfoComposition';
import { IngestProgressCard } from './IngestProgressCard';
import { StartIngestModal } from './StartIngestModal';
import { ContradictionCard } from './ContradictionCard';
import type { EvidenceMessage } from './ContradictionCard';
import { FactReviewList } from './FactReviewList';
import { VoiceConfidenceCard } from './VoiceConfidenceCard';
import { LockCanonFooter } from './LockCanonFooter';
import { SceneReviewRow } from './SceneReviewRow';
import {
  gatherColdStartSources,
  gatherIngestInputs,
  replayEntriesFrom,
} from './ingestSources';
import {
  checkWatermark,
  indexById,
  driftBannerState,
  localiseSceneDrift,
  type DriftMessage,
  type DriftScene,
  type SceneDriftReport,
  type WatermarkVerdict,
} from '../../utils/storyBible/msgDrift';
import { makeLlmCall } from '../../utils/storyIngest/llmBridge';
import { estimateAnnotateTokens } from '../../utils/storyIngest/annotate';
import { BeatMapCard } from './BeatMapCard';
import {
  extendChunkPlan,
  planTranscriptChunks,
} from '../../utils/storyIngest/transcriptChunker';
import { Button, ConfirmDialog, Modal } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import type { Project, ProjectChatRef, StoryArchiveReason } from '../../api/client';
import type {
  Contradiction,
  MetaSection,
  UserVoiceSection,
} from '../../types/storyBible';
import type { IngestMessage } from '../../utils/storyIngest/types';
import {
  bibleUuid,
  capturedAt,
  describeRef,
  resolveRefState,
  userAnnotationSourceRef,
} from '../../utils/storyBible/sourceRefs';
import { storyApi } from '../../api/client';

/**
 * Story tab of the Works panel — productization step 2, phase 5.
 *
 * What ships here is read plumbing plus the one decision the bible can't
 * be built without: which chat it is the story OF. Ingestion (phases
 * 6–8) fills everything else; until then this tab shows what exists and
 * lets the user designate (or re-designate) the source chat.
 */

function showIngestError(err: unknown): void {
  showToastGlobal(
    err instanceof Error ? err.message : 'Failed to start the build',
    'error'
  );
}

function sameChat(a: ProjectChatRef, b: ProjectChatRef): boolean {
  return a.character_avatar === b.character_avatar && a.file_name === b.file_name;
}

/** `continuity.data` is `Record<string, unknown>` on the wire — reconcile
 *  writes it, but a stale deploy, a mid-write crash, or a future schema
 *  drift could still hand this tab something unshaped. Rendering "no
 *  contradiction data" is always safe; rendering a crash is not. */
function readContradictions(data: Record<string, unknown> | undefined): Contradiction[] {
  const raw = data?.contradictions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is Contradiction => {
    const c = entry as Partial<Contradiction> | null;
    return (
      typeof c === 'object' &&
      c !== null &&
      typeof c.id === 'string' &&
      typeof c.type === 'string' &&
      typeof c.description === 'string' &&
      Array.isArray(c.sources) &&
      typeof c.resolution?.status === 'string'
    );
  });
}

const ARCHIVE_REASON_LABEL: Record<StoryArchiveReason, string> = {
  reset: 'before a reset',
  change_source_chat: 'before changing the source chat',
  reingest: 'before re-ingesting',
  restore_backup: 'before a restore',
};

function SourceChatPickerModal({
  chats,
  current,
  onPick,
  onClose,
  busy,
}: {
  chats: ProjectChatRef[];
  current: ProjectChatRef | null;
  onPick: (chat: ProjectChatRef) => void;
  onClose: () => void;
  busy: boolean;
}) {
  // No default selection when there is a real choice to make: silently
  // pre-picking one chat as the story's source is exactly the decision
  // the user should be making deliberately.
  const [picked, setPicked] = useState<ProjectChatRef | null>(
    chats.length === 1 ? chats[0] : null
  );

  return (
    <Modal isOpen onClose={onClose} title="Choose the source chat">
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          A story is built from one chat. Pick the roleplay this work is
          the story of — you can change it later, but that starts the
          story over.
        </p>
        <ul className="space-y-2 max-h-72 overflow-y-auto">
          {chats.map((chat) => {
            const isPicked = picked !== null && sameChat(picked, chat);
            const isCurrent = current !== null && sameChat(current, chat);
            return (
              <li key={`${chat.character_avatar}:${chat.file_name}`}>
                <button
                  type="button"
                  onClick={() => setPicked(chat)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                    isPicked
                      ? 'border-[var(--color-accent)] bg-[var(--color-bg-tertiary)]'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]'
                  }`}
                >
                  <span className="block text-[var(--color-text-primary)]">
                    {chat.file_name}
                  </span>
                  <span className="block text-xs text-[var(--color-text-secondary)]">
                    {chat.character_avatar}
                    {isCurrent && ' · current source'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!picked || busy}
            onClick={() => picked && onPick(picked)}
          >
            {busy ? 'Saving…' : 'Use this chat'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function StoryTab({
  project,
  canManage,
}: {
  project: Project;
  canManage: boolean;
}) {
  const {
    manifest,
    sections,
    scenes,
    scenesHasMore,
    facts,
    factsHasMore,
    archives,
    archivesLoaded,
    archivesHasMore,
    isLoading,
    isSaving,
    error,
    load,
    clear,
    loadMoreFacts,
    loadMoreScenes,
    designateSourceChat,
    resetBible,
    loadArchives,
    loadMoreArchives,
    restoreArchive,
    relinkSourceChat,
    loadAllScenesWithData,
    flagScenesStale,
    clearSceneStale,
  } = useStoryStore();
  const characters = useCharacterStore((s) => s.characters);
  const personas = usePersonaStore((s) => s.personas);
  const wiScanDepth = useWorldInfoStore((s) => s.scanDepth);
  const runIngest = useStoryIngestStore((s) => s.run);
  const runAnnotate = useStoryIngestStore((s) => s.runAnnotate);
  const ingestRunning = useStoryIngestStore((s) => s.isRunning);
  const loadCheckpoint = useStoryIngestStore((s) => s.loadCheckpoint);
  const clearIngest = useStoryIngestStore((s) => s.clear);
  const resetIngestState = useStoryIngestStore((s) => s.resetIngestState);
  const checkpoint = useStoryIngestStore((s) => s.checkpoint);

  /** The picker is opened for one of two entirely different intents. A
   *  bare boolean would have routed both through the same onPick, and a
   *  relink taking the Change path would call `resetBible` — that is the
   *  bug this discriminant exists to prevent. */
  const [pickerMode, setPickerMode] = useState<null | 'designate' | 'relink'>(
    null
  );
  const [confirmReset, setConfirmReset] = useState(false);
  /** A chat chosen in the picker that would REPLACE an existing source,
   *  held until the user confirms the discard it implies. */
  const [pendingChange, setPendingChange] = useState<ProjectChatRef | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  /** TEMPORARY (step 3 phase 2). The annotate pass has no home of its own
   *  until Phase 5's Render tab, which defaults to "annotate first" when
   *  `scenes[].function` is empty. This flag and the section it opens are
   *  scaffolding so the pass can be exercised on a real key before then;
   *  Phase 5 removes both. */
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  /** A walk long enough to need an explicit "yes, this one's long"
   *  before it spends more of the user's key than usual (plan Phase 7:
   *  no silent caps). Holds what's needed to resume the SAME build once
   *  confirmed, without re-fetching the chat. */
  const [pendingLongWalk, setPendingLongWalk] = useState<{
    profileId: string | null;
    messages: IngestMessage[];
    capturedWiFired: unknown;
    chunkCount: number;
    /** True when `chunkCount` counts only the messages past the watermark
     *  — the dialog says "the new messages" rather than "the whole chat". */
    incremental: boolean;
  } | null>(null);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  /** Upstream-drift state (phase 11). Derived per visit and never
   *  persisted: representing it as a checkpoint status would trip
   *  `isBuildActiveNow` and silently disable the whole review UI, and any
   *  new persisted field is a backend `extra="forbid"` change. */
  const [drift, setDrift] = useState<{
    verdict: WatermarkVerdict;
    scenes: SceneDriftReport | null;
  } | null>(null);
  const [driftDismissed, setDriftDismissed] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [pendingReingest, setPendingReingest] = useState(false);

  useEffect(() => {
    void load(project.id);
    void loadCheckpoint(project.id);
    return () => {
      clear();
      clearIngest();
    };
  }, [project.id, load, clear, loadCheckpoint, clearIngest]);

  const meta = sections.meta?.data as unknown as MetaSection | undefined;
  const sourceChat = meta?.source?.chat ?? null;
  /** Locked bibles disable every write in this tab except unlock, reset,
   *  and change source (§3.2 — reset/change destroy `meta` wholesale,
   *  which is unlock-by-destruction and honest). */
  const canonLocked = isCanonLocked(sections);
  /** A build in flight or resumable (§3.3). Scene edits, fact deletes and
   *  resolutions render disabled with "Finish or clear the build first";
   *  resolutions stay ENABLED per the plan (reconcile's merge was
   *  designed resolution-safe). */
  const buildActive =
    checkpoint?.status === 'running' ||
    checkpoint?.status === 'paused' ||
    checkpoint?.status === 'error';
  /** Fact deletes, scene edits, sample paste, relink, lock — every §5
   *  action except the resolution-shaped ones — gates on this. */
  const writesDisabled = !canManage || canonLocked || buildActive;
  /** Annotate's own gate (step-3 plan §3.3), deliberately NOT
   *  `writesDisabled` — that composite carries `canonLocked`, and step 3
   *  narrows the lock to *user-authored* edits. A locked bible is exactly
   *  the state a user annotates in before rendering.
   *
   *  It mirrors `runAnnotate`'s own refusal rather than inventing one: the
   *  store is the choke point, and a button that opens a modal the store
   *  will then refuse is just a slower toast. Parking at `annotate` itself
   *  is resumable and must stay clickable; parking anywhere else in the
   *  pipeline is what would lose that pass's progress, since `current_pass`
   *  is one field. */
  const annotateBlocked =
    checkpoint?.status === 'running' ||
    (checkpoint?.current_pass != null &&
      checkpoint.current_pass !== 'annotate' &&
      checkpoint.current_pass !== 'review');
  /** Contradiction resolutions (Keep/Defer/Reopen/Write my own) stay
   *  live during a build (plan §3.3): reconcile's existing-wins merge
   *  was designed resolution-safe, so the review UI shouldn't punish
   *  the user for running a walk. The lock still blocks — locking IS
   *  the mode where nothing edits. */
  const resolutionsDisabled = !canManage || canonLocked;

  const contradictions = useMemo(
    () => readContradictions(sections.continuity?.data),
    [sections.continuity]
  );
  const unresolvedContradictions = contradictions.filter(
    (c) => c.resolution.status === 'unresolved'
  ).length;

  const userVoice = useMemo(
    () => sections.user_voice?.data as unknown as UserVoiceSection | undefined,
    [sections.user_voice]
  );

  /** One evidence fetch shared across every ContradictionCard (§6.1: "one
   *  fetch shared across all cards"). The cache is keyed by the current
   *  source chat ref so a relink invalidates it, and null is the
   *  fall-through the cards render as snapshot-only — never a throw. */
  const evidenceCacheRef = useRef<{
    key: string;
    messages: EvidenceMessage[] | null;
    inFlight: Promise<EvidenceMessage[] | null> | null;
  } | null>(null);
  const loadChatMessages = useCallback(async (): Promise<EvidenceMessage[] | null> => {
    const chat = sourceChat?.ref ?? null;
    if (!chat) return null;
    const key = `${chat.character_avatar}\u0000${chat.file_name}`;
    const cache = evidenceCacheRef.current;
    if (cache?.key === key) return cache.inFlight ?? cache.messages;
    const inFlight = api
      .getChatMessages(chat.character_avatar, chat.file_name)
      .then((r) => r.messages as EvidenceMessage[])
      .catch(() => null);
    evidenceCacheRef.current = { key, messages: null, inFlight };
    const messages = await inFlight;
    if (evidenceCacheRef.current?.key === key) {
      evidenceCacheRef.current = { key, messages, inFlight: null };
    }
    return messages;
  }, [sourceChat]);

  /** The same per-visit fetch, in the shape drift comparison needs.
   *
   *  Deliberately built from the EVIDENCE cache rather than from
   *  `gatherIngestInputs`: the raw rows still carry `swipes`, which the
   *  ingest shape drops, so drift can resolve the exact swipe a ref names
   *  instead of reporting `unverifiable` whenever the user has swiped.
   *
   *  Filtered to id-bearing messages because that is the population the
   *  watermark counts (`gatherIngestInputs` drops the rest), and comparing
   *  against a different population would read as phantom growth. */
  const driftMessagesFrom = useCallback(
    (messages: EvidenceMessage[]): DriftMessage[] => {
      const out: DriftMessage[] = [];
      for (const raw of messages) {
        const m = raw as unknown as {
          mes?: string;
          send_date?: number;
          swipe_id?: number;
          swipes?: string[];
          extra?: { ggbc_id?: unknown };
        };
        const id = typeof m.extra?.ggbc_id === 'string' ? m.extra.ggbc_id : '';
        if (!id) continue;
        const swipeIdx = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
        const content =
          Array.isArray(m.swipes) && m.swipes[swipeIdx] !== undefined
            ? m.swipes[swipeIdx]
            : (m.mes ?? '');
        out.push({
          id,
          content: content ?? '',
          swipeIdx,
          timestamp: typeof m.send_date === 'number' ? m.send_date : 0,
          swipes: Array.isArray(m.swipes) ? m.swipes : null,
        });
      }
      return out;
    },
    []
  );

  const characterNameByAvatar = useMemo(
    () => new Map(characters.map((c) => [c.avatar, c.name])),
    [characters]
  );

  /** One live-ref bundle passed to every ref classifier in the tab. An
   *  omitted list reads as 'live' (see `resolveRefState`'s can't-tell
   *  rule), so half-filled versions of this are what invent dangling
   *  false-positives — build it once, use it everywhere. */
  const liveRefs = useMemo(
    () => ({
      chats: project.chats,
      characterAvatars: characters.map((c) => c.avatar),
      characterNameByAvatar,
      personaNames: personas.map((p) => p.name),
    }),
    [project.chats, characters, characterNameByAvatar, personas]
  );

  const sourceState = useMemo(() => {
    if (!sourceChat) return null;
    return resolveRefState(sourceChat, liveRefs);
  }, [sourceChat, liveRefs]);

  const watermark = meta?.ingest_watermark ?? null;

  /** Drift detection (phase 11 §4).
   *
   *  Gated three ways so the cost lands only where it buys something: no
   *  watermark means nothing was ever walked (decidable from `meta` alone,
   *  no fetch at all), an active build means the answer is about to change
   *  anyway, and the work is deferred off the render path because it
   *  fetches the whole chat.
   *
   *  Unlike phase 10's evidence fetch — which is lazy, firing only when a
   *  card is expanded — this is EAGER for anyone with a walked bible. That
   *  is a real new cost per visit, accepted because the alternative is a
   *  persisted field (backend `extra="forbid"`) and because the gates
   *  above bound who pays it. */
  useEffect(() => {
    if (!watermark?.last_msg || watermark.message_count <= 0) {
      setDrift(null);
      return;
    }
    if (buildActive || ingestRunning) return;

    let cancelled = false;
    const run = async () => {
      const raw = await loadChatMessages();
      if (cancelled || !raw) return;
      const live = driftMessagesFrom(raw);
      const index = indexById(live);
      const verdict = await checkWatermark(watermark, live, index);
      if (cancelled) return;

      if (verdict.kind !== 'diverged') {
        setDrift({ verdict, scenes: null });
        return;
      }
      // Tier 2 only runs once tier 1 has already said something is wrong,
      // so the per-scene fetch never happens on the common clean path.
      const rows = await loadAllScenesWithData();
      if (cancelled) return;
      const scenes = rows
        ? await localiseSceneDrift(
            rows.map((row) => row.data as unknown as DriftScene),
            live,
            index
          )
        : null;
      if (!cancelled) setDrift({ verdict, scenes });
    };

    // Deferred off the critical render path — but WITH A DEADLINE.
    //
    // `requestIdleCallback(cb)` with no `timeout` is only ever run when
    // the browser decides it has idle time, and it is allowed to decide
    // "never". This app gives it plenty of reason to: an animated
    // background, a live chat panel, and third-party extension scripts
    // that throw on load. Without the deadline the drift check simply
    // does not happen, and the banner never appears — no error, no
    // warning, just silence.
    //
    // That is not hypothetical. It shipped, and on production the
    // "N new messages" banner stayed hidden through repeated opens of
    // the Story tab, appearing only after a full page reload settled
    // the page enough for an idle slot to open up. Caught by driving
    // the deployed site (2026-08-11); no unit test could see it,
    // because jsdom has no `requestIdleCallback` and the suite has
    // always taken the `setTimeout` fallback below.
    const IDLE_DEADLINE_MS = 2000;

    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const hasIdle =
      typeof window !== 'undefined' && typeof w.requestIdleCallback === 'function';

    // Track WHICH scheduler was used rather than inferring it from the
    // presence of `cancelIdleCallback`: a browser exposing the canceller
    // but not the scheduler would otherwise hand a timeout id to the
    // wrong canceller and leak the callback.
    const handle = hasIdle
      ? w.requestIdleCallback!(() => void run(), { timeout: IDLE_DEADLINE_MS })
      : (setTimeout(() => void run(), 0) as unknown as number);

    return () => {
      cancelled = true;
      if (hasIdle) w.cancelIdleCallback?.(handle);
      else clearTimeout(handle);
    };
  }, [
    watermark,
    buildActive,
    ingestRunning,
    loadChatMessages,
    driftMessagesFrom,
    loadAllScenesWithData,
  ]);

  /** Divergence and new-messages are mutually exclusive verdicts, so the
   *  banner renders at most one thing. Dismissal is per-visit and resets
   *  when the verdict itself changes. */
  const driftKind = drift?.verdict.kind ?? null;
  useEffect(() => {
    setDriftDismissed(false);
  }, [driftKind]);

  /** Every rule about what the banner shows and offers lives in this
   *  pure function so it can be tested in plain node — including the one
   *  that matters most, that a locked bible is never offered a re-ingest
   *  (which would destroy the lock via `resetBible`). */
  const banner = useMemo(
    () =>
      driftBannerState(drift?.verdict, drift?.scenes, {
        canonLocked,
        canManage,
        hasPinnedPlan: (checkpoint?.chunk_plan.length ?? 0) > 0,
      }),
    [drift, canonLocked, canManage, checkpoint]
  );
  const newMessageCount = banner.newMessageCount;
  // Memoised because the `?? []` fallback would otherwise mint a new
  // array on every render, re-running the filter below each time.
  const staleSceneIds = useMemo(
    () => drift?.scenes?.downstreamSceneIds ?? [],
    [drift]
  );
  /** Scenes the user has waved off this visit. Detection would otherwise
   *  re-derive the same set on the next render and the badge would come
   *  straight back, which reads as the dismiss having failed. */
  const [dismissedScenes, setDismissedScenes] = useState<Set<string>>(new Set());
  const staleSceneSet = useMemo(
    () => new Set(staleSceneIds.filter((id) => !dismissedScenes.has(id))),
    [staleSceneIds, dismissedScenes]
  );

  const dismissSceneStale = async (sceneId: string) => {
    setDismissedScenes((prev) => new Set(prev).add(sceneId));
    // Clear the persisted flag too, so Lock canon and any later consumer
    // agree with what the user just decided. If the write is refused or
    // fails, the badge must come BACK: a hidden badge sitting over a
    // still-true `stale_source` is the one state this must never leave.
    const ok = await clearSceneStale(sceneId);
    if (!ok) {
      setDismissedScenes((prev) => {
        const next = new Set(prev);
        next.delete(sceneId);
        return next;
      });
    }
  };

  const designate = async (chat: ProjectChatRef) => {
    const ok = await designateSourceChat(chat, {
      characters: project.characters.map((avatar) => ({
        avatar,
        name: characterNameByAvatar.get(avatar),
      })),
      title: project.name,
      // Belt and braces alongside resetBible's return value: confirmChange
      // awaits a reset before getting here, and this pins the write to the
      // Work the user actually picked the chat for.
      projectId: project.id,
    });
    if (ok) setPickerMode(null);
    return ok;
  };

  const relink = async (chat: ProjectChatRef) => {
    // Relink is not a designate: same roleplay, new identity. The store
    // action keeps the ingest watermark and the captured snapshot
    // verbatim — the picker calls this straight, no reset in between.
    const ok = await relinkSourceChat(chat);
    if (ok) setPickerMode(null);
    return ok;
  };

  const onPick = async (chat: ProjectChatRef) => {
    if (pickerMode === 'relink') {
      await relink(chat);
      return;
    }
    // Repointing an existing bible at a different chat orphans every
    // scene and fact — their message refs address the OLD chat, and a
    // scene carries no chat ref of its own to notice. So changing the
    // source discards the bible first (plan Decision 4), behind an
    // explicit confirm.
    if (sourceChat && !sameChat(sourceChat.ref, chat)) {
      setPickerMode(null);
      setPendingChange(chat);
      return;
    }
    await designate(chat);
  };

  /** Write-my-own (§6.2): append the user's fact FIRST so the resolution
   *  never cites an id that doesn't exist yet, then patch the entry to
   *  cite it. The append is retry-safe on its own (the server is
   *  idempotent by fact id, and this call ties itself to the same id).
   *
   *  Guarded end-to-end against a Work switch mid-flight: the append
   *  goes to `project.id`, and the resolution PUT will NOT run if the
   *  user has since navigated away — otherwise the store's own
   *  `patchContinuity` reads its target from `get().projectId`, and a
   *  slow appendFact could resolve after the user opened Work B, so the
   *  resolution would land on B's continuity while A's contradiction
   *  stayed unresolved and the user sees a success.
   *
   *  Returns true only when both halves landed — the modal in the card
   *  keeps the user's text intact on false. */
  const writeOwnFact = async (
    contradiction: Contradiction,
    text: string,
    rationale: string
  ): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const workId = project.id;
    const factId = bibleUuid();
    const fact = {
      id: factId,
      text: trimmed,
      category:
        contradiction.type === 'world_rule' ? 'world_rule' : 'change',
      confidence: 'explicit',
      source: userAnnotationSourceRef(),
      // The one legal home for back-refs to the losers, per Phase 8's
      // decision 1: appended, not mutating the losers themselves.
      contradicts: contradiction.sources,
      supersedes: null,
      established_in: null,
    };
    try {
      await storyApi.appendFact(
        workId,
        fact as unknown as Record<string, unknown>
      );
    } catch (error) {
      showToastGlobal(
        error instanceof Error ? error.message : 'Failed to save your fact',
        'error'
      );
      return false;
    }
    // The store's projectId may have moved on during the append (Work
    // switch). Only patch the continuity when the tab is still on the
    // Work whose contradiction this is for — otherwise the resolution
    // PUT would land on the wrong bible.
    if (useStoryStore.getState().projectId !== workId) return false;
    const patched = await useStoryStore.getState().patchContinuity(
      (entries) => {
        // No entry means the target was cleaned up between opening the
        // modal and submitting (a delete of one of its sources
        // dropped it, another tab resolved and reconcile pruned it).
        // Nothing to write — the store's own no-op discipline.
        if (!entries.some((entry) => entry.id === contradiction.id)) {
          return null;
        }
        return entries.map((entry) =>
          entry.id === contradiction.id
            ? {
                ...entry,
                resolution: {
                  status: 'user_chose' as const,
                  canonical_choice: factId,
                  rationale,
                  resolved_at: capturedAt(),
                },
              }
            : entry
        );
      },
      {
        target: { type: 'contradiction', id: contradiction.id },
        classification: 'contradiction',
        diff: `write-my-own: ${trimmed.slice(0, 200)}`,
      }
    );
    return patched;
  };

  const confirmChange = async () => {
    const chat = pendingChange;
    setPendingChange(null);
    if (!chat) return;
    // Reset first: if designation then fails, an empty bible is honest,
    // whereas new meta over old scenes is silently wrong. Tagged so the
    // archive list can tell this apart from a raw "Reset story" click.
    if (await resetBible('change_source_chat')) await designate(chat);
  };

  const toggleArchives = () => {
    const next = !archivesOpen;
    setArchivesOpen(next);
    if (next && !archivesLoaded) void loadArchives();
  };

  // The scanner's own book set: globally active + the character's
  // embedded/linked + persona-linked, plus whatever this chat's
  // resolveEffectiveBooks config contributes (which folds in the legacy
  // chat-linked map for chats that haven't been promoted to a v2 config).
  // Ingesting every book in the library instead would write lore from
  // unrelated stories into this bible as canon.
  const booksForChat = useCallback(
    (avatar: string, fileName: string) => {
      const wi = useWorldInfoStore.getState();
      const chars = useCharacterStore.getState();
      const persona = usePersonaStore
        .getState()
        .getPersonaForContext(avatar, fileName);
      const inheritedIds = Array.from(
        new Set<string>([
          ...wi.activeBookIds,
          ...chars.getActiveBookIdsForCharacter(avatar),
          ...(persona?.linkedBookIds ?? []),
        ])
      );
      const chatConfig = fileName
        ? useChatLoreConfigStore.getState().getEffectiveConfig(fileName)
        : undefined;
      const { effectiveBooks, effectiveActiveIds } = resolveEffectiveBooks(
        wi.getComposableBooks(),
        inheritedIds,
        chatConfig
      );
      const activeIds = new Set(effectiveActiveIds);
      return effectiveBooks.filter((b) => activeIds.has(b.id));
    },
    []
  );

  const coldStartSources = useMemo(() => {
    if (!sourceChat) return null;
    const avatar = sourceChat.ref.character_avatar;
    const character = characters.find((c) => c.avatar === avatar) ?? null;
    const relevant = booksForChat(avatar, sourceChat.ref.file_name);
    // The persona the app itself would resolve for THIS chat — chat lock,
    // then character lock, then the active one. Picking `isDefault`
    // instead writes the wrong protagonist into the bible for anyone who
    // switched persona in the chat but never changed their default.
    const persona = usePersonaStore
      .getState()
      .getPersonaForContext(avatar, sourceChat.ref.file_name);
    return gatherColdStartSources(character, avatar, persona ?? null, relevant);
  }, [sourceChat, characters, booksForChat, personas]);

  const buildAndRun = async (
    profileId: string | null,
    messages: IngestMessage[],
    capturedWiFired: unknown,
    confirmLongWalk: boolean,
    hasNewMessages = false
  ) => {
    if (!sourceChat || !coldStartSources) return;
    const profile = profileId
      ? useConnectionProfileStore.getState().getProfile(profileId)
      : null;
    const settings = useSettingsStore.getState();
    const provider = profile?.provider ?? settings.activeProvider;
    const model = profile?.model ?? settings.activeModel;
    // A saved custom profile points at its OWN endpoint; falling back
    // to the settings URL would send this run somewhere else entirely.
    const customUrl = profile
      ? profile.customUrl
      : (settings as unknown as { customEndpointUrl?: string }).customEndpointUrl;

    await runIngest({
      projectId: project.id,
      sources: coldStartSources,
      messages,
      capturedWiFired,
      wiEntries: replayEntriesFrom(
        booksForChat(sourceChat.ref.character_avatar, sourceChat.ref.file_name)
      ),
      wiScanDepth,
      // A group chat's source would be a group file; solo is the v1
      // cut, and the replay pass skips group chats regardless.
      isGroupChat: false,
      chat: sourceChat.ref,
      confirmLongWalk,
      hasNewMessages,
      llm: makeLlmCall({
        provider,
        model,
        customUrl,
        characterName: coldStartSources.characterName,
      }),
      model,
    });
    // The walk re-read the chat and moved the watermark to whatever it
    // saw. Comparing that fresher watermark against this mount's older
    // snapshot can report `anchor_deleted` for messages that plainly
    // exist, so drop the snapshot and let the drift effect re-fetch.
    evidenceCacheRef.current = null;
    await load(project.id);
  };

  /**
   * Start a build.
   *
   * `incremental` means "continue this bible over the messages added since
   * the watermark". It changes what the long-walk confirmation counts:
   * the dialog authorises NEW spend, so it must be scoped to the
   * extension. Gating on the cumulative plan would re-prompt on every
   * message added to a long chat, asking the user to re-authorise chunks
   * they already paid for.
   */
  const startIngest = async (profileId: string | null, incremental = false) => {
    if (!sourceChat || !coldStartSources) return;
    setPreparing(true);
    try {
      const { messages, capturedWiFired } = await gatherIngestInputs(
        sourceChat.ref
      );
      setStartOpen(false);

      // A very long walk spends more of the user's key than usual —
      // confirm before any model call, not mid-build (plan: "no silent
      // caps"). Cheap to check: chunk planning is pure and instant.
      const pinnedPlan = checkpoint?.chunk_plan ?? [];
      const extension =
        incremental && pinnedPlan.length > 0
          ? extendChunkPlan(messages, pinnedPlan)
          : null;
      const chunkCount = extension
        ? extension.chunks.length
        : planTranscriptChunks(messages).chunks.length;
      const exceeds = extension
        ? extension.exceedsSoftCap
        : planTranscriptChunks(messages).exceedsSoftCap;

      if (exceeds) {
        setPendingLongWalk({
          profileId,
          messages,
          capturedWiFired,
          chunkCount,
          incremental,
        });
        return;
      }

      await buildAndRun(profileId, messages, capturedWiFired, false, incremental);
    } catch (err) {
      showIngestError(err);
    } finally {
      setPreparing(false);
    }
  };

  const confirmLongWalkAndRun = async () => {
    if (!pendingLongWalk) return;
    const { profileId, messages, capturedWiFired, incremental } = pendingLongWalk;
    setPendingLongWalk(null);
    setPreparing(true);
    try {
      await buildAndRun(profileId, messages, capturedWiFired, true, incremental);
    } catch (err) {
      showIngestError(err);
    } finally {
      setPreparing(false);
    }
  };

  /**
   * Run the annotate pass (step 3 phase 2).
   *
   * TEMPORARY entry point — Phase 5's Render tab owns this properly.
   *
   * Deliberately NOT gated on `canonLocked`, and deliberately not routed
   * through `writesDisabled`. Step 3 narrows the lock invariant to
   * *user-authored* edits: annotate writes derived fields nothing else
   * owns, and a locked bible is exactly the state a user annotates in
   * before rendering. `writesDisabled` is a three-term composite that
   * carries `canonLocked`, so inheriting it would drag the lock back in.
   *
   * The store is still the choke point — `runAnnotate` refuses on a
   * checkpoint parked mid-pipeline, since writing `current_pass:
   * 'annotate'` over a parked walk would destroy the signal
   * `resumableWalk` reads. The button below only mirrors that refusal so
   * the user is not offered a click that toasts at them.
   */
  const startAnnotate = async (profileId: string | null) => {
    const profile = profileId
      ? useConnectionProfileStore.getState().getProfile(profileId)
      : null;
    const settings = useSettingsStore.getState();
    const provider = profile?.provider ?? settings.activeProvider;
    const model = profile?.model ?? settings.activeModel;
    const customUrl = profile
      ? profile.customUrl
      : (settings as unknown as { customEndpointUrl?: string }).customEndpointUrl;

    setPreparing(true);
    try {
      setAnnotateOpen(false);
      await runAnnotate({
        projectId: project.id,
        llm: makeLlmCall({
          provider,
          model,
          customUrl,
          characterName: coldStartSources?.characterName || 'Story',
        }),
        model,
      });
      // The pass rewrites scene rows and may add the `narrative` section.
      await load(project.id);
    } catch (err) {
      showIngestError(err);
    } finally {
      setPreparing(false);
    }
  };

  /** Pick up new messages without re-reading (or re-paying for) the chat. */
  const updateStory = async () => {
    if (canonLocked) return;
    await startIngest(null, true);
  };

  /** Rebuild from scratch. Routed through `resetBible('reingest')`, which
   *  snapshots to the archive first — the only reason this is offered as a
   *  remedy for divergence at all. */
  const reingestFromScratch = async () => {
    if (!sourceChat) return;
    setPendingReingest(false);
    // Both links matter: reset wipes `meta`, so a failed re-designation
    // leaves no source chat and therefore no coldStartSources. Opening
    // the build modal anyway strands it behind an unusable state and it
    // pops open unprompted the moment a later designate succeeds.
    // Mirrors confirmChange's chained reset-then-designate.
    if (!(await resetBible('reingest'))) return;
    if (await designate(sourceChat.ref)) setStartOpen(true);
  };

  const flagStaleScenes = async () => {
    // The per-row Dismiss is a newer and more specific judgement than
    // this bulk action. Re-flagging a dismissed scene would persist
    // `stale_source: true` while the badge — and therefore the row's own
    // Dismiss button — stays hidden for the rest of the visit, leaving a
    // Lock-canon warning the user has no control to clear.
    const targets = staleSceneIds.filter((id) => !dismissedScenes.has(id));
    if (targets.length === 0) return;
    setFlagging(true);
    try {
      const result = await flagScenesStale(targets);
      if (result.flagged > 0 || result.alreadyFlagged > 0) {
        showToastGlobal(
          `${result.flagged + result.alreadyFlagged} scene(s) marked as out of date`,
          'success'
        );
      }
      await load(project.id);
    } finally {
      setFlagging(false);
    }
  };

  if (isLoading && !manifest) {
    return (
      <p className="text-sm text-[var(--color-text-secondary)]">Loading story…</p>
    );
  }

  if (error && !manifest) {
    // Only a load that produced NOTHING blanks the tab, and even then it
    // offers a way out — a transient network blip shouldn't strand the
    // user on an error with no retry.
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 text-sm text-[var(--color-error)]">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
        <Button variant="secondary" onClick={() => void load(project.id)}>
          Try again
        </Button>
      </div>
    );
  }

  // Shared between the empty state below and the full view further down:
  // a reset (or a project that never had a bible) must not strand the
  // user without a way to see or restore past snapshots — the whole
  // point of phase 9 is that a reset stops being a dead end.
  const archivesSection = canManage && (
    <section className="pt-2 border-t border-[var(--color-border)]">
      <Button variant="secondary" onClick={toggleArchives}>
        <History size={16} />
        {archivesOpen ? 'Hide' : 'Show'} snapshots
      </Button>
      {archivesOpen && (
        <div className="mt-2 space-y-1">
          {archives.length === 0 && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              No snapshots yet — one is taken automatically before a
              reset, a re-ingest, or a source-chat change.
            </p>
          )}
          {archives.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)]"
            >
              <div className="min-w-0">
                <p className="text-sm text-[var(--color-text-primary)] truncate">
                  {a.source_label || 'Untitled'} ·{' '}
                  {ARCHIVE_REASON_LABEL[a.reason] ?? 'a snapshot'}
                </p>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {new Date(a.created_at).toLocaleString()} ·{' '}
                  {a.scene_count} scenes · {a.fact_count} facts
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => setPendingRestore(a.id)}
                disabled={isSaving}
              >
                Restore
              </Button>
            </div>
          ))}
          {archivesHasMore && (
            <Button
              variant="secondary"
              onClick={() => void loadMoreArchives()}
              className="mt-2"
            >
              Load more
            </Button>
          )}
        </div>
      )}
    </section>
  );

  const restoreConfirmDialog = (
    <ConfirmDialog
      isOpen={pendingRestore !== null}
      title="Restore this snapshot?"
      message="The current story is replaced with this snapshot. Whatever's here now is itself snapshotted first, so this can be undone too."
      confirmLabel="Restore"
      danger
      busy={isSaving}
      onConfirm={() => {
        // ConfirmDialog calls onClose right after onConfirm, which also
        // clears pendingRestore — only the id capture here is load-bearing.
        const id = pendingRestore;
        if (id) void restoreArchive(id);
      }}
      onClose={() => setPendingRestore(null)}
    />
  );

  // Empty state: no bible yet.
  if (!hasBible(manifest)) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center text-center gap-3 py-8">
          <BookOpen size={32} className="text-[var(--color-text-secondary)]" />
          <div>
            <p className="text-sm text-[var(--color-text-primary)]">
              No story yet
            </p>
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">
              {project.chats.length === 0
                ? 'Attach a chat to this work first — a story is built from a roleplay.'
                : 'Choose which chat this work is the story of to get started.'}
            </p>
          </div>
          {canManage && project.chats.length > 0 && (
            <Button variant="primary" onClick={() => setPickerMode('designate')}>
              Choose source chat
            </Button>
          )}
        </div>
        {pickerMode !== null && (
          <SourceChatPickerModal
            chats={project.chats}
            current={null}
            onPick={onPick}
            onClose={() => setPickerMode(null)}
            busy={isSaving}
          />
        )}
        {archivesSection}
        {restoreConfirmDialog}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Source chat */}
      <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-2">
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          Source chat
        </h3>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[var(--color-text-primary)] truncate">
              {sourceChat ? describeRef(sourceChat) : 'None'}
            </p>
            {sourceState === 'dangling' && (
              <p className="flex items-center gap-1 text-xs text-[var(--color-warning)] mt-0.5">
                <Link2Off size={12} />
                That chat is no longer attached to this work
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Dangling only: a live ref has nothing to relink, and drift
                isn't a state a chat ref can be in (no name snapshot to
                drift). Relink and Change are deliberately distinct: only
                Change discards. */}
            {canManage && sourceState === 'dangling' && (
              <Button
                variant="secondary"
                onClick={() => setPickerMode('relink')}
                disabled={isSaving || canonLocked}
              >
                Relink
              </Button>
            )}
            {canManage && project.chats.length > 0 && (
              <Button
                variant="secondary"
                onClick={() => setPickerMode('designate')}
              >
                Change
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Which attached chats the story actually covers */}
      {project.chats.length > 1 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
            Chats in this work
          </h3>
          <ul className="space-y-1">
            {project.chats.map((chat) => {
              const isSource =
                sourceChat !== null && sameChat(sourceChat.ref, chat);
              return (
                <li
                  key={`${chat.character_avatar}:${chat.file_name}`}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)]"
                >
                  <span className="text-sm text-[var(--color-text-primary)] truncate">
                    {chat.file_name}
                  </span>
                  <span
                    className={`text-xs shrink-0 ${
                      isSource
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {isSource ? 'Source' : 'Not in bible'}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            A story is built from one chat. The others stay attached to the
            work but aren't part of it.
          </p>
        </section>
      )}

      {/* Upstream drift (phase 11). Inline and persistent, not a toast:
          toasts auto-dismiss and this is a state, not an event. */}
      {!driftDismissed && banner.kind !== 'none' && (
        <>
          {banner.kind === 'new_messages' && (
            <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm text-[var(--color-text-primary)]">
                    {newMessageCount} new{' '}
                    {newMessageCount === 1 ? 'message' : 'messages'} since this
                    story was built
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    {canonLocked
                      ? 'Canon is locked — unlock to bring them in.'
                      : banner.canUpdate
                        ? 'Reads only what’s new, so it costs a fraction of a rebuild.'
                        : 'The build state for this story was cleared, so picking these up needs a full rebuild.'}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {banner.canUpdate && (
                    <Button
                      variant="primary"
                      onClick={() => void updateStory()}
                      disabled={preparing || !coldStartSources}
                    >
                      <Sparkles size={16} />
                      {preparing ? 'Starting…' : 'Update story'}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => setDriftDismissed(true)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </section>
          )}

          {banner.kind === 'diverged' && (
            <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-2 border border-[var(--color-warning)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-1.5 text-sm text-[var(--color-text-primary)]">
                    <CircleAlert size={14} className="text-[var(--color-warning)]" />
                    This chat’s history changed
                  </h3>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    {canonLocked
                      ? 'Some scenes may no longer match their source. Unlock canon to re-ingest.'
                      : banner.staleSceneCount > 0
                        ? `Some scenes may no longer match their source — ${banner.staleSceneCount} of them look affected.`
                        : 'Some scenes may no longer match their source.'}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Both actions are suppressed while locked, and that has
                      to happen HERE: resetBible and designateSourceChat are
                      ungated, so neither will refuse on our behalf — and
                      re-ingest wipes `meta`, which would take the lock with
                      it. */}
                  {banner.canFlag && (
                    <Button
                      variant="secondary"
                      onClick={() => void flagStaleScenes()}
                      disabled={flagging}
                    >
                      {flagging ? 'Marking…' : 'Mark affected scenes'}
                    </Button>
                  )}
                  {banner.canReingest && (
                    <Button
                      variant="secondary"
                      onClick={() => setPendingReingest(true)}
                      disabled={isSaving || preparing}
                    >
                      Re-ingest
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => setDriftDismissed(true)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
              {banner.incompleteCheck && (
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Some parts of this chat couldn’t be re-checked, so the list
                  of affected scenes may be incomplete.
                </p>
              )}
            </section>
          )}
        </>
      )}

      <IngestProgressCard />

      {/* Build the groundwork */}
      {canManage && !ingestRunning && (
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm text-[var(--color-text-primary)]">
                {(manifest?.scene_count ?? 0) > 0 || checkpoint?.status === 'complete'
                  ? 'Rebuild the groundwork'
                  : 'Build the groundwork'}
              </h3>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                Reads the character, your persona and any lorebooks. Runs
                on your API key.
              </p>
            </div>
            <Button
              variant="primary"
              onClick={() => setStartOpen(true)}
              disabled={preparing || !coldStartSources || canonLocked}
            >
              <Sparkles size={16} />
              {preparing ? 'Starting…' : 'Build'}
            </Button>
          </div>
          {canonLocked && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Canon is locked — unlock to rebuild.
            </p>
          )}
          {checkpoint?.replay_approx && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Lorebook usage was reconstructed from the chat rather than
              measured, so treat it as approximate.
            </p>
          )}
          {(checkpoint?.status === 'running' ||
            checkpoint?.status === 'error' ||
            checkpoint?.status === 'paused') && (
            <button
              type="button"
              onClick={() => void resetIngestState()}
              className="text-xs text-[var(--color-text-secondary)] underline"
            >
              Build state looks stuck? Clear it
            </button>
          )}
        </section>
      )}

      {/* TEMPORARY (step 3 phase 2) — Phase 5's Render tab replaces this
          whole section, where "annotate first" becomes the default state
          of the tab rather than a button of its own. */}
      {canManage && !ingestRunning && (manifest?.scene_count ?? 0) > 0 && (
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm text-[var(--color-text-primary)]">
                Annotate the scenes
              </h3>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                Records each scene’s beat, tension and how tightly to tell
                it. Runs on your API key; scenes already annotated are
                skipped.
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => setAnnotateOpen(true)}
              disabled={preparing || annotateBlocked}
            >
              <Sparkles size={16} />
              {preparing ? 'Starting…' : 'Annotate'}
            </Button>
          </div>
          {annotateBlocked && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Finish or clear the story build first — annotating now would
              lose its progress.
            </p>
          )}
        </section>
      )}

      {/* The annotate pass's output. Read-only, and shown to viewers too —
          reads take `project:view` (plan §4, Permissions). */}
      {(manifest?.scene_count ?? 0) > 0 && <BeatMapCard />}

      {/* What the bible holds so far */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
          Contents
        </h3>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          {(
            [
              ['Scenes', manifest?.scene_count ?? 0, false],
              ['Facts', manifest?.fact_count ?? 0, false],
              ['Edits', manifest?.edit_count ?? 0, false],
              [
                'Contradictions',
                unresolvedContradictions,
                unresolvedContradictions > 0,
              ],
            ] as [string, number, boolean][]
          ).map(([label, count, warn]) => (
            <div
              key={label}
              className={`rounded-lg py-2 ${
                warn ? 'bg-[var(--color-warning)]/15' : 'bg-[var(--color-bg-secondary)]'
              }`}
            >
              <dt
                className={`text-xs ${
                  warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'
                }`}
              >
                {label}
              </dt>
              <dd
                className={`text-lg ${
                  warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-primary)]'
                }`}
              >
                {count}
              </dd>
            </div>
          ))}
        </dl>
        {hasUnreadableChecksNote(checkpoint?.error) && (
          <p className="text-xs text-[var(--color-warning)] mt-2">
            Some contradiction checks couldn't be read, so this count may be
            incomplete.
          </p>
        )}
        <p className="text-xs text-[var(--color-text-secondary)] mt-2">
          Building the story from your chat comes next — this work is ready
          for it.
        </p>
      </section>

      {/* Scenes — with editable titles and merge-with-previous (§6, §5.3). */}
      {scenes.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
            Scenes
          </h3>
          <ul className="space-y-1">
            {scenes.map((scene, i) => (
              <SceneReviewRow
                key={scene.id}
                scene={scene}
                // The list pages forward from sequence 0, so the loaded
                // list's head IS the bible's head — the first scene has
                // nothing to merge into either way.
                isFirst={i === 0}
                canManage={canManage}
                disabled={writesDisabled}
                canonLocked={canonLocked}
                stale={staleSceneSet.has(scene.id)}
                onClearStale={() => void dismissSceneStale(scene.id)}
              />
            ))}
          </ul>
          {scenesHasMore && (
            <Button
              variant="secondary"
              onClick={() => void loadMoreScenes()}
              className="mt-2"
            >
              Load more
            </Button>
          )}
        </section>
      )}

      {/* Established facts — the review-mode accordion (§6.3). */}
      <FactReviewList
        facts={facts}
        scenes={scenes}
        hasMore={factsHasMore}
        onLoadMore={() => void loadMoreFacts()}
        canManage={canManage}
        disabled={writesDisabled}
      />

      {/* Voice profile meter with the paste fallback (§6.4). Rendered
          only when the section exists; the store's own manifest gate
          keeps its writes safe against a bible that hasn't been built. */}
      {userVoice && (
        <VoiceConfidenceCard
          voice={userVoice}
          canManage={canManage}
          disabled={writesDisabled}
        />
      )}

      {/* Contradictions — the review checkpoint (§6.1). */}
      {contradictions.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
              Contradictions
            </h3>
            {unresolvedContradictions > 0 && (
              <span className="text-xs text-[var(--color-warning)]">
                {unresolvedContradictions} unresolved
              </span>
            )}
          </div>
          <div className="space-y-2">
            {contradictions.map((c) => (
              <ContradictionCard
                key={c.id}
                contradiction={c}
                loadChatMessages={loadChatMessages}
                onWriteOwn={(text, rationale) =>
                  writeOwnFact(c, text, rationale)
                }
                canManage={canManage}
                disabled={resolutionsDisabled}
                deleteDisabled={buildActive}
              />
            ))}
          </div>
        </section>
      )}

      {/* Lock canon footer (§6.6). Rendered wherever a bible with ≥1
          section beyond meta exists — its own manifest gate handles the
          rest so the footer never appears on an untouched Work. */}
      <LockCanonFooter
        contradictions={contradictions}
        sections={sections}
        liveRefs={liveRefs}
        canManage={canManage}
        disabled={buildActive}
      />

      {canManage && (
        <section className="pt-2 border-t border-[var(--color-border)]">
          <Button
            variant="danger"
            onClick={() => setConfirmReset(true)}
            disabled={isSaving}
          >
            <RotateCcw size={16} />
            Reset story
          </Button>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            Deletes everything built from this chat. The chat itself is
            untouched, and a snapshot is kept below — this can be undone.
          </p>
        </section>
      )}

      {archivesSection}

      {startOpen && coldStartSources && (
        <StartIngestModal
          estimatedTokens={estimateColdStartTokens(coldStartSources)}
          onStart={(profileId) => void startIngest(profileId)}
          onClose={() => setStartOpen(false)}
          busy={preparing}
        />
      )}

      {/* TEMPORARY (step 3 phase 2) — see the section above. */}
      {annotateOpen && (
        <StartIngestModal
          mode="annotate"
          estimatedTokens={estimateAnnotateTokens(manifest?.scene_count ?? 0)}
          onStart={(profileId) => void startAnnotate(profileId)}
          onClose={() => setAnnotateOpen(false)}
          busy={preparing}
        />
      )}

      {pickerMode !== null && (
        <SourceChatPickerModal
          chats={project.chats}
          current={sourceChat?.ref ?? null}
          onPick={onPick}
          onClose={() => setPickerMode(null)}
          busy={isSaving}
        />
      )}

      <ConfirmDialog
        isOpen={pendingChange !== null}
        title="Change the source chat?"
        message="The story so far was built from the current chat, so changing it deletes every scene, fact and note first. The chats themselves are untouched."
        confirmLabel="Change and start over"
        danger
        busy={isSaving}
        onConfirm={() => void confirmChange()}
        onClose={() => setPendingChange(null)}
      />

      <ConfirmDialog
        isOpen={confirmReset}
        title="Reset this story?"
        message="Every scene, fact and note built from this chat is deleted, and the story has to be built again from scratch. A snapshot is kept, so this can be undone from the snapshots list below."
        confirmLabel="Reset story"
        danger
        busy={isSaving}
        onConfirm={() => {
          setConfirmReset(false);
          void resetBible();
        }}
        onClose={() => setConfirmReset(false)}
      />

      <ConfirmDialog
        isOpen={pendingLongWalk !== null}
        title={pendingLongWalk?.incremental ? 'That’s a lot of new messages' : 'This chat is long'}
        message={
          pendingLongWalk?.incremental
            ? `Reading the new messages will take about ${pendingLongWalk?.chunkCount ?? 0} passes over the model and will spend more of your key than usual. Continue?`
            : `Reading the whole chat will take about ${pendingLongWalk?.chunkCount ?? 0} passes over the model and will spend more of your key than usual. Continue?`
        }
        confirmLabel="Build anyway"
        onConfirm={() => void confirmLongWalkAndRun()}
        onClose={() => setPendingLongWalk(null)}
      />

      <ConfirmDialog
        isOpen={pendingReingest}
        title="Re-ingest from scratch?"
        message="Every scene, fact and note built from this chat is deleted and rebuilt by reading the whole chat again, which spends your key. A snapshot is kept first, so this can be undone from the snapshots list below."
        confirmLabel="Re-ingest"
        danger
        busy={isSaving}
        onConfirm={() => void reingestFromScratch()}
        onClose={() => setPendingReingest(false)}
      />

      {restoreConfirmDialog}
    </div>
  );
}
