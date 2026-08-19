import { useMemo, useState } from 'react';
import {
  Volume2,
  VolumeX,
  MessageCircle,
  GripVertical,
  UserPlus,
  X,
} from 'lucide-react';
import type { CharacterInfo } from '../../api/client';
import {
  useChatStore,
  getTalkativeness,
  type GroupActivationStrategy,
  type GroupCardMode,
} from '../../stores/chatStore';
import { useCharacterStore } from '../../stores/characterStore';
import { Modal } from '../ui/Modal';
import { getDefaultAvatarUrl } from '../../utils/emotions';

interface GroupChatControlsProps {
  fileName: string;
  characters: CharacterInfo[];
  isSending: boolean;
}

const STRATEGY_OPTIONS: Array<{
  value: GroupActivationStrategy;
  label: string;
  hint: string;
}> = [
  {
    value: 'list',
    label: 'List',
    hint: 'Every member replies in order (default).',
  },
  {
    value: 'natural',
    label: 'Natural',
    hint: 'Pick who was mentioned, else weighted by talkativeness.',
  },
  {
    value: 'pooled',
    label: 'Pooled',
    hint: 'Weighted random, skipping the most recent speaker(s).',
  },
  {
    value: 'manual',
    label: 'Manual',
    hint: 'No auto-pick; use the talk-next buttons below.',
  },
];

const CARD_MODE_OPTIONS: Array<{
  value: GroupCardMode;
  label: string;
  hint: string;
}> = [
  {
    value: 'swap',
    label: 'Swap',
    hint: 'Only the active speaker gets full info — lower token cost.',
  },
  {
    value: 'join',
    label: 'Join',
    hint: 'All members get full description, personality, scenario, and examples.',
  },
];

/**
 * Collapsible controls for the active group chat: activation strategy,
 * pooled exclusion window, per-member mute/force-talk, auto-mode loop,
 * drag-to-reorder, and scenario override. All changes are written straight
 * to the persisted group chat record.
 */
