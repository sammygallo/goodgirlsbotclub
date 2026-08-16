import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import { usePersonaInterviewStore } from '../../../stores/personaInterviewStore';
import type { Persona } from '../../../stores/personaStore';
import { getProviderAndModel } from '../../../utils/llm/resolve';
import { isWeakModel } from '../../../utils/storyIngest/modelStrength';
import { Button, BottomSheet, Modal } from '../../ui';
import { PersonaInterviewChat } from './PersonaInterviewChat';
import { PersonaPreviewPanel } from './PersonaPreviewPanel';
import { PersonaInterviewAvatarStep } from './PersonaInterviewAvatarStep';
import { PersonaInterviewReview, DEFAULT_REVIEW_SETTINGS, type ReviewSettingsState } from './PersonaInterviewReview';

export interface PersonaInterviewProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (persona: Persona) => void;
  /** "Use the simple form instead" escape hatch — the parent handles opening
   *  the plain PersonaForm; this component never renders it itself. */
  onUseSimpleForm: () => void;
}

function IntroScreen({
  provider,
  model,
  weakModel,
  onStart,
  onUseSimpleForm,
}: {
  provider: string;
  model: string;
  weakModel: boolean;
  onStart: () => void;
  onUseSimpleForm: () => void;
}) {
  return (
    <div className="h-full overflow-y-auto flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full space-y-5 text-center">
        <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">Let's build your persona together</h2>
        <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
          I'll ask a few quick questions about who you want to be in your chats — a name and a sketch of the person —
          and fill it in as we go. Skip anything, tell me to decide, or wrap up early whenever you want.
        </p>

        <div className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2">
          Using <span className="text-[var(--color-text-primary)] font-medium">{provider}</span> ·{' '}
          <span className="text-[var(--color-text-primary)] font-medium">{model}</span>
        </div>

        {weakModel && (
          <div className="flex items-start gap-2 text-left text-xs text-amber-400 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              This looks like a lighter/cheaper model — it may need more nudging or give thinner answers. You can switch
              models in Settings before starting, or just go with it.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button type="button" variant="primary" onClick={onStart} className="w-full">
            Start
          </Button>
          <button
            type="button"
            onClick={onUseSimpleForm}
            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] underline underline-offset-2"
          >
            Use the simple form instead
          </button>
        </div>
      </div>
    </div>
  );
}

function SynthesizingScreen({
  error,
  onRetry,
  onCancel,
}: {
  error: string | null;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      {!error ? (
        <>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]" />
          <p className="text-sm text-[var(--color-text-secondary)]">Putting together your persona…</p>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-red-400 max-w-sm">{error}</p>
          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Full-screen persona interview wizard — parallels CharacterInterview. Not
 * built on the shared `Modal` (which is meant for a single centered dialog,
 * not this two-pane chat+preview layout). z-[100] matches Modal's own
 * full-overlay convention. Unlike the character wizard there is no
 * cross-session resume, so closing mid-interview simply discards after a
 * confirm.
 */
export function PersonaInterview({ isOpen, onClose, onCreated, onUseSimpleForm }: PersonaInterviewProps) {
  const phase = usePersonaInterviewStore((s) => s.phase);
  const error = usePersonaInterviewStore((s) => s.error);
  const start = usePersonaInterviewStore((s) => s.start);
  const retryTurn = usePersonaInterviewStore((s) => s.retryTurn);
  const abort = usePersonaInterviewStore((s) => s.abort);
  const reset = usePersonaInterviewStore((s) => s.reset);

  const [showPreviewSheet, setShowPreviewSheet] = useState(false);
  // Injection/default/lorebook settings live here (not in the store's draft)
  // so a "Change avatar" round-trip that remounts the review doesn't reset
  // them — same reason CharacterInterview owns InterviewReview's extras.
  const [reviewSettings, setReviewSettings] = useState<ReviewSettingsState>(DEFAULT_REVIEW_SETTINGS);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);

  if (!isOpen) return null;

  const closeAfterCleanup = () => {
    abort();
    reset();
    setReviewSettings(DEFAULT_REVIEW_SETTINGS);
    setShowLeaveDialog(false);
    onClose();
  };

  const handleClose = () => {
    // A synchronous createPersona means 'saving' is momentary, but keep the
    // guard for parity — never tear down while a save is notionally in flight.
    if (phase === 'saving') return;
    if (phase === 'intro') {
      closeAfterCleanup();
      return;
    }
    // An in-app dialog, not window.confirm() — some mobile WebView/PWA
    // contexts silently suppress confirm(), which reads as a dead close
    // button (confirmed on the character wizard, 2026-08-09).
    setShowLeaveDialog(true);
  };

  const { provider, model } = getProviderAndModel();
  const weakModel = isWeakModel(model);

  // Portal to document.body — this wizard is mounted inside the app header,
  // which is `position: sticky; z-index: 20` and therefore its own stacking
  // context; a bare `fixed inset-0 z-[100]` would be trapped beneath it (the
  // sidebar paints over it). The character wizard sidesteps this only because
  // it mounts in the sidebar, not the header. Matches Modal/HelpTip, which
  // portal for the same reason.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <h1 className="text-base font-semibold text-[var(--color-text-primary)]">Create a persona — interview</h1>
        <button
          type="button"
          onClick={handleClose}
          disabled={phase === 'saving'}
          className="p-2 -mr-2 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden relative">
        {phase === 'intro' && (
          <IntroScreen
            provider={provider}
            model={model}
            weakModel={weakModel}
            onStart={start}
            onUseSimpleForm={onUseSimpleForm}
          />
        )}

        {phase === 'chat' && (
          <div className="h-full flex flex-col md:flex-row min-h-0">
            <div className="flex-1 min-h-0 min-w-0">
              <PersonaInterviewChat />
            </div>

            {/* Desktop: fixed-width side panel */}
            <div className="hidden md:block w-[380px] flex-shrink-0 border-l border-[var(--color-border)] overflow-y-auto">
              <PersonaPreviewPanel />
            </div>

            {/* Mobile: floating chip opens the same content in a bottom sheet */}
            <button
              type="button"
              onClick={() => setShowPreviewSheet(true)}
              className="md:hidden fixed bottom-24 right-4 z-10 px-3 py-2 rounded-full bg-[var(--color-primary)] text-white text-xs font-medium shadow-lg"
            >
              View persona
            </button>
            <div className="md:hidden">
              <BottomSheet isOpen={showPreviewSheet} onClose={() => setShowPreviewSheet(false)} title="Persona so far">
                <PersonaPreviewPanel />
              </BottomSheet>
            </div>
          </div>
        )}

        {phase === 'synthesizing' && (
          <SynthesizingScreen error={error} onRetry={retryTurn} onCancel={handleClose} />
        )}

        {phase === 'avatar' && <PersonaInterviewAvatarStep />}

        {(phase === 'review' || phase === 'saving') && (
          <PersonaInterviewReview
            settings={reviewSettings}
            onSettingsChange={setReviewSettings}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
      </div>

      <Modal
        isOpen={showLeaveDialog}
        onClose={() => setShowLeaveDialog(false)}
        title="Leave this persona interview?"
        size="sm"
      >
        <p className="text-sm text-[var(--color-text-secondary)] mb-6">
          Your progress here isn't saved — leave now and you'll start fresh next time.
        </p>
        <div className="flex flex-col gap-2">
          <Button type="button" variant="danger" size="sm" onClick={closeAfterCleanup} className="w-full">
            Discard &amp; close
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowLeaveDialog(false)}
            className="w-full"
          >
            Keep editing
          </Button>
        </div>
      </Modal>
    </div>,
    document.body
  );
}
