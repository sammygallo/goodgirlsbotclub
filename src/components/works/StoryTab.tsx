import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  CircleAlert,
  History,
  Link2Off,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useStoryStore, hasBible } from '../../stores/storyStore';
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
import {
  gatherColdStartSources,
  gatherIngestInputs,
  replayEntriesFrom,
} from './ingestSources';
import { makeLlmCall } from '../../utils/storyIngest/llmBridge';
import { planTranscriptChunks } from '../../utils/storyIngest/transcriptChunker';
import { Button, ConfirmDialog, Modal } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import type { Project, ProjectChatRef, StoryArchiveReason } from '../../api/client';
import type { Contradiction, MetaSection } from '../../types/storyBible';
import type { IngestMessage } from '../../utils/storyIngest/types';
import { describeRef, resolveRefState } from '../../utils/storyBible/sourceRefs';

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

/** `character_attribute` -> "character attribute" — the enum values are
 *  the only vocabulary the judge speaks; Phase 10's card can afford nicer
 *  copy, this read-only list doesn't need to invent any. */
function humanizeContradictionType(type: string): string {
  return type.replace(/_/g, ' ');
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
  } = useStoryStore();
  const characters = useCharacterStore((s) => s.characters);
  const personas = usePersonaStore((s) => s.personas);
  const wiScanDepth = useWorldInfoStore((s) => s.scanDepth);
  const runIngest = useStoryIngestStore((s) => s.run);
  const ingestRunning = useStoryIngestStore((s) => s.isRunning);
  const loadCheckpoint = useStoryIngestStore((s) => s.loadCheckpoint);
  const clearIngest = useStoryIngestStore((s) => s.clear);
  const resetIngestState = useStoryIngestStore((s) => s.resetIngestState);
  const checkpoint = useStoryIngestStore((s) => s.checkpoint);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  /** A chat chosen in the picker that would REPLACE an existing source,
   *  held until the user confirms the discard it implies. */
  const [pendingChange, setPendingChange] = useState<ProjectChatRef | null>(null);
  const [startOpen, setStartOpen] = useState(false);
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
  } | null>(null);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);

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

  const contradictions = useMemo(
    () => readContradictions(sections.continuity?.data),
    [sections.continuity]
  );
  const unresolvedContradictions = contradictions.filter(
    (c) => c.resolution.status === 'unresolved'
  ).length;

  const characterNameByAvatar = useMemo(
    () => new Map(characters.map((c) => [c.avatar, c.name])),
    [characters]
  );

  const sourceState = useMemo(() => {
    if (!sourceChat) return null;
    return resolveRefState(sourceChat, {
      chats: project.chats,
      characterAvatars: characters.map((c) => c.avatar),
      characterNameByAvatar,
    });
  }, [sourceChat, project.chats, characters, characterNameByAvatar]);

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
    if (ok) setPickerOpen(false);
    return ok;
  };

  const onPick = async (chat: ProjectChatRef) => {
    // Repointing an existing bible at a different chat orphans every
    // scene and fact — their message refs address the OLD chat, and a
    // scene carries no chat ref of its own to notice. So changing the
    // source discards the bible first (plan Decision 4), behind an
    // explicit confirm.
    if (sourceChat && !sameChat(sourceChat.ref, chat)) {
      setPickerOpen(false);
      setPendingChange(chat);
      return;
    }
    await designate(chat);
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
    confirmLongWalk: boolean
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
      llm: makeLlmCall({
        provider,
        model,
        customUrl,
        characterName: coldStartSources.characterName,
      }),
      model,
    });
    await load(project.id);
  };

  const startIngest = async (profileId: string | null) => {
    if (!sourceChat || !coldStartSources) return;
    setPreparing(true);
    try {
      const { messages, capturedWiFired } = await gatherIngestInputs(
        sourceChat.ref
      );
      setStartOpen(false);

      // A very long chat spends more of the user's key than usual —
      // confirm before any model call, not mid-build (plan: "no silent
      // caps"). Cheap to check: chunk planning is pure and instant.
      const plan = planTranscriptChunks(messages);
      if (plan.exceedsSoftCap) {
        setPendingLongWalk({
          profileId,
          messages,
          capturedWiFired,
          chunkCount: plan.chunks.length,
        });
        return;
      }

      await buildAndRun(profileId, messages, capturedWiFired, false);
    } catch (err) {
      showIngestError(err);
    } finally {
      setPreparing(false);
    }
  };

  const confirmLongWalkAndRun = async () => {
    if (!pendingLongWalk) return;
    const { profileId, messages, capturedWiFired } = pendingLongWalk;
    setPendingLongWalk(null);
    setPreparing(true);
    try {
      await buildAndRun(profileId, messages, capturedWiFired, true);
    } catch (err) {
      showIngestError(err);
    } finally {
      setPreparing(false);
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
              reset or a source-chat change.
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
            <Button variant="primary" onClick={() => setPickerOpen(true)}>
              Choose source chat
            </Button>
          )}
        </div>
        {pickerOpen && (
          <SourceChatPickerModal
            chats={project.chats}
            current={null}
            onPick={onPick}
            onClose={() => setPickerOpen(false)}
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
          {canManage && project.chats.length > 0 && (
            <Button variant="secondary" onClick={() => setPickerOpen(true)}>
              Change
            </Button>
          )}
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
              disabled={preparing || !coldStartSources}
            >
              <Sparkles size={16} />
              {preparing ? 'Starting…' : 'Build'}
            </Button>
          </div>
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

      {/* Scenes (read-only) */}
      {scenes.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
            Scenes
          </h3>
          <ul className="space-y-1">
            {scenes.map((scene) => (
              <li
                key={scene.id}
                className="px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)]"
              >
                <p className="text-sm text-[var(--color-text-primary)]">
                  {scene.title || `Scene ${scene.sequence + 1}`}
                </p>
                {scene.summary && (
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    {scene.summary}
                  </p>
                )}
              </li>
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

      {/* Fact log (read-only, paginated) */}
      {facts.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
            Established facts
          </h3>
          <ul className="space-y-1">
            {facts.map((entry) => (
              <li
                key={entry.id}
                className="px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-primary)]"
              >
                {String(entry.data.text ?? '')}
                <span className="ml-2 text-xs text-[var(--color-text-secondary)]">
                  {String(entry.data.confidence ?? '')}
                </span>
              </li>
            ))}
          </ul>
          {factsHasMore && (
            <Button
              variant="secondary"
              onClick={() => void loadMoreFacts()}
              className="mt-2"
            >
              Load more
            </Button>
          )}
        </section>
      )}

      {/* Contradictions (read-only) — resolving them is Phase 10's
          review UX; this is only the flag, no evidence or fact lookups. */}
      {contradictions.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
            Contradictions
          </h3>
          <ul className="space-y-1">
            {contradictions.slice(0, 20).map((c) => (
              <li
                key={c.id}
                className="px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-primary)]"
              >
                <span className="mr-2 text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                  {humanizeContradictionType(c.type)}
                </span>
                {c.description}
              </li>
            ))}
          </ul>
          {contradictions.length > 20 && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              and {contradictions.length - 20} more
            </p>
          )}
        </section>
      )}

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

      {pickerOpen && (
        <SourceChatPickerModal
          chats={project.chats}
          current={sourceChat?.ref ?? null}
          onPick={onPick}
          onClose={() => setPickerOpen(false)}
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
        title="This chat is long"
        message={`Reading the whole chat will take about ${pendingLongWalk?.chunkCount ?? 0} passes over the model and will spend more of your key than usual. Continue?`}
        confirmLabel="Build anyway"
        onConfirm={() => void confirmLongWalkAndRun()}
        onClose={() => setPendingLongWalk(null)}
      />

      {restoreConfirmDialog}
    </div>
  );
}
