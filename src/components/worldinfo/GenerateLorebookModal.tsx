/**
 * GenerateLorebookModal — distill a chat transcript into a new lorebook.
 *
 * Flow: pre-flight (shows the model-call count) → generating (progress + cancel)
 * → review (edit/deselect drafts, name the book) → create. The actual extraction
 * lives in `src/utils/lorebookFromTranscript.ts`; this component owns the UI and
 * the final write into the world-info store.
 *
 * Shared by both entry points (in-chat options menu and the World Info page),
 * so it takes already-prepared `TranscriptMsg[]` rather than reaching into a
 * particular store for the active chat.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, Trash2, BookPlus } from 'lucide-react';
import { Modal, Button, Input, TextArea, TagInput } from '../ui';
import { useSettingsStore } from '../../stores/settingsStore';
import { useCharacterStore } from '../../stores/characterStore';
import {
  useWorldInfoStore,
  type WorldInfoBook,
} from '../../stores/worldInfoStore';
import {
  planChunks,
  extractLorebookEntries,
  type TranscriptMsg,
  type DraftLorebookEntry,
} from '../../utils/lorebookFromTranscript';

interface GenerateLorebookModalProps {
  isOpen: boolean;
  onClose: () => void;
  messages: TranscriptMsg[];
  characterName: string;
  defaultBookName: string;
  /**
   * Avatar of the character this chat belongs to. When provided, the new book
   * is auto-linked to that character so it activates automatically in their
   * chats — it stays its own standalone book (not merged into the character's
   * embedded/auto-memory book). Per-user only; never shared with other users.
   */
  characterAvatar?: string;
  onCreated?: (book: WorldInfoBook) => void;
}

type Phase = 'preflight' | 'generating' | 'review' | 'error';

interface EditableDraft extends DraftLorebookEntry {
  uid: number;
  enabled: boolean;
}

