import { useState } from 'react';
import { useCharacterStore } from '../../stores/characterStore';
import { Modal, Button, ImageUpload, ExpressionUpload } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import { CoreCardFields } from './fields/CoreCardFields';
import { AdvancedCardFields } from './fields/AdvancedCardFields';
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

        <CoreCardFields
          formData={formData}
          onChange={handleChange}
          alternateGreetings={alternateGreetings}
          onAlternateGreetingsChange={setAlternateGreetings}
          aiHelper={{ fields: aiFieldsSnapshot, onResult: setAIResult }}
        />

        {/* Expression Images */}
        <ExpressionUpload onExpressionsChange={setExpressionFiles} />

        <AdvancedCardFields
          formData={formData}
          onChange={handleChange}
          onTagsChange={(tags) => setFormData((prev) => ({ ...prev, tags }))}
          tagSuggestions={getAllTags()}
          characterVersion={characterVersion}
          onCharacterVersionChange={setCharacterVersion}
          depthPromptPrompt={depthPromptPrompt}
          onDepthPromptPromptChange={setDepthPromptPrompt}
          depthPromptDepth={depthPromptDepth}
          onDepthPromptDepthChange={setDepthPromptDepth}
          depthPromptRole={depthPromptRole}
          onDepthPromptRoleChange={setDepthPromptRole}
          systemPromptOverride={systemPromptOverride}
          onSystemPromptOverrideChange={setSystemPromptOverride}
          postHistoryInstructions={postHistoryInstructions}
          onPostHistoryInstructionsChange={setPostHistoryInstructions}
          talkativeness={talkativeness}
          onTalkativenessChange={setTalkativeness}
          aiHelper={{ fields: aiFieldsSnapshot, onResult: setAIResult }}
        />

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
            disabled={isCreating || isUploadingExpressions}
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
