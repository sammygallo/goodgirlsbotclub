import { useMemo, useState } from 'react';
import { Modal, Button, ConfirmDialog, TextArea, Input } from '../ui';
import {
  useLoreConflictStore,
  type ConflictRecord,
  type ConflictScope,
} from '../../stores/loreConflictStore';
import { useWorldInfoStore, type WorldInfoEntry } from '../../stores/worldInfoStore';
import { entryLabel } from '../../utils/lorebookLint';
import { EntryHistory, relativeTime } from './EntryHistory';

// ---------------------------------------------------------------------------
// Lorebook v2 — Auto Memory conflict resolution sheet (Phase 4)
// ---------------------------------------------------------------------------
//
// Surfaces every pending loreConflictStore record in scope (a single chat, or
// a whole book spanning many chats) and lets the user resolve each one.
// Lives in worldinfo/ (not chat/lore/) because it's used from both surfaces
// and worldinfo/ already has no dependency on chat/lore/.

export type ConflictSheetScope =
  | { kind: 'chat'; chatFile: string }
  | { kind: 'book'; bookId: string };

export interface ConflictResolutionSheetProps {
  isOpen: boolean;
  onClose: () => void;
  scope: ConflictSheetScope;
}

/**
 * Same comma-parsing convention as ForkEntryEditor.tsx's / WorldInfoEntryForm.tsx's
 * own (unexported, so re-declared here rather than imported) `parseCsv`: trim
 * each piece, drop empties.
 */
function parseCsv(s: string): string[] {
  return s
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Chat filenames are `<id>.jsonl`; strip that for a readable label. */
function chatFileLabel(chatFile: string): string {
  return chatFile.endsWith('.jsonl') ? chatFile.slice(0, -'.jsonl'.length) : chatFile;
}

const DETECTOR_LABEL: Record<ConflictRecord['detectedBy'], string> = {
  llm: 'Flagged during extraction',
  lint: 'Caught by similarity check',
};

interface ConflictCardProps {
  record: ConflictRecord;
  live: WorldInfoEntry | undefined;
  bookName: string;
  scope: ConflictSheetScope;
}

function ConflictCard({ record, live, bookName, scope }: ConflictCardProps) {
  const resolveConflict = useLoreConflictStore((s) => s.resolveConflict);
  const updateProposed = useLoreConflictStore((s) => s.updateProposed);

  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(record.proposedContent);
  const [draftKeys, setDraftKeys] = useState(record.proposedKeys.join(', '));

  const drifted = live !== undefined && live.content !== record.existingContentSnapshot;

  // Provenance line for the existing entry — degrades gracefully (omitted
  // entirely) when there's no revision to attribute it to.
  let provenance: string | null = null;
  if (live && live.revisions.length > 0) {
    const firstRev = live.revisions[0];
    provenance =
      live.source === 'auto_memory'
        ? `Added by auto memory · ${relativeTime(firstRev.ts)}`
        : `Written by ${firstRev.authorHandle || 'unknown'} · ${relativeTime(firstRev.ts)}`;
  }

  const newFactLabel =
    scope.kind === 'book'
      ? `New fact from ${chatFileLabel(record.chatFile)}`
      : 'New fact from this chat';

  const handleSaveEdit = () => {
    updateProposed(record.id, {
      proposedContent: draftContent,
      proposedKeys: parseCsv(draftKeys),
    });
    setEditing(false);
  };

  return (
    <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="font-medium text-[var(--color-text-primary)]">{bookName}</span>
        <span className="px-1.5 py-0.5 rounded bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)]">
          {DETECTOR_LABEL[record.detectedBy]}
        </span>
        <span className="ml-auto flex-shrink-0 text-[var(--color-text-secondary)]">
          {relativeTime(record.createdAt)}
        </span>
      </div>

      {/* Existing lore panel, or orphan note */}
      {live ? (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Existing lore
          </p>
          <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
            {entryLabel(live)}
          </p>
          <div className="p-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap">
              {live.content}
            </p>
          </div>
          {provenance && (
            <p className="text-xs text-[var(--color-text-secondary)]">{provenance}</p>
          )}
          {live.revisions.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                History
              </summary>
              <div className="mt-1.5">
                <EntryHistory revisions={live.revisions} currentContent={live.content} />
              </div>
            </details>
          )}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-text-secondary)] italic">
          The entry this conflicted with was deleted.
        </p>
      )}

      {/* Drift note — informational only; actions still act on `live`. */}
      {drifted && (
        <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-1.5">
          <p className="text-xs text-amber-400">
            This entry changed since the conflict was detected
          </p>
          <details>
            <summary className="cursor-pointer text-xs text-amber-400/80 hover:text-amber-400">
              View old snapshot
            </summary>
            <div className="mt-1.5 p-2 rounded bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap">
              {record.existingContentSnapshot}
            </div>
          </details>
        </div>
      )}

      {/* Proposed fact panel */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {newFactLabel}
        </p>
        {editing ? (
          <div className="space-y-2">
            <TextArea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={4}
            />
            <Input
              label="Keys (comma-separated)"
              value={draftKeys}
              onChange={(e) => setDraftKeys(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={handleSaveEdit}>
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap">
              {record.proposedContent}
            </p>
            {record.proposedKeys.length > 0 && (
              <p>
                {record.proposedKeys.map((k, i) => (
                  <span
                    key={i}
                    className="inline-block mr-1 mb-0.5 px-1.5 py-0.5 rounded bg-[var(--color-bg-primary)] text-xs text-[var(--color-text-secondary)]"
                  >
                    {k}
                  </span>
                ))}
              </p>
            )}
          </>
        )}
      </div>

      {/* Actions */}
      {!editing &&
        (live ? (
          <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
            <div className="grid grid-cols-3 gap-2">
              <Button variant="primary" size="sm" onClick={() => resolveConflict(record.id, 'keep')}>
                Keep existing
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => resolveConflict(record.id, 'replace')}
              >
                Replace
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => resolveConflict(record.id, 'fork_chat')}
              >
                Keep both (this chat)
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => resolveConflict(record.id, 'fork_group')}
              >
                Keep both in this book
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit proposed
              </Button>
              <Button variant="ghost" size="sm" onClick={() => resolveConflict(record.id, 'dismiss')}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 pt-2 border-t border-[var(--color-border)]">
            <Button
              variant="primary"
              size="sm"
              onClick={() => resolveConflict(record.id, 'add_new')}
              className="flex-1"
            >
              Add as new entry
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => resolveConflict(record.id, 'dismiss')}
              className="flex-1"
            >
              Dismiss
            </Button>
          </div>
        ))}
    </div>
  );
}

