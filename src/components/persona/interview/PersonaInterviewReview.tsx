import type { Dispatch, SetStateAction } from 'react';
import { User } from 'lucide-react';
import { usePersonaInterviewStore } from '../../../stores/personaInterviewStore';
import {
  usePersonaStore,
  type Persona,
  type PersonaDescriptionPosition,
  type PersonaDescriptionRole,
} from '../../../stores/personaStore';
import { Button, Input, TextArea } from '../../ui';
import { PersonaSettingsFields } from '../PersonaSettingsFields';

/** The injection/default/lorebook settings live here rather than in
 *  InterviewDraft (which only holds name + description) and are owned by the
 *  parent PersonaInterview — this component unmounts whenever the user steps
 *  back to the avatar step ("Change avatar") and returns, so component-local
 *  state would silently reset to defaults on that round trip. */
export interface ReviewSettingsState {
  descriptionPosition: PersonaDescriptionPosition;
  descriptionDepth: number;
  descriptionRole: PersonaDescriptionRole;
  isDefault: boolean;
  linkedBookIds: string[];
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettingsState = {
  descriptionPosition: 'before_char',
  descriptionDepth: 4,
  descriptionRole: 'system',
  isDefault: false,
  linkedBookIds: [],
};

interface PersonaInterviewReviewProps {
  settings: ReviewSettingsState;
  /** React setState-style: accepts a value or a functional updater. The
   *  updater form lets writes compose against the latest settings even across
   *  the async lorebook-upload gap in PersonaSettingsFields. */
  onSettingsChange: Dispatch<SetStateAction<ReviewSettingsState>>;
  onClose: () => void;
  onCreated?: (persona: Persona) => void;
}

export function PersonaInterviewReview({ settings, onSettingsChange, onClose, onCreated }: PersonaInterviewReviewProps) {
  const phase = usePersonaInterviewStore((s) => s.phase);
  const draft = usePersonaInterviewStore((s) => s.interview.draft);
  const avatarDataUrl = usePersonaInterviewStore((s) => s.avatarDataUrl);
  const updateDraftField = usePersonaInterviewStore((s) => s.updateDraftField);
  const setPhase = usePersonaInterviewStore((s) => s.setPhase);
  const reset = usePersonaInterviewStore((s) => s.reset);

  const createPersona = usePersonaStore((s) => s.createPersona);

  const isSaving = phase === 'saving';
  // Functional form so each write composes against the latest settings.
  const patchSettings = (patch: Partial<ReviewSettingsState>) =>
    onSettingsChange((prev) => ({ ...prev, ...patch }));

  const handleSave = () => {
    const trimmedName = draft.name.trim();
    if (!trimmedName || isSaving) return;
    setPhase('saving');

    // createPersona is synchronous — it persists locally, auto-activates the
    // first/default persona itself (so no redundant setActivePersona here),
    // and fires the settings-blob + avatar-blob sync in the background.
    const persona = createPersona({
      name: trimmedName,
      description: draft.description.trim(),
      avatarDataUrl: avatarDataUrl ?? undefined,
      descriptionPosition: settings.descriptionPosition,
      descriptionDepth: settings.descriptionDepth,
      descriptionRole: settings.descriptionRole,
      isDefault: settings.isDefault,
      linkedBookIds: settings.linkedBookIds,
    });

    reset();
    onSettingsChange(DEFAULT_REVIEW_SETTINGS);
    onClose();
    onCreated?.(persona);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Review your persona</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">
            Everything from the interview is editable here before you save.
          </p>
        </div>

        <fieldset disabled={isSaving} className="space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-3 p-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg">
            <div className="w-16 h-16 rounded-full overflow-hidden bg-[var(--color-bg-secondary)] flex items-center justify-center shrink-0">
              {avatarDataUrl ? (
                <img src={avatarDataUrl} alt="Persona avatar" className="w-full h-full object-cover" />
              ) : (
                <User size={28} className="text-[var(--color-text-secondary)]" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-[var(--color-text-primary)] font-medium">
                {avatarDataUrl ? 'Avatar ready' : 'No avatar set'}
              </p>
              <button
                type="button"
                onClick={() => setPhase('avatar')}
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                {avatarDataUrl ? 'Change avatar' : 'Add an avatar'}
              </button>
            </div>
          </div>

          <Input
            label="Name *"
            placeholder="e.g., Alex, Dungeon Master, Narrator"
            value={draft.name}
            onChange={(e) => updateDraftField('name', e.target.value)}
            required
          />

          <TextArea
            label="Description"
            placeholder="Describe who you are when using this persona..."
            value={draft.description}
            onChange={(e) => updateDraftField('description', e.target.value)}
            rows={5}
          />

          <PersonaSettingsFields
            descriptionPosition={settings.descriptionPosition}
            onDescriptionPositionChange={(v) => patchSettings({ descriptionPosition: v })}
            descriptionDepth={settings.descriptionDepth}
            onDescriptionDepthChange={(v) => patchSettings({ descriptionDepth: v })}
            descriptionRole={settings.descriptionRole}
            onDescriptionRoleChange={(v) => patchSettings({ descriptionRole: v })}
            isDefault={settings.isDefault}
            onIsDefaultChange={(v) => patchSettings({ isDefault: v })}
            linkedBookIds={settings.linkedBookIds}
            onLinkedBookIdsChange={(update) =>
              onSettingsChange((prev) => ({
                ...prev,
                linkedBookIds: typeof update === 'function' ? update(prev.linkedBookIds) : update,
              }))
            }
          />
        </fieldset>

        <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
          <Button
            type="button"
            variant="primary"
            isLoading={isSaving}
            disabled={!draft.name.trim()}
            onClick={handleSave}
            className="flex-1"
          >
            {isSaving ? 'Saving…' : 'Create Persona'}
          </Button>
        </div>
      </div>
    </div>
  );
}
