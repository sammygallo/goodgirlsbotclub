import { useDeferredValue, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Plus,
  Upload,
  BookOpen,
  Sparkles,
  Loader2,
  Search,
  X,
  RefreshCw,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useCharacterStore } from '../../stores/characterStore';
import { usePersonaStore } from '../../stores/personaStore';
import { useChatLoreConfigStore } from '../../stores/chatLoreConfigStore';
import { useLoreConflictStore } from '../../stores/loreConflictStore';
import {
  useWorldInfoStore,
  auditBookHealth,
  type WorldInfoBook,
} from '../../stores/worldInfoStore';
import { profileForProvider, estimateTokens } from '../../utils/tokenizer';
import { lintBook, worstSeverity } from '../../utils/lorebookLint';
import {
  computeBookAttachments,
  filterBooksByScope,
  type BookAttachments,
  type LibraryScope,
} from '../../utils/bookAttachments';
import {
  buildEntrySearchIndex,
  searchEntries,
  MIN_SEARCH_QUERY_LENGTH,
} from '../../utils/lorebookSearch';
import { Button, Input, ConfirmDialog, Modal } from '../ui';
import { WorldInfoBookEditor } from './WorldInfoBookEditor';
import { ChatPickerModal, type ChatSelection } from './ChatPickerModal';
import { GenerateLorebookModal } from './GenerateLorebookModal';
import { AddDocumentModal } from './AddDocumentModal';
import { LibraryFilterBar } from './LibraryFilterBar';
import { LibraryBookRow } from './LibraryBookRow';
import { ConflictResolutionSheet } from './ConflictResolutionSheet';
import { BookAttachmentChips } from './BookAttachmentChips';
import { EntrySearchResults } from './EntrySearchResults';
import { CharacterEdit } from '../character/CharacterEdit';
import { api } from '../../api/client';
import type { TranscriptMsg } from '../../utils/lorebookFromTranscript';

/** Safe fallback for a book somehow missing from the attachments map. */
const EMPTY_ATTACHMENTS: BookAttachments = {
  ownerAvatar: null,
  linkedByCharacterAvatars: [],
  linkedByPersonas: [],
  chatFiles: [],
  globallyActive: false,
};

const EMPTY_STATE_COPY: Record<LibraryScope, { title: string; body: string }> = {
  all: {
    title: 'No lorebooks yet',
    body: 'Create one above, or import an existing World Info JSON.',
  },
  world: {
    title: 'No world lorebooks yet',
    body: 'Create one above, or import an existing World Info JSON.',
  },
  character: {
    title: 'No character lorebooks yet',
    body: "Add one from a character's Edit screen, or import below.",
  },
  auto_memory: {
    title: 'No auto-memory lorebooks yet',
    body: 'These are generated automatically as chats accumulate lore.',
  },
  shared: {
    title: 'Nothing shared with you yet',
    body: 'Books your group members mark as shared appear here.',
  },
};

