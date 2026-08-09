import { useState, useEffect, useRef } from 'react';
import { BookOpen, Download, FileImage, FileJson, Copy, UserCircle, Globe, Lock, Loader2, Wand2, Link2, Unlink, ArrowRightLeft, History } from 'lucide-react';
import { useCharacterStore } from '../../stores/characterStore';
import { useCharacterOwnershipStore } from '../../stores/characterOwnershipStore';
import { useAuthStore } from '../../stores/authStore';
import { hasPermission } from '../../utils/permissions';
import { spritesApi, type CharacterInfo } from '../../api/client';
import { Modal, Button, ImageUpload, ExpressionUpload } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import { cardToCharacterInfo, type CharacterCardV2, type CharacterExportData } from '../../utils/characterCard';
import { CoreCardFields } from './fields/CoreCardFields';
import { AdvancedCardFields } from './fields/AdvancedCardFields';
import { CharacterLorebookSection } from './CharacterLorebookSection';
import { useWorldInfoStore } from '../../stores/worldInfoStore';
import { GuideDrawer } from '../guides/GuideDrawer';
import { LivePortraitSetup } from './LivePortraitSetup';
import { CharacterSetupWizard } from './CharacterSetupWizard';
import { TransferOwnershipModal } from './TransferOwnershipModal';
import { useLivePortraitStore } from '../../stores/livePortraitStore';
import { useGenerationStore } from '../../stores/generationStore';
import { usePromptTemplateStore } from '../../stores/promptTemplateStore';
import { estimateTokens } from '../../utils/tokenizer';

/** Import provenance written by CharacterImport.tsx into
 *  `data.extensions.ggbc.import`. Read-only here — this component only
 *  ever repopulates the form from it, never writes it. */
interface ImportProvenance {
  version: number;
  imported_at: string;
  source_format: string;
  original_card: CharacterCardV2 | CharacterExportData | null;
  fixes_applied?: Array<{ finding: string; pass: string; field: string }>;
}

function getImportProvenance(character: CharacterInfo): ImportProvenance | null {
  const ggbc = character.data?.extensions?.ggbc as { import?: ImportProvenance } | undefined;
  return ggbc?.import ?? null;
}

interface CharacterEditProps {
  isOpen: boolean;
  onClose: () => void;
  character: CharacterInfo;
  onSaved?: () => void;
  onDuplicated?: (newAvatarUrl: string) => void;
  onConvertToPersona?: (character: CharacterInfo) => void;
}

