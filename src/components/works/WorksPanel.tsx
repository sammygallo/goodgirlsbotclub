import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Library,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { hasPermission } from '../../utils/permissions';
import { Button, ConfirmDialog, Input, TextArea } from '../ui';
import type { ProjectDeliverableType } from '../../api/client';

const DELIVERABLE_LABELS: Record<ProjectDeliverableType, string> = {
  freeform: 'Freeform',
  novel: 'Novel',
  comic: 'Comic / Manga',
  video_series: 'Video Series',
};

/**
 * Works panel — productization step 1.
 *
 * Slide-in panel (same mount/animation pattern as GuidesPanel) with a
 * list view (create + browse works) and a detail view (edit metadata,
 * link characters and chats). A Work is the project container that
 * later steps grow into story-state + production pipelines.
 */
export function WorksPanel() {
  const {
    isOpen,
    openProjectId,
    items,
    selected,
    isLoading,
    error,
    closePanel,
    backToList,
    openProject,
    createProject,
    updateSelected,
    deleteSelected,
    attachCharacter,
    detachCharacter,
    attachChat,
    detachChat,
    openChatRef,
  } = useProjectStore();
  const currentUser = useAuthStore((s) => s.currentUser);
  const canManage = hasPermission(currentUser, 'project:manage');

  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!mounted) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mounted, closePanel]);

  if (!mounted) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={closePanel}
      />

      {/* Panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[90vw] sm:max-w-2xl
          bg-[var(--color-bg-primary)] border-l border-[var(--color-border)] shadow-2xl
          flex flex-col overflow-hidden
          transform transition-transform duration-300 ease-in-out
          ${visible ? 'translate-x-0' : 'translate-x-full'}
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--color-border)] flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {openProjectId && (
              <button
                onClick={backToList}
                className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
                aria-label="Back to all works"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <Library size={18} className="text-[var(--color-primary)] shrink-0" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
              {openProjectId ? selected?.name ?? 'Work' : 'Works'}
            </h2>
          </div>
          <button
            onClick={closePanel}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
            aria-label="Close works"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-xl mx-auto">
            {error && (
              <p className="text-sm text-red-400 mb-4" role="alert">
                {error}
              </p>
            )}
            {openProjectId ? (
              selected ? (
                <WorkDetail
                  // Remount when the server state advances so the local
                  // name/description drafts re-seed from the fresh row.
                  key={`${selected.id}:${selected.server_ts}`}
                  canManage={canManage}
                  updateSelected={updateSelected}
                  deleteSelected={deleteSelected}
                  attachCharacter={attachCharacter}
                  detachCharacter={detachCharacter}
                  attachChat={attachChat}
                  detachChat={detachChat}
                  openChatRef={openChatRef}
                />
              ) : (
                <p className="text-sm text-[var(--color-text-secondary)]">Loading…</p>
              )
            ) : (
              <WorksList
                items={items}
                isLoading={isLoading}
                canManage={canManage}
                createProject={createProject}
                openProject={openProject}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function WorksList({
  items,
  isLoading,
  canManage,
  createProject,
  openProject,
}: {
  items: ReturnType<typeof useProjectStore.getState>['items'];
  isLoading: boolean;
  canManage: boolean;
  createProject: (
    name: string,
    type: ProjectDeliverableType,
    description?: string
  ) => Promise<unknown>;
  openProject: (id: string) => Promise<void>;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<ProjectDeliverableType>('freeform');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    const created = await createProject(name.trim(), type);
    setCreating(false);
    if (created) {
      setName('');
      setType('freeform');
      setShowCreate(false);
    }
  };

  return (
    <>
      <header className="mb-4 flex items-start justify-between gap-3">
        <p className="text-sm text-[var(--color-text-secondary)]">
          A work collects chats and characters into one ongoing story — the
          home base it grows from.
        </p>
        {canManage && !showCreate && (
          <Button variant="secondary" onClick={() => setShowCreate(true)}>
            <Plus size={16} className="mr-1" />
            New
          </Button>
        )}
      </header>

      {canManage && showCreate && (
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 mb-4">
          <div className="space-y-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name your work…"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ProjectDeliverableType)}
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)]"
            >
              {Object.entries(DELIVERABLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleCreate} disabled={!name.trim() || creating}>
                Create
              </Button>
            </div>
          </div>
        </section>
      )}

      {isLoading && items.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--color-text-secondary)]">
          No works yet{canManage ? ' — create your first one above.' : '.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => void openProject(item.id)}
                className={`w-full text-left rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-primary)]/60 transition-colors p-4 ${
                  item.status === 'archived' ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
                    {item.name}
                  </p>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-primary)]/15 text-[var(--color-primary)] shrink-0">
                    {DELIVERABLE_LABELS[item.deliverable_type]}
                  </span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  {item.chat_count} chat{item.chat_count === 1 ? '' : 's'} ·{' '}
                  {item.character_count} character{item.character_count === 1 ? '' : 's'}
                  {item.status === 'archived' ? ' · archived' : ''}
                </p>
                {item.description && (
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                    {item.description}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function WorkDetail({
  canManage,
  updateSelected,
  deleteSelected,
  attachCharacter,
  detachCharacter,
  attachChat,
  detachChat,
  openChatRef,
}: {
  canManage: boolean;
  updateSelected: ReturnType<typeof useProjectStore.getState>['updateSelected'];
  deleteSelected: () => Promise<boolean>;
  attachCharacter: (avatar: string) => Promise<boolean>;
  detachCharacter: (avatar: string) => Promise<boolean>;
  attachChat: ReturnType<typeof useProjectStore.getState>['attachChat'];
  detachChat: ReturnType<typeof useProjectStore.getState>['detachChat'];
  openChatRef: ReturnType<typeof useProjectStore.getState>['openChatRef'];
}) {
  const selected = useProjectStore((s) => s.selected);
  const { characters, selectedCharacter, isGroupChatMode } = useCharacterStore();
  const { currentChatFile } = useChatStore();

  const [name, setName] = useState(selected?.name ?? '');
  const [description, setDescription] = useState(selected?.description ?? '');
  const [addAvatar, setAddAvatar] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const characterName = useMemo(() => {
    const byAvatar = new Map(characters.map((c) => [c.avatar, c.name]));
    return (avatar: string) => byAvatar.get(avatar) ?? avatar;
  }, [characters]);

  if (!selected) return null;

  const metaDirty =
    name.trim() !== selected.name || description !== selected.description;
  const attachableCharacters = characters.filter(
    (c) => !selected.characters.includes(c.avatar)
  );
  const currentChatRef =
    !isGroupChatMode && selectedCharacter && currentChatFile
      ? { character_avatar: selectedCharacter.avatar, file_name: currentChatFile }
      : null;
  const currentChatAttached =
    currentChatRef !== null &&
    selected.chats.some(
      (c) =>
        c.character_avatar === currentChatRef.character_avatar &&
        c.file_name === currentChatRef.file_name
    );

  return (
    <div className="space-y-6">
      {/* Metadata */}
      <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Work name"
          disabled={!canManage}
        />
        <TextArea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this work about?"
          rows={2}
          disabled={!canManage}
        />
        <div className="flex items-center gap-2">
          <select
            value={selected.deliverable_type}
            disabled={!canManage}
            onChange={(e) =>
              void updateSelected(() => ({
                deliverable_type: e.target.value as ProjectDeliverableType,
              }))
            }
            className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)]"
          >
            {Object.entries(DELIVERABLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {canManage && metaDirty && (
            <Button
              variant="primary"
              onClick={() =>
                void updateSelected(() => ({ name: name.trim() || selected.name, description }))
              }
            >
              Save
            </Button>
          )}
        </div>
      </section>

      {/* Characters */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
          Characters ({selected.characters.length})
        </h3>
        {selected.characters.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)] mb-2">
            No characters in this work yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2 mb-2">
            {selected.characters.map((avatar) => (
              <li
                key={avatar}
                className="flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)]"
              >
                {characterName(avatar)}
                {canManage && (
                  <button
                    onClick={() => void detachCharacter(avatar)}
                    className="p-0.5 rounded-full text-[var(--color-text-secondary)] hover:text-red-400"
                    aria-label={`Remove ${characterName(avatar)}`}
                  >
                    <X size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && attachableCharacters.length > 0 && (
          <div className="flex gap-2">
            <select
              value={addAvatar}
              onChange={(e) => setAddAvatar(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text-primary)]"
            >
              <option value="">Add a character…</option>
              {attachableCharacters.map((c) => (
                <option key={c.avatar} value={c.avatar}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              disabled={!addAvatar}
              onClick={async () => {
                if (await attachCharacter(addAvatar)) setAddAvatar('');
              }}
            >
              <Plus size={16} />
            </Button>
          </div>
        )}
      </section>

      {/* Chats */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
          Chats ({selected.chats.length})
        </h3>
        {selected.chats.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)] mb-2">
            No chats in this work yet.
          </p>
        ) : (
          <ul className="space-y-1.5 mb-2">
            {selected.chats.map((ref) => (
              <li
                key={`${ref.character_avatar}/${ref.file_name}`}
                className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] px-3 py-2"
              >
                <MessageSquare
                  size={16}
                  className="text-[var(--color-primary)] shrink-0"
                />
                <button
                  onClick={() => void openChatRef(ref)}
                  className="flex-1 min-w-0 text-left"
                  title="Open this chat"
                >
                  <p className="text-sm text-[var(--color-text-primary)] truncate">
                    {ref.file_name}
                  </p>
                  <p className="text-xs text-[var(--color-text-secondary)] truncate">
                    {characterName(ref.character_avatar)}
                  </p>
                </button>
                {canManage && (
                  <button
                    onClick={() => void detachChat(ref)}
                    className="p-1 rounded text-[var(--color-text-secondary)] hover:text-red-400"
                    aria-label="Remove chat from work"
                  >
                    <X size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && currentChatRef && !currentChatAttached && (
          <Button variant="secondary" onClick={() => void attachChat(currentChatRef)}>
            <Plus size={16} className="mr-1" />
            Add current chat
          </Button>
        )}
      </section>

      {/* Danger zone */}
      {canManage && (
        <section className="flex gap-2 pt-2 border-t border-[var(--color-border)]">
          <Button
            variant="secondary"
            onClick={() =>
              void updateSelected((p) => ({
                status: p.status === 'archived' ? 'active' : 'archived',
              }))
            }
          >
            {selected.status === 'archived' ? (
              <>
                <ArchiveRestore size={16} className="mr-1" />
                Unarchive
              </>
            ) : (
              <>
                <Archive size={16} className="mr-1" />
                Archive
              </>
            )}
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} className="mr-1" />
            Delete
          </Button>
        </section>
      )}

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void deleteSelected();
        }}
        title="Delete this work?"
        message="The work and its links are removed. The chats and characters themselves are not touched."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}