export function ConflictResolutionSheet({ isOpen, onClose, scope }: ConflictResolutionSheetProps) {
  const records = useLoreConflictStore((s) => s.records);
  const resolveAll = useLoreConflictStore((s) => s.resolveAll);
  const books = useWorldInfoStore((s) => s.books);

  const matching = useMemo(() => {
    const list = Object.values(records).filter((r) =>
      scope.kind === 'chat' ? r.chatFile === scope.chatFile : r.bookId === scope.bookId
    );
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }, [records, scope]);

  const [confirmBulk, setConfirmBulk] = useState<'keep' | 'replace' | null>(null);

  const bulkScope: ConflictScope =
    scope.kind === 'chat' ? { kind: 'chat', chatFile: scope.chatFile } : { kind: 'book', bookId: scope.bookId };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Resolve memory conflicts" size="lg">
      <div className="space-y-4">
        {matching.length >= 2 && (
          <div className="flex gap-2 pb-3 border-b border-[var(--color-border)]">
            <Button variant="ghost" size="sm" onClick={() => setConfirmBulk('keep')}>
              Keep all existing
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmBulk('replace')}>
              Replace all
            </Button>
          </div>
        )}

        {matching.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">No pending conflicts.</p>
        ) : (
          <div className="space-y-3">
            {matching.map((record) => {
              const book = books.find((b) => b.id === record.bookId);
              const live = book?.entries.find((e) => e.id === record.existingEntryId);
              return (
                <ConflictCard
                  key={record.id}
                  record={record}
                  live={live}
                  bookName={book?.name ?? 'Unknown book'}
                  scope={scope}
                />
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmBulk !== null}
        onClose={() => setConfirmBulk(null)}
        onConfirm={() => {
          if (confirmBulk) resolveAll(bulkScope, confirmBulk);
        }}
        title={confirmBulk === 'keep' ? 'Keep all existing?' : 'Replace all?'}
        message={`Applies to ${matching.length} pending conflicts. Entries deleted since detection are skipped.`}
        confirmLabel={confirmBulk === 'keep' ? 'Keep all existing' : 'Replace all'}
      />
    </Modal>
  );
}
