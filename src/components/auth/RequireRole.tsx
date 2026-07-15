import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { hasMinRole } from '../../utils/permissions';
import type { UserRole } from '../../types';

interface RequireRoleProps {
  minRole: UserRole;
  children: React.ReactNode;
  /** Where to redirect when the user lacks permission. Defaults to "/" */
  redirectTo?: string;
}

/**
 * Route guard that renders children only when the current user's role
 * meets or exceeds `minRole`. Otherwise redirects.
 */
export function RequireRole({ minRole, children, redirectTo = '/' }: RequireRoleProps) {
  const { isAuthenticated, isLoading, currentUser } = useAuthStore();

  // Wait for the app-root checkAuth() to resolve before deciding — otherwise
  // a hard reload on a guarded route bounces to /login even when the user
  // has a valid session, since isAuthenticated defaults to false.
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-primary)]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--color-primary)]" />
      </div>
    );
  }

  if (!isAuthenticated || !currentUser) {
    return <Navigate to="/login" replace />;
  }

  if (!hasMinRole(currentUser.role, minRole)) {
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
}