export function WorldInfoPage(_props?: { params?: Record<string, string> }) {
  const { goBack } = useSettingsPanelStore();
  const {
    books,
    activeBookIds,
    chatLinkedBookIds,
    scanDepth,
    maxRecursionSteps,
    tokenBudget,
    error,
    createBook,
    renameBook,
    deleteBook,
    duplicateBook,
    toggleBookActive,
    setScanDepth,
    setMaxRecursionSteps,
    setTokenBudget,
    exportBookJson,
    importBookJson,
    clearError,
    sharedBooks,
    sharedBooksStatus,
    sharedBooksError,
    fetchSharedBooks,
    copySharedBook,
  } = useWorldInfoStore();

  const [newBookName, setNewBookName] = useState('');
  const [editingBook, setEditingBook] = useState<WorldInfoBook | null>(null);
  const [initialEntryId, setInitialEntryId] = useState<string | undefined>(undefined);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<WorldInfoBook | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Lorebook v2 (Phase 3) library controls: scope filter + entry search.
  const [scope, setScope] = useState<LibraryScope>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);
  const [editingCharacterAvatar, setEditingCharacterAvatar] = useState<string | null>(null);

  // Lorebook v2 (Phase 4): which book (if any) currently has its Auto Memory
  // conflict-resolution sheet open.
  const [conflictSheetBookId, setConflictSheetBookId] = useState<string | null>(null);

  const chatConfigs = useChatLoreConfigStore((s) => s.configs);
  const characters = useCharacterStore((s) => s.characters);
  const linkedBookIdsByAvatar = useCharacterStore((s) => s.linkedBookIdsByAvatar);
  const personas = usePersonaStore((s) => s.personas);
  const conflictRecords = useLoreConflictStore((s) => s.records);

  // "Generate from chat" flow: pick a chat → load its messages → review modal.
  const [isChatPickerOpen, setIsChatPickerOpen] = useState(false);
  const [isAddDocumentOpen, setIsAddDocumentOpen] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [pendingGen, setPendingGen] = useState<{
    messages: TranscriptMsg[];
    characterName: string;
    characterAvatar: string;
    defaultBookName: string;
  } | null>(null);

  const handleChatSelected = async (sel: ChatSelection) => {
    setIsChatPickerOpen(false);
    setGenError(null);
    setGenLoading(true);
    try {
      const { messages: raw } = await api.getChatMessages(sel.avatar, sel.fileName);
      const messages: TranscriptMsg[] = raw.map((m) => ({
        name: m.name,
        isUser: m.is_user,
        isSystem: m.is_system,
        content: m.mes,
      }));
      setPendingGen({
        messages,
        characterName: sel.characterName,
        characterAvatar: sel.avatar,
        defaultBookName: `${sel.characterName} — Lore`,
      });
    } catch (err) {
      console.error('[WI] Failed to load chat for lorebook generation:', err);
      setGenError('Could not load that chat. Please try again.');
    } finally {
      setGenLoading(false);
    }
  };

  // Lorebook health: audit each active book against the active provider's
  // tokenizer profile. Memoized — never build fresh arrays inside zustand
  // selectors (React #185 churn hazard).
  const activeProvider = useSettingsStore((s) => s.activeProvider);

  // Resolve a character avatar to display info for owner chips / attachment
  // chips. Not memoized as a function reference (it's cheap and only ever
  // used inside other memos / JSX, never passed anywhere that cares about
  // referential stability across renders).
  const resolveCharacter = (avatar: string): { avatar: string; name: string } | null => {
    const character = characters.find((c) => c.avatar === avatar);
    return character ? { avatar: character.avatar, name: character.name } : null;
  };

  // Global entry search index — rebuilt only when the books array changes.
  const searchIndex = useMemo(() => buildEntrySearchIndex(books), [books]);
  const searchHits = useMemo(
    () => searchEntries(searchIndex, deferredQuery),
    [searchIndex, deferredQuery]
  );
  const isSearching = deferredQuery.trim().length >= MIN_SEARCH_QUERY_LENGTH;

  // Attachment summary (owner / linked characters / personas / chats /
  // globally-active) per book, for the library rows' badge/chip row.
  const attachments = useMemo(
    () =>
      computeBookAttachments({
        books,
        activeBookIds,
        linkedBookIdsByAvatar,
        personas,
        chatConfigs,
        legacyChatLinkedBookIds: chatLinkedBookIds,
      }),
    [books, activeBookIds, linkedBookIdsByAvatar, personas, chatConfigs, chatLinkedBookIds]
  );

  // Per-book token estimate over enabled entries only, for the library row's
  // "~N tok" caption.
  const tokenEstimatesByBookId = useMemo(() => {
    const profile = profileForProvider(activeProvider || '');
    const map = new Map<string, number>();
    for (const book of books) {
      let total = 0;
      for (const entry of book.entries) {
        if (!entry.enabled) continue;
        total += estimateTokens(entry.content, profile);
      }
      map.set(book.id, total);
    }
    return map;
  }, [books, activeProvider]);

  // Same per-book token estimate, computed over the Shared tab's books
  // instead of the caller's own — sharedBooks is fetched/normalized
  // separately (see fetchSharedBooks) and never mixed into `books`.
  const sharedTokenEstimatesByBookId = useMemo(() => {
    const profile = profileForProvider(activeProvider || '');
    const map = new Map<string, number>();
    for (const book of sharedBooks) {
      let total = 0;
      for (const entry of book.entries) {
        if (!entry.enabled) continue;
        total += estimateTokens(entry.content, profile);
      }
      map.set(book.id, total);
    }
    return map;
  }, [sharedBooks, activeProvider]);

  // Pending Auto Memory conflict counts per book, for the library row's
  // conflict pill (Lorebook v2 Phase 4).
  const conflictCountsByBookId = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of Object.values(conflictRecords)) {
      map.set(record.bookId, (map.get(record.bookId) ?? 0) + 1);
    }
    return map;
  }, [conflictRecords]);

  // Scope-filtered book list, with presentation-only ordering: world books
  // keep their existing array order; character-owned books (in 'all',
  // 'character', 'auto_memory') are grouped/sorted by resolved owner display
  // name, then book name.
  const scopedBooks = useMemo(() => {
    const filtered = filterBooksByScope(books, scope);
    if (scope === 'world') return filtered;

    const ownerName = (book: WorldInfoBook): string => {
      if (!book.ownerCharacterAvatar) return '';
      const character = characters.find((c) => c.avatar === book.ownerCharacterAvatar);
      return character?.name ?? '';
    };
    const byOwnerThenName = (a: WorldInfoBook, b: WorldInfoBook) => {
      const nameCompare = ownerName(a).localeCompare(ownerName(b));
      if (nameCompare !== 0) return nameCompare;
      return a.name.localeCompare(b.name);
    };

    if (scope === 'all') {
      const worldBooks = filtered.filter((b) => b.ownerCharacterAvatar == null);
      const charBooks = filtered
        .filter((b) => b.ownerCharacterAvatar != null)
        .sort(byOwnerThenName);
      return [...worldBooks, ...charBooks];
    }

    // 'character' and 'auto_memory'
    return [...filtered].sort(byOwnerThenName);
  }, [books, scope, characters]);

  // Segment count badges for the filter bar. 'shared' isn't a real
  // filterBooksByScope filter (it always returns []) — its count comes from
  // sharedBooks.length instead, same as the Shared tab's own content.
  const segmentCounts = useMemo(() => {
    const scopes: LibraryScope[] = ['all', 'character', 'world', 'auto_memory'];
    const counts = {} as Record<LibraryScope, number>;
    for (const s of scopes) {
      counts[s] = filterBooksByScope(books, s).length;
    }
    counts.shared = sharedBooks.length;
    return counts;
  }, [books, sharedBooks]);

  const health = useMemo(() => {
    const profile = profileForProvider(activeProvider || '');
    const reports = books
      .filter((b) => activeBookIds.includes(b.id))
      .map((b) => {
        // Entry-quality lint, folded into the same pass so nothing recomputes
        // per render. Errors = entries the scanner can never fire.
        const lint = lintBook(b.entries, profile);
        let lintErrors = 0;
        let lintWarnings = 0;
        for (const { findings } of lint) {
          const worst = worstSeverity(findings);
          if (worst === 'error') lintErrors++;
          else if (worst === 'warning') lintWarnings++;
        }
        return {
          book: b,
          audit: auditBookHealth(b, profile),
          lintErrors,
          lintWarnings,
        };
      });
    const pinnedTotal = reports.reduce((s, r) => s + r.audit.pinnedTokens, 0);
    return { reports, pinnedTotal };
  }, [books, activeBookIds, activeProvider]);
  const pinnedOverBudget = tokenBudget > 0 && health.pinnedTotal > tokenBudget;

  const handleCreate = () => {
    const trimmed = newBookName.trim();
    if (!trimmed) return;
    createBook(trimmed);
    setNewBookName('');
  };

  const handleStartRename = (book: WorldInfoBook) => {
    setRenamingId(book.id);
    setRenameValue(book.name);
  };

  const handleFinishRename = () => {
    if (renamingId && renameValue.trim()) {
      renameBook(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleExport = (book: WorldInfoBook) => {
    const json = exportBookJson(book.id);
    if (!json) return;
    const safeName = book.name.replace(/[^a-z0-9_\-\s]/gi, '_').trim() || 'lorebook';
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // reset
    try {
      const text = await file.text();
      const nameFromFile = file.name.replace(/\.json$/i, '');
      const imported = importBookJson(text, nameFromFile);
      if (imported) {
        setImportNotice(
          `Imported "${imported.name}" with ${imported.entries.length} entr${imported.entries.length === 1 ? 'y' : 'ies'}`
        );
        setTimeout(() => setImportNotice(null), 4000);
      }
    } catch (err) {
      console.error('[WI] Import failed:', err);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => goBack()}
          className="p-2"
          aria-label="Back"
        >
          <ArrowLeft size={24} />
        </Button>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)] flex-1">
          World Info
        </h1>
        <span className="text-xs px-2 py-1 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
          {activeBookIds.length} active
        </span>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={clearError}
              className="text-red-400 hover:text-red-300"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {importNotice && (
          <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
            <p className="text-sm text-green-400">{importNotice}</p>
          </div>
        )}
        {genError && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
            <p className="text-sm text-red-400">{genError}</p>
            <button
              onClick={() => setGenError(null)}
              className="text-red-400 hover:text-red-300"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {/* Global settings */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Scan Settings
          </h2>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                Scan Depth
              </label>
              <input
                type="number"
                value={scanDepth}
                min={1}
                max={50}
                onChange={(e) => setScanDepth(Number(e.target.value) || 4)}
                className="w-20 px-2 py-1 text-sm text-right bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
              />
            </div>
            <input
              type="range"
              min={1}
              max={50}
              step={1}
              value={scanDepth}
              onChange={(e) => setScanDepth(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]"
            />
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              Number of recent messages scanned for keyword matches.
            </p>
          </div>

          <div className="pt-3 border-t border-[var(--color-border)]">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                Max Recursion Steps
              </label>
              <input
                type="number"
                value={maxRecursionSteps}
                min={0}
                max={10}
                onChange={(e) =>
                  setMaxRecursionSteps(Number(e.target.value) || 0)
                }
                className="w-20 px-2 py-1 text-sm text-right bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
              />
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={maxRecursionSteps}
              onChange={(e) => setMaxRecursionSteps(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]"
            />
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              How many times to rescan using matched entries' content as the
              haystack. 0 disables recursion.
            </p>
          </div>

          <div className="pt-3 border-t border-[var(--color-border)]">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                Token Budget
              </label>
              <input
                type="number"
                value={tokenBudget}
                min={0}
                max={32768}
                step={64}
                onChange={(e) => setTokenBudget(Number(e.target.value) || 0)}
                className="w-24 px-2 py-1 text-sm text-right bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
              />
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
              Max total tokens of injected entries. Constant and critical
              entries are exempt from trimming and count against the budget
              first; of the rest, entries with higher <code>order</code> are
              dropped first when over budget. 0 = unlimited.
            </p>
          </div>
        </section>

        {/* Lorebook health */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Lorebook health
          </h2>
          {health.reports.length === 0 ? (
            <p className="text-xs text-[var(--color-text-secondary)]">
              No active lorebooks — activate a book below to see its health.
            </p>
          ) : (
            <>
              <div
                className={`p-3 rounded-lg border ${
                  pinnedOverBudget
                    ? 'bg-red-500/10 border-red-500/30'
                    : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'
                }`}
              >
                <p
                  className={`text-sm ${
                    pinnedOverBudget
                      ? 'text-red-400 font-medium'
                      : 'text-[var(--color-text-primary)]'
                  }`}
                >
                  Pinned lore (constant + critical): ~{health.pinnedTotal}
                  {tokenBudget > 0 ? ` / ${tokenBudget}` : ''} tokens
                  {tokenBudget === 0 ? ' (no budget limit)' : ''}
                </p>
                {pinnedOverBudget && (
                  <p className="mt-1 text-xs text-red-400">
                    If every constant + critical entry fired at once they
                    would exceed the budget on their own — raise the budget,
                    narrow scope, or demote entries. (Keyword-gated critical
                    entries only cost tokens when they actually fire.)
                  </p>
                )}
              </div>
              <ul className="space-y-2">
                {health.reports.map(({ book, audit, lintErrors, lintWarnings }) => (
                  <li
                    key={book.id}
                    className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]"
                  >
                    <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                      {book.name}
                    </p>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      {audit.entryCount} enabled · {audit.constantCount}{' '}
                      constant · {audit.criticalCount} critical · ~
                      {audit.pinnedTokens} pinned tokens
                    </p>
                    {lintErrors > 0 && (
                      <p className="mt-1 text-xs text-red-400">
                        {lintErrors} entr{lintErrors === 1 ? 'y' : 'ies'} can
                        never fire — open the book to fix.
                      </p>
                    )}
                    {lintWarnings > 0 && (
                      <p className="mt-1 text-xs text-amber-400">
                        {lintWarnings} entr{lintWarnings === 1 ? 'y' : 'ies'}{' '}
                        need{lintWarnings === 1 ? 's' : ''} attention.
                      </p>
                    )}
                    {audit.constantShare > 0.2 && (
                      <p className="mt-1 text-xs text-amber-400">
                        Over 20% constant — consider demoting some.
                      </p>
                    )}
                    {audit.criticalCount > 5 && (
                      <p className="mt-1 text-xs text-amber-400">
                        More than a handful marked critical — if everything is
                        critical, nothing is.
                      </p>
                    )}
                    {audit.danglingRelated.length > 0 && (
                      <p className="mt-1 text-xs text-amber-400">
                        {audit.danglingRelated.length} broken related-entry
                        link
                        {audit.danglingRelated.length === 1 ? '' : 's'}.
                      </p>
                    )}
                    {audit.inactiveRelated.length > 0 && (
                      <p className="mt-1 text-xs text-amber-400">
                        {audit.inactiveRelated.length} related-entry link
                        {audit.inactiveRelated.length === 1 ? '' : 's'} point
                        {audit.inactiveRelated.length === 1 ? 's' : ''} at a
                        disabled or empty entry — the chain silently stops
                        there.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* Lorebooks */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Lorebooks
            </h2>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFileSelected}
              className="hidden"
            />
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                title="Generate from chat"
                onClick={() => {
                  setGenError(null);
                  setIsChatPickerOpen(true);
                }}
                className="text-xs gap-1.5"
              >
                <Sparkles size={14} />
                <span className="hidden sm:inline">Generate from chat</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Add document"
                onClick={() => setIsAddDocumentOpen(true)}
                className="text-xs gap-1.5"
              >
                <FileText size={14} />
                <span className="hidden sm:inline">Add document</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Import"
                onClick={handleImportClick}
                className="text-xs gap-1.5"
              >
                <Upload size={14} />
                <span className="hidden sm:inline">Import</span>
              </Button>
            </div>
          </div>

          {/* Scope filter + entry search (Lorebook v2 Phase 3) */}
          <div className="mb-3 space-y-2">
            <LibraryFilterBar
              scope={scope}
              onScopeChange={(s) => {
                setScope(s);
                // The row being renamed may no longer be visible under the
                // new scope — always clear rather than special-casing it.
                setRenamingId(null);
                setRenameValue('');
                // Phase 5 staleness model: "last successful fetch until the
                // user asks again" — fetch once on first entry into the tab,
                // not on every switch back into it (the header refresh
                // button below covers "ask again").
                if (s === 'shared' && sharedBooksStatus === 'idle') {
                  fetchSharedBooks();
                }
              }}
              counts={segmentCounts}
            />
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] pointer-events-none"
              />
              <Input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search entries in all books..."
                className="pl-9 pr-8"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {isSearching && (
              <p className="text-xs text-[var(--color-text-secondary)]">
                Searching entries in all books — the scope filter above is
                ignored while searching.
              </p>
            )}
          </div>

          {scope === 'shared' ? (
            <div className="flex items-center justify-between mb-3 gap-2">
              <p className="text-xs text-[var(--color-text-secondary)]">
                Books your group members have marked shared.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchSharedBooks()}
                disabled={sharedBooksStatus === 'loading'}
                className="text-xs shrink-0"
              >
                <RefreshCw
                  size={14}
                  className={`mr-1 ${sharedBooksStatus === 'loading' ? 'animate-spin' : ''}`}
                />
                Refresh
              </Button>
            </div>
          ) : (
            <div className="flex gap-2 mb-3">
              <Input
                value={newBookName}
                onChange={(e) => setNewBookName(e.target.value)}
                placeholder="New lorebook name..."
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                className="flex-1"
              />
              <Button
                onClick={handleCreate}
                disabled={!newBookName.trim()}
                className="shrink-0"
                size="sm"
              >
                <Plus size={14} className="mr-1" />
                Create
              </Button>
            </div>
          )}

          {isSearching ? (
            <EntrySearchResults
              hits={searchHits}
              query={deferredQuery}
              onOpenEntry={(bookId, entryId) => {
                const book = books.find((b) => b.id === bookId);
                if (book) {
                  setEditingBook(book);
                  setInitialEntryId(entryId);
                }
              }}
            />
          ) : scope === 'shared' ? (
            sharedBooksStatus === 'loading' ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-text-secondary)]">
                <Loader2 size={16} className="animate-spin" />
                Loading shared lorebooks…
              </div>
            ) : sharedBooksStatus === 'error' ? (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-red-400">
                      {sharedBooksError || 'Could not load shared lorebooks.'}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => fetchSharedBooks()}
                      className="mt-2 text-xs"
                    >
                      <RefreshCw size={14} className="mr-1" />
                      Retry
                    </Button>
                  </div>
                </div>
              </div>
            ) : sharedBooks.length === 0 ? (
              <div className="text-center py-10">
                <BookOpen
                  size={48}
                  className="mx-auto text-[var(--color-text-secondary)] mb-3"
                />
                <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
                  {EMPTY_STATE_COPY.shared.title}
                </h3>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {EMPTY_STATE_COPY.shared.body}
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {sharedBooks.map((book) => {
                  const isActive = activeBookIds.includes(book.id);
                  const tokenEstimate = sharedTokenEstimatesByBookId.get(book.id) ?? 0;
                  return (
                    <LibraryBookRow
                      key={book.id}
                      readOnly
                      book={book}
                      isActive={isActive}
                      ownerCharacter={null}
                      attachments={EMPTY_ATTACHMENTS}
                      tokenEstimate={tokenEstimate}
                      isRenaming={false}
                      renameValue=""
                      onRenameValueChange={() => {}}
                      onFinishRename={() => {}}
                      onCancelRename={() => {}}
                      onStartRename={() => {}}
                      onToggleActive={() => toggleBookActive(book.id)}
                      onOpen={() => {
                        setEditingBook(book);
                        setInitialEntryId(undefined);
                      }}
                      onDuplicate={() => {}}
                      onExport={() => {}}
                      onDelete={() => {}}
                      onCopyToLibrary={() => {
                        const copy = copySharedBook(book.id);
                        if (copy) {
                          setImportNotice(`Copied "${copy.name}" to your library`);
                          setTimeout(() => setImportNotice(null), 4000);
                        }
                      }}
                    />
                  );
                })}
              </ul>
            )
          ) : scopedBooks.length === 0 ? (
            <div className="text-center py-10">
              <BookOpen
                size={48}
                className="mx-auto text-[var(--color-text-secondary)] mb-3"
              />
              <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
                {EMPTY_STATE_COPY[scope].title}
              </h3>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {EMPTY_STATE_COPY[scope].body}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {scopedBooks.map((book) => {
                const isActive = activeBookIds.includes(book.id);
                const isRenaming = renamingId === book.id;
                const ownerCharacter = book.ownerCharacterAvatar
                  ? resolveCharacter(book.ownerCharacterAvatar)
                  : null;
                const bookAttachments = attachments.get(book.id) ?? EMPTY_ATTACHMENTS;
                const tokenEstimate = tokenEstimatesByBookId.get(book.id) ?? 0;
                return (
                  <LibraryBookRow
                    key={book.id}
                    book={book}
                    isActive={isActive}
                    ownerCharacter={ownerCharacter}
                    attachments={bookAttachments}
                    tokenEstimate={tokenEstimate}
                    isRenaming={isRenaming}
                    renameValue={renameValue}
                    onRenameValueChange={setRenameValue}
                    onFinishRename={handleFinishRename}
                    onCancelRename={() => {
                      setRenamingId(null);
                      setRenameValue('');
                    }}
                    onStartRename={() => handleStartRename(book)}
                    onToggleActive={() => toggleBookActive(book.id)}
                    onOpen={() => {
                      setEditingBook(book);
                      setInitialEntryId(undefined);
                    }}
                    onDuplicate={() => duplicateBook(book.id)}
                    onExport={() => handleExport(book)}
                    onDelete={() => setConfirmDelete(book)}
                    onOwnerChipClick={(avatar) => setEditingCharacterAvatar(avatar)}
                    attachmentsSlot={
                      <BookAttachmentChips
                        attachments={bookAttachments}
                        resolveCharacter={resolveCharacter}
                        onCharacterClick={(avatar) => setEditingCharacterAvatar(avatar)}
                      />
                    }
                    conflictCount={conflictCountsByBookId.get(book.id) ?? 0}
                    onResolveConflicts={() => setConflictSheetBookId(book.id)}
                  />
                );
              })}
            </ul>
          )}
        </section>

        <section className="text-center py-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Lorebooks sync across your devices, and books you mark shared sync to
            your group. Active books are scanned against recent messages;
            matching entries are injected at their configured position.
          </p>
        </section>
      </div>

      {editingBook && (
        <WorldInfoBookEditor
          isOpen={!!editingBook}
          onClose={() => {
            setEditingBook(null);
            setInitialEntryId(undefined);
          }}
          book={books.find((b) => b.id === editingBook.id) || editingBook}
          initialEntryId={initialEntryId}
          // editingBook can come from the "Shared with me" tab's raw
          // sharedBooks entry (see onOpen below), which won't be in the
          // viewer's own `books` — createEntry/updateEntry/deleteEntry are
          // either silent no-ops or, on an id collision, misdirected writes
          // to one of the viewer's own books for an id absent from `books`,
          // so gate every mutating control off the same own-books check
          // used to resolve `book` just above.
          readOnly={!books.some((b) => b.id === editingBook.id)}
        />
      )}

      {confirmDelete && (() => {
        const ownerChar = confirmDelete.ownerCharacterAvatar
          ? resolveCharacter(confirmDelete.ownerCharacterAvatar)
          : null;
        const message = ownerChar
          ? `Delete "${confirmDelete.name}" and all its entries? This cannot be undone. It will stop auto-activating in ${ownerChar.name}'s chats.`
          : `Delete "${confirmDelete.name}" and all its entries? This cannot be undone.`;
        return (
          <ConfirmDialog
            isOpen={!!confirmDelete}
            onClose={() => setConfirmDelete(null)}
            onConfirm={() => {
              deleteBook(confirmDelete.id);
              setConfirmDelete(null);
            }}
            title="Delete Lorebook"
            message={message}
            confirmLabel="Delete"
            danger
          />
        );
      })()}

      {editingCharacterAvatar && (() => {
        const character = characters.find((c) => c.avatar === editingCharacterAvatar);
        return character ? (
          <CharacterEdit
            isOpen
            character={character}
            onClose={() => setEditingCharacterAvatar(null)}
          />
        ) : null;
      })()}

      <ChatPickerModal
        isOpen={isChatPickerOpen}
        onClose={() => setIsChatPickerOpen(false)}
        onSelect={handleChatSelected}
      />

      <ConflictResolutionSheet
        isOpen={conflictSheetBookId !== null}
        onClose={() => setConflictSheetBookId(null)}
        scope={{ kind: 'book', bookId: conflictSheetBookId ?? '' }}
      />

      <AddDocumentModal
        isOpen={isAddDocumentOpen}
        onClose={() => setIsAddDocumentOpen(false)}
        onCreated={(book) => {
          setImportNotice(
            `Created "${book.name}" with ${book.entries.length} entr${book.entries.length === 1 ? 'y' : 'ies'}`
          );
          setTimeout(() => setImportNotice(null), 4000);
        }}
      />

      {genLoading && (
        <Modal isOpen={genLoading} onClose={() => {}} title="Loading chat" size="sm">
          <div className="flex items-center gap-2 py-2 text-sm text-[var(--color-text-secondary)]">
            <Loader2 size={16} className="animate-spin" />
            Loading chat messages…
          </div>
        </Modal>
      )}

      {pendingGen && (
        <GenerateLorebookModal
          isOpen={!!pendingGen}
          onClose={() => setPendingGen(null)}
          messages={pendingGen.messages}
          characterName={pendingGen.characterName}
          characterAvatar={pendingGen.characterAvatar}
          defaultBookName={pendingGen.defaultBookName}
          onCreated={(book) => {
            setImportNotice(
              `Created "${book.name}" with ${book.entries.length} entr${book.entries.length === 1 ? 'y' : 'ies'}`
            );
            setTimeout(() => setImportNotice(null), 4000);
          }}
        />
      )}
    </div>
  );
}
