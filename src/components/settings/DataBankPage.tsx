/**
 * Phase 8.5 — Data Bank / RAG
 *
 * Lets users upload or paste plain-text documents, chunk + embed them via
 * OpenAI's text-embedding-3-small model, and manage per-character or global
 * scope. Embedded chunks are automatically injected into the system prompt at
 * generation time based on relevance to the user's last message.
 */

import { useRef, useState } from 'react';
import {
  ArrowLeft,
  Database,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Key,
  Loader2,
  Plus,
  Trash2,
  User,
  Zap,
} from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useDataBankStore, embeddingsConfigured, type DataBankDocument } from '../../stores/dataBankStore';
import { useChatHistoryRagStore } from '../../stores/chatHistoryRagStore';
import { useCharacterStore } from '../../stores/characterStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui';

// ---------------------------------------------------------------------------
// Add-document form
// ---------------------------------------------------------------------------

interface AddFormProps {
  onAdd: (name: string, content: string, scope: 'global' | 'character', characterAvatar?: string) => void;
  characters: { name: string; avatar: string }[];
}

function AddDocumentForm({ onAdd, characters }: AddFormProps) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<'global' | 'character'>('global');
  const [charAvatar, setCharAvatar] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setContent(text ?? '');
      if (!name) setName(file.name.replace(/\.[^.]+$/, ''));
    };
    reader.readAsText(file);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  const handleAdd = () => {
    if (!content.trim()) return;
    onAdd(name, content, scope, scope === 'character' ? charAvatar : undefined);
    setName('');
    setContent('');
    setScope('global');
    setCharAvatar('');
    setIsExpanded(false);
  };

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="w-full flex items-center gap-3 p-4 bg-[var(--color-bg-secondary)] rounded-lg text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        <Plus size={18} className="text-[var(--color-primary)] shrink-0" />
        <span className="text-sm text-[var(--color-text-primary)]">Add document</span>
      </button>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
      <p className="text-sm font-medium text-[var(--color-text-primary)]">Add document</p>

      {/* Name */}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Document name (optional)"
        className="w-full text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
      />

      {/* Scope toggle */}
      <div className="flex gap-2">
        <button
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

      {/* Character picker */}
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

      {/* Content */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Paste text content here…"
        rows={6}
        className="w-full text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] resize-none font-mono"
      />

      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" accept=".txt,.md,.markdown" onChange={handleFileChange} className="hidden" />
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] transition-colors"
        >
          <FileText size={12} /> Upload .txt / .md
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setIsExpanded(false)}
          className="text-xs text-[var(--color-text-secondary)] px-3 py-1.5"
        >
          Cancel
        </button>
        <Button size="sm" onClick={handleAdd} disabled={!content.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document card
// ---------------------------------------------------------------------------

interface DocCardProps {
  doc: DataBankDocument;
  isEmbedding: boolean;
  hasApiKey: boolean;
  onEmbed: (id: string) => void;
  onDelete: (id: string) => void;
  characterName?: string;
}

function DocCard({ doc, isEmbedding, hasApiKey, onEmbed, onDelete, characterName }: DocCardProps) {
  const [showContent, setShowContent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-[var(--color-primary)]/15 flex items-center justify-center shrink-0 mt-0.5">
          <Database size={15} className="text-[var(--color-primary)]" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--color-text-primary)] truncate">
              {doc.name}
            </span>
            {/* Scope badge */}
            <span
              className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                doc.scope === 'global'
                  ? 'bg-blue-500/15 text-blue-400'
                  : 'bg-purple-500/15 text-purple-400'
              }`}
            >
              {doc.scope === 'global' ? 'global' : characterName ?? doc.characterAvatar ?? 'character'}
            </span>
            {/* Embedded badge */}
            {doc.isEmbedded && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/15 text-green-400">
                embedded
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            {doc.chunks.length} chunk{doc.chunks.length !== 1 ? 's' : ''} · {doc.content.length.toLocaleString()} chars
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Preview toggle */}
          <button
            onClick={() => setShowContent((v) => !v)}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            title={showContent ? 'Hide content' : 'Preview content'}
          >
            {showContent ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>

          {/* Embed button */}
          {!doc.isEmbedded && (
            <button
              onClick={() => onEmbed(doc.id)}
              disabled={isEmbedding || !hasApiKey}
              title={hasApiKey ? 'Embed document' : 'Set an OpenAI API key first'}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-primary)] transition-colors disabled:opacity-40"
            >
              {isEmbedding ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
            </button>
          )}

          {/* Delete */}
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => { onDelete(doc.id); setConfirmDelete(false); }}
                className="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs px-2 py-1 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-[var(--color-bg-tertiary)] transition-colors"
              title="Delete document"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Content preview */}
      {showContent && (
        <div className="px-4 pb-3">
          <pre className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap font-mono">
            {doc.content.slice(0, 2000)}{doc.content.length > 2000 ? '\n…' : ''}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DataBankPage(_props?: { params?: Record<string, string> }) {
  const { goBack } = useSettingsPanelStore();
  const {
    documents,
    embeddingIds,
    setEmbeddingsApiKey,
    addDocument,
    deleteDocument,
    embedDocument,
  } = useDataBankStore();

  const characters = useCharacterStore((s) => s.characters);
  const secrets = useSettingsStore((s) => s.secrets);
  const hasKey = embeddingsConfigured(secrets);

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);

  const handleSaveKey = async () => {
    const v = apiKeyInput.trim();
    if (!v) return;
    setEmbedError(null);
    try {
      await setEmbeddingsApiKey(v);
      setApiKeyInput('');
    } catch (e) {
      setEmbedError(e instanceof Error ? e.message : 'Failed to save key');
    }
  };

  const handleEmbed = async (id: string) => {
    setEmbedError(null);
    try {
      await embedDocument(id);
    } catch (e) {
      setEmbedError(e instanceof Error ? e.message : 'Embedding failed');
    }
  };

  const handleAdd = (
    name: string,
    content: string,
    scope: 'global' | 'character',
    characterAvatar?: string
  ) => {
    addDocument(name, content, scope, characterAvatar);
  };

  // Build character lookup for badge labels
  const charByAvatar = Object.fromEntries(
    characters.map((c) => [c.avatar, c.name])
  );

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="sticky top-0 z-10 h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => goBack()}
          className="p-2"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </Button>
        <h1 className="text-base font-semibold text-[var(--color-text-primary)]">Data Bank</h1>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* API key section */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Key size={16} className="text-[var(--color-primary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              OpenAI Embeddings API Key
            </h2>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Required to embed documents and perform similarity search. Uses{' '}
            <span className="font-mono">text-embedding-3-small</span>. Stored securely on the
            server; the key never reaches your browser.
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={hasKey ? '•••• configured — enter to replace' : 'sk-…'}
                className="w-full text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 pr-9 text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
              <button
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]"
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button
              size="sm"
              onClick={handleSaveKey}
              disabled={!apiKeyInput.trim()}
            >
              Save
            </Button>
          </div>
          {hasKey && (
            <p className="text-xs text-green-400">
              Embeddings key configured. Documents can now be embedded.
            </p>
          )}
        </section>

        {/* Chat memory — semantic retrieval over past chat turns */}
        <ChatHistoryRagSection />

        {/* Embed error */}
        {embedError && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
            {embedError}
          </div>
        )}

        {/* Documents */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              Documents ({documents.length})
            </h2>
          </div>

          {documents.length === 0 && (
            <p className="text-sm text-[var(--color-text-secondary)] text-center py-8">
              No documents yet. Add one below.
            </p>
          )}

          {documents.map((doc) => (
            <DocCard
              key={doc.id}
              doc={doc}
              isEmbedding={embeddingIds.has(doc.id)}
              hasApiKey={hasKey}
              onEmbed={handleEmbed}
              onDelete={deleteDocument}
              characterName={doc.characterAvatar ? charByAvatar[doc.characterAvatar] : undefined}
            />
          ))}

          <AddDocumentForm onAdd={handleAdd} characters={characters.map((c) => ({ name: c.name, avatar: c.avatar ?? '' }))} />
        </div>

        {/* How it works */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">How it works</h2>
          <ul className="text-xs text-[var(--color-text-secondary)] space-y-1 list-disc list-inside">
            <li>Upload or paste documents (lore, wiki pages, character backstory, etc.)</li>
            <li>Click ⚡ to embed a document — this calls OpenAI once per chunk</li>
            <li>At generation time, the most relevant chunks are automatically injected into the system prompt</li>
            <li>
              <span className="text-blue-400">Global</span> documents are available in every chat;{' '}
              <span className="text-purple-400">character</span> documents are only used when chatting with that character
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat-history RAG settings — embeds older chat turns so the model can
// recall specific past moments by relevance, instead of carrying everything
// in raw history. Shares the OpenAI embeddings key with the Data Bank.
// ---------------------------------------------------------------------------

function ChatHistoryRagSection() {
  const enabled = useChatHistoryRagStore((s) => s.enabled);
  const setEnabled = useChatHistoryRagStore((s) => s.setEnabled);
  const embeddingsByChat = useChatHistoryRagStore((s) => s.embeddingsByChat);
  const hasKey = embeddingsConfigured(useSettingsStore((s) => s.secrets));

  const totalChats = Object.keys(embeddingsByChat).length;
  const totalEmbeddings = Object.values(embeddingsByChat).reduce(
    (sum, arr) => sum + arr.length,
    0
  );

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Chat memory (semantic recall)
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled(!enabled)}
          className={`relative w-9 h-5 rounded-full transition-colors ${
            enabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-bg-tertiary)]'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      <p className="text-xs text-[var(--color-text-secondary)]">
        Embeds older chat turns so the AI can recall past moments by relevance
        — pairs well with summary compaction. Costs one OpenAI embedding call
        per new message and uses the API key above.
      </p>
      {enabled && !hasKey && (
        <p className="text-xs text-amber-400">
          No OpenAI embeddings key set — chat memory is inactive until you save one above.
        </p>
      )}
      {enabled && hasKey && totalEmbeddings > 0 && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {totalEmbeddings} message{totalEmbeddings === 1 ? '' : 's'} embedded across {totalChats} chat{totalChats === 1 ? '' : 's'}.
        </p>
      )}
    </section>
  );
}
