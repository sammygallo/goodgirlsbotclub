/**
 * Embeddings API key card + chat-memory toggle — shared between MyKeysPage
 * (restricted-permission users' key page) and AISettingsPage (the full
 * settings page most users actually reach). Both need this: the embeddings
 * key powers Lorebook semantic search server-side, not just the
 * chat-memory feature below it. Extracted to one place rather than
 * duplicated in both pages, so the two never drift out of sync.
 */
import { useEffect, useState } from 'react';
import { Eye, EyeOff, Key } from 'lucide-react';
import { api } from '../../api/client';
import { useSettingsStore } from '../../stores/settingsStore';
import { useDataBankStore, embeddingsConfigured } from '../../stores/dataBankStore';
import { useChatHistoryRagStore } from '../../stores/chatHistoryRagStore';
import { Button, Input } from '../ui';

export function EmbeddingsApiKeySection() {
  const secrets = useSettingsStore((s) => s.secrets);
  const globalSecrets = useSettingsStore((s) => s.globalSecrets);
  const globalSharingEnabled = useSettingsStore((s) => s.globalSharingEnabled);
  const setEmbeddingsApiKey = useDataBankStore((s) => s.setEmbeddingsApiKey);
  const hasEmbeddingsKey = embeddingsConfigured(secrets, globalSecrets, globalSharingEnabled);

  const [embedKeyInput, setEmbedKeyInput] = useState('');
  const [showEmbedKey, setShowEmbedKey] = useState(false);
  const [embedKeyError, setEmbedKeyError] = useState<string | null>(null);

  const handleSaveEmbeddingsKey = async () => {
    const v = embedKeyInput.trim();
    if (!v) return;
    setEmbedKeyError(null);
    try {
      await setEmbeddingsApiKey(v);
      setEmbedKeyInput('');
    } catch (e) {
      setEmbedKeyError(e instanceof Error ? e.message : 'Failed to save key');
    }
  };

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3 cyberpunk-card">
      <div className="flex items-center gap-2">
        <Key size={16} className="text-[var(--color-primary)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
          OpenAI Embeddings API Key
        </h2>
      </div>
      <p className="text-xs text-[var(--color-text-secondary)]">
        Powers semantic search for lorebooks and chat memory. Stored securely on the server; the
        key never reaches your browser.
      </p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={showEmbedKey ? 'text' : 'password'}
            value={embedKeyInput}
            onChange={(e) => setEmbedKeyInput(e.target.value)}
            placeholder={hasEmbeddingsKey ? '•••• configured — enter to replace' : 'sk-…'}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowEmbedKey((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            {showEmbedKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <Button onClick={handleSaveEmbeddingsKey} disabled={!embedKeyInput.trim()} className="shrink-0">
          Save
        </Button>
      </div>
      {embedKeyError && <p className="text-xs text-red-400">{embedKeyError}</p>}
      {hasEmbeddingsKey && (
        <p className="text-xs text-green-400">
          Embeddings key configured. New lorebook entries become searchable shortly after adding.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Chat-history RAG settings — embeds older chat turns so the model can
// recall specific past moments by relevance, instead of carrying everything
// in raw history. Shares the embeddings key with the card above. Relocated
// from the retired DataBankPage.tsx.
// ---------------------------------------------------------------------------

export function ChatHistoryRagSection() {
  const enabled = useChatHistoryRagStore((s) => s.enabled);
  const setEnabled = useChatHistoryRagStore((s) => s.setEnabled);
  const hasKey = embeddingsConfigured(
    useSettingsStore((s) => s.secrets),
    useSettingsStore((s) => s.globalSecrets),
    useSettingsStore((s) => s.globalSharingEnabled),
  );

  // Phase 2 of the memory-consolidation plan: embedding is server-side now
  // (a POST /chats/save side effect), so this counter comes from
  // GET /retrieval/messages/status instead of the old in-memory
  // embeddingsByChat cache, which only ever reflected the current
  // session's own work and reset to zero on every reload.
  const [status, setStatus] = useState<{ embedded: number; pending: number; failed: number } | null>(null);
  useEffect(() => {
    // Nothing renders `status` while disabled (see the JSX below), so
    // there's no need to reset it here — just skip the fetch.
    if (!enabled) return;
    let cancelled = false;
    api.getMessageEmbeddingsStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { /* non-fatal — the counter just stays hidden */ });
    return () => { cancelled = true; };
  }, [enabled]);

  return (
    <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-3 cyberpunk-card">
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
      {enabled && hasKey && status && status.embedded > 0 && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          {status.embedded} message{status.embedded === 1 ? '' : 's'} indexed
          {status.pending > 0 ? `, ${status.pending} more indexing` : ''}.
        </p>
      )}
      {enabled && hasKey && status && status.failed > 0 && (
        <p className="text-xs text-amber-400">
          {status.failed} chat{status.failed === 1 ? '' : 's'} failed to index — check that your
          OpenAI key above is valid, then re-save the chat to retry.
        </p>
      )}
    </section>
  );
}