export function GroupChatControls({
  fileName,
  characters,
  isSending,
}: GroupChatControlsProps) {
  const groupChat = useChatStore((s) =>
    s.groupChats.find((g) => g.fileName === fileName) || null
  );
  const setGroupActivationStrategy = useChatStore((s) => s.setGroupActivationStrategy);
  const setGroupCardMode = useChatStore((s) => s.setGroupCardMode);
  const toggleGroupMute = useChatStore((s) => s.toggleGroupMute);
  const setGroupPooledExcludeRecent = useChatStore((s) => s.setGroupPooledExcludeRecent);
  const setGroupAutoMode = useChatStore((s) => s.setGroupAutoMode);
  const setGroupAutoModeDelay = useChatStore((s) => s.setGroupAutoModeDelay);
  const setGroupScenarioOverride = useChatStore((s) => s.setGroupScenarioOverride);
  const reorderGroupMembers = useChatStore((s) => s.reorderGroupMembers);
  const forceGroupMemberTalk = useChatStore((s) => s.forceGroupMemberTalk);
  const setGroupTalkativenessOverride = useChatStore(
    (s) => s.setGroupTalkativenessOverride
  );
  const addGroupChatMember = useChatStore((s) => s.addGroupChatMember);
  const removeGroupChatMember = useChatStore((s) => s.removeGroupChatMember);
  const reorderGroupChatCharacters = useCharacterStore(
    (s) => s.reorderGroupChatCharacters
  );
  const toggleGroupChatCharacter = useCharacterStore(
    (s) => s.toggleGroupChatCharacter
  );
  const allCharacters = useCharacterStore((s) => s.characters);

  const mutedSet = useMemo(
    () => new Set(groupChat?.mutedAvatars ?? []),
    [groupChat?.mutedAvatars]
  );
  const overrides = useMemo(
    () => groupChat?.talkativenessOverrides ?? {},
    [groupChat?.talkativenessOverrides]
  );

  // Local drag state — we only persist when the drop lands.
  const [draggingAvatar, setDraggingAvatar] = useState<string | null>(null);
  const [dragOverAvatar, setDragOverAvatar] = useState<string | null>(null);
  // Member add modal
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [addMemberQuery, setAddMemberQuery] = useState('');

  if (!groupChat) return null;

  const strategy = groupChat.activationStrategy;
  const excludeRecent = groupChat.pooledExcludeRecent;
  const autoModeEnabled = groupChat.autoModeEnabled;
  const autoModeDelayMs = groupChat.autoModeDelayMs;
  const scenarioOverride = groupChat.scenarioOverride;
  const cardMode = groupChat.cardMode;
  // Pooled N must stay below the pool size so we always have a valid fallback.
  const maxExclude = Math.max(0, characters.length - 1);
  const activeHint =
    STRATEGY_OPTIONS.find((o) => o.value === strategy)?.hint ?? '';
  const activeCardHint =
    CARD_MODE_OPTIONS.find((o) => o.value === cardMode)?.hint ?? '';

  const handleDragStart = (avatar: string) => {
    if (isSending) return;
    setDraggingAvatar(avatar);
  };

  const handleDragOver = (avatar: string, e: React.DragEvent) => {
    if (isSending) return;
    if (!draggingAvatar || draggingAvatar === avatar) return;
    e.preventDefault();
    setDragOverAvatar(avatar);
  };

  const handleDrop = (targetAvatar: string) => {
    if (isSending) return;
    if (!draggingAvatar || draggingAvatar === targetAvatar) {
      setDraggingAvatar(null);
      setDragOverAvatar(null);
      return;
    }
    const currentOrder = characters.map((c) => c.avatar);
    const srcIdx = currentOrder.indexOf(draggingAvatar);
    const dstIdx = currentOrder.indexOf(targetAvatar);
    if (srcIdx === -1 || dstIdx === -1) {
      setDraggingAvatar(null);
      setDragOverAvatar(null);
      return;
    }
    const next = [...currentOrder];
    next.splice(srcIdx, 1);
    next.splice(dstIdx, 0, draggingAvatar);
    reorderGroupMembers(fileName, next);
    reorderGroupChatCharacters(next);
    setDraggingAvatar(null);
    setDragOverAvatar(null);
  };

  const handleDragEnd = () => {
    setDraggingAvatar(null);
    setDragOverAvatar(null);
  };

  // Talkativeness slider: map [0, 100] UI range to [0, 1] stored value. A
  // "reset" button clears the override back to the card's default.
  const handleTalkSliderChange = (avatar: string, uiValue: number) => {
    const clamped = Math.max(0, Math.min(1, uiValue / 100));
    setGroupTalkativenessOverride(fileName, avatar, clamped);
  };
  const handleTalkReset = (avatar: string) => {
    setGroupTalkativenessOverride(fileName, avatar, null);
  };

  // Filter out characters already in the group when rendering the add modal.
  // The picker list mirrors the sidebar's sort: just alphabetical by name.
  const inGroupAvatars = new Set(characters.map((c) => c.avatar));
  const pickableCharacters = allCharacters
    .filter((c) => !inGroupAvatars.has(c.avatar))
    .filter((c) => {
      const q = addMemberQuery.trim().toLowerCase();
      if (!q) return true;
      return (c.name || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const handleAddMember = async (character: CharacterInfo) => {
    // 1) Add to the live roster (fetches full card data if needed)
    await toggleGroupChatCharacter(character.avatar);
    // 2) Pull the enriched character back out of the store and update the
    //    persisted group + post greeting. toggleGroupChatCharacter has
    //    resolved full-data by now.
    const enriched =
      useCharacterStore
        .getState()
        .groupChatCharacters.find((c) => c.avatar === character.avatar) ||
      character;
    addGroupChatMember(fileName, enriched);
    setShowAddMemberModal(false);
    setAddMemberQuery('');
  };

  const handleRemoveMember = (avatar: string) => {
    if (isSending) return;
    if (characters.length <= 2) return; // groups need 2+
    // Remove from persisted record + live roster in lockstep. Use the direct
    // avatar-based remove rather than toggle, which is order-sensitive.
    removeGroupChatMember(fileName, avatar);
    // toggleGroupChatCharacter on an in-group avatar removes it.
    toggleGroupChatCharacter(avatar);
  };

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Activation strategy
          </label>
        </div>
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-[var(--color-bg-tertiary)] p-1">
          {STRATEGY_OPTIONS.map((opt) => {
            const active = opt.value === strategy;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setGroupActivationStrategy(fileName, opt.value)}
                className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[var(--color-primary)] text-white shadow-sm'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
          {activeHint}
        </p>
      </div>

      {/* Phase 5.3: card-handling mode — swap (current speaker only) vs join (all members). */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Card mode
          </label>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--color-bg-tertiary)] p-1">
          {CARD_MODE_OPTIONS.map((opt) => {
            const active = opt.value === cardMode;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setGroupCardMode(fileName, opt.value)}
                className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[var(--color-primary)] text-white shadow-sm'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
          {activeCardHint}
        </p>
      </div>

      {strategy === 'pooled' && (
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] mb-1.5">
            Skip last {excludeRecent} speaker{excludeRecent === 1 ? '' : 's'}
          </label>
          <input
            type="range"
            min={0}
            max={maxExclude}
            step={1}
            value={Math.min(excludeRecent, maxExclude)}
            onChange={(e) =>
              setGroupPooledExcludeRecent(fileName, Number(e.target.value))
            }
            className="w-full"
            aria-label="Pooled exclude-recent count"
          />
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Members who spoke in the last {excludeRecent} turn
            {excludeRecent === 1 ? '' : 's'} are skipped by the pooled roll.
          </p>
        </div>
      )}

      {strategy !== 'manual' && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Auto-mode
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={autoModeEnabled}
              onClick={() => setGroupAutoMode(fileName, !autoModeEnabled)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                autoModeEnabled
                  ? 'bg-[var(--color-primary)]'
                  : 'bg-[var(--color-bg-tertiary)]'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  autoModeEnabled ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Keep generating next speakers after each reply. Stop button breaks
            the loop.
          </p>
          {autoModeEnabled && (
            <div className="mt-2">
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                Delay between turns: {(autoModeDelayMs / 1000).toFixed(1)}s
              </label>
              <input
                type="range"
                min={0}
                max={30000}
                step={500}
                value={autoModeDelayMs}
                onChange={(e) =>
                  setGroupAutoModeDelay(fileName, Number(e.target.value))
                }
                className="w-full"
                aria-label="Auto-mode delay between turns"
              />
            </div>
          )}
        </div>
      )}

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] mb-1.5">
          Group scenario override
        </label>
        <textarea
          value={scenarioOverride}
          onChange={(e) => setGroupScenarioOverride(fileName, e.target.value)}
          placeholder="Leave empty to use each member's own scenario."
          rows={3}
          className="w-full rounded-md bg-[var(--color-bg-tertiary)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] px-2 py-1.5 placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
        />
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          Macros like <code>{'{{user}}'}</code> work here.{' '}
          <code>{'{{char}}'}</code> is empty in group context.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Members ({characters.length - mutedSet.size}/{characters.length} active)
          </label>
          <button
            type="button"
            onClick={() => setShowAddMemberModal(true)}
            disabled={isSending}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
            title="Add a member"
            aria-label="Add member"
          >
            <UserPlus size={12} />
            <span>Add</span>
          </button>
        </div>
        <ul className="space-y-2">
          {characters.map((c) => {
            const muted = mutedSet.has(c.avatar);
            const hasOverride =
              typeof overrides[c.avatar] === 'number';
            const talk = getTalkativeness(c, overrides[c.avatar]);
            const isDragTarget = dragOverAvatar === c.avatar;
            const isDragged = draggingAvatar === c.avatar;
            const canRemove = characters.length > 2 && !isSending;
            return (
              <li
                key={c.avatar}
                draggable={!isSending}
                onDragStart={() => handleDragStart(c.avatar)}
                onDragOver={(e) => handleDragOver(c.avatar, e)}
                onDrop={() => handleDrop(c.avatar)}
                onDragEnd={handleDragEnd}
                className={`rounded-md transition-colors ${
                  isDragTarget
                    ? 'bg-[var(--color-primary)]/20'
                    : 'bg-[var(--color-bg-tertiary)]/50'
                } ${isDragged ? 'opacity-40' : ''}`}
              >
                <div className="flex items-center gap-1">
                  <span
                    className={`flex-shrink-0 pl-1.5 ${
                      isSending
                        ? 'text-[var(--color-text-secondary)]/40'
                        : 'text-[var(--color-text-secondary)] cursor-grab active:cursor-grabbing'
                    }`}
                    title={isSending ? 'Reorder disabled while sending' : 'Drag to reorder'}
                    aria-label="Drag handle"
                  >
                    <GripVertical size={14} />
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleGroupMute(fileName, c.avatar)}
                    className={`flex-1 flex items-center gap-2 px-1 py-1.5 text-sm transition-colors ${
                      muted
                        ? 'text-[var(--color-text-secondary)] opacity-70'
                        : 'text-[var(--color-text-primary)] hover:opacity-80'
                    }`}
                    aria-pressed={muted}
                    title={muted ? `Unmute ${c.name}` : `Mute ${c.name}`}
                  >
                    {muted ? (
                      <VolumeX size={16} className="text-red-400 flex-shrink-0" />
                    ) : (
                      <Volume2
                        size={16}
                        className="text-[var(--color-primary)] flex-shrink-0"
                      />
                    )}
                    <span
                      className={`flex-1 text-left truncate ${
                        muted ? 'line-through' : ''
                      }`}
                    >
                      {c.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => forceGroupMemberTalk(c, characters)}
                    disabled={isSending}
                    className="flex-shrink-0 p-1.5 rounded-md text-[var(--color-primary)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed"
                    title={`Make ${c.name} respond next`}
                    aria-label={`Force ${c.name} to respond`}
                  >
                    <MessageCircle size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveMember(c.avatar)}
                    disabled={!canRemove}
                    className="flex-shrink-0 p-1.5 mr-1 rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                    title={
                      characters.length <= 2
                        ? 'Groups need at least 2 members'
                        : `Remove ${c.name} from group`
                    }
                    aria-label={`Remove ${c.name} from group`}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="flex items-center gap-2 pl-6 pr-2 pb-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(talk * 100)}
                    onChange={(e) =>
                      handleTalkSliderChange(c.avatar, Number(e.target.value))
                    }
                    className="flex-1 h-1 accent-[var(--color-primary)]"
                    aria-label={`Talkativeness for ${c.name}`}
                    title="Adjust talkativeness for this group only"
                  />
                  <span className="text-xs text-[var(--color-text-secondary)] tabular-nums flex-shrink-0 w-12 text-right">
                    t={talk.toFixed(2)}
                    {hasOverride && (
                      <span className="text-[var(--color-primary)]">*</span>
                    )}
                  </span>
                  {hasOverride && (
                    <button
                      type="button"
                      onClick={() => handleTalkReset(c.avatar)}
                      className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-1.5 py-0.5 rounded"
                      title="Clear override, use card value"
                    >
                      reset
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {showAddMemberModal && (
        <Modal
          isOpen={showAddMemberModal}
          onClose={() => {
            setShowAddMemberModal(false);
            setAddMemberQuery('');
          }}
          title="Add member to group"
          size="md"
        >
          <div className="space-y-3">
            <input
              type="text"
              value={addMemberQuery}
              onChange={(e) => setAddMemberQuery(e.target.value)}
              placeholder="Search characters..."
              className="w-full rounded-md bg-[var(--color-bg-tertiary)] text-sm text-[var(--color-text-primary)] border border-[var(--color-border)] px-3 py-2 placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
              autoFocus
            />
            {pickableCharacters.length === 0 ? (
              <p className="text-sm text-[var(--color-text-secondary)] text-center py-6">
                {addMemberQuery.trim()
                  ? 'No matching characters.'
                  : 'All your characters are already in this group.'}
              </p>
            ) : (
              <ul className="space-y-1 max-h-[50vh] overflow-y-auto">
                {pickableCharacters.map((c) => (
                  <li key={c.avatar}>
                    <button
                      type="button"
                      onClick={() => handleAddMember(c)}
                      className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    >
                      <img
                        src={getDefaultAvatarUrl(c.avatar)}
                        alt=""
                        className="w-8 h-8 rounded-full object-cover bg-[var(--color-bg-tertiary)] flex-shrink-0"
                        onError={(e) => {
                          e.currentTarget.style.visibility = 'hidden';
                        }}
                      />
                      <span className="flex-1 truncate">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
