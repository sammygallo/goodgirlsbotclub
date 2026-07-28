import { useEffect, useMemo, useState } from 'react';
import { BookOpen, CircleAlert, Link2Off, RotateCcw } from 'lucide-react';
import { useStoryStore, hasBible } from '../../stores/storyStore';
import { useCharacterStore } from '../../stores/characterStore';
import { Button, ConfirmDialog, Modal } from '../ui';
import type { Project, ProjectChatRef } from '../../api/client';
import type { MetaSection } from '../../types/storyBible';
import { describeRef, resolveRefState } from '../../utils/storyBible/sourceRefs';

/**
 * Story tab of the Works panel — productization step 2, phase 5.
 *
 * What ships here is read plumbing plus the one decision the bible can't
 * be built without: which chat it is the story OF. Ingestion (phases
 * 6–8) fills everything else; until then this tab shows what exists and
 * lets the user designate (or re-designate) the source chat.
 */

function sameChat(a: ProjectChatRef, b: ProjectChatRef): boolean {
  return a.character_avatar === b.character_avatar && a.file_name === b.file_name;
}

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
    isLoading,
    isSaving,
    error,
    load,
    clear,
    loadMoreFacts,
    loadMoreScenes,
    designateSourceChat,
    resetBible,
  } = useStoryStore();
  const characters = useCharacterStore((s) => s.characters);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  /** A chat chosen in the picker that would REPLACE an existing source,
   *  held until the user confirms the discard it implies. */
  const [pendingChange, setPendingChange] = useState<ProjectChatRef | null>(null);

  useEffect(() => {
    void load(project.id);
    return () => clear();
  }, [project.id, load, clear]);

  const meta = sections.meta?.data as unknown as MetaSection | undefined;
  const sourceChat = meta?.source?.chat ?? null;

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
    // whereas new meta over old scenes is silently wrong.
    if (await resetBible()) await designate(chat);
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

      {/* What the bible holds so far */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
          Contents
        </h3>
        <dl className="grid grid-cols-3 gap-2 text-center">
          {[
            ['Scenes', manifest?.scene_count ?? 0],
            ['Facts', manifest?.fact_count ?? 0],
            ['Edits', manifest?.edit_count ?? 0],
          ].map(([label, count]) => (
            <div
              key={label as string}
              className="rounded-lg bg-[var(--color-bg-secondary)] py-2"
            >
              <dt className="text-xs text-[var(--color-text-secondary)]">
                {label}
              </dt>
              <dd className="text-lg text-[var(--color-text-primary)]">{count}</dd>
            </div>
          ))}
        </dl>
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

      {canManage && (
        <section className="pt-2 border-t border-[var(--color-border)]">
          <Button variant="danger" onClick={() => setConfirmReset(true)}>
            <RotateCcw size={16} />
            Reset story
          </Button>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            Deletes everything built from this chat. The chat itself is
            untouched.
          </p>
        </section>
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
        onConfirm={() => void confirmChange()}
        onClose={() => setPendingChange(null)}
      />

      <ConfirmDialog
        isOpen={confirmReset}
        title="Reset this story?"
        message="Every scene, fact and note built from this chat is deleted. This can't be undone, and the story has to be built again from scratch."
        confirmLabel="Reset story"
        danger
        onConfirm={() => {
          setConfirmReset(false);
          void resetBible();
        }}
        onClose={() => setConfirmReset(false)}
      />
    </div>
  );
}
