import { useState, type ReactNode } from 'react';
import { Check, Upload, Sparkles, SkipForward, AlertTriangle, Settings2, ChevronDown, ChevronUp } from 'lucide-react';
import { usePersonaInterviewStore } from '../../../stores/personaInterviewStore';
import { useImageGenStore } from '../../../stores/imageGenStore';
import { useAuthStore } from '../../../stores/authStore';
import { hasPermission } from '../../../utils/permissions';
import { compressImageFile } from '../../../utils/images';
import type { PersonaDraft } from '../../../utils/personaInterview/types';
import type { ImageGenBackend } from '../../../api/imageGenApi';
import { Button, ImageUpload } from '../../ui';
import { ImageCropModal } from '../../ui/ImageCropModal';
import { ImageGenProviderNotice } from '../../settings/ImageGenProviderNotice';

// ─── Option card — local copy of the pattern in CharacterSetupWizard /
// InterviewAvatarStep (not exported there). ─────────────────────────────────

interface OptionCardProps {
  onClick: () => void;
  icon: ReactNode;
  label: string;
  description: string;
  disabled?: boolean;
}

function OptionCard({ onClick, icon, label, description, disabled }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] hover:border-[var(--color-primary)]/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[var(--color-border)]"
    >
      <div className="flex items-start gap-3">
        <span className="shrink-0 mt-0.5 text-[var(--color-primary)]">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-text-primary)]">{label}</p>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 leading-relaxed">{description}</p>
        </div>
      </div>
    </button>
  );
}

// ─── Portrait prompt ──────────────────────────────────────────────────────

function firstSentence(text: string): string {
  return (text.split(/(?<=[.!?])\s+/)[0] || text).trim();
}

/** Deterministic portrait prompt from the persona draft. Always ends with
 *  the house content-safety line: an original, fictional portrait, not a
 *  depiction of any real person (see content_safety_nsfw_scope — real-person
 *  depiction is gated at the prompt level, not moderated after the fact). */
export function buildPersonaPortraitPrompt(draft: PersonaDraft): string {
  const parts: string[] = [];
  if (draft.name) parts.push(draft.name);
  if (draft.description) parts.push(firstSentence(draft.description));

  const subject = parts.filter(Boolean).join(', ') || 'an original character';
  return (
    `Portrait of ${subject}. Digital painting, detailed, character portrait, centered composition, ` +
    `plain background. Fictional character, original artwork — not based on or depicting any real person.`
  );
}

// ─── Step ─────────────────────────────────────────────────────────────────

type Choice = 'upload' | 'generate' | null;

