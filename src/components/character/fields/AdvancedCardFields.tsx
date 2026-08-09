import { Input, TextArea, TagInput, HelpTip } from '../../ui';
import { AIHelperButton } from '../AIHelperButton';
import type { CharacterFieldsSnapshot } from '../../../utils/aiCharacterHelper';
import type { AIHelperConfig, FieldChangeHandler } from './CoreCardFields';

/** Shared by CharacterCreation, CharacterEdit, and the interview wizard's
 *  review step — same "AIHelperButton in Creation/Interview vs HelpTip in
 *  Edit" split as CoreCardFields, plus three fields (Character's Note,
 *  System Prompt Override, Post-History Instructions) that carry a HelpTip
 *  in Edit but nothing at all in Creation — `helpTips` being omitted there
 *  naturally reproduces that asymmetry rather than forcing a fake swap. */
export interface AdvancedCardFormData {
  exampleMessages: string;
  creatorNotes: string;
  creator: string;
  tags: string[];
}

export interface AdvancedCardFieldsProps {
  formData: AdvancedCardFormData;
  onChange: FieldChangeHandler;
  onTagsChange: (tags: string[]) => void;
  tagSuggestions: string[];

  characterVersion: string;
  onCharacterVersionChange: (value: string) => void;

  depthPromptPrompt: string;
  onDepthPromptPromptChange: (value: string) => void;
  depthPromptDepth: number;
  onDepthPromptDepthChange: (value: number) => void;
  depthPromptRole: 'system' | 'user' | 'assistant';
  onDepthPromptRoleChange: (value: 'system' | 'user' | 'assistant') => void;

  systemPromptOverride: string;
  onSystemPromptOverrideChange: (value: string) => void;

  postHistoryInstructions: string;
  onPostHistoryInstructionsChange: (value: string) => void;

  talkativeness: string;
  onTalkativenessChange: (value: string) => void;

  /** AI-helper mode — only wired to "Example Messages" here (the other
   *  fields in this component have no AIHelperButton in either caller). */
  aiHelper?: AIHelperConfig;
  /** HelpTip mode (Edit). Ignored when `aiHelper` is set. */
  helpTips?: {
    exampleMessages?: string;
    characterNote?: string;
    systemPrompt?: string;
    postHistoryInstructions?: string;
  };
}

function exampleMessagesLabelExtra(
  aiHelper: AIHelperConfig | undefined,
  tip: string | undefined
) {
  const field: keyof CharacterFieldsSnapshot = 'exampleMessages';
  if (aiHelper) {
    return <AIHelperButton field={field} fields={aiHelper.fields} onResult={aiHelper.onResult(field)} />;
  }
  return tip ? <HelpTip tip={tip} /> : undefined;
}

export function AdvancedCardFields({
  formData,
  onChange,
  onTagsChange,
  tagSuggestions,
  characterVersion,
  onCharacterVersionChange,
  depthPromptPrompt,
  onDepthPromptPromptChange,
  depthPromptDepth,
  onDepthPromptDepthChange,
  depthPromptRole,
  onDepthPromptRoleChange,
  systemPromptOverride,
  onSystemPromptOverrideChange,
  postHistoryInstructions,
  onPostHistoryInstructionsChange,
  talkativeness,
  onTalkativenessChange,
  aiHelper,
  helpTips,
}: AdvancedCardFieldsProps) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] py-2">
        Advanced Options
      </summary>

      <div className="space-y-4 mt-2 pl-2 border-l-2 border-[var(--color-border)]">
        {/* Example Messages */}
        <TextArea
          label="Example Messages"
          labelExtra={exampleMessagesLabelExtra(aiHelper, helpTips?.exampleMessages)}
          placeholder="Example dialogue to help the AI understand the character's voice..."
          value={formData.exampleMessages}
          onChange={onChange('exampleMessages')}
          rows={4}
        />

        {/* Character's Note (Depth Prompt) */}
        <div className="space-y-2">
          <TextArea
            label="Character's Note"
            labelExtra={helpTips?.characterNote ? <HelpTip tip={helpTips.characterNote} /> : undefined}
            placeholder="Injected at a configurable depth in the chat to reinforce behavior..."
            value={depthPromptPrompt}
            onChange={(e) => onDepthPromptPromptChange(e.target.value)}
            rows={2}
          />
          {depthPromptPrompt && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                  Injection Depth
                </label>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={depthPromptDepth}
                  onChange={(e) => onDepthPromptDepthChange(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                  Role
                </label>
                <select
                  value={depthPromptRole}
                  onChange={(e) => onDepthPromptRoleChange(e.target.value as 'system' | 'user' | 'assistant')}
                  className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                >
                  <option value="system">System</option>
                  <option value="user">User</option>
                  <option value="assistant">Assistant</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* System Prompt Override */}
        <TextArea
          label="System Prompt Override"
          labelExtra={helpTips?.systemPrompt ? <HelpTip tip={helpTips.systemPrompt} /> : undefined}
          placeholder="Overrides the main system prompt for this character..."
          value={systemPromptOverride}
          onChange={(e) => onSystemPromptOverrideChange(e.target.value)}
          rows={3}
        />

        {/* Post-History Instructions */}
        <TextArea
          label="Post-History Instructions"
          labelExtra={
            helpTips?.postHistoryInstructions ? <HelpTip tip={helpTips.postHistoryInstructions} /> : undefined
          }
          placeholder="Instructions appended after the chat history..."
          value={postHistoryInstructions}
          onChange={(e) => onPostHistoryInstructionsChange(e.target.value)}
          rows={2}
        />

        {/* Talkativeness */}
        <div>
          <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
            Talkativeness ({talkativeness})
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={talkativeness}
            onChange={(e) => onTalkativenessChange(e.target.value)}
            className="w-full"
          />
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            Used in group chats to control how often this character speaks.
          </p>
        </div>

        {/* Character Version */}
        <Input
          label="Character Version"
          placeholder="e.g., 1.0"
          value={characterVersion}
          onChange={(e) => onCharacterVersionChange(e.target.value)}
        />

        {/* Creator Notes */}
        <TextArea
          label="Creator Notes"
          placeholder="Notes about the character for other users..."
          value={formData.creatorNotes}
          onChange={onChange('creatorNotes')}
          rows={2}
        />

        {/* Creator */}
        <Input
          label="Creator"
          placeholder="Your name or handle"
          value={formData.creator}
          onChange={onChange('creator')}
        />

        {/* Tags */}
        <TagInput label="Tags" value={formData.tags} onChange={onTagsChange} suggestions={tagSuggestions} />
      </div>
    </details>
  );
}
