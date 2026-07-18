import { useState, useEffect, useCallback } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSwipeSidebar } from '../../hooks/useSwipeSidebar';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { SettingsPanel } from '../settings/SettingsPanel';
import { GuidesPanel } from '../guides/GuidesPanel';
import { WorksPanel } from '../works/WorksPanel';
import { OnboardingWalkthrough } from '../onboarding/OnboardingWalkthrough';
import { useOnboardingStore } from '../../stores/onboardingStore';

export function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const swipeRef = useSwipeSidebar(sidebarOpen, openSidebar, closeSidebar);
  const { isAuthenticated, isLoading } = useAuthStore();
  const { fetchSettings, fetchSecrets, fetchGlobalSecrets } = useSettingsStore();
  const navigate = useNavigate();

  // checkAuth() is called once at the App root so it resolves regardless of
  // which route mounts first — no need to call it again here.

  // Load settings when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      fetchSettings();
      fetchSecrets();
      fetchGlobalSecrets();
    }
  }, [isAuthenticated, fetchSettings, fetchSecrets, fetchGlobalSecrets]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/login');
    }
  }, [isAuthenticated, isLoading, navigate]);

  // Onboarding: trigger walkthrough on first authenticated visit
  const { hasCompleted, start: startOnboarding } = useOnboardingStore();
  useEffect(() => {
    if (isAuthenticated && !hasCompleted) {
      startOnboarding();
    }
  }, [isAuthenticated, hasCompleted, startOnboarding]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-primary)]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--color-primary)]" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // Navigation to /login is triggered by the effect above — show spinner
    // while the router processes the redirect rather than flashing blank.
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-primary)]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--color-primary)]" />
      </div>
    );
  }

  return (
    <div ref={swipeRef} className="flex bg-[var(--color-bg-primary)] overflow-hidden" style={{ height: '100dvh' }}>
      {/* Sidebar */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <Header onMenuClick={() => setSidebarOpen(true)} />

        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      {/* Settings Panel — slides in from right, overlays chat */}
      <SettingsPanel />

      {/* Guides Panel — slides in from right, overlays chat */}
      <GuidesPanel />

      {/* Works Panel — slides in from right, overlays chat */}
      <WorksPanel />

      {/* Onboarding Walkthrough */}
      <OnboardingWalkthrough />
    </div>
  );
}
