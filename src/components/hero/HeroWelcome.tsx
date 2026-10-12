import { Button } from '../ui';

interface HeroWelcomeProps {
  /** Opens the character list and focuses its search box (D-H11). */
  onBrowse: () => void;
  /** Fills the page's height when nothing sits below it. */
  fill: boolean;
}

/**
 * The static welcome panel (D-H9): shown when there is no featured character to
 * lead with — nothing configured, nothing visible to this user, or everything
 * gated away. Announcements alone never earn a hero. No carousel, no controls.
 *
 * Unlike the hero it is themed (card, text and the primary button come from the
 * theme tokens, as D-H20 directs), because it sits on the page background and
 * not on imagery.
 */
export function HeroWelcome({ onBrowse, fill }: HeroWelcomeProps) {
  return (
    <div className={`flex items-center justify-center px-4 py-10 sm:px-8 ${fill ? 'flex-1' : ''}`}>
      <section
        aria-label="Welcome"
        className="flex w-full max-w-[720px] flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 sm:p-10"
      >
        <h3 className="text-2xl font-semibold text-[var(--color-text-primary)] sm:text-[32px] sm:leading-tight">
          Start a new conversation
        </h3>
        <p className="text-base text-[var(--color-text-secondary)] sm:text-[17px]">
          Pick a character to chat with, or create your own.
        </p>
        <div>
          <Button variant="primary" size="lg" onClick={onBrowse}>
            Browse characters
          </Button>
        </div>
      </section>
    </div>
  );
}
