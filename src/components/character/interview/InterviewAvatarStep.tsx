import { useState, type ReactNode } from 'react';
import { Check, Upload, Sparkles, SkipForward, AlertTriangle } from 'lucide-react';
import { useCharacterInterviewStore } from '../../../stores/characterInterviewStore';
import { useImageGenStore } from '../../../stores/imageGenStore';
import { useAuthStore } from '../../../stores/authStore';
import { hasPermission } from '../../../utils/permissions';
import type { InterviewDraft } from '../../../utils/characterInterview/types';
import { Button, ImageUpload } from '../../ui';
import { ImageCropModal } from '../../ui/ImageCropModal';

// ─── Option card — replicated from CharacterSetupWizard.tsx's own local
// OptionCard (not exported there, so this is a local copy, not an import).
// ───────────────────────────────────────────────────────────────────────

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

function truncateWords(text: string, maxWords: number): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : trimmed;
}

function firstSentence(text: string): string {
  return (text.split(/(?<=[.!?])\s+/)[0] || text).trim();
}

/** Deterministic portrait prompt built from the interview draft so far —
 *  leans on name/a one-line read of the description/personality tone
 *  rather than feeding the model's own full prose verbatim. Always ends
 *  with the house content-safety line: this is a fictional character
 *  portrait, not a depiction of any real person (see content_safety_nsfw_
 *  scope memory — real-person depiction is gated out at the prompt level,
 *  not just moderated after the fact). */
export function buildPortraitPrompt(draft: InterviewDraft): string {
  const parts: string[] = [];
  if (draft.name) parts.push(draft.name);
  if (draft.description) parts.push(firstSentence(draft.description));
  if (draft.personality) parts.push(`${truncateWords(draft.personality, 12)} expression`);

  const subject = parts.filter(Boolean).join(', ') || 'an original character';
  return (
    `Portrait of ${subject}. Digital painting, detailed, character portrait, centered composition, ` +
    `plain background. Fictional character, original artwork — not based on or depicting any real person.`
  );
}

// ─── Step ─────────────────────────────────────────────────────────────────

type Choice = 'upload' | 'generate' | null;

export function InterviewAvatarStep() {
  const interview = useCharacterInterviewStore((s) => s.interview);
  const setAvatarFile = useCharacterInterviewStore((s) => s.setAvatarFile);
  const proceedToReview = useCharacterInterviewStore((s) => s.proceedToReview);

  const currentUser = useAuthStore((s) => s.currentUser);
  const canGenerate = hasPermission(currentUser, 'generation:image');

  const generate = useImageGenStore((s) => s.generate);
  const genBusy = useImageGenStore((s) => s.isGenerating);
  const genError = useImageGenStore((s) => s.error);
  const clearGenError = useImageGenStore((s) => s.clearError);

  const [choice, setChoice] = useState<Choice>(null);
  const [generatedSrc, setGeneratedSrc] = useState<string | null>(null);

  const handleGenerateClick = async () => {
    setChoice('generate');
    clearGenError();
    const prompt = buildPortraitPrompt(interview.draft);
    const dataUrl = await generate(prompt);
    if (dataUrl) setGeneratedSrc(dataUrl);
  };

  const handleCropConfirm = (file: File) => {
    setGeneratedSrc(null);
    setAvatarFile(file);
    proceedToReview();
  };

  const handleSkip = () => {
    proceedToReview();
  };

  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full space-y-4">
        <div className="text-center space-y-1.5">
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">Give them a face</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Optional — you can always add or change this later.
          </p>
        </div>

        {choice === 'upload' ? (
          <div className="space-y-3">
            <ImageUpload
              onImageSelect={(file) => {
                if (file) {
                  setAvatarFile(file);
                  proceedToReview();
                }
              }}
              label="Avatar"
            />
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
                  ? 'Draft a portrait from the character so far — you can crop and confirm it.'
                  : "Your account doesn't have image-generation access."
              }
            />
            <OptionCard
              onClick={handleSkip}
              disabled={genBusy}
              icon={<SkipForward size={20} />}
              label="Skip for now"
              description="Create the character without an avatar."
            />

            {choice === 'generate' && genBusy && (
              <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-text-secondary)] py-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-primary)]" />
                Generating…
              </div>
            )}

            {choice === 'generate' && !genBusy && genError && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{genError} — check your Image Generation settings, or use Upload/Skip instead.</span>
              </div>
            )}
          </div>
        )}

        {/* Scoped to the 'generate' choice (not just generatedSrc being set)
            so a late-resolving generate() can never pop this over the
            Upload flow if the user switched choices in the meantime — the
            OptionCards above are also disabled while genBusy so that
            switch can't happen mid-request in the first place; this is the
            defense-in-depth backstop. */}
        {choice === 'generate' && generatedSrc && (
          <ImageCropModal imageSrc={generatedSrc} onConfirm={handleCropConfirm} onClose={() => setGeneratedSrc(null)} />
        )}
      </div>
    </div>
  );
}
