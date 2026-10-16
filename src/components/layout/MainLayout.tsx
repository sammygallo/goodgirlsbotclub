import { useState, useEffect, useCallback, useMemo } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { drawerOpenBlocked, useSwipeSidebar } from '../../hooks/useSwipeSidebar';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import type { LayoutOutletContext } from './layoutContext';
import { SettingsPanel } from '../settings/SettingsPanel';
import { GuidesPanel } from '../guides/GuidesPanel';
import { WorksPanel } from '../works/WorksPanel';
import { OnboardingWalkthrough } from '../onboarding/OnboardingWalkthrough';
import { useOnboardingStore } from '../../stores/onboardingStore';

export function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // D-S14: the menu button and the hero's Browse stay operable behind a right
  // panel (focus returns to the button when the drawer closes to open one), so
  // the drawer refuses to open over it.
  const openSidebar = useCallback(() => {
    if (drawerOpenBlocked()) return;
    setSidebarOpen(true);
  }, []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  // Stable identity: a fresh object each render would re-render the routed
  // ChatView on every sidebar toggle, which it did not do before.
  const outletContext = useMemo<LayoutOutletContext>(() => ({ openSidebar }), [openSidebar]);
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
    <div ref={swipeRef} className="bg-[var(--color-bg-primary)] overflow-hidden" style={{ height: '100dvh' }}>
      {/* Navigation drawer (E6-S3, A1): closed on load at every width, so there
          is no sidebar column and the content below spans the viewport from
          first paint. A direct child of this root, so the drawer's focus trap
          reaches the header, <main> and the panels as its siblings. */}
      <Sidebar isOpen={sidebarOpen} onClose={closeSidebar} />

      {/* Main Content */}
      <div className="flex flex-col min-w-0 h-full">
        <Header onMenuClick={openSidebar} menuOpen={sidebarOpen} />

        {/* A named size container (D-C3): the chat's desktop avatar panel
            splits off only while <main> is at least 600px wide. */}
        <main className="@container/main flex-1 overflow-hidden">
          <Outlet context={outletContext} />
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
