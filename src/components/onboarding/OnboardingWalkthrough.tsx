import { useEffect, useCallback, useMemo, useRef } from 'react';
import { Sparkles, Key, Users, MessageSquare, Palette, PartyPopper, ArrowRight, X } from 'lucide-react';
import { useOnboardingStore, TOTAL_STEPS } from '../../stores/onboardingStore';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useAuthStore } from '../../stores/authStore';
import { can } from '../../utils/permissions';
import { Button } from '../ui';
import { ModalExemptPortal } from '../ui/ModalExemptPortal';

interface StepDef {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
  ctaLabel?: string;
}

function buildSteps(isAdmin: boolean): StepDef[] {
  return [
    {
      icon: Sparkles,
      title: 'Welcome to GoodGirlsBotClub',
      description:
        'Your personal AI character chat platform. Let\u2019s walk through the basics so you can start chatting in under a minute.',
    },
    {
      icon: Key,
      title: 'Set Up Your AI Provider',
      description: isAdmin
        ? 'To chat with characters you\u2019ll need an API key from a provider like OpenAI, Anthropic, or Google. You can configure this in AI Settings.'
        : 'Enter your own API key from a provider like OpenAI, Anthropic, or Google. If your admin has shared keys, you can start chatting right away!',
      ctaLabel: isAdmin ? 'Open AI Settings' : 'Set Up My Keys',
    },
    {
      icon: Users,
      title: 'Character Management',
      description:
        'Import character cards, create your own from scratch, and organize the roster. This is where you\u2019ll spend time building up who you chat with.',
      ctaLabel: 'Open Character Management',
    },
    {
      icon: MessageSquare,
      title: 'Start Chatting',
      description:
        'Select a character, type your message, and hit send. You can edit, regenerate, or swipe between alternate responses. Try group chats with multiple characters too!',
    },
    {
      icon: Palette,
      title: 'Make It Yours',
      description:
        'Pick an accent color, switch between light and dark, or build a fully custom theme. Appearance lives in Settings — you can tweak it anytime.',
      ctaLabel: 'Customize Appearance',
    },
    {
      icon: PartyPopper,
      title: "You're All Set!",
      description: isAdmin
        ? 'You can replay this walkthrough anytime from the Settings page. Enjoy chatting!'
        : 'Enjoy chatting with your characters!',
    },
  ];
}

