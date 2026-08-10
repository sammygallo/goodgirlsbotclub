import { useState } from 'react';
import { Merge, Pencil } from 'lucide-react';
import type { StorySceneSummary } from '../../api/client';
import { useStoryStore } from '../../stores/storyStore';
import type { Scene } from '../../types/storyBible';
import { Button, ConfirmDialog, Input } from '../ui';

/**
 * One scene row in the review list (plan §6, §5.3).
 *
 * The read-only tile Phase 5 shipped, plus two write actions: rename
 * (cosmetic edit through `patchScene`) and merge-with-previous
 * (`mergeSceneIntoPrevious`). No split, no reorder — those are §8's
 * "deliberately not this phase". Delete lives on the fact log, not here,
 * because a scene delete without a merge is orphaning: this file only
 * exposes the two operations that keep the fact→scene links intact by
 * construction.
 */
export function SceneReviewRow({
  scene,
  isFirst,
  canManage,
  disabled,
}: {
  scene: StorySceneSummary;
  /** No predecessor to merge into. Merge is hidden rather than disabled
   *  to make the affordance's absence deliberate — a greyed-out button
   *  reads as "you can't merge this one" when the answer is "there's
   *  nothing to merge with". */
  isFirst: boolean;
  canManage: boolean;
  /** Canon locked, a build is running, or the user is a viewer. */
  disabled: boolean;
}) {
  const patchScene = useStoryStore((s) => s.patchScene);
  const mergeSceneIntoPrevious = useStoryStore((s) => s.mergeSceneIntoPrevious);
  const isSaving = useStoryStore((s) => s.isSaving);

  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);

  const label = scene.title || `Scene ${scene.sequence + 1}`;
  const busy = disabled || isSaving;

  const beginEdit = () => {
    setDraftTitle(scene.title || '');
    setEditingTitle(true);
  };

  const cancelEdit = () => {
    setEditingTitle(false);
    setDraftTitle('');
  };

  const saveTitle = async () => {
    const trimmed = draftTitle.trim();
    // No-op the store's own way: if the title didn't change, don't
    // bump server_ts and don't append an edit row for a change that
    // didn't happen.
    if (trimmed === (scene.title ?? '').trim()) {
      cancelEdit();
      return;
    }
    const ok = await patchScene(
      scene.id,
      (data: Scene) => ({ ...data, title: trimmed }),
      {
        target: { type: 'scene', id: scene.id },
        classification: 'cosmetic',
        diff: `scene title: ${scene.title ?? ''} → ${trimmed}`,
      }
    );
    if (ok) cancelEdit();
  };

  const doMerge = async () => {
    setConfirmMerge(false);
    await mergeSceneIntoPrevious(scene.id);
  };

  return (
    <li className="px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] space-y-1">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <div className="flex items-center gap-2">
              <Input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveTitle();
                  else if (e.key === 'Escape') cancelEdit();
                }}
                autoFocus
                maxLength={200}
                aria-label="Scene title"
                disabled={busy}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void saveTitle()}
                disabled={busy}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelEdit}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <p className="text-sm text-[var(--color-text-primary)] truncate">
              {label}
            </p>
          )}
          {!editingTitle && scene.summary && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {scene.summary}
            </p>
          )}
        </div>
        {canManage && !editingTitle && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={beginEdit}
              disabled={busy}
              aria-label="Edit scene title"
            >
              <Pencil size={14} />
            </Button>
            {!isFirst && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmMerge(true)}
                disabled={busy}
                aria-label="Merge into previous scene"
              >
                <Merge size={14} />
              </Button>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirmMerge}
        title="Merge into previous?"
        // The scene→fact index is healed by the union write, but the
        // fact→scene back-pointer on this scene's facts is a permanent
        // dangling ref (facts are append-only; there is nothing to heal
        // them with). Says so in copy.
        message={`This folds "${label}" into the scene before it — one combined title, summary and message range. Facts that pointed AT this scene will still name it, and Lock canon lists those as warnings.`}
        confirmLabel="Merge"
        busy={isSaving}
        onConfirm={() => void doMerge()}
        onClose={() => setConfirmMerge(false)}
      />
    </li>
  );
}