export function CharacterEdit({
  isOpen,
  onClose,
  character,
  onSaved,
  onDuplicated,
  onConvertToPersona,
}: CharacterEditProps) {
  const {
    updateCharacter,
    duplicateCharacter,
    isEditing,
    isExporting,
    isDuplicating,
    error,
    clearError,
    exportCharacterAsPNG,
    exportCharacterAsJSON,
    getLinkedBookIds,
    setLinkedBookIds,
    getAllTags,
  } = useCharacterStore();
  const ownershipStore = useCharacterOwnershipStore();
  const currentUser = useAuthStore((s) => s.currentUser);
  const canSetGlobal = hasPermission(currentUser, 'character:set_global');
  const visibility = ownershipStore.getVisibility(character.avatar);
  const [isTogglingVisibility, setIsTogglingVisibility] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const isCharacterOwner =
    !!currentUser && ownershipStore.isOwnedBy(character.avatar, currentUser.handle);
  const canTransferOwnership = visibility === 'global' && isCharacterOwner;
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showLivePortraitSetup, setShowLivePortraitSetup] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [guideSection, setGuideSection] = useState<string | undefined>(undefined);
  const [showGuide, setShowGuide] = useState(false);
  const openGuide = (sectionId?: string) => {
    setGuideSection(sectionId);
    setShowGuide(true);
  };
  const livePortraitClips = useLivePortraitStore((s) => s.clipsByAvatar[character.avatar]);
  const hasLivePortraitClips = !!livePortraitClips && Object.keys(livePortraitClips).length > 0;
  const linkedPresetId = useGenerationStore((s) => s.linkedPresetByAvatar[character.avatar]);
  const linkedPreset = useGenerationStore((s) =>
    linkedPresetId ? s.presets.find((p) => p.id === linkedPresetId) : undefined
  );
  const setLinkedPreset = useGenerationStore((s) => s.setLinkedPreset);
  const linkedTemplateId = usePromptTemplateStore((s) => s.linkedTemplateByAvatar[character.avatar]);
  const linkedTemplate = usePromptTemplateStore((s) =>
    linkedTemplateId ? s.templates.find((t) => t.id === linkedTemplateId) : undefined
  );
  const setLinkedTemplate = usePromptTemplateStore((s) => s.setLinkedTemplate);

  const lorebookSectionRef = useRef<HTMLDivElement>(null);
  const embeddedBook = useWorldInfoStore((s) =>
    s.books.find((b) => b.ownerCharacterAvatar === character.avatar)
  );
  const hasEmbeddedLorebook = !!embeddedBook;
  const embeddedEntryCount = embeddedBook?.entries.length ?? 0;

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

  // Phase 2: Advanced character fields
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([]);
  const [characterVersion, setCharacterVersion] = useState('');
  const [depthPromptPrompt, setDepthPromptPrompt] = useState('');
  const [depthPromptDepth, setDepthPromptDepth] = useState(4);
  const [depthPromptRole, setDepthPromptRole] = useState<'system' | 'user' | 'assistant'>('system');
  const [systemPromptOverride, setSystemPromptOverride] = useState('');
  const [postHistoryInstructions, setPostHistoryInstructions] = useState('');
  const [talkativeness, setTalkativeness] = useState('0.5');
  // Phase 4.3: extra linked lorebooks (staged, committed on Save)
  const [linkedBookIds, setLinkedBookIdsLocal] = useState<string[]>([]);

  const getAvatarUrl = (avatar: string) => `/blobs/character/${encodeURIComponent(avatar)}`;

  // Populate form when character changes or modal opens
  useEffect(() => {
    if (isOpen && character) {
      setAvatarFile(null); // Reset file selection
      setShowExportMenu(false); // Reset export menu
      setFormData({
        name: character.name || '',
        description: character.description || character.data?.description || '',
        personality: character.personality || character.data?.personality || '',
        firstMessage: character.first_mes || character.data?.first_mes || '',
        scenario: character.scenario || character.data?.scenario || '',
        exampleMessages: character.mes_example || character.data?.mes_example || '',
        creatorNotes: character.creator_notes || character.data?.creator_notes || '',
        creator: character.creator || character.data?.creator || '',
        tags: character.tags || character.data?.tags || [],
      });

      // Populate advanced fields
      setAlternateGreetings(
        character.alternate_greetings || character.data?.alternate_greetings || []
      );
      setCharacterVersion(
        character.character_version || character.data?.character_version || ''
      );
      setSystemPromptOverride(
        character.system_prompt || character.data?.system_prompt || ''
      );
      setPostHistoryInstructions(
        character.post_history_instructions || character.data?.post_history_instructions || ''
      );

      const depthPrompt = character.data?.extensions?.depth_prompt;
      setDepthPromptPrompt(depthPrompt?.prompt || '');
      setDepthPromptDepth(depthPrompt?.depth ?? 4);
      setDepthPromptRole(
        (depthPrompt?.role as 'system' | 'user' | 'assistant') || 'system'
      );

      const charTalkativeness = character.data?.extensions?.talkativeness;
      setTalkativeness(typeof charTalkativeness === 'string' ? charTalkativeness : '0.5');

      // Phase 4.3: hydrate linked lorebook ids for this character
      setLinkedBookIdsLocal(getLinkedBookIds(character.avatar));
    }
  }, [isOpen, character, getLinkedBookIds]);

  const handleExportPNG = async () => {
    setShowExportMenu(false);
    await exportCharacterAsPNG(character);
  };

  const handleExportJSON = () => {
    setShowExportMenu(false);
    exportCharacterAsJSON(character);
  };

  const handleChange = (field: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    if (error) clearError();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      return;
    }

    const success = await updateCharacter(
      {
        avatar_url: character.avatar,
        ch_name: formData.name.trim(),
        description: formData.description.trim(),
        personality: formData.personality.trim(),
        first_mes: formData.firstMessage.trim(),
        scenario: formData.scenario.trim(),
        mes_example: formData.exampleMessages.trim(),
        creator_notes: formData.creatorNotes.trim(),
        creator: formData.creator.trim(),
        tags: formData.tags.join(', '),
        chat: character.create_date, // Preserve existing
        create_date: character.create_date, // Preserve existing
        // Advanced fields
        alternate_greetings: alternateGreetings.filter((g) => g.trim()),
        system_prompt: systemPromptOverride.trim() || undefined,
        post_history_instructions: postHistoryInstructions.trim() || undefined,
        character_version: characterVersion.trim() || undefined,
        depth_prompt_prompt: depthPromptPrompt.trim() || undefined,
        depth_prompt_depth: depthPromptPrompt.trim() ? depthPromptDepth : undefined,
        depth_prompt_role: depthPromptPrompt.trim() ? depthPromptRole : undefined,
        talkativeness: talkativeness || undefined,
        // Preserve the existing favorite flag and any third-party extension
        // namespaces — previously every edit silently sent fav:false and
        // rebuilt `extensions` from scratch, clearing both.
        fav: character.fav,
        extensions: character.data?.extensions,
      },
      avatarFile || undefined
    );

    if (success) {
      // Persist linked lorebook selections (client-side only)
      setLinkedBookIds(character.avatar, linkedBookIds);

      // Upload expression images if any
      if (expressionFiles.size > 0) {
        setIsUploadingExpressions(true);
        try {
          const characterName = character.name;
          console.log('[CharacterEdit] Uploading expressions for:', characterName);
          const results = await Promise.allSettled(
            Array.from(expressionFiles.entries()).map(([emotion, file]) =>
              spritesApi.uploadSprite(characterName, emotion, file)
            )
          );
          // Log any failures
          const failures = results.filter((r) => r.status === 'rejected');
          if (failures.length > 0) {
            console.error('[CharacterEdit] Some expression uploads failed:', failures);
          }
        } catch (err) {
          console.error('[CharacterEdit] Failed to upload expressions:', err);
        } finally {
          setIsUploadingExpressions(false);
        }
      }

      onClose();
      onSaved?.();
    }
  };

  const handleClose = () => {
    clearError();
    onClose();
  };

  const handleDuplicate = async () => {
    const newAvatar = await duplicateCharacter(character.avatar);
    if (newAvatar) {
      onClose();
      onDuplicated?.(newAvatar);
    }
  };

  const handleConvertToPersona = () => {
    onClose();
    onConvertToPersona?.(character);
  };

  const importProvenance = getImportProvenance(character);

  /** Repopulate the form from the card exactly as it was parsed at import
   *  time, before any deterministic/AI fix touched it. Non-destructive —
   *  this only changes in-progress form state; nothing is persisted until
   *  the user reviews and hits Save. */
  const handleRestoreOriginalImport = () => {
    if (!importProvenance?.original_card) return;
    const info = cardToCharacterInfo(importProvenance.original_card);

    setFormData({
      name: info.name || '',
      description: info.description || info.data?.description || '',
      personality: info.personality || info.data?.personality || '',
      firstMessage: info.first_mes || info.data?.first_mes || '',
      scenario: info.scenario || info.data?.scenario || '',
      exampleMessages: info.mes_example || info.data?.mes_example || '',
      creatorNotes: info.creator_notes || info.data?.creator_notes || '',
      creator: info.creator || info.data?.creator || '',
      tags: info.tags || info.data?.tags || [],
    });
    setAlternateGreetings(info.alternate_greetings || info.data?.alternate_greetings || []);
    setCharacterVersion(info.character_version || info.data?.character_version || '');
    setSystemPromptOverride(info.system_prompt || info.data?.system_prompt || '');
    setPostHistoryInstructions(
      info.post_history_instructions || info.data?.post_history_instructions || ''
    );
    const depthPrompt = info.data?.extensions?.depth_prompt;
    setDepthPromptPrompt(depthPrompt?.prompt || '');
    setDepthPromptDepth(depthPrompt?.depth ?? 4);
    setDepthPromptRole((depthPrompt?.role as 'system' | 'user' | 'assistant') || 'system');
    const restoredTalkativeness = info.data?.extensions?.talkativeness;
    setTalkativeness(typeof restoredTalkativeness === 'string' ? restoredTalkativeness : '0.5');

    showToastGlobal('Restored the original imported text — review and Save to keep it.', 'info');
  };

  const handleToggleVisibility = async () => {
    const next = visibility === 'global' ? 'personal' : 'global';
    setIsTogglingVisibility(true);
    try {
      await ownershipStore.setVisibility(character.avatar, next);
      // Server physically moved the file between directories — refresh the
      // character list so subsequent API calls target the right scope.
      await useCharacterStore.getState().fetchCharacters();
    } catch (err) {
      console.error('Failed to change character visibility', err);
    } finally {
      setIsTogglingVisibility(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={`Edit ${character.name}`} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Avatar Upload */}
        <ImageUpload
          currentImage={getAvatarUrl(character.avatar)}
          onImageSelect={setAvatarFile}
          label="Avatar"
        />

        {/* Import provenance — only shown for characters imported after this
            landed; a manually-created or pre-existing character has none. */}
        {importProvenance?.original_card && (
          <div className="p-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg flex items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-2 min-w-0 text-[var(--color-text-secondary)]">
              <History size={14} className="shrink-0" />
              <span className="truncate">
                Imported {new Date(importProvenance.imported_at).toLocaleDateString()}
                {importProvenance.fixes_applied && importProvenance.fixes_applied.length > 0
                  ? ` · ${importProvenance.fixes_applied.length} fix${importProvenance.fixes_applied.length === 1 ? '' : 'es'} applied`
                  : ''}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRestoreOriginalImport}
              className="shrink-0"
            >
              Restore original import
            </Button>
          </div>
        )}

        {/* Character Actions */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleDuplicate}
            isLoading={isDuplicating}
            title="Create a copy of this character"
          >
            <Copy size={16} className="mr-1.5" />
            Duplicate
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleConvertToPersona}
            title="Create a new persona using this character's data"
          >
            <UserCircle size={16} className="mr-1.5" />
            To Persona
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShowWizard(true)}
            title="Get personalized settings recommendations for this character"
          >
            <Wand2 size={16} className="mr-1.5" />
            Setup Wizard
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => openGuide()}
            title="Open the character building guide"
          >
            <BookOpen size={16} className="mr-1.5" />
            Building Guide
          </Button>
          {hasEmbeddedLorebook && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                lorebookSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              title="Jump to this character's lorebook"
            >
              <BookOpen size={16} className="mr-1.5" />
              Lorebook ({embeddedEntryCount})
            </Button>
          )}
          <div className="relative">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={isExporting}
            >
              {isExporting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-1.5" />
                  Exporting
                </>
              ) : (
                <>
                  <Download size={16} className="mr-1.5" />
                  Export
                </>
              )}
            </Button>

            {showExportMenu && (
              <div className="absolute top-full right-0 mt-1 min-w-[220px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg z-10 overflow-hidden">
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
                  onClick={handleExportPNG}
                >
                  <FileImage size={18} className="text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-medium text-[var(--color-text-primary)]">PNG Card</p>
                    <p className="text-xs text-[var(--color-text-secondary)]">Card with embedded data</p>
                  </div>
                </button>
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors border-t border-[var(--color-border)]"
                  onClick={handleExportJSON}
                >
                  <FileJson size={18} className="text-[var(--color-primary)]" />
                  <div>
                    <p className="text-sm font-medium text-[var(--color-text-primary)]">JSON</p>
                    <p className="text-xs text-[var(--color-text-secondary)]">V2 card as JSON</p>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Linked Generation Preset (auto-loads on chat open) */}
        {linkedPreset && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 px-3 py-2">
            <div className="min-w-0 flex items-center gap-2">
              <Link2 size={14} className="text-[var(--color-primary)] shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                  Linked preset: {linkedPreset.name}
                </p>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Sampler auto-loads when you chat with {character.name}.
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLinkedPreset(character.avatar, null)}
              className="shrink-0"
              title="Remove the link (the preset itself is kept)"
            >
              <Unlink size={14} className="mr-1.5" />
              Unlink
            </Button>
          </div>
        )}

        {/* Linked Prompt Template (HYPERCODE / etc.) */}
        {linkedTemplate && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 px-3 py-2">
            <div className="min-w-0 flex items-center gap-2">
              <Link2 size={14} className="text-[var(--color-primary)] shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                  Linked prompt: {linkedTemplate.name}
                </p>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  System prompt auto-loads when you chat with {character.name} (~
                  {estimateTokens(linkedTemplate.prompt.mainPrompt)} tok / turn).
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLinkedTemplate(character.avatar, null)}
              className="shrink-0"
              title="Remove the link (the template itself is kept)"
            >
              <Unlink size={14} className="mr-1.5" />
              Unlink
            </Button>
          </div>
        )}

        {/* Visibility (global vs personal) — gated on character:set_global */}
        {canSetGlobal && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                Visibility: {visibility === 'global' ? 'Global' : 'Personal'}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {visibility === 'global'
                  ? 'Shared with all users on this server.'
                  : 'Only visible to you.'}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleToggleVisibility}
              disabled={isTogglingVisibility}
              className="shrink-0"
            >
              {isTogglingVisibility ? (
                <Loader2 size={14} className="animate-spin mr-1.5" />
              ) : visibility === 'global' ? (
                <Lock size={14} className="mr-1.5" />
              ) : (
                <Globe size={14} className="mr-1.5" />
              )}
              {visibility === 'global' ? 'Make Personal' : 'Make Global'}
            </Button>
          </div>
        )}

        {/* Transfer Ownership — only the current owner of a global character can hand it off */}
        {canTransferOwnership && (
          <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                You own this character
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Transfer ownership to another user. The character stays global.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowTransferModal(true)}
              className="shrink-0"
            >
              <ArrowRightLeft size={14} className="mr-1.5" />
              Transfer
            </Button>
          </div>
        )}

        <CoreCardFields
          formData={formData}
          onChange={handleChange}
          alternateGreetings={alternateGreetings}
          onAlternateGreetingsChange={setAlternateGreetings}
          helpTips={{
            description:
              "The AI's mental image of the character. Describe physical appearance, background, world context, and relevant history. This is included in every prompt — be thorough but not redundant.",
            personality:
              "How the character thinks, speaks, and feels. Focus on speech patterns, emotional tendencies, and quirks. Specific phrases like 'speaks in short, clipped sentences' or 'always deflects with humor' lead to more consistent character behavior than abstract traits like 'kind.'",
            firstMessage:
              'The character\'s opening line when a new chat starts. Sets the tone and scene for the whole conversation. Opening mid-action or mid-moment works better than a generic greeting — it immediately pulls the user into the world.',
            scenario:
              'The specific situation when the chat begins — location, what just happened, the stakes. Unlike Description (which is always-on), Scenario sets the starting context for this particular conversation. Keep it focused; save world-building for World Info.',
          }}
        />

        {/* Expression Images */}
        <ExpressionUpload
          characterName={character.name}
          onExpressionsChange={setExpressionFiles}
        />

        {/* Live Portrait — generates animated MP4 clips for the in-chat avatar */}
        <div className="border border-[var(--color-border)] rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[var(--color-text-primary)] flex-1">
              Live Portrait
            </p>
            {hasLivePortraitClips ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-violet-500/15 text-violet-400">
                {Object.keys(livePortraitClips!).length} clips ready
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                not generated
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Generate animated clips so this character can breathe, blink, and react with
            emotion in chat. One-time generation per character, then plays for free.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowLivePortraitSetup(true)}
          >
            {hasLivePortraitClips ? 'Manage clips' : 'Set up Live Portrait'}
          </Button>
        </div>

        {/* Phase 4.3: Character lorebooks */}
        <div ref={lorebookSectionRef} className="scroll-mt-16 space-y-2">
          <div className="flex items-center justify-end -mb-2">
            <button
              type="button"
              onClick={() => openGuide('lorebooks')}
              className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] inline-flex items-center gap-1"
            >
              <BookOpen size={12} /> Lorebook guide
            </button>
          </div>
          <CharacterLorebookSection
            avatar={character.avatar}
            characterName={formData.name || character.name}
            linkedBookIds={linkedBookIds}
            onLinkedBookIdsChange={setLinkedBookIdsLocal}
          />
        </div>

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
          helpTips={{
            exampleMessages:
              "Sample dialogue that teaches the AI the character's voice. Use the format: {{user}}: [message]\n{{char}}: [response]\n\nA few good examples (3–5 exchanges) are more effective than many mediocre ones. Focus on capturing distinctive speech patterns or reactions rather than plot.",
            characterNote:
              'A reminder injected at a specific position in the chat history (controlled by Injection Depth). Useful for keeping the AI on-track during long conversations where early instructions start to fade. Acts as a nudge rather than a full system prompt.',
            systemPrompt:
              "Replaces the global Main Prompt for this character only. Use when a character needs a fundamentally different system prompt than your default. Only active if 'Honor character's System Prompt override' is enabled in Generation Settings → Prompts.",
            postHistoryInstructions:
              "A system message inserted after the chat history, just before the AI responds. This is the last thing the AI reads before generating a reply — great for final behavioral nudges or reminders. Requires 'Honor character's Post-History Instructions' in Generation Settings → Prompts.",
          }}
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
            disabled={isEditing || isUploadingExpressions}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={isEditing || isUploadingExpressions}
            disabled={!formData.name.trim()}
            className="flex-1"
          >
            {isUploadingExpressions ? 'Uploading Expressions...' : 'Save Changes'}
          </Button>
        </div>
      </form>
      <LivePortraitSetup
        avatar={character.avatar}
        characterName={character.name}
        imageUrl={`/blobs/character/${encodeURIComponent(character.avatar)}`}
        isOpen={showLivePortraitSetup}
        onClose={() => setShowLivePortraitSetup(false)}
      />
      <CharacterSetupWizard
        isOpen={showWizard}
        onClose={() => setShowWizard(false)}
        characterName={character.name}
        characterAvatar={character.avatar}
        onApplyToCharacterSystemPrompt={(text) => {
          setSystemPromptOverride(text);
          showToastGlobal(
            `HYPERCODE prompt set on ${character.name}. Click Save Changes to persist.`,
            'success'
          );
        }}
        existingSystemPromptOverride={systemPromptOverride}
        characterFieldsTokens={
          estimateTokens(formData.description) +
          estimateTokens(formData.personality) +
          estimateTokens(formData.scenario) +
          estimateTokens(formData.firstMessage)
        }
      />
      <GuideDrawer
        isOpen={showGuide}
        onClose={() => setShowGuide(false)}
        guideSlug="character-guide"
        sectionId={guideSection}
      />
      <TransferOwnershipModal
        isOpen={showTransferModal}
        onClose={() => setShowTransferModal(false)}
        character={character}
        onTransferred={() => {
          // After a successful transfer the caller is no longer the owner —
          // close the editor so the UI re-checks permissions on next open.
          onClose();
        }}
      />
    </Modal>
  );
}