export function OnboardingWalkthrough() {
  const { isOpen, isDocked, currentStep, nextStep, prevStep, complete, skip, dock, returnFromDock } =
    useOnboardingStore();
  const userRole = useAuthStore((s) => s.currentUser?.role);
  const isAdmin = can(userRole, 'settings:view');
  const steps = useMemo(() => buildSteps(isAdmin), [isAdmin]);

  // Escape key to skip (only when modal is visible)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skip();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, skip]);

  // Lock body scroll when modal is visible
  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Auto-return from dock when the user closes the settings panel.
  // Steps 1, 2, and 4 all hand off to the settings panel.
  const watchesSettingsPanel =
    currentStep === 1 || currentStep === 2 || currentStep === 4;
  const prevSettingsOpenRef = useRef(false);
  useEffect(() => {
    if (!isDocked || !watchesSettingsPanel) return;
    prevSettingsOpenRef.current = useSettingsPanelStore.getState().isOpen;
    const unsub = useSettingsPanelStore.subscribe((state) => {
      const prev = prevSettingsOpenRef.current;
      prevSettingsOpenRef.current = state.isOpen;
      if (prev && !state.isOpen) {
        returnFromDock(true);
      }
    });
    return unsub;
  }, [isDocked, watchesSettingsPanel, returnFromDock]);

  const handleCta = useCallback(() => {
    const step = steps[currentStep];
    if (!step.ctaLabel) return;

    // Dock the walkthrough (stays alive as a floating chip), then open target UI
    dock();

    if (currentStep === 1) {
      if (isAdmin) {
        const panel = useSettingsPanelStore.getState();
        panel.open();
        requestAnimationFrame(() => {
          useSettingsPanelStore.getState().pushPage('ai');
        });
      } else {
        useSettingsPanelStore.getState().openToPage('my-keys');
      }
    } else if (currentStep === 2) {
      useSettingsPanelStore.getState().openToPage('characters');
    } else if (currentStep === 4) {
      // Open settings main page and scroll to the Appearance section
      useSettingsPanelStore.getState().open();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .getElementById('appearance-section')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }
  }, [currentStep, dock, isAdmin, steps]);

  const handleChipReturn = useCallback(() => {
    // If we're handing off to the settings panel and it's still open,
    // close it — the subscription effect will handle advancing. This avoids
    // a double-advance when both close() + returnFromDock() fire.
    if (watchesSettingsPanel && useSettingsPanelStore.getState().isOpen) {
      useSettingsPanelStore.getState().close();
      return;
    }
    returnFromDock(true);
  }, [watchesSettingsPanel, returnFromDock]);

  // Render floating chip when docked
  if (isDocked) {
    return (
      <ModalExemptPortal>
        <div className="fixed bottom-4 right-4 z-[1200] flex items-center gap-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-full shadow-2xl pl-4 pr-2 py-2 animate-fade-in-up">
          <span className="text-xs font-medium text-[var(--color-text-primary)]">
            Setup · {currentStep + 1}/{TOTAL_STEPS}
          </span>
          <button
            onClick={handleChipReturn}
            className="flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] hover:opacity-80 transition-opacity px-2 py-1 rounded-full"
            aria-label="Return to setup walkthrough"
          >
            Continue
            <ArrowRight size={14} />
          </button>
          <button
            onClick={skip}
            className="p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors rounded-full"
            aria-label="Dismiss setup walkthrough"
          >
            <X size={14} />
          </button>
        </div>
      </ModalExemptPortal>
    );
  }

  if (!isOpen) return null;

  const step = steps[currentStep];
  const StepIcon = step.icon;
  const isFirst = currentStep === 0;
  const isLast = currentStep === TOTAL_STEPS - 1;

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center p-6" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Card */}
      <div className="relative w-full max-w-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-2xl shadow-2xl animate-fade-in-up">
        {/* Progress dots */}
        <div className="flex justify-center gap-2 pt-6">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors duration-200 ${
                i <= currentStep
                  ? 'bg-[var(--color-primary)]'
                  : 'bg-[var(--color-bg-tertiary)]'
              }`}
              aria-label={`Step ${i + 1} of ${TOTAL_STEPS}`}
            />
          ))}
        </div>

        {/* Icon */}
        <div className="flex justify-center pt-6">
          <div className="w-16 h-16 rounded-2xl bg-[var(--color-primary)]/20 flex items-center justify-center">
            <StepIcon size={32} className="text-[var(--color-primary)]" />
          </div>
        </div>

        {/* Title */}
        <h2 className="text-xl font-bold text-center text-[var(--color-text-primary)] px-6 pt-4">
          {step.title}
        </h2>

        {/* Description */}
        <p className="text-sm text-center text-[var(--color-text-secondary)] leading-relaxed px-6 pt-2 pb-6">
          {step.description}
        </p>

        {/* CTA button */}
        {step.ctaLabel && (
          <div className="px-6 pb-4">
            <Button variant="secondary" className="w-full" onClick={handleCta}>
              {step.ctaLabel}
            </Button>
          </div>
        )}

        {/* Navigation footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[var(--color-border)]">
          {isFirst ? (
            <Button variant="ghost" size="sm" onClick={skip}>
              Skip
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={prevStep}>
              Back
            </Button>
          )}

          {isLast ? (
            <Button variant="primary" size="sm" onClick={complete}>
              Finish
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={nextStep}>
              Next
            </Button>
          )}
        </div>

        {/* Skip link on middle steps */}
        {!isFirst && !isLast && (
          <div className="text-center pb-4">
            <button
              className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
              onClick={skip}
            >
              Skip walkthrough
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
