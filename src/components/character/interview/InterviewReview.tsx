import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useCharacterInterviewStore } from '../../../stores/characterInterviewStore';
import { useCharacterStore } from '../../../stores/characterStore';
import { useWorldInfoStore } from '../../../stores/worldInfoStore';
import { showToastGlobal } from '../../ui/Toast';
import { Button } from '../../ui';
import { CoreCardFields, type FieldChangeHandler } from '../fields/CoreCardFields';
import { AdvancedCardFields } from '../fields/AdvancedCardFields';
import type { CharacterFieldsSnapshot } from '../../../utils/aiCharacterHelper';
import type { StagedLoreEntry } from '../../../utils/characterInterview/types';
import { INTERVIEW_PROMPT_VERSION } from '../../../utils/characterInterview/prompts';

/** AdvancedCardFields needs these but InterviewDraft has no home for them —
 *  local-only, mirroring CharacterCreation.tsx's own local advanced state.
 *  Owned by CharacterInterview.tsx (not this component) and passed down,
 *  because InterviewReview unmounts whenever the user steps over to
 *  InterviewAvatarStep (e.g. "Change avatar") and back — component-local
 *  state here would silently reset to defaults on that round trip. */
export interface ReviewExtrasState {
  creator: string;
  characterVersion: string;
  depthPromptPrompt: string;
  depthPromptDepth: number;
  depthPromptRole: 'system' | 'user' | 'assistant';
  systemPromptOverride: string;
  postHistoryInstructions: string;
  talkativeness: string;
}

export const DEFAULT_REVIEW_EXTRAS: ReviewExtrasState = {
  creator: '',
  characterVersion: '',
  depthPromptPrompt: '',
  depthPromptDepth: 4,
  depthPromptRole: 'system',
  systemPromptOverride: '',
  postHistoryInstructions: '',
  talkativeness: '0.5',
};

interface InterviewReviewProps {
  extras: ReviewExtrasState;
  onExtrasChange: (extras: ReviewExtrasState) => void;
  onClose: () => void;
  onCreated?: (avatarUrl: string) => void;
}

/**
 * registerEmbeddedBookFromCard's server sync is fire-and-forget and only
 * ever surfaces failure by setting worldInfoStore's `error` field. Copied
 * verbatim (same heuristic and caveats) from CharacterImport.tsx's own
 * watchForLorebookSyncFailure — see that file's doc comment for the full
 * rationale. Kept as a plain function (not a hook) since it only needs to
 * run once, right after a successful save.
 */
function watchForLorebookSyncFailure(): void {
  const errorBeforeThisSave = useWorldInfoStore.getState().error;
  const unsub = useWorldInfoStore.subscribe((state) => {
    if (!state.error || state.error === errorBeforeThisSave) return;
    showToastGlobal(
      `Character saved, but the lorebook didn't sync: ${state.error} — retry from the character's Lorebook section.`,
      'warning'
    );
    unsub();
  });
  setTimeout(unsub, 5000);
}

