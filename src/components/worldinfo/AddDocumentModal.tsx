/**
 * AddDocumentModal — paste or upload plain text, chunk it, and create a new
 * Lorebook from it (one semantic-only entry per chunk). This is the surviving
 * UI for what used to be the standalone "Data Bank" settings page — see
 * dataBankStore.ts's module docstring for why a "document" IS a Lorebook now.
 *
 * Unlike GenerateLorebookModal there's no model call to stream: addDocument()
 * is a synchronous, optimistic local write, so this is a single-phase form.
 */
import { useEffect, useRef, useState } from 'react';
import { FileText, Globe, User } from 'lucide-react';
import { Modal, Button, Input, TextArea } from '../ui';
import { useDataBankStore, embeddingsConfigured } from '../../stores/dataBankStore';
import { useWorldInfoStore, type WorldInfoBook } from '../../stores/worldInfoStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useSettingsStore } from '../../stores/settingsStore';

interface AddDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (book: WorldInfoBook) => void;
}

export function AddDocumentModal({ isOpen, onClose, onCreated }: AddDocumentModalProps) {
  const characters = useCharacterStore((s) => s.characters);
  const addDocument = useDataBankStore((s) => s.addDocument);
  const hasEmbeddingsKey = embeddingsConfigured(
    useSettingsStore((s) => s.secrets),
    useSettingsStore((s) => s.globalSecrets),
    useSettingsStore((s) => s.globalSharingEnabled),
  );

  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<'global' | 'character'>('global');
  const [charAvatar, setCharAvatar] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset on every open — same convention as GenerateLorebookModal.
  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setContent('');
    setScope('global');
    setCharAvatar('');
    setError(null);
  }, [isOpen]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setContent(text ?? '');
      if (!name) setName(file.name.replace(/\.[^.]+$/, ''));
    };
    reader.onerror = () => setError(`Failed to read "${file.name}"`);
    reader.readAsText(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  const handleAdd = () => {
    if (!content.trim() || (scope === 'character' && !charAvatar)) return;
    setError(null);
    try {
      const bookId = addDocument(
        name,
        content,
        scope,
        scope === 'character' ? charAvatar || undefined : undefined
      );
      // addDocument's local write is synchronous — the fresh book is already
      // in worldInfoStore's state by the time this returns (same idiom as
      // GenerateLorebookModal.handleCreate's "read the fresh copy" comment).
      const book = useWorldInfoStore.getState().books.find((b) => b.id === bookId);
      if (book) onCreated?.(book);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add document');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add document" size="md">
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Paste or upload text — it's chunked automatically into a new lorebook, one entry per
          chunk. Relevant chunks are injected into context the same way any other lorebook entry
          is.
        </p>

        <Input
          label="Document name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Untitled"
        />

        <div>
          <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
            Scope
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setScope('global')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                scope === 'global'
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
              }`}
            >
              <Globe size={12} /> Global
            </button>
            <button
              type="button"
              onClick={() => setScope('character')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                scope === 'character'
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
              }`}
            >
              <User size={12} /> Character
            </button>
          </div>
        </div>

        {scope === 'character' && (
          <select
            value={charAvatar}
            onChange={(e) => setCharAvatar(e.target.value)}
            className="w-full text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
          >
            <option value="">— Select character —</option>
            {characters.map((c) => (
              <option key={c.avatar} value={c.avatar}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        <TextArea
          label="Content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste text content here…"
          rows={6}
          className="font-mono text-sm"
        />

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.markdown"
            onChange={handleFileChange}
            className="hidden"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileRef.current?.click()}
            className="text-xs"
          >
            <FileText size={14} className="mr-1.5" /> Upload .txt / .md
          </Button>
        </div>

        {!hasEmbeddingsKey && (
          <p className="text-xs text-amber-400">
            No embeddings key set (Settings → AI Settings) — this document's chunks won't
            become semantically searchable until one is saved.
          </p>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!content.trim() || (scope === 'character' && !charAvatar)}>
            Add document
          </Button>
        </div>
      </div>
    </Modal>
  );
}
