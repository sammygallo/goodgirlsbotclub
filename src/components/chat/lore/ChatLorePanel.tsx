import { useMemo, useState } from 'react';
import { Modal, Button, Input, ConfirmDialog } from '../../ui';
import { showToastGlobal } from '../../ui/Toast';
import {
  useWorldInfoStore,
  type WorldInfoEntry,
} from '../../../stores/worldInfoStore';
import { useCharacterStore } from '../../../stores/characterStore';
import { usePersonaStore } from '../../../stores/personaStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useChatLoreConfigStore } from '../../../stores/chatLoreConfigStore';
import { profileForProvider } from '../../../utils/tokenizer';
import { resolveEffectiveBooks, type ChatLoreConfig } from '../../../utils/worldInfoComposition';
import { buildChatLoreView, type LoreEntryRowVM } from '../../../utils/chatLoreView';
import { WorldInfoEntryForm } from '../../worldinfo/WorldInfoEntryForm';
import { EntryHistory } from '../../worldinfo/EntryHistory';
import { LoreBookSection } from './LoreBookSection';
import { ForkEntryEditor } from './ForkEntryEditor';
import { AttachBookPicker } from './AttachBookPicker';
import type { LoreRowAction } from './LoreEntryRow';

export interface ChatLorePanelProps {
  isOpen: boolean;
  onClose: () => void;
  chatFile: string;
  characterAvatars: string[];
}

// Stable fallback so zustand selectors never return a fresh array/object
// reference (fresh refs per call destabilize useSyncExternalStore — React #185).
const EMPTY_IDS: string[] = [];

type PanelView =
  | { kind: 'list' }
  | { kind: 'fork'; bookId: string; entryId: string }
  | { kind: 'viewBase'; bookId: string; entryId: string }
  | { kind: 'createLocal' }
  | { kind: 'editLocal'; entryId: string }
  | { kind: 'attach' }
  | { kind: 'saveAsBook' };

/** Read-only view of a real library entry, plus its history. Subscribes
 *  directly rather than trusting a copy from the row, so a concurrent edit
 *  to the base entry elsewhere is reflected immediately. */
function BaseEntryViewer({
  bookId,
  entryId,
  onClose,
}: {
  bookId: string;
  entryId: string;
  onClose: () => void;
}) {
  // bookId can point at a shared book (e.g. resolving a 'viewBase' row for
  // an entry inherited via a group member's shared book), so this must look
  // across the composable universe, not just the viewer's own books.
  // updateEntry below is self-limiting to the viewer's own books either way
  // (it maps over get().books, a no-op for a foreign book id), so restoring
  // a revision on a shared entry the viewer doesn't own silently does nothing.
  const entry = useWorldInfoStore((s) =>
    s.getComposableBooks().find((b) => b.id === bookId)?.entries.find((e) => e.id === entryId)
  );
  const updateEntry = useWorldInfoStore((s) => s.updateEntry);

  if (!entry) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          This entry no longer exists in its source lorebook.
        </p>
        <Button variant="secondary" onClick={onClose} className="w-full">
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        {entry.comment && (
          <p className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
            {entry.comment}
          </p>
        )}
        <p className="text-xs text-[var(--color-text-secondary)] mb-2">
          {entry.constant ? (
            <em>No keywords (always active)</em>
          ) : entry.semanticOnly ? (
            <em>
              Semantic only — no keywords, matched by meaning server-side. Doesn't fire
              in group chats or on turns that fall back to the local keyword scan.
            </em>
          ) : entry.keys.length > 0 ? (
            entry.keys.map((k, i) => (
              <span
                key={i}
                className="inline-block mr-1 mb-0.5 px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)]"
              >
                {k}
              </span>
            ))
          ) : (
            <em className="text-red-400">Missing keywords</em>
          )}
        </p>
        <p className="text-sm text-[var(--color-text-primary)] whitespace-pre-wrap p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
          {entry.content}
        </p>
      </div>

      {entry.revisions.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-border)]">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            History
          </h3>
          <EntryHistory
            revisions={entry.revisions}
            currentContent={entry.content}
            onRestore={(rev) => updateEntry(bookId, entryId, { content: rev.prevContent })}
          />
        </div>
      )}

      <Button variant="secondary" onClick={onClose} className="w-full">
        Back
      </Button>
    </div>
  );
}

