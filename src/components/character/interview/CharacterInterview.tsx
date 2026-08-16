import { useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { useCharacterInterviewStore } from '../../../stores/characterInterviewStore';
import { getProviderAndModel } from '../../../utils/llm/resolve';
import { isWeakModel } from '../../../utils/storyIngest/modelStrength';
import { Button, BottomSheet, Modal } from '../../ui';
import { InterviewChat } from './InterviewChat';
import { CardPreviewPanel } from './CardPreviewPanel';
import { InterviewAvatarStep } from './InterviewAvatarStep';
import { InterviewReview, DEFAULT_REVIEW_EXTRAS, type ReviewExtrasState } from './InterviewReview';

export interface CharacterInterviewProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (avatarUrl: string) => void;
  /** "Use the simple form instead" escape hatch — the parent handles
   *  swapping to CharacterCreation; this component never renders it itself. */
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
        <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">Let's build a character together</h2>
        <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
          I'll ask a few questions about who they are, how they talk, and how a chat with them should feel — and
          fill in the card as we go. Skip anything, tell me to decide, or wrap up early whenever you want.
        </p>

        <div className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2">
          Using <span className="text-[var(--color-text-primary)] font-medium">{provider}</span> ·{' '}
          <span className="text-[var(--color-text-primary)] font-medium">{model}</span>
        </div>

        {weakModel && (
          <div className="flex items-start gap-2 text-left text-xs text-amber-400 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              This looks like a lighter/cheaper model — it may need more nudging or give thinner answers. You can
              switch models in Settings before starting, or just go with it.
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
          <p className="text-sm text-[var(--color-text-secondary)]">Putting together your character card…</p>
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
 * Full-screen interview wizard — replaces (or, per the caller's own
 * routing, sits alongside) the plain CharacterCreation form. Not built on
 * the shared `Modal` component: Modal caps at max-w-2xl and is meant for a
 * single centered dialog, not this screen's two-pane chat+preview layout.
 * z-[100] matches Modal's own full-overlay convention — nothing in this
 * flow is expected to coexist with an open Modal, but staying at the same
 * tier (rather than exceeding it) keeps the stacking order predictable if
 * one ever does.
 */
export function CharacterInterview({ isOpen, onClose, onCreated, onUseSimpleForm }: CharacterInterviewProps) {
  const phase = useCharacterInterviewStore((s) => s.phase);
  const error = useCharacterInterviewStore((s) => s.error);
  const start = useCharacterInterviewStore((s) => s.start);
  const retryTurn = useCharacterInterviewStore((s) => s.retryTurn);
  const abort = useCharacterInterviewStore((s) => s.abort);
  const reset = useCharacterInterviewStore((s) => s.reset);
  const discardDraft = useCharacterInterviewStore((s) => s.discardDraft);

  const [showCardSheet, setShowCardSheet] = useState(false);
  // Advanced-review fields with no home in the store's InterviewDraft
  // (Creator, System Prompt Override, etc.) — owned here rather than by
  // InterviewReview itself, since that component unmounts whenever the
  // user steps over to InterviewAvatarStep ("Change avatar") and back.
  const [reviewExtras, setReviewExtras] = useState<ReviewExtrasState>(DEFAULT_REVIEW_EXTRAS);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);

  if (!isOpen) return null;

  const closeAfterCleanup = () => {
    abort();
    reset();
    setReviewExtras(DEFAULT_REVIEW_EXTRAS);
    setShowLeaveDialog(false);
    onClose();
  };

  const handleSaveAndClose = () => {
    // The interview is autosaved at every safe checkpoint already (see
    // characterInterviewStore's persistDraft calls) — closing just needs
    // to tear down local/in-flight state, not push anything new.
    closeAfterCleanup();
  };

  const handleDiscardProgress = () => {
    void discardDraft();
    closeAfterCleanup();
  };

  const handleClose = () => {
    // A save is in flight — closing now would abandon it mid-request with
    // no way to cancel the underlying createCharacter call, so the character
    // could still get created (and force-selected via onCreated) after the
    // user believes they discarded it. Make the close control unreachable
    // for the duration instead of trying to race the request.
    if (phase === 'saving') return;
    if (phase === 'intro') {
      // Nothing sent yet — nothing to save or discard.
      closeAfterCleanup();
      return;
    }
    // An in-app dialog, not window.confirm() — native confirm() is
    // unreliable in exactly this spot: some mobile WebView/PWA contexts
    // suppress it entirely, silently resolving false with no dialog ever
    // shown to the user, which reads as "the close button doesn't work"
    // rather than as a cancelled action (confirmed live 2026-08-09 — a
    // real user hit this). An in-app dialog sidesteps that.
    setShowLeaveDialog(true);
  };

  const { provider, model } = getProviderAndModel();
  const weakModel = isWeakModel(model);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <h1 className="text-base font-semibold text-[var(--color-text-primary)]">Create a character — interview</h1>
        <button
          type="button"
          onClick={handleClose}
          disabled={phase === 'saving'}
          className="p-2 -mr-2 rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          aria-label="Close"
          title={phase === 'saving' ? 'Saving — please wait' : undefined}
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
              <InterviewChat />
            </div>

            {/* Desktop: fixed-width side panel */}
            <div className="hidden md:block w-[380px] flex-shrink-0 border-l border-[var(--color-border)] overflow-y-auto">
              <CardPreviewPanel />
            </div>

            {/* Mobile: floating chip opens the same content in a bottom sheet */}
            <button
              type="button"
              onClick={() => setShowCardSheet(true)}
              className="md:hidden fixed bottom-24 right-4 z-10 px-3 py-2 rounded-full bg-[var(--color-primary)] text-white text-xs font-medium shadow-lg"
            >
              View card
            </button>
            <div className="md:hidden">
              <BottomSheet isOpen={showCardSheet} onClose={() => setShowCardSheet(false)} title="Character so far">
                <CardPreviewPanel />
              </BottomSheet>
            </div>
          </div>
        )}

        {phase === 'synthesizing' && (
          <SynthesizingScreen error={error} onRetry={retryTurn} onCancel={handleClose} />
        )}

        {phase === 'avatar' && <InterviewAvatarStep />}

        {/* 'saving' stays on InterviewReview (rather than swapping to a
            separate spinner screen) so the in-progress form — including
            local-only fields with no home in the store, like Creator/
            Character Version — never gets thrown away by a remount if the
            save fails and phase drops back to 'review'. */}
        {(phase === 'review' || phase === 'saving') && (
          <InterviewReview
            extras={reviewExtras}
            onExtrasChange={setReviewExtras}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
      </div>

      <Modal
        isOpen={showLeaveDialog}
        onClose={() => setShowLeaveDialog(false)}
        title="Leave this character interview?"
        size="sm"
      >
        <p className="text-sm text-[var(--color-text-secondary)] mb-6">
          Your progress is saved automatically — pick up where you left off later, or discard it now.
        </p>
        <div className="flex flex-col gap-2">
          <Button type="button" variant="primary" size="sm" onClick={handleSaveAndClose} className="w-full">
            Save &amp; close
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={handleDiscardProgress} className="w-full">
            Discard progress
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowLeaveDialog(false)}
            className="w-full"
          >
            Cancel
          </Button>
        </div>
      </Modal>
    </div>
  );
}
