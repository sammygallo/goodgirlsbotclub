import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Copy,
  Download,
  Edit3,
  Globe,
  Loader2,
  Lock,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCharacterStore } from '../../stores/characterStore';
import { useCharacterOwnershipStore, type CharacterOwnershipState } from '../../stores/characterOwnershipStore';
import type { User, UserRole } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { can, hasPermission } from '../../utils/permissions';
import { api, type CharacterInfo } from '../../api/client';
import { Button, ConfirmDialog } from '../ui';
import { CharacterCreation } from '../character/CharacterCreation';
import { CharacterInterview } from '../character/interview/CharacterInterview';
import { CharacterEdit } from '../character/CharacterEdit';
import { CharacterImport } from '../character/CharacterImport';

type FilterMode = 'all' | 'mine';

export function CharacterManagementPage() {
  const { goBack } = useSettingsPanelStore();
  const {
    characters,
    fetchCharacters,
    deleteCharacter,
    duplicateCharacter,
    exportCharacterAsPNG,
    exportCharacterAsJSON,
  } = useCharacterStore();
  const ownershipStore = useCharacterOwnershipStore();
  const currentUser = useAuthStore((s) => s.currentUser);

  const userHandle = currentUser?.handle ?? '';
  const userRole = currentUser?.role;

  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [editingCharacter, setEditingCharacter] = useState<CharacterInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isLoadingEdit, setIsLoadingEdit] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showInterview, setShowInterview] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [exportingAvatar, setExportingAvatar] = useState<string | null>(null);

  useEffect(() => {
    fetchCharacters();
  }, [fetchCharacters]);

  // Filtered + sorted character list
  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return characters
      .filter((char) => {
        if (filterMode === 'mine' && !ownershipStore.isOwnedBy(char.avatar, userHandle)) {
          return false;
        }
        if (query) {
          const name = (char.name || '').toLowerCase();
          const creator = (char.creator || char.data?.creator || '').toLowerCase();
          if (!name.includes(query) && !creator.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [characters, searchQuery, filterMode, ownershipStore, userHandle]);

  // Open edit modal — needs full character data
  const handleEdit = async (avatar: string) => {
    setIsLoadingEdit(true);
    try {
      const full = await api.getCharacter(avatar);
      setEditingCharacter(full);
    } catch {
      // fall back to partial data from list
      const partial = characters.find((c) => c.avatar === avatar) ?? null;
      setEditingCharacter(partial);
    } finally {
      setIsLoadingEdit(false);
    }
  };

  const handleDuplicate = async (avatar: string) => {
    // Server-side: duplicating always creates a new personal copy in the
    // caller's directory. Visibility and ownership for the new copy are
    // left at their defaults (personal, unowned) — the caller can promote
    // the copy to global afterwards if desired.
    await duplicateCharacter(avatar);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    await deleteCharacter(deleteTarget);
    setDeleteTarget(null);
    setIsDeleting(false);
  };

  const [visibilityBusy, setVisibilityBusy] = useState<string | null>(null);

  const handleToggleVisibility = async (avatar: string) => {
    const current = ownershipStore.getVisibility(avatar);
    const next = current === 'global' ? 'personal' : 'global';
    setVisibilityBusy(avatar);
    try {
      await ownershipStore.setVisibility(avatar, next);
      // Server physically moved the file between directories — refresh the
      // character list so subsequent API calls target the right scope.
      await fetchCharacters();
    } catch (err) {
      console.error('Failed to change character visibility', err);
    } finally {
      setVisibilityBusy(null);
    }
  };

  const handleExport = async (avatar: string, format: 'png' | 'json') => {
    setExportingAvatar(avatar);
    try {
      const full = await api.getCharacter(avatar);
      if (format === 'png') {
        await exportCharacterAsPNG(full);
      } else {
        exportCharacterAsJSON(full);
      }
    } catch {
      // ignore — store sets its own error
    } finally {
      setExportingAvatar(null);
    }
  };

  const deleteTargetName =
    characters.find((c) => c.avatar === deleteTarget)?.name ?? 'this character';

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button variant="ghost" size="sm" onClick={() => goBack()} className="p-2" aria-label="Back">
          <ArrowLeft size={24} />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
            Character Management
          </h1>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {characters.length} character{characters.length !== 1 ? 's' : ''}
          </p>
        </div>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Search + Filter */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]"
            />
            <input
              type="text"
              placeholder="Search characters..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>
          {can(userRole, 'character:create') && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowInterview(true)}
              className="flex items-center gap-1.5 shrink-0"
            >
              <Plus size={16} />
              New
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1.5 shrink-0"
          >
            <Upload size={16} />
            Import
          </Button>
          <div className="flex rounded-lg overflow-hidden border border-[var(--color-border)]">
            {(['all', 'mine'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                className={`px-3 py-2 text-xs font-medium transition-colors ${
                  filterMode === mode
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {mode === 'all' ? 'All' : 'Mine'}
              </button>
            ))}
          </div>
        </div>

        {/* Loading indicator for edit */}
        {isLoadingEdit && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--color-primary)]" />
            <span className="ml-2 text-sm text-[var(--color-text-secondary)]">Loading character...</span>
          </div>
        )}

        {/* Character list */}
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {searchQuery || filterMode === 'mine'
                ? 'No characters match your filters.'
                : 'No characters yet. Tap + New to create one.'}
            </p>
          </div>
        ) : (
          <ul className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden divide-y divide-[var(--color-border)]">
            {filtered.map((char) => (
              <CharacterRow
                key={char.avatar}
                character={char}
                currentUser={currentUser}
                userHandle={userHandle}
                userRole={userRole}
                ownershipStore={ownershipStore}
                onEdit={handleEdit}
                onDuplicate={handleDuplicate}
                onDelete={setDeleteTarget}
                onToggleVisibility={handleToggleVisibility}
                onExport={handleExport}
                isExporting={exportingAvatar === char.avatar}
                isVisibilityBusy={visibilityBusy === char.avatar}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Create modal — plain form, reached via the interview wizard's
          "Use the simple form instead" escape hatch */}
      <CharacterCreation
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => {
          setShowCreate(false);
          fetchCharacters();
        }}
      />

      {/* Interview wizard — default "New" flow */}
      <CharacterInterview
        isOpen={showInterview}
        onClose={() => setShowInterview(false)}
        onCreated={() => {
          setShowInterview(false);
          fetchCharacters();
        }}
        onUseSimpleForm={() => {
          setShowInterview(false);
          setShowCreate(true);
        }}
      />

      {/* Edit modal */}
      {editingCharacter && (
        <CharacterEdit
          isOpen
          onClose={() => setEditingCharacter(null)}
          character={editingCharacter}
          onSaved={() => {
            setEditingCharacter(null);
            fetchCharacters();
          }}
        />
      )}

      {/* Import modal */}
      <CharacterImport
        isOpen={showImport}
        onClose={() => setShowImport(false)}
        onImported={() => {
          setShowImport(false);
          fetchCharacters();
        }}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Character"
        message={`Are you sure you want to delete "${deleteTargetName}"? This action cannot be undone.`}
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete'}
        danger
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual character row
// ---------------------------------------------------------------------------

interface CharacterRowProps {
  character: CharacterInfo;
  currentUser: User | null;
  userHandle: string;
  userRole: UserRole | undefined;
  ownershipStore: CharacterOwnershipState;
  onEdit: (avatar: string) => void;
  onDuplicate: (avatar: string) => void;
  onDelete: (avatar: string) => void;
  onToggleVisibility: (avatar: string) => void;
  onExport: (avatar: string, format: 'png' | 'json') => void;
  isExporting: boolean;
  isVisibilityBusy: boolean;
}

function CharacterRow({
  character,
  currentUser,
  userHandle,
  userRole,
  ownershipStore,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleVisibility,
  onExport,
  isExporting,
  isVisibilityBusy,
}: CharacterRowProps) {
  const avatar = character.avatar;
  const visibility = ownershipStore.getVisibility(avatar);
  const isOwned = ownershipStore.isOwnedBy(avatar, userHandle);
  const ownerHandle = ownershipStore.getOwner(avatar);
  // Admin/owner only — server populates this for callers who can see
  // every user's cards, so the row can surface that linz/vulpixxy also
  // have their own copies of the same-named character.
  const otherOwners = ownershipStore.getOtherOwners(avatar);

  const canEdit =
    hasPermission(currentUser, 'character:edit') ||
    ownershipStore.canEditCharacter(avatar, userHandle, userRole);
  const canDelete = ownershipStore.canDeleteCharacter(avatar, userHandle, userRole);
  const canDuplicate = can(userRole, 'character:create');
  const canSetGlobal = hasPermission(currentUser, 'character:set_global');

  const creator = character.creator || character.data?.creator || null;
  const thumbnailUrl = `/blobs/character/${encodeURIComponent(avatar)}`;
  const [showExportMenu, setShowExportMenu] = useState(false);

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <div className="w-12 h-12 rounded-lg overflow-hidden bg-[var(--color-bg-tertiary)] flex-shrink-0">
          <img
            src={thumbnailUrl}
            alt={character.name}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
              {character.name}
            </p>
            {/* Visibility badge */}
            {visibility === 'global' ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-500/20 text-blue-400">
                GLOBAL
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-500/20 text-amber-400">
                PERSONAL
              </span>
            )}
            {/* Ownership badge */}
            {isOwned && (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-green-500/20 text-green-400">
                YOURS
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] truncate mt-0.5">
            {creator ? `by ${creator}` : ownerHandle ? `owned by ${ownerHandle}` : 'No owner'}
            {otherOwners.length > 0 && (
              <span className="ml-1">· also owned by {otherOwners.join(', ')}</span>
            )}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {canEdit && (
            <button
              onClick={() => onEdit(avatar)}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              title="Edit"
              aria-label={`Edit ${character.name}`}
            >
              <Edit3 size={14} />
            </button>
          )}
          {/* Export */}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu((v) => !v)}
              disabled={isExporting}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50"
              title="Export"
              aria-label={`Export ${character.name}`}
            >
              {isExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden min-w-[120px]">
                  <button
                    onClick={() => { setShowExportMenu(false); onExport(avatar, 'png'); }}
                    className="w-full px-3 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    Export as PNG
                  </button>
                  <button
                    onClick={() => { setShowExportMenu(false); onExport(avatar, 'json'); }}
                    className="w-full px-3 py-2 text-left text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  >
                    Export as JSON
                  </button>
                </div>
              </>
            )}
          </div>
          {canDuplicate && (
            <button
              onClick={() => onDuplicate(avatar)}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              title="Duplicate"
              aria-label={`Duplicate ${character.name}`}
            >
              <Copy size={14} />
            </button>
          )}
          {canSetGlobal && (
            <button
              onClick={() => onToggleVisibility(avatar)}
              disabled={isVisibilityBusy}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50"
              title={visibility === 'global' ? 'Make personal' : 'Make global'}
              aria-label={`Toggle visibility for ${character.name}`}
            >
              {isVisibilityBusy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : visibility === 'global' ? (
                <Globe size={14} />
              ) : (
                <Lock size={14} />
              )}
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => onDelete(avatar)}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Delete"
              aria-label={`Delete ${character.name}`}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
