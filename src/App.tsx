import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './components/auth/LoginPage';
import { RegisterPage } from './components/auth/RegisterPage';
import { ForgotPasswordPage } from './components/auth/ForgotPasswordPage';
import { ProfilePage } from './components/auth/ProfilePage';
import { RequireRole } from './components/auth/RequireRole';
import { MainLayout } from './components/layout/MainLayout';
import { ChatView } from './components/chat/ChatView';
// Settings pages are now rendered inside the slide-in SettingsPanel (not routes).
import { InviteAcceptPage } from './components/auth/InviteAcceptPage';
import { GuidesRouteRedirect } from './components/guides/GuidesRouteRedirect';
import { ToastProvider } from './components/ui/Toast';
import { GlobalExtensionHost } from './extensions/sandbox/GlobalExtensionHost';
import { ExtensionPopupRoot } from './extensions/sandbox/ExtensionPopupRoot';
import { LovenseQuickControl } from './components/lovense/LovenseQuickControl';
import { useAuthStore } from './stores/authStore';

// Phase 7.1: Register all built-in extensions at app startup.
import './extensions';

function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth);

  // Runs once at the app root so isLoading resolves regardless of which
  // route the user lands on first (e.g. a deep link to /login or /profile,
  // which mount outside MainLayout and would otherwise never call this).
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <BrowserRouter>
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/profile" element={<RequireRole minRole="end_user"><ProfilePage /></RequireRole>} />
        <Route path="/invite/:token" element={<InviteAcceptPage />} />
        <Route path="/" element={<MainLayout />}>
          <Route index element={<ChatView />} />
          <Route path="chat/:characterId" element={<ChatView />} />
          <Route
            path="guides"
            element={
              <RequireRole minRole="contributor">
                <GuidesRouteRedirect />
              </RequireRole>
            }
          />
          <Route
            path="guides/:slug"
            element={
              <RequireRole minRole="contributor">
                <GuidesRouteRedirect />
              </RequireRole>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <GlobalExtensionHost />
      <ExtensionPopupRoot />
      <LovenseQuickControl />
    </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
