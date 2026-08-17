import { Link } from 'react-router-dom';
import { KeyRound } from 'lucide-react';

export function ForgotPasswordPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[var(--color-bg-primary)]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt="Good Girls Bot Club"
            className="w-64 h-auto mx-auto mb-3"
          />
        </div>

        <div className="bg-[var(--color-bg-secondary)] rounded-xl p-6 shadow-xl text-center space-y-4">
          <KeyRound size={32} className="mx-auto text-[var(--color-text-secondary)]" />
          <h1 className="text-lg font-medium text-[var(--color-text-primary)]">Forgot your password?</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Self-service password reset isn't available yet. Reach out to whoever set up your GGBC account, or find
            us on Discord, and we'll help you regain access.
          </p>
        </div>

        <div className="text-center mt-6">
          <Link to="/login" className="text-sm text-[var(--color-primary)] hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