export function GenerateLorebookModal({
  isOpen,
  onClose,
  messages,
  characterName,
  defaultBookName,
  characterAvatar,
  onCreated,
}: GenerateLorebookModalProps) {
  const createBook = useWorldInfoStore((s) => s.createBook);
  const createEntry = useWorldInfoStore((s) => s.createEntry);

  const [phase, setPhase] = useState<Phase>('preflight');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const [bookName, setBookName] = useState(defaultBookName);
  const [error, setError] = useState<string | null>(null);
  const [truncatedNote, setTruncatedNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const chunkCount = planChunks(messages, characterName).length;

  // Reset everything each time the modal opens so a second run starts clean.
  useEffect(() => {
    if (!isOpen) return;
    setPhase('preflight');
    setProgress({ done: 0, total: chunkCount });
    setDrafts([]);
    setBookName(defaultBookName);
    setError(null);
    setTruncatedNote(null);
    // chunkCount/defaultBookName are derived from props; intentionally only
    // re-init on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Abort any in-flight generation if the modal unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleGenerate = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('generating');
    setError(null);
    setProgress({ done: 0, total: chunkCount });

    try {
      const { activeProvider, activeModel } = useSettingsStore.getState();
      const result = await extractLorebookEntries(messages, characterName, {
        provider: activeProvider,
        model: activeModel,
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });

      if (result.truncated) {
        setTruncatedNote(
          `Chat was long — processed the first ${result.messagesProcessed} of ${result.messagesTotal} messages.`
        );
      }
      setDrafts(
        result.entries.map((e, i) => ({ ...e, uid: i, enabled: true }))
      );
      setPhase('review');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled — return to the pre-flight screen.
        setPhase('preflight');
        return;
      }
      setError(err instanceof Error ? err.message : 'Generation failed.');
      setPhase('error');
    } finally {
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const updateDraft = (uid: number, patch: Partial<EditableDraft>) =>
    setDrafts((cur) => cur.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));

  const removeDraft = (uid: number) =>
    setDrafts((cur) => cur.filter((d) => d.uid !== uid));

  const enabledDrafts = drafts.filter(
    (d) => d.enabled && d.keys.length > 0 && d.content.trim().length > 0
  );

  const handleCreate = () => {
    const name = bookName.trim() || defaultBookName;
    const book = createBook(name);
    for (const draft of enabledDrafts) {
      createEntry(book.id, {
        keys: draft.keys,
        content: draft.content.trim(),
        comment: draft.category,
      });
    }
    // Auto-link the new (standalone) book to the source character so it
    // activates automatically in their chats, without merging it into the
    // character's single embedded/auto-memory book.
    if (characterAvatar) {
      const cs = useCharacterStore.getState();
      cs.setLinkedBookIds(characterAvatar, [
        ...cs.getLinkedBookIds(characterAvatar),
        book.id,
      ]);
    }
    // `book` is the snapshot from before entries were added — read the fresh
    // copy so callers see the populated entry list.
    const fresh =
      useWorldInfoStore.getState().books.find((b) => b.id === book.id) ?? book;
    onCreated?.(fresh);
    onClose();
  };

  const allEnabled = drafts.length > 0 && drafts.every((d) => d.enabled);
  const toggleAll = () =>
    setDrafts((cur) => cur.map((d) => ({ ...d, enabled: !allEnabled })));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create lorebook from chat" size="lg">
      {/* ---------------------------------------------------------------- */}
      {/* Pre-flight */}
      {/* ---------------------------------------------------------------- */}
      {phase === 'preflight' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-[var(--color-primary)]/15 text-[var(--color-primary)] flex-shrink-0">
              <Sparkles size={20} />
            </div>
            <div className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              The active model will read the whole conversation and extract
              characters, places, items, factions, events, and lore into draft
              lorebook entries. You'll review and edit them before anything is
              saved.
              {characterAvatar && (
                <>
                  {' '}The new book will be linked to{' '}
                  <span className="text-[var(--color-text-primary)]">
                    {characterName}
                  </span>{' '}
                  so it activates automatically in their chats.
                </>
              )}
            </div>
          </div>

          {chunkCount === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)]">
              There aren't enough messages in this chat to extract anything yet.
            </p>
          ) : (
            <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)]">
              This will make{' '}
              <span className="font-semibold text-[var(--color-text-primary)]">
                {chunkCount} model call{chunkCount === 1 ? '' : 's'}
              </span>{' '}
              using your active provider/model.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleGenerate} disabled={chunkCount === 0}>
              <Sparkles size={16} className="mr-2" />
              Generate
            </Button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Generating */}
      {/* ---------------------------------------------------------------- */}
      {phase === 'generating' && (
        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3 text-[var(--color-text-primary)]">
            <Loader2 size={20} className="animate-spin text-[var(--color-primary)]" />
            <span className="text-sm">
              Extracting lore… chunk {Math.min(progress.done + 1, progress.total)} of{' '}
              {progress.total}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
            <div
              className="h-full bg-[var(--color-primary)] transition-all duration-300"
              style={{
                width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Error */}
      {/* ---------------------------------------------------------------- */}
      {phase === 'error' && (
        <div className="space-y-4">
          <p className="text-sm text-red-400">{error}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button onClick={() => setPhase('preflight')}>Try again</Button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Review */}
      {/* ---------------------------------------------------------------- */}
      {phase === 'review' && (
        <div className="space-y-4">
          {truncatedNote && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
              {truncatedNote}
            </div>
          )}

          {drafts.length === 0 ? (
            <div className="text-center py-8">
              <BookPlus
                size={40}
                className="mx-auto text-[var(--color-text-secondary)] mb-3"
              />
              <p className="text-sm text-[var(--color-text-primary)] mb-1">
                No lore found in this chat
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                The model didn't find durable facts worth saving. Try a longer
                conversation.
              </p>
            </div>
          ) : (
            <>
              <Input
                label="Lorebook name"
                value={bookName}
                onChange={(e) => setBookName(e.target.value)}
              />

              <div className="flex items-center justify-between text-xs text-[var(--color-text-secondary)]">
                <span>
                  {enabledDrafts.length} of {drafts.length} entr
                  {drafts.length === 1 ? 'y' : 'ies'} selected
                </span>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-[var(--color-primary)] hover:underline"
                >
                  {allEnabled ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              <ul className="space-y-3">
                {drafts.map((draft) => (
                  <li
                    key={draft.uid}
                    className={`p-3 rounded-lg border transition-colors ${
                      draft.enabled
                        ? 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]'
                        : 'border-[var(--color-border)] bg-transparent opacity-60'
                    }`}
                  >
                    <div className="flex items-start gap-2 mb-2">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) =>
                          updateDraft(draft.uid, { enabled: e.target.checked })
                        }
                        className="mt-1 w-4 h-4 accent-[var(--color-primary)] flex-shrink-0"
                        aria-label="Include this entry"
                      />
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--color-primary)]/15 text-[var(--color-primary)] flex-shrink-0">
                        {draft.category}
                      </span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => removeDraft(draft.uid)}
                        className="p-1 rounded text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 flex-shrink-0"
                        aria-label="Remove entry"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="space-y-2 pl-6">
                      <TagInput
                        value={draft.keys}
                        onChange={(keys) => updateDraft(draft.uid, { keys })}
                        placeholder="Add keyword..."
                      />
                      <TextArea
                        value={draft.content}
                        onChange={(e) =>
                          updateDraft(draft.uid, { content: e.target.value })
                        }
                        rows={2}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={enabledDrafts.length === 0 || !bookName.trim()}
            >
              <BookPlus size={16} className="mr-2" />
              Create lorebook ({enabledDrafts.length})
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