export function InterviewReview({ extras, onExtrasChange, onClose, onCreated }: InterviewReviewProps) {
  const phase = useCharacterInterviewStore((s) => s.phase);
  const interview = useCharacterInterviewStore((s) => s.interview);
  const avatarFile = useCharacterInterviewStore((s) => s.avatarFile);
  const avatarSource = useCharacterInterviewStore((s) => s.avatarSource);
  const updateDraftField = useCharacterInterviewStore((s) => s.updateDraftField);
  const updateStagedLore = useCharacterInterviewStore((s) => s.updateStagedLore);
  const setPhase = useCharacterInterviewStore((s) => s.setPhase);
  const resetInterview = useCharacterInterviewStore((s) => s.reset);
  const discardInterviewDraft = useCharacterInterviewStore((s) => s.discardDraft);

  const createCharacter = useCharacterStore((s) => s.createCharacter);
  const getAllTags = useCharacterStore((s) => s.getAllTags);
  const characterStoreError = useCharacterStore((s) => s.error);
  const clearCharacterStoreError = useCharacterStore((s) => s.clearError);
  const registerEmbeddedBookFromCard = useCharacterStore((s) => s.registerEmbeddedBookFromCard);

  const { draft, stagedLore } = interview;
  const isSaving = phase === 'saving';

  const {
    creator,
    characterVersion,
    depthPromptPrompt,
    depthPromptDepth,
    depthPromptRole,
    systemPromptOverride,
    postHistoryInstructions,
    talkativeness,
  } = extras;
  const patchExtras = (patch: Partial<ReviewExtrasState>) => onExtrasChange({ ...extras, ...patch });

  // Avatar preview — object URL derived straight from avatarFile (no
  // setState-in-effect round trip); a separate effect only handles
  // revoking it, on change or unmount.
  const avatarPreviewUrl = useMemo(() => (avatarFile ? URL.createObjectURL(avatarFile) : null), [avatarFile]);
  useEffect(() => {
    return () => {
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    };
  }, [avatarPreviewUrl]);

  const handleChange: FieldChangeHandler = (field) => (e) => {
    const value = e.target.value;
    if (characterStoreError) clearCharacterStoreError();
    switch (field) {
      case 'name':
        updateDraftField('name', value);
        break;
      case 'description':
        updateDraftField('description', value);
        break;
      case 'personality':
        updateDraftField('personality', value);
        break;
      case 'firstMessage':
        updateDraftField('first_mes', value);
        break;
      case 'scenario':
        updateDraftField('scenario', value);
        break;
      case 'exampleMessages':
        updateDraftField('mes_example', value);
        break;
      case 'creatorNotes':
        updateDraftField('creator_notes', value);
        break;
      case 'creator':
        patchExtras({ creator: value });
        break;
      default:
        break;
    }
  };

  const aiFieldsSnapshot: CharacterFieldsSnapshot = {
    name: draft.name,
    description: draft.description,
    personality: draft.personality,
    firstMessage: draft.first_mes,
    scenario: draft.scenario,
    exampleMessages: draft.mes_example,
  };
  const setAIResult = (field: keyof CharacterFieldsSnapshot) => (value: string) => {
    switch (field) {
      case 'name':
        updateDraftField('name', value);
        break;
      case 'description':
        updateDraftField('description', value);
        break;
      case 'personality':
        updateDraftField('personality', value);
        break;
      case 'firstMessage':
        updateDraftField('first_mes', value);
        break;
      case 'scenario':
        updateDraftField('scenario', value);
        break;
      case 'exampleMessages':
        updateDraftField('mes_example', value);
        break;
      default:
        break;
    }
  };

  const handleLoreChange = (index: number, patch: Partial<StagedLoreEntry>) => {
    updateStagedLore(stagedLore.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };
  const handleLoreRemove = (index: number) => {
    updateStagedLore(stagedLore.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!draft.name.trim() || isSaving) return;
    setPhase('saving');

    const avatarUrl = await createCharacter(
      {
        ch_name: draft.name.trim(),
        description: draft.description.trim(),
        personality: draft.personality.trim(),
        first_mes: draft.first_mes.trim(),
        scenario: draft.scenario.trim(),
        mes_example: draft.mes_example.trim(),
        creator_notes: draft.creator_notes.trim(),
        creator: creator.trim(),
        tags: draft.tags.join(', '),
        alternate_greetings: draft.alternate_greetings.filter((g) => g.trim()),
        system_prompt: systemPromptOverride.trim() || undefined,
        post_history_instructions: postHistoryInstructions.trim() || undefined,
        character_version: characterVersion.trim() || undefined,
        depth_prompt_prompt: depthPromptPrompt.trim() || undefined,
        depth_prompt_depth: depthPromptPrompt.trim() ? depthPromptDepth : undefined,
        depth_prompt_role: depthPromptPrompt.trim() ? depthPromptRole : undefined,
        talkativeness: talkativeness || undefined,
        extensions: {
          ggbc: {
            interview: {
              version: 1,
              prompt_version: INTERVIEW_PROMPT_VERSION,
              created_at: new Date().toISOString(),
            },
          },
        },
        // Record how the avatar was made (generated/uploaded) for the selfie
        // safety gate. Sent ONLY as the top-level avatar_provenance_source field
        // — intentionally NOT written into the card `data` blob (a round-tripping
        // stamp could be re-trusted on a later edit and reopen the gate).
        // See utils/avatarProvenance.
        avatarProvenance: avatarSource ?? undefined,
      },
      avatarFile ?? undefined
    );

    if (avatarUrl) {
      if (stagedLore.length > 0) {
        registerEmbeddedBookFromCard(
          avatarUrl,
          { entries: stagedLore.map((e) => ({ keys: e.keys, content: e.content, name: e.title })) },
          `${draft.name.trim() || 'Character'} Lorebook`
        );
        watchForLorebookSyncFailure();
      }
      void discardInterviewDraft();
      resetInterview();
      onExtrasChange(DEFAULT_REVIEW_EXTRAS);
      onClose();
      onCreated?.(avatarUrl);
    } else {
      // createCharacter already stamped the failure onto characterStore's
      // own `error` field — read it fresh rather than the stale value
      // captured at this render, since it changed during the await above.
      setPhase('review');
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Review your character</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">
            Everything from the interview is editable here before you save.
          </p>
        </div>

        <fieldset disabled={isSaving} className="space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-3 p-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg">
            <div className="w-16 h-16 rounded-lg overflow-hidden bg-[var(--color-bg-secondary)] flex items-center justify-center shrink-0">
              {avatarPreviewUrl ? (
                <img src={avatarPreviewUrl} alt="Avatar preview" className="w-full h-full object-cover" />
              ) : (
                <span className="text-[10px] text-[var(--color-text-secondary)] text-center px-1">No avatar</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-[var(--color-text-primary)] font-medium">
                {avatarPreviewUrl ? 'Avatar ready' : 'No avatar set'}
              </p>
              <button
                type="button"
                onClick={() => setPhase('avatar')}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                {avatarPreviewUrl ? 'Change avatar' : 'Add an avatar'}
              </button>
            </div>
          </div>

          <CoreCardFields
            formData={{
              name: draft.name,
              description: draft.description,
              personality: draft.personality,
              firstMessage: draft.first_mes,
              scenario: draft.scenario,
            }}
            onChange={handleChange}
            alternateGreetings={draft.alternate_greetings}
            onAlternateGreetingsChange={(greetings) => updateDraftField('alternate_greetings', greetings)}
            aiHelper={{ fields: aiFieldsSnapshot, onResult: setAIResult }}
          />

          {/* Staged lore */}
          {stagedLore.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                World / Lore ({stagedLore.length})
              </h3>
              <div className="space-y-2">
                {stagedLore.map((entry, i) => (
                  <div
                    key={i}
                    className="p-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <input
                        value={entry.title ?? ''}
                        onChange={(e) => handleLoreChange(i, { title: e.target.value })}
                        placeholder="Entry title"
                        className="flex-1 text-sm bg-transparent border-b border-[var(--color-border)] px-1 py-0.5 text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)]"
                      />
                      <button
                        type="button"
                        onClick={() => handleLoreRemove(i)}
                        className="text-[var(--color-text-secondary)] hover:text-red-400 shrink-0 p-0.5"
                        aria-label="Remove lore entry"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <input
                      value={entry.keys.join(', ')}
                      onChange={(e) =>
                        handleLoreChange(i, {
                          keys: e.target.value.split(',').map((k) => k.trim()).filter(Boolean),
                        })
                      }
                      placeholder="Keys (comma-separated)"
                      className="w-full text-xs bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-secondary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                    />
                    <textarea
                      value={entry.content}
                      onChange={(e) => handleLoreChange(i, { content: e.target.value })}
                      rows={2}
                      placeholder="Content"
                      className="w-full text-xs bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text-primary)] resize-none focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <AdvancedCardFields
            formData={{
              exampleMessages: draft.mes_example,
              creatorNotes: draft.creator_notes,
              creator,
              tags: draft.tags,
            }}
            onChange={handleChange}
            onTagsChange={(tags) => updateDraftField('tags', tags)}
            tagSuggestions={getAllTags()}
            characterVersion={characterVersion}
            onCharacterVersionChange={(value) => patchExtras({ characterVersion: value })}
            depthPromptPrompt={depthPromptPrompt}
            onDepthPromptPromptChange={(value) => patchExtras({ depthPromptPrompt: value })}
            depthPromptDepth={depthPromptDepth}
            onDepthPromptDepthChange={(value) => patchExtras({ depthPromptDepth: value })}
            depthPromptRole={depthPromptRole}
            onDepthPromptRoleChange={(value) => patchExtras({ depthPromptRole: value })}
            systemPromptOverride={systemPromptOverride}
            onSystemPromptOverrideChange={(value) => patchExtras({ systemPromptOverride: value })}
            postHistoryInstructions={postHistoryInstructions}
            onPostHistoryInstructionsChange={(value) => patchExtras({ postHistoryInstructions: value })}
            talkativeness={talkativeness}
            onTalkativenessChange={(value) => patchExtras({ talkativeness: value })}
            aiHelper={{ fields: aiFieldsSnapshot, onResult: setAIResult }}
          />
        </fieldset>

        {characterStoreError && (
          <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
            {characterStoreError}
          </div>
        )}

        <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
          <Button
            type="button"
            variant="primary"
            isLoading={isSaving}
            disabled={!draft.name.trim()}
            onClick={handleSave}
            className="flex-1"
          >
            {isSaving ? 'Saving…' : 'Save character'}
          </Button>
        </div>
      </div>
    </div>
  );
}
