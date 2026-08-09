import { useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { Modal, Button, Input, TextArea, ImageUpload, ExpressionUpload, TagInput } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import { AlternateGreetingsEditor } from './AlternateGreetingsEditor';
import { AIHelperButton } from './AIHelperButton';
import { spritesApi } from '../../api/client';

interface CharacterCreationProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (avatarUrl: string) => void;
  initialData?: Partial<{
    name: string;
    description: string;
    personality: string;
    firstMessage: string;
    scenario: string;
    exampleMessages: string;
    creatorNotes: string;
    creator: string;
    tags: string[];
  }>;
}

export function CharacterCreation({ isOpen, onClose, onCreated, initialData }: CharacterCreationProps) {
  const { createCharacter, isCreating, error, clearError, getAllTags } = useCharacterStore();

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [expressionFiles, setExpressionFiles] = useState<Map<string, File>>(new Map());
  const [isUploadingExpressions, setIsUploadingExpressions] = useState(false);
  const [formData, setFormData] = useState<{
    name: string;
    description: string;
    personality: string;
    firstMessage: string;
    scenario: string;
    exampleMessages: string;
    creatorNotes: string;
    creator: string;
    tags: string[];
  }>({
    name: initialData?.name || '',
    description: initialData?.description || '',
    personality: initialData?.personality || '',
    firstMessage: initialData?.firstMessage || '',
    scenario: initialData?.scenario || '',
    exampleMessages: initialData?.exampleMessages || '',
    creatorNotes: initialData?.creatorNotes || '',
    creator: initialData?.creator || '',
    tags: initialData?.tags || [],
  });

  // Phase 2: Advanced character fields
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([]);
  const [characterVersion, setCharacterVersion] = useState('');
  const [depthPromptPrompt, setDepthPromptPrompt] = useState('');
  const [depthPromptDepth, setDepthPromptDepth] = useState(4);
  const [depthPromptRole, setDepthPromptRole] = useState<'system' | 'user' | 'assistant'>('system');
  const [systemPromptOverride, setSystemPromptOverride] = useState('');
  const [postHistoryInstructions, setPostHistoryInstructions] = useState('');
  const [talkativeness, setTalkativeness] = useState('0.5');

  const handleChange = (field: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    if (error) clearError();
  };

  const aiFieldsSnapshot = {
    name: formData.name,
    description: formData.description,
    personality: formData.personality,
    firstMessage: formData.firstMessage,
    scenario: formData.scenario,
    exampleMessages: formData.exampleMessages,
  };
  const setAIResult = (field: keyof typeof aiFieldsSnapshot) => (value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (error) clearError();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      return;
    }

    const avatarUrl = await createCharacter(
      {
        ch_name: formData.name.trim(),
        description: formData.description.trim(),
        personality: formData.personality.trim(),
        first_mes: formData.firstMessage.trim(),
        scenario: formData.scenario.trim(),
        mes_example: formData.exampleMessages.trim(),
        creator_notes: formData.creatorNotes.trim(),
        creator: formData.creator.trim(),
        tags: formData.tags.join(', '),
        // Advanced fields
        alternate_greetings: alternateGreetings.filter((g) => g.trim()),
        system_prompt: systemPromptOverride.trim() || undefined,
        post_history_instructions: postHistoryInstructions.trim() || undefined,
        character_version: characterVersion.trim() || undefined,
        depth_prompt_prompt: depthPromptPrompt.trim() || undefined,
        depth_prompt_depth: depthPromptPrompt.trim() ? depthPromptDepth : undefined,
        depth_prompt_role: depthPromptPrompt.trim() ? depthPromptRole : undefined,
        talkativeness: talkativeness || undefined,
      },
      avatarFile || undefined
    );

    if (avatarUrl) {
      // Upload expression images if any
      if (expressionFiles.size > 0) {
        setIsUploadingExpressions(true);
        try {
          const characterName = formData.name.trim();
          console.log('[CharacterCreation] Uploading expressions for:', characterName);
          const results = await Promise.allSettled(
            Array.from(expressionFiles.entries()).map(([emotion, file]) =>
              spritesApi.uploadSprite(characterName, emotion, file)
            )
          );
          // Log any failures
          const failures = results.filter((r) => r.status === 'rejected');
          if (failures.length > 0) {
            console.error('[CharacterCreation] Some expression uploads failed:', failures);
            showToastGlobal(
              `Character saved, but ${failures.length} expression image${failures.length === 1 ? '' : 's'} failed to upload — retry from the character's edit screen.`,
              'warning'
            );
          }
        } catch (err) {
          console.error('[CharacterCreation] Failed to upload expressions:', err);
          showToastGlobal(
            "Character saved, but expression images failed to upload — retry from the character's edit screen.",
            'warning'
          );
        } finally {
          setIsUploadingExpressions(false);
        }
      }

      // Reset form
      setAvatarFile(null);
      setExpressionFiles(new Map());
      setFormData({
        name: '',
        description: '',
        personality: '',
        firstMessage: '',
        scenario: '',
        exampleMessages: '',
        creatorNotes: '',
        creator: '',
        tags: [],
      });
      setAlternateGreetings([]);
      setCharacterVersion('');
      setDepthPromptPrompt('');
      setDepthPromptDepth(4);
      setDepthPromptRole('system');
      setSystemPromptOverride('');
      setPostHistoryInstructions('');
      setTalkativeness('0.5');
      onClose();
      onCreated?.(avatarUrl);
    }
  };

  const handleClose = () => {
    clearError();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Character" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Avatar Upload */}
        <ImageUpload
          onImageSelect={setAvatarFile}
          label="Avatar"
        />

        {/* Name - Required */}
        <Input
          label="Name *"
          placeholder="Character's name"
          value={formData.name}
          onChange={handleChange('name')}
          required
          autoFocus
        />

        {/* Description */}
        <TextArea
          label="Description"
          labelExtra={
            <AIHelperButton
              field="description"
              fields={aiFieldsSnapshot}
              onResult={setAIResult('description')}
            />
          }
          placeholder="Describe the character's appearance, background, and other details..."
          value={formData.description}
          onChange={handleChange('description')}
          rows={3}
        />

        {/* Personality */}
        <TextArea
          label="Personality"
          labelExtra={
            <AIHelperButton
              field="personality"
              fields={aiFieldsSnapshot}
              onResult={setAIResult('personality')}
            />
          }
          placeholder="Character's personality traits, mannerisms, speech patterns..."
          value={formData.personality}
          onChange={handleChange('personality')}
          rows={3}
        />

        {/* First Message */}
        <TextArea
          label="First Message"
          labelExtra={
            <AIHelperButton
              field="firstMessage"
              fields={aiFieldsSnapshot}
              onResult={setAIResult('firstMessage')}
            />
          }
          placeholder="The character's opening message when starting a new chat..."
          value={formData.firstMessage}
          onChange={handleChange('firstMessage')}
          rows={4}
        />

        {/* Alternate Greetings */}
        <AlternateGreetingsEditor
          greetings={alternateGreetings}
          onChange={setAlternateGreetings}
        />

        {/* Scenario */}
        <TextArea
          label="Scenario"
          labelExtra={
            <AIHelperButton
              field="scenario"
              fields={aiFieldsSnapshot}
              onResult={setAIResult('scenario')}
            />
          }
          placeholder="The setting or context for conversations..."
          value={formData.scenario}
          onChange={handleChange('scenario')}
          rows={2}
        />

        {/* Expression Images */}
        <ExpressionUpload onExpressionsChange={setExpressionFiles} />

        {/* Collapsible Advanced Section */}
        <details className="group">
          <summary className="cursor-pointer text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] py-2">
            Advanced Options
          </summary>

          <div className="space-y-4 mt-2 pl-2 border-l-2 border-[var(--color-border)]">
            {/* Example Messages */}
            <TextArea
              label="Example Messages"
              labelExtra={
                <AIHelperButton
                  field="exampleMessages"
                  fields={aiFieldsSnapshot}
                  onResult={setAIResult('exampleMessages')}
                />
              }
              placeholder="Example dialogue to help the AI understand the character's voice..."
              value={formData.exampleMessages}
              onChange={handleChange('exampleMessages')}
              rows={4}
            />

            {/* Character's Note (Depth Prompt) */}
            <div className="space-y-2">
              <TextArea
                label="Character's Note"
                placeholder="Injected at a configurable depth in the chat to reinforce behavior..."
                value={depthPromptPrompt}
                onChange={(e) => setDepthPromptPrompt(e.target.value)}
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
                      onChange={(e) => setDepthPromptDepth(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                      Role
                    </label>
                    <select
                      value={depthPromptRole}
                      onChange={(e) =>
                        setDepthPromptRole(e.target.value as 'system' | 'user' | 'assistant')
                      }
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
              placeholder="Overrides the main system prompt for this character..."
              value={systemPromptOverride}
              onChange={(e) => setSystemPromptOverride(e.target.value)}
              rows={3}
            />

            {/* Post-History Instructions */}
            <TextArea
              label="Post-History Instructions"
              placeholder="Instructions appended after the chat history..."
              value={postHistoryInstructions}
              onChange={(e) => setPostHistoryInstructions(e.target.value)}
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
                onChange={(e) => setTalkativeness(e.target.value)}
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
              onChange={(e) => setCharacterVersion(e.target.value)}
            />

            {/* Creator Notes */}
            <TextArea
              label="Creator Notes"
              placeholder="Notes about the character for other users..."
              value={formData.creatorNotes}
              onChange={handleChange('creatorNotes')}
              rows={2}
            />

            {/* Creator */}
            <Input
              label="Creator"
              placeholder="Your name or handle"
              value={formData.creator}
              onChange={handleChange('creator')}
            />

            {/* Tags */}
            <TagInput
              label="Tags"
              value={formData.tags}
              onChange={(tags) => setFormData((prev) => ({ ...prev, tags }))}
              suggestions={getAllTags()}
            />
          </div>
        </details>

        {/* Error Message */}
        {error && (
          <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={isCreating || isUploadingExpressions}
            disabled={!formData.name.trim()}
            className="flex-1"
          >
            {isUploadingExpressions ? 'Uploading Expressions...' : 'Create Character'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