/**
 * Main per-chat lore panel — supersedes ChatLorebookModal. Shows every
 * source contributing lore to this chat (global-active, character, persona,
 * chat-attached, and chat-only), lets the author fine-tune each entry
 * per-chat (exclude, fork, add chat-only entries) without ever touching the
 * shared library, and can materialize the whole resolved set into a new
 * standalone lorebook.
 */
export function ChatLorePanel({ isOpen, onClose, chatFile, characterAvatars }: ChatLorePanelProps) {
  const [view, setView] = useState<PanelView>({ kind: 'list' });
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: 'discardFork'; bookId: string; entryId: string }
    | { kind: 'removeLocal'; entryId: string }
    | null
  >(null);
  const [saveAsBookName, setSaveAsBookName] = useState('');

  // ---- Store subscriptions --------------------------------------------
  // Composable = own books + the caller's group's shared books (own wins
  // on id collision) — widens what resolveEffectiveBooks / buildChatLoreView
  // can see without touching either, per Phase 1's purity contract.
  // getComposableBooks() returns a fresh array each call, so it can't be
  // called inside the selector itself (React #185: a fresh ref every call
  // defeats useSyncExternalStore's snapshot check and re-renders forever).
  // ChatLorePanel is mounted whenever a chat is open — not just while the
  // modal is visually open — so this selector runs continuously; select the
  // two stable underlying arrays instead and recompose with useMemo.
  const ownBooks = useWorldInfoStore((s) => s.books);
  const sharedBooksForCompose = useWorldInfoStore((s) => s.sharedBooks);
  const books = useMemo(() => {
    const ownIds = new Set(ownBooks.map((b) => b.id));
    const sharedNonColliding = sharedBooksForCompose.filter((b) => !ownIds.has(b.id));
    return [...ownBooks, ...sharedNonColliding];
  }, [ownBooks, sharedBooksForCompose]);
  const activeBookIds = useWorldInfoStore((s) => s.activeBookIds);
  const legacyLinkedBookIds = useWorldInfoStore((s) => s.chatLinkedBookIds[chatFile] ?? EMPTY_IDS);
  const tokenBudget = useWorldInfoStore((s) => s.tokenBudget);
  const setEntryExcluded = useChatLoreConfigStore((s) => s.setEntryExcluded);
  const setBookExcluded = useChatLoreConfigStore((s) => s.setBookExcluded);
  const removeOverlay = useChatLoreConfigStore((s) => s.removeOverlay);
  const addLocalEntry = useChatLoreConfigStore((s) => s.addLocalEntry);
  const updateLocalEntry = useChatLoreConfigStore((s) => s.updateLocalEntry);
  const removeLocalEntry = useChatLoreConfigStore((s) => s.removeLocalEntry);
  const resetCustomizations = useChatLoreConfigStore((s) => s.resetCustomizations);
  const persistedConfig = useChatLoreConfigStore((s) => s.configs[chatFile]);

  const characters = useCharacterStore((s) => s.characters);
  // Subscribed so the memo below recomputes when any character's book links
  // change — getActiveBookIdsForCharacter reads this map internally.
  useCharacterStore((s) => s.linkedBookIdsByAvatar);

  const personas = usePersonaStore((s) => s.personas);
  const activePersonaId = usePersonaStore((s) => s.activePersonaId);
  const personaLocks = usePersonaStore((s) => s.locks);

  const activeProvider = useSettingsStore((s) => s.activeProvider);

  // ---- Derive inherited ids + effective config, then build the VM -------
  const { vm, inheritedBookIds, effectiveConfig } = useMemo(() => {
    const cs = useCharacterStore.getState();
    const ps = usePersonaStore.getState();

    // Character books: union across every avatar in this chat (solo has one,
    // a group has every member) — mirrors chatStore.ts's own conversation
    // builders exactly (getActiveBookIdsForCharacter per member, unioned).
    const characterBookIds = Array.from(
      new Set(characterAvatars.flatMap((a) => cs.getActiveBookIdsForCharacter(a)))
    );
    const characterNames = new Map<string, string>();
    for (const avatar of characterAvatars) {
      characterNames.set(avatar, characters.find((c) => c.avatar === avatar)?.name ?? avatar);
    }
    const characterBookNames = new Map<string, string>();
    for (const avatar of characterAvatars) {
      const name = characterNames.get(avatar) ?? avatar;
      for (const id of cs.getActiveBookIdsForCharacter(avatar)) {
        if (!characterBookNames.has(id)) characterBookNames.set(id, name);
      }
    }

    // Persona: chatStore's builders resolve one persona per speaking
    // character via getPersonaForContext(avatar). A chat can have several
    // members with different locks, so union every distinct persona's
    // linked books; the section label uses the FIRST one resolved (solo
    // chats — the overwhelming majority — have exactly one anyway).
    const personaBookIdSet = new Set<string>();
    let personaName: string | null = null;
    const seenPersonaIds = new Set<string>();
    for (const avatar of characterAvatars) {
      const persona = ps.getPersonaForContext(avatar);
      if (!persona || seenPersonaIds.has(persona.id)) continue;
      seenPersonaIds.add(persona.id);
      for (const id of persona.linkedBookIds ?? []) personaBookIdSet.add(id);
      if (personaName === null) personaName = persona.name;
    }

    const inheritedBookIds = Array.from(
      new Set([...activeBookIds, ...characterBookIds, ...Array.from(personaBookIdSet)])
    );

    // Same synthesis getEffectiveConfig performs, done here so the result is
    // reactive off the subscribed primitives above (persistedConfig / the
    // legacy per-chat map) instead of a stale getState() snapshot.
    const effectiveConfig: ChatLoreConfig | undefined =
      persistedConfig ??
      (legacyLinkedBookIds.length > 0
        ? {
            chatFile,
            linkedBookIds: [...legacyLinkedBookIds],
            excludedEntryIds: {},
            overlays: {},
            localEntries: [],
            updatedAt: 0,
          }
        : undefined);

    const chatAttachedBookIds = effectiveConfig?.linkedBookIds ?? [];
    const profile = profileForProvider(activeProvider || '');

    const vm = buildChatLoreView({
      books,
      inheritedBookIds,
      effectiveConfig,
      characterAvatars,
      characterNames,
      personaName,
      personaBookIds: Array.from(personaBookIdSet),
      chatAttachedBookIds,
      profile,
      tokenBudget,
      characterBookIds,
      characterBookNames,
    });

    return { vm, inheritedBookIds, effectiveConfig };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    books,
    activeBookIds,
    legacyLinkedBookIds,
    persistedConfig,
    characters,
    personas,
    activePersonaId,
    personaLocks,
    characterAvatars,
    chatFile,
    tokenBudget,
    activeProvider,
  ]);

  const localSection = vm.sections.find((s) => s.labelKind === 'chat_local');
  const localEntries: WorldInfoEntry[] = localSection?.rows.map((r) => r.base) ?? [];
  const allShownBookIds = new Set(vm.sections.map((s) => s.book.id));

  const toggleExpanded = (bookId: string) => {
    setCollapsedIds((cur) => {
      const next = new Set(cur);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  };

  const handleBookToggle = (bookId: string, allEntryIds: string[], toggle: 'on' | 'off' | 'mixed') => {
    // Native checkbox convention: fully-on -> off; off or mixed -> on.
    const nextExcluded = toggle === 'on';
    setBookExcluded(chatFile, bookId, allEntryIds, nextExcluded);
  };

  const handleRowAction = (bookId: string, row: LoreEntryRowVM, action: LoreRowAction) => {
    switch (action) {
      case 'toggle': {
        if (row.provenance === 'local') {
          updateLocalEntry(chatFile, row.base.id, { enabled: !row.effective.enabled });
        } else {
          const nextExcluded = row.provenance !== 'excluded';
          setEntryExcluded(chatFile, bookId, row.base.id, nextExcluded);
        }
        break;
      }
      case 'fork':
        setView({ kind: 'fork', bookId, entryId: row.base.id });
        break;
      case 'discardFork':
        setPendingConfirm({ kind: 'discardFork', bookId, entryId: row.base.id });
        break;
      case 'viewBase':
        setView({ kind: 'viewBase', bookId, entryId: row.base.id });
        break;
      case 'editLocal':
        setView({ kind: 'editLocal', entryId: row.base.id });
        break;
      case 'removeLocal':
        setPendingConfirm({ kind: 'removeLocal', entryId: row.base.id });
        break;
    }
  };

  const handleSaveAsBook = () => {
    const name = saveAsBookName.trim();
    if (!name) return;
    const wi = useWorldInfoStore.getState();
    const { effectiveBooks, effectiveActiveIds } = resolveEffectiveBooks(
      books,
      inheritedBookIds,
      effectiveConfig
    );
    const activeIdSet = new Set(effectiveActiveIds);
    // effectiveBooks is already in the right order (source books, synthetic
    // local book last) — just filter down to the ones actually active,
    // since the v1/linked-only fast paths return the FULL raw books array
    // here, not just the active subset.
    const orderedBooks = effectiveBooks.filter((b) => activeIdSet.has(b.id));

    const newBook = wi.createBook(name);
    const idMap = new Map<string, string>();
    const createdIds: { newId: string; oldRelatedIds: string[] }[] = [];

    for (const book of orderedBooks) {
      for (const entry of book.entries) {
        const { id: oldId, createdAt: _createdAt, updatedAt: _updatedAt, revisions: _revisions, ...rest } = entry;
        const created = wi.createEntry(newBook.id, rest);
        if (!created) continue;
        idMap.set(oldId, created.id);
        createdIds.push({ newId: created.id, oldRelatedIds: entry.relatedIds });
      }
    }

    for (const { newId, oldRelatedIds } of createdIds) {
      if (oldRelatedIds.length === 0) continue;
      const remapped = oldRelatedIds
        .map((oldRelId) => idMap.get(oldRelId))
        .filter((id): id is string => !!id);
      wi.updateEntry(newBook.id, newId, { relatedIds: remapped });
    }

    showToastGlobal(
      `Created "${name}" with ${createdIds.length} entr${createdIds.length === 1 ? 'y' : 'ies'}`,
      'success'
    );
    onClose();
  };

  const pinnedLine = `${vm.effectiveEntryCount} entr${vm.effectiveEntryCount === 1 ? 'y' : 'ies'} active · ~${vm.pinnedTokens}${
    vm.tokenBudget > 0 ? ` / ${vm.tokenBudget}` : ''
  } pinned tokens${vm.tokenBudget === 0 ? ' (no budget limit)' : ''}`;

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Lore for this chat" size="lg">
        {view.kind === 'list' && (
          <div className="space-y-4">
            <div
              className={`p-3 rounded-lg border ${
                vm.pinnedOverBudget
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'
              }`}
            >
              <p
                className={`text-sm ${
                  vm.pinnedOverBudget ? 'text-red-400 font-medium' : 'text-[var(--color-text-primary)]'
                }`}
              >
                {pinnedLine}
              </p>
              {vm.pinnedOverBudget && (
                <p className="mt-1 text-xs text-red-400">
                  Constant + critical lore alone exceeds the World Info budget —
                  raise the budget, narrow scope, or demote/exclude entries for
                  this chat.
                </p>
              )}
            </div>

            {vm.hasAnyCustomization && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmReset(true)}
                className="text-xs"
              >
                Reset all customizations
              </Button>
            )}

            <div className="space-y-2">
              {vm.sections.map((section) => (
                <LoreBookSection
                  key={section.book.id}
                  section={section}
                  expanded={!collapsedIds.has(section.book.id)}
                  onToggleExpanded={() => toggleExpanded(section.book.id)}
                  onBookToggle={() =>
                    handleBookToggle(
                      section.book.id,
                      section.book.entries.map((e) => e.id),
                      section.bookToggle
                    )
                  }
                  onRowAction={(row, action) => handleRowAction(section.book.id, row, action)}
                />
              ))}
            </div>

            <div className="flex flex-col gap-2 pt-3 border-t border-[var(--color-border)]">
              <Button variant="secondary" size="sm" onClick={() => setView({ kind: 'createLocal' })}>
                + Chat-only entry
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setView({ kind: 'attach' })}>
                Attach another lorebook
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setView({ kind: 'saveAsBook' })}>
                Save this chat's lore as a new world book
              </Button>
            </div>
          </div>
        )}

        {view.kind === 'fork' && (
          <ForkEntryEditor
            key={`${view.bookId}:${view.entryId}`}
            chatFile={chatFile}
            bookId={view.bookId}
            entryId={view.entryId}
            onClose={() => setView({ kind: 'list' })}
          />
        )}

        {view.kind === 'viewBase' && (
          <BaseEntryViewer
            bookId={view.bookId}
            entryId={view.entryId}
            onClose={() => setView({ kind: 'list' })}
          />
        )}

        {view.kind === 'createLocal' && (
          <WorldInfoEntryForm
            bookId={localSection?.book.id ?? ''}
            entry={null}
            onClose={() => setView({ kind: 'list' })}
            onSave={(data) => addLocalEntry(chatFile, data)}
            siblingEntries={localEntries}
          />
        )}

        {view.kind === 'editLocal' && (() => {
          const entry = localEntries.find((e) => e.id === view.entryId);
          if (!entry) {
            return (
              <div className="space-y-4">
                <p className="text-sm text-[var(--color-text-secondary)]">
                  This chat-only entry no longer exists.
                </p>
                <Button variant="secondary" onClick={() => setView({ kind: 'list' })} className="w-full">
                  Back
                </Button>
              </div>
            );
          }
          return (
            <WorldInfoEntryForm
              bookId={localSection?.book.id ?? ''}
              entry={entry}
              onClose={() => setView({ kind: 'list' })}
              onSave={(data) => updateLocalEntry(chatFile, entry.id, data)}
              siblingEntries={localEntries}
            />
          );
        })()}

        {view.kind === 'attach' && (
          <AttachBookPicker
            chatFile={chatFile}
            alreadyShownBookIds={allShownBookIds}
            chatAttachedBookIds={effectiveConfig?.linkedBookIds ?? EMPTY_IDS}
            onClose={() => setView({ kind: 'list' })}
          />
        )}

        {view.kind === 'saveAsBook' && (
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              Creates a brand-new lorebook with a snapshot of every entry
              currently in effect for this chat — inherited, attached,
              forked, and chat-only. The source books and this chat's
              customizations are left untouched.
            </p>
            <Input
              label="New lorebook name"
              value={saveAsBookName}
              onChange={(e) => setSaveAsBookName(e.target.value)}
              autoFocus
            />
            <div className="flex gap-3 pt-2 border-t border-[var(--color-border)]">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setView({ kind: 'list' })}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                disabled={!saveAsBookName.trim()}
                onClick={handleSaveAsBook}
              >
                Create
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => resetCustomizations(chatFile)}
        title="Reset all customizations?"
        message="Attached books are kept — only this chat's exclusions, forks, and chat-only entries are removed."
        confirmLabel="Reset"
        danger
      />

      <ConfirmDialog
        isOpen={pendingConfirm?.kind === 'discardFork'}
        onClose={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm?.kind === 'discardFork') removeOverlay(chatFile, pendingConfirm.entryId);
        }}
        title="Discard fork?"
        message="This removes the per-chat override and goes back to the library entry's own content."
        confirmLabel="Discard"
        danger
      />

      <ConfirmDialog
        isOpen={pendingConfirm?.kind === 'removeLocal'}
        onClose={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm?.kind === 'removeLocal') removeLocalEntry(chatFile, pendingConfirm.entryId);
        }}
        title="Remove chat-only entry?"
        message="This entry only exists in this chat — removing it can't be undone from here."
        confirmLabel="Remove"
        danger
      />
    </>
  );
}
