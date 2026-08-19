import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Lock, LogIn, User } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { Button, Input } from '../ui';

export function LoginPage() {
  const navigate = useNavigate();
  const {
    isLoading,
    error,
    isAuthenticated,
    canSelfRegister,
    checkRegistration,
    login,
    clearError,
  } = useAuthStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    checkRegistration();
  }, [checkRegistration]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    clearError();

    const success = await login(username.trim(), password);
    if (success) {
      navigate('/');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[var(--color-bg-primary)]">
      <div className="w-full max-w-sm">
        {/* Logo/Title */}
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt="Good Girls Bot Club"
            className="w-64 h-auto mx-auto mb-3"
          />
          <p className="text-[var(--color-text-secondary)]">
            Sign in to continue
          </p>
        </div>

        {/* Login Form */}
        <div className="bg-[var(--color-bg-secondary)] rounded-xl p-6 shadow-xl">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Username</label>
              <div className="flex items-center gap-3 p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
                <User size={20} className="text-[var(--color-text-secondary)] shrink-0" />
                <Input
                  type="text"
                  placeholder="Enter username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="flex-1"
                  autoFocus
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Password</label>
              <div className="flex items-center gap-3 p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
                <Lock size={20} className="text-[var(--color-text-secondary)] shrink-0" />
                <Input
                  type="password"
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="flex-1"
                />
              </div>
            </div>

            {error && (
              <p className="text-red-500 text-sm text-center">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              size="lg"
              isLoading={isLoading}
              disabled={!username.trim()}
            >
              <LogIn size={20} className="mr-2" />
              Sign In
            </Button>

            <p className="text-center">
              <Link to="/forgot-password" className="text-sm text-[var(--color-primary)] hover:underline">
                Forgot password?
              </Link>
            </p>
          </form>
        </div>

        {/* Footer */}
        <div className="text-center mt-6">
          {canSelfRegister && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              New user?{' '}
              <Link to="/register" className="text-[var(--color-primary)] hover:underline">
                Create an account
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
