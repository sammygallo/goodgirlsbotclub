import { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Edit2,
  Download,
  Upload,
  Copy,
  BookOpen,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  useWorldInfoStore,
  auditBookHealth,
  type WorldInfoBook,
} from '../../stores/worldInfoStore';
import { profileForProvider } from '../../utils/tokenizer';
import { lintBook, worstSeverity } from '../../utils/lorebookLint';
import { Button, Input, ConfirmDialog, Modal } from '../ui';
import { WorldInfoBookEditor } from './WorldInfoBookEditor';
import { ChatPickerModal, type ChatSelection } from './ChatPickerModal';
import { GenerateLorebookModal } from './GenerateLorebookModal';
import { api } from '../../api/client';
import type { TranscriptMsg } from '../../utils/lorebookFromTranscript';

export function WorldInfoPage(_props?: { params?: Record<string, string> }) {
  const { goBack } = useSettingsPanelStore();
  const {
    books,
    activeBookIds,
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
  } = useWorldInfoStore();

  const [newBookName, setNewBookName] = useState('');
  const [editingBook, setEditingBook] = useState<WorldInfoBook | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<WorldInfoBook | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // "Generate from chat" flow: pick a chat → load its messages → review modal.
  const [isChatPickerOpen, setIsChatPickerOpen] = useState(false);
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

  // Character-embedded books are managed from the character editor; hide
  // them from the global lorebook list to avoid confusion.
  const globalBooks = books.filter((b) => b.ownerCharacterAvatar == null);
  const charOwnedCount = books.length - globalBooks.length;

  // Lorebook health: audit each active book against the active provider's
  // tokenizer profile. Memoized — never build fresh arrays inside zustand
  // selectors (React #185 churn hazard).
  const activeProvider = useSettingsStore((s) => s.activeProvider);
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
                onClick={() => {
                  setGenError(null);
                  setIsChatPickerOpen(true);
                }}
                className="text-xs"
              >
                <Sparkles size={14} className="mr-1" />
                Generate from chat
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleImportClick}
                className="text-xs"
              >
                <Upload size={14} className="mr-1" />
                Import
              </Button>
            </div>
          </div>

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

          {globalBooks.length === 0 ? (
            <div className="text-center py-10">
              <BookOpen
                size={48}
                className="mx-auto text-[var(--color-text-secondary)] mb-3"
              />
              <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
                No lorebooks yet
              </h3>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Create one above, or import an existing World Info JSON.
              </p>
              {charOwnedCount > 0 && (
                <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
                  {charOwnedCount} character-embedded lorebook
                  {charOwnedCount === 1 ? ' is' : 's are'} managed from the
                  character editor.
                </p>
              )}
            </div>
          ) : (
            <ul className="space-y-2">
              {globalBooks.map((book) => {
                const isActive = activeBookIds.includes(book.id);
                const isRenaming = renamingId === book.id;
                return (
                  <li
                    key={book.id}
                    className={`
                      p-3 rounded-lg border transition-colors
                      ${
                        isActive
                          ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]'
                          : 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)]'
                      }
                    `}
                  >
                    <div className="flex items-center gap-2">
                      <label className="flex items-center cursor-pointer flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={isActive}
                          onChange={() => toggleBookActive(book.id)}
                          className="w-4 h-4 accent-[var(--color-primary)]"
                          aria-label={`${isActive ? 'Deactivate' : 'Activate'} ${book.name}`}
                        />
                      </label>
                      {isRenaming ? (
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={handleFinishRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleFinishRename();
                            if (e.key === 'Escape') {
                              setRenamingId(null);
                              setRenameValue('');
                            }
                          }}
                          autoFocus
                          className="flex-1 px-2 py-1 text-sm bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                        />
                      ) : (
                        <button
                          onClick={() => setEditingBook(book)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                            {book.name}
                          </p>
                          <p className="text-xs text-[var(--color-text-secondary)]">
                            {book.entries.length} entr
                            {book.entries.length === 1 ? 'y' : 'ies'}
                            {isActive ? ' · active' : ''}
                          </p>
                        </button>
                      )}
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <button
                          onClick={() => handleStartRename(book)}
                          className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
                          title="Rename"
                          aria-label="Rename lorebook"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => duplicateBook(book.id)}
                          className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
                          title="Duplicate"
                          aria-label="Duplicate lorebook"
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          onClick={() => handleExport(book)}
                          className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)]"
                          title="Export JSON"
                          aria-label="Export lorebook"
                        >
                          <Download size={14} />
                        </button>
                        <button
                          onClick={() => setConfirmDelete(book)}
                          className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10"
                          title="Delete"
                          aria-label="Delete lorebook"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="text-center py-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Lorebooks are stored locally. Active books are scanned against recent
            messages; matching entries are injected at their configured position.
          </p>
          {globalBooks.length > 0 && charOwnedCount > 0 && (
            <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
              {charOwnedCount} character-embedded lorebook
              {charOwnedCount === 1 ? '' : 's'} hidden (managed from the
              character editor).
            </p>
          )}
        </section>
      </div>

      {editingBook && (
        <WorldInfoBookEditor
          isOpen={!!editingBook}
          onClose={() => setEditingBook(null)}
          book={books.find((b) => b.id === editingBook.id) || editingBook}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          isOpen={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteBook(confirmDelete.id);
            setConfirmDelete(null);
          }}
          title="Delete Lorebook"
          message={`Delete "${confirmDelete.name}" and all its entries? This cannot be undone.`}
          confirmLabel="Delete"
          danger
        />
      )}

      <ChatPickerModal
        isOpen={isChatPickerOpen}
        onClose={() => setIsChatPickerOpen(false)}
        onSelect={handleChatSelected}
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