export function PersonaInterviewAvatarStep() {
  const interview = usePersonaInterviewStore((s) => s.interview);
  const setAvatarDataUrl = usePersonaInterviewStore((s) => s.setAvatarDataUrl);
  const proceedToReview = usePersonaInterviewStore((s) => s.proceedToReview);

  const currentUser = useAuthStore((s) => s.currentUser);
  const canGenerate = hasPermission(currentUser, 'generation:image');

  const generate = useImageGenStore((s) => s.generate);
  const genBusy = useImageGenStore((s) => s.isGenerating);
  const genError = useImageGenStore((s) => s.error);
  const clearGenError = useImageGenStore((s) => s.clearError);
  const imageBackend = useImageGenStore((s) => s.backend);
  const setImageConfig = useImageGenStore((s) => s.setConfig);

  const [choice, setChoice] = useState<Choice>(null);
  const [generatedSrc, setGeneratedSrc] = useState<string | null>(null);
  const [showImageOptions, setShowImageOptions] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  /** Any picked/cropped/generated File becomes a bounded data URL before it
   *  goes into the persona (persona.avatarDataUrl lives in localStorage +
   *  the /blobs PUT, so an un-shrunk base64 would bloat both). */
  const commitFile = async (file: File) => {
    setUploadError(null);
    try {
      const dataUrl = await compressImageFile(file);
      setAvatarDataUrl(dataUrl);
      proceedToReview();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not process that image.');
    }
  };

  const handleGenerateClick = async () => {
    setChoice('generate');
    clearGenError();
    const prompt = buildPersonaPortraitPrompt(interview.draft);
    // freeFallback: a flaky Pollinations failure silently retries AI Horde so
    // the zero-setup path doesn't dead-end mid-wizard.
    const dataUrl = await generate(prompt, undefined, { freeFallback: true });
    if (dataUrl) setGeneratedSrc(dataUrl);
    else setShowImageOptions(true);
  };

  const handleCropConfirm = (file: File) => {
    setGeneratedSrc(null);
    void commitFile(file);
  };

  const handleSkip = () => {
    proceedToReview();
  };

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full space-y-4">
        <div className="text-center space-y-1.5">
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Give your persona a face</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Optional — you can always add or change this later.
          </p>
        </div>

        {choice === 'upload' ? (
          <div className="space-y-3">
            <ImageUpload
              onImageSelect={(file) => {
                if (file) void commitFile(file);
              }}
              label="Avatar"
            />
            {uploadError && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{uploadError}</span>
              </div>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setChoice(null)}>
              Back
            </Button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <OptionCard
              onClick={() => setChoice('upload')}
              disabled={genBusy}
              icon={<Upload size={20} />}
              label="Upload an image"
              description="Pick a file from your device and crop it to a portrait."
            />
            <OptionCard
              onClick={handleGenerateClick}
              disabled={!canGenerate || genBusy}
              icon={canGenerate ? <Sparkles size={20} /> : <Check size={20} className="opacity-30" />}
              label={canGenerate ? 'Generate a portrait' : 'Generate a portrait (unavailable)'}
              description={
                canGenerate
                  ? 'Draft a portrait from your persona so far — you can crop and confirm it.'
                  : "Your account doesn't have image-generation access."
              }
            />
            <OptionCard
              onClick={handleSkip}
              disabled={genBusy}
              icon={<SkipForward size={20} />}
              label="Skip for now"
              description="Create the persona without an avatar."
            />

            {/* Image options — switch engine or reuse the main provider without
                leaving the wizard. Auto-opens when a generation fails. */}
            {canGenerate && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowImageOptions((v) => !v)}
                  disabled={genBusy}
                  className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
                >
                  <Settings2 size={13} />
                  Image options
                  {showImageOptions ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                {showImageOptions && (
                  <div className="mt-2 space-y-2.5 p-3 bg-[var(--color-bg-tertiary)] rounded-lg border border-[var(--color-border)]">
                    <ImageGenProviderNotice />
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                        Image engine
                      </label>
                      <select
                        value={imageBackend}
                        onChange={(e) => setImageConfig({ backend: e.target.value as ImageGenBackend })}
                        disabled={genBusy}
                        className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
                      >
                        <option value="pollinations">Pollinations (free, no setup)</option>
                        <option value="horde">AI Horde (free, distributed)</option>
                        <option value="dalle">OpenAI DALL·E (uses your OpenAI key)</option>
                        <option value="sdwebui">SD WebUI (local)</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}

            {choice === 'generate' && genBusy && (
              <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-text-secondary)] py-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-primary)]" />
                Generating…
              </div>
            )}

            {choice === 'generate' && !genBusy && genError && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{genError}. Try a different image engine in “Image options” above, or use Upload/Skip instead.</span>
              </div>
            )}

            {uploadError && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>
        )}

        {/* Scoped to the 'generate' choice so a late-resolving generate() can
            never pop this over the Upload flow if the user switched. */}
        {choice === 'generate' && generatedSrc && (
          <ImageCropModal imageSrc={generatedSrc} onConfirm={handleCropConfirm} onClose={() => setGeneratedSrc(null)} />
        )}
      </div>
    </div>
  );
}
