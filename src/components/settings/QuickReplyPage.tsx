import { useState } from 'react';
import { ArrowLeft, ChevronRight, ChevronDown, ChevronUp, Plus, Pencil, Trash2, Check, X, Zap } from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useQuickReplyStore, type QuickReplyEntry } from '../../stores/quickReplyStore';
import { Button, Input } from '../ui';

export function QuickReplyPage(_props?: { params?: Record<string, string> }) {
  const { goBack } = useSettingsPanelStore();
  const {
    sets,
    activeSetId,
    setActiveSet,
    createSet,
    renameSet,
    deleteSet,
    addEntry,
    updateEntry,
    deleteEntry,
    moveEntryUp,
    moveEntryDown,
  } = useQuickReplyStore();

  // null = set list view; string = entry list view for that set id
  const [viewSetId, setViewSetId] = useState<string | null>(null);
  const [newSetName, setNewSetName] = useState('');
  const [isAddingSet, setIsAddingSet] = useState(false);
  const [renamingSetId, setRenamingSetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Entry editing state
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [isAddingEntry, setIsAddingEntry] = useState(false);
  const [entryLabelDraft, setEntryLabelDraft] = useState('');
  const [entryMessageDraft, setEntryMessageDraft] = useState('');

  const currentSet = viewSetId ? sets.find((s) => s.id === viewSetId) ?? null : null;

  // ── Helpers ────────────────────────────────────────────────────

  const handleCreateSet = () => {
    const name = newSetName.trim();
    if (!name) return;
    createSet(name);
    setNewSetName('');
    setIsAddingSet(false);
  };

  const startRename = (id: string, currentName: string) => {
    setRenamingSetId(id);
    setRenameDraft(currentName);
  };

  const commitRename = () => {
    if (renamingSetId) renameSet(renamingSetId, renameDraft);
    setRenamingSetId(null);
    setRenameDraft('');
  };

  const handleDeleteSet = (id: string) => {
    deleteSet(id);
    if (viewSetId === id) setViewSetId(null);
  };

  const startAddEntry = () => {
    setEditingEntryId(null);
    setEntryLabelDraft('');
    setEntryMessageDraft('');
    setIsAddingEntry(true);
  };

  const startEditEntry = (entry: QuickReplyEntry) => {
    setIsAddingEntry(false);
    setEditingEntryId(entry.id);
    setEntryLabelDraft(entry.label);
    setEntryMessageDraft(entry.message);
  };

  const commitEntry = () => {
    if (!viewSetId) return;
    const label = entryLabelDraft.trim();
    const message = entryMessageDraft;
    if (!label || !message.trim()) return;
    if (isAddingEntry) {
      addEntry(viewSetId, label, message);
      setIsAddingEntry(false);
    } else if (editingEntryId) {
      updateEntry(viewSetId, editingEntryId, label, message);
      setEditingEntryId(null);
    }
    setEntryLabelDraft('');
    setEntryMessageDraft('');
  };

  const cancelEntry = () => {
    setIsAddingEntry(false);
    setEditingEntryId(null);
    setEntryLabelDraft('');
    setEntryMessageDraft('');
  };

  // ── Entry form (shared for add + edit) ───────────────────────
  // A plain element, not a nested component: a component closure recreated
  // each render would remount (and drop focus) on every keystroke.

  const entryForm = (
    <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3 space-y-2">
      <Input
        value={entryLabelDraft}
        onChange={(e) => setEntryLabelDraft(e.target.value)}
        placeholder="Button label (e.g. Hello!)"
        className="text-sm"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
          if (e.key === 'Escape') cancelEntry();
        }}
      />
      <textarea
        value={entryMessageDraft}
        onChange={(e) => setEntryMessageDraft(e.target.value)}
        placeholder="Message text sent to the AI…"
        rows={3}
        className="w-full bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] rounded-lg px-3 py-2 resize-none focus:outline-none border border-[var(--color-border)] focus:border-[var(--color-primary)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancelEntry();
        }}
      />
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={cancelEntry}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={commitEntry}
          disabled={!entryLabelDraft.trim() || !entryMessageDraft.trim()}
        >
          Save
        </Button>
      </div>
    </div>
  );

  // ── Entry list view ────────────────────────────────────────────

  if (currentSet) {
    return (
      <div className="min-h-screen bg-[var(--color-bg-primary)]">
        <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
          <Button variant="ghost" size="sm" className="p-2" onClick={() => setViewSetId(null)} aria-label="Back">
            <ArrowLeft size={24} />
          </Button>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)] flex-1 truncate">
            {currentSet.name}
          </h1>
          <Button type="button" variant="ghost" size="sm" className="p-2" onClick={startAddEntry} aria-label="Add entry">
            <Plus size={20} />
          </Button>
        </header>

        <div className="max-w-2xl mx-auto p-4 space-y-3">
          {isAddingEntry && entryForm}

          {currentSet.entries.length === 0 && !isAddingEntry && (
            <div className="text-center py-12 text-[var(--color-text-secondary)]">
              <Zap size={32} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">No entries yet.</p>
              <p className="text-xs mt-1">Tap + to add your first quick reply.</p>
            </div>
          )}

          {currentSet.entries.map((entry, idx) => {
            const isEditing = editingEntryId === entry.id;
            return (
              <div key={entry.id} className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden">
                {isEditing ? (
                  <div className="p-3">
                    {entryForm}
                  </div>
                ) : (
                  <div className="flex items-start gap-2 p-3">
                    {/* Reorder buttons */}
                    <div className="flex flex-col gap-0.5 flex-shrink-0 mt-0.5">
                      <button
                        type="button"
                        onClick={() => moveEntryUp(currentSet.id, entry.id)}
                        disabled={idx === 0}
                        className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-25 transition-colors"
                        aria-label="Move up"
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveEntryDown(currentSet.id, entry.id)}
                        disabled={idx === currentSet.entries.length - 1}
                        className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-25 transition-colors"
                        aria-label="Move down"
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>

                    {/* Label + message preview */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                        {entry.label}
                      </p>
                      <p className="text-xs text-[var(--color-text-secondary)] truncate mt-0.5">
                        {entry.message}
                      </p>
                    </div>

                    {/* Edit / Delete */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => startEditEntry(entry)}
                        className="p-1.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                        aria-label="Edit entry"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteEntry(currentSet.id, entry.id)}
                        className="p-1.5 rounded text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        aria-label="Delete entry"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Set list view ──────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button variant="ghost" size="sm" className="p-2" onClick={() => goBack()} aria-label="Back">
          <ArrowLeft size={24} />
        </Button>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Quick Replies</h1>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-6">
        {/* Active Set selector */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Active Set</h2>
          {sets.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)]">No sets yet. Create one below.</p>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setActiveSet(null)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeSetId === null
                    ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-medium'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                }`}
              >
                {activeSetId === null && <Check size={14} />}
                <span className={activeSetId === null ? '' : 'ml-[18px]'}>None (bar hidden)</span>
              </button>
              {sets.map((qs) => (
                <button
                  key={qs.id}
                  type="button"
                  onClick={() => setActiveSet(qs.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                    activeSetId === qs.id
                      ? 'bg-[var(--color-primary)]/20 text-[var(--color-primary)] font-medium'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                  }`}
                >
                  {activeSetId === qs.id ? <Check size={14} /> : <span className="w-[14px]" />}
                  <span className="flex-1 text-left truncate">{qs.name}</span>
                  <span className="text-xs opacity-60">{qs.entries.length} entries</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Manage Sets */}
        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Manage Sets</h2>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="p-1.5 flex items-center gap-1 text-xs"
              onClick={() => { setIsAddingSet(true); setNewSetName(''); }}
            >
              <Plus size={15} />
              New Set
            </Button>
          </div>

          {isAddingSet && (
            <div className="bg-[var(--color-bg-secondary)] rounded-lg p-3 flex items-center gap-2">
              <Input
                value={newSetName}
                onChange={(e) => setNewSetName(e.target.value)}
                placeholder="Set name…"
                className="flex-1 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleCreateSet(); }
                  if (e.key === 'Escape') setIsAddingSet(false);
                }}
              />
              <Button type="button" variant="primary" size="sm" className="p-1.5" onClick={handleCreateSet} disabled={!newSetName.trim()}>
                <Check size={16} />
              </Button>
              <Button type="button" variant="ghost" size="sm" className="p-1.5" onClick={() => setIsAddingSet(false)}>
                <X size={16} />
              </Button>
            </div>
          )}

          {sets.length === 0 && !isAddingSet && (
            <div className="text-center py-10 text-[var(--color-text-secondary)]">
              <Zap size={32} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">No sets yet.</p>
              <p className="text-xs mt-1">Create a set and add quick reply buttons to it.</p>
            </div>
          )}

          {sets.map((qs) => (
            <div key={qs.id} className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden">
              {renamingSetId === qs.id ? (
                <div className="flex items-center gap-2 p-3">
                  <Input
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    className="flex-1 text-sm"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      if (e.key === 'Escape') setRenamingSetId(null);
                    }}
                  />
                  <Button type="button" variant="primary" size="sm" className="p-1.5" onClick={commitRename} disabled={!renameDraft.trim()}>
                    <Check size={16} />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="p-1.5" onClick={() => setRenamingSetId(null)}>
                    <X size={16} />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3">
                  {/* Navigate into set */}
                  <button
                    type="button"
                    onClick={() => setViewSetId(qs.id)}
                    className="flex-1 flex items-center gap-3 py-3 text-left min-w-0"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">{qs.name}</p>
                      <p className="text-xs text-[var(--color-text-secondary)]">
                        {qs.entries.length === 0 ? 'No entries' : `${qs.entries.length} entr${qs.entries.length === 1 ? 'y' : 'ies'}`}
                      </p>
                    </div>
                    <ChevronRight size={16} className="text-[var(--color-text-secondary)] flex-shrink-0" />
                  </button>
                  {/* Rename */}
                  <button
                    type="button"
                    onClick={() => startRename(qs.id, qs.name)}
                    className="p-1.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    aria-label="Rename set"
                  >
                    <Pencil size={15} />
                  </button>
                  {/* Delete */}
                  <button
                    type="button"
                    onClick={() => handleDeleteSet(qs.id)}
                    className="p-1.5 rounded text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    aria-label="Delete set"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
