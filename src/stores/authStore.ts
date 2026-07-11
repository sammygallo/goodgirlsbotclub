import { create } from 'zustand';
import { api, clearCsrfToken, type UserInfo } from '../api/client';
import { useCharacterStore } from './characterStore';
import { useChatStore } from './chatStore';
import { useSettingsStore } from './settingsStore';
import { useWorldInfoStore } from './worldInfoStore';
import { useBranchStore } from './branchStore';
import { useRegexScriptStore } from './regexScriptStore';
import { usePromptTemplateStore } from './promptTemplateStore';
import { useImageGenStore } from './imageGenStore';
import { useDataBankStore } from './dataBankStore';
import { useThemeStore } from './themeStore';
import { useDisplayPreferencesStore } from './displayPreferencesStore';
import { useSpeechPreferencesStore } from './speechPreferencesStore';
import { useGenerationStore } from './generationStore';
import { usePersonaStore } from './personaStore';
import { useConnectionProfileStore } from './connectionProfileStore';
import { useChatHistoryRagStore } from './chatHistoryRagStore';
import { useExtensionStore } from './extensionStore';
import { useSummarizeStore } from './summarizeStore';
import { useAutoMemoryStore } from './autoMemoryStore';
import { useTranslateStore } from './translateStore';
import { useQuickReplyStore } from './quickReplyStore';
import { useExpressionsStore } from './expressionsStore';
import { useMotionModeStore } from './motionModeStore';
import { useUsageStore } from './usageStore';
import { useLovenseStore } from './lovenseStore';
import { clearAllAppStorage } from '../utils/serverSettings';
import { syncGlobalVarsFromServer } from '../utils/stscript/executor';
import type { UserRole, Permission } from '../types';

/** Survives clearAllAppStorage() (different prefix) so we can detect when the
 *  authenticated handle changes between sessions on a shared browser. */
const ACTIVE_HANDLE_KEY = 'ggbc:active-handle';

/**
 * Wipe every trace of the current user: each store's in-memory state and the
 * entire app-owned localStorage keyspace. Called on logout and whenever the
 * active handle changes, so a shared browser can never carry one account's
 * data (settings, secrets, transcripts, version tokens) into the next.
 */
function resetAllUserState(): void {
  useCharacterStore.getState().resetUser();
  useChatStore.getState().resetUser();
  useSettingsStore.setState({
    secrets: {},
    globalSecrets: {},
    globalSharingEnabled: false,
    globalSharingSupported: false,
    activeProvider: 'openai',
    activeModel: 'gpt-4o',
    error: null,
    successMessage: null,
  });
  useWorldInfoStore.getState().resetUser();
  useExtensionStore.getState().resetUser();
  useSummarizeStore.getState().resetUser();
  useAutoMemoryStore.getState().resetUser();
  useTranslateStore.getState().resetUser();
  useQuickReplyStore.getState().resetUser();
  useExpressionsStore.getState().resetUser();
  useMotionModeStore.getState().resetUser();
  useUsageStore.getState().resetUser();
  useLovenseStore.getState().resetUser();
  useDataBankStore.getState().resetUser();
  useChatHistoryRagStore.getState().resetUser();
  useImageGenStore.getState().resetUser();
  useGenerationStore.getState().resetUser();
  useBranchStore.getState().resetUser();
  // Catch-all for orphan keys no single store owns (VN backgrounds, costumes,
  // global vars, the migration sentinel) and stores without their own resetUser.
  clearAllAppStorage();
}

/**
 * Ensure cached state belongs to `handle`. If the last active handle differs
 * (or is unknown), reset everything before the new user hydrates; a normal
 * same-user reload keeps its instant-render cache.
 */
function ensureUserScope(handle: string): void {
  let prev: string | null = null;
  try { prev = localStorage.getItem(ACTIVE_HANDLE_KEY); } catch { prev = null; }
  if (prev !== handle) {
    resetAllUserState();
  }
  try { localStorage.setItem(ACTIVE_HANDLE_KEY, handle); } catch { /* ignore */ }
}

interface CurrentUser {
  handle: string;
  name: string;
  /** @deprecated Legacy role shim. Use `permissions` instead. */
  role: UserRole;
  avatar?: string;
  groupId?: string;
  permissions?: Permission[];
}

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  currentUser: CurrentUser | null;
  availableUsers: UserInfo[];
  error: string | null;
  canSelfRegister: boolean;

  // Actions
  checkAuth: () => Promise<void>;
  fetchUsers: () => Promise<void>;
  checkRegistration: () => Promise<void>;
  register: (handle: string, name: string, password?: string, inviteToken?: string) => Promise<boolean>;
  login: (handle: string, password?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  updateCurrentUser: (updates: { name?: string; avatar?: string }) => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  isLoading: true,
  currentUser: null,
  availableUsers: [],
  error: null,
  canSelfRegister: false,

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const user = await api.getCurrentUser();
      if (user) {
        ensureUserScope(user.handle);
        useWorldInfoStore.getState().initForUser(user.handle);
        useExtensionStore.getState().initForUser(user.handle);
        useSummarizeStore.getState().initForUser(user.handle);
        useAutoMemoryStore.getState().initForUser(user.handle);
        useTranslateStore.getState().initForUser(user.handle);
        useQuickReplyStore.getState().initForUser(user.handle);
        useExpressionsStore.getState().initForUser(user.handle);
        useMotionModeStore.getState().initForUser(user.handle);
        useUsageStore.getState().initForUser(user.handle);
        useLovenseStore.getState().initForUser(user.handle);
        set({
          isAuthenticated: true,
          currentUser: {
            handle: user.handle,
            name: user.name,
            role: user.role,
            avatar: user.avatar,
            groupId: user.groupId,
            permissions: user.permissions,
          },
          isLoading: false,
        });
        useThemeStore.getState().fetchTheme();
        useDisplayPreferencesStore.getState().fetchPrefs();
        useSpeechPreferencesStore.getState().fetchPrefs();
        useGenerationStore.getState().fetchPrefs();
        usePersonaStore.getState().fetchPrefs();
        useConnectionProfileStore.getState().fetchPrefs();
        useChatHistoryRagStore.getState().fetchPrefs();
      useWorldInfoStore.getState().fetchPrefs();
      useBranchStore.getState().fetchPrefs();
      useChatStore.getState().fetchPrefs();
      useRegexScriptStore.getState().fetchPrefs();
      usePromptTemplateStore.getState().fetchPrefs();
      useImageGenStore.getState().fetchPrefs();
      useDataBankStore.getState().fetchPrefs();
      useExtensionStore.getState().fetchPrefs();
      useSummarizeStore.getState().fetchPrefs();
      useAutoMemoryStore.getState().fetchPrefs();
      useTranslateStore.getState().fetchPrefs();
      useQuickReplyStore.getState().fetchPrefs();
      useSummarizeStore.getState().fetchSummaries();
      syncGlobalVarsFromServer();
      useCharacterStore.getState().fetchLinkedBooks();
      useCharacterStore.getState().fetchFavorites();
      useMotionModeStore.getState().fetchPrefs();
      useUsageStore.getState().fetchPrefs();
      } else {
        set({ isAuthenticated: false, currentUser: null, isLoading: false });
      }
    } catch {
      set({ isAuthenticated: false, currentUser: null, isLoading: false });
    }
  },

  fetchUsers: async () => {
    try {
      const users = await api.getUsers();
      set({ availableUsers: users });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch users' });
    }
  },

  checkRegistration: async () => {
    try {
      const result = await api.checkCanRegister();
      set({ canSelfRegister: result.canRegister });
    } catch {
      set({ canSelfRegister: false });
    }
  },

  register: async (handle: string, name: string, password?: string, inviteToken?: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.register(handle, name, password, inviteToken);
      // ggbc-backend's /auth/register sets the session cookie on success,
      // so we can immediately fetch the full user (via the ST proxy, so we
      // get permissions/avatar/groupId in the same shape login uses).
      const user = await api.getCurrentUser();
      const h = user?.handle ?? result.handle;
      ensureUserScope(h);
      useWorldInfoStore.getState().initForUser(h);
      useExtensionStore.getState().initForUser(h);
      useSummarizeStore.getState().initForUser(h);
      useAutoMemoryStore.getState().initForUser(h);
      useTranslateStore.getState().initForUser(h);
      useQuickReplyStore.getState().initForUser(h);
      useExpressionsStore.getState().initForUser(h);
      useMotionModeStore.getState().initForUser(h);
      useUsageStore.getState().initForUser(h);
      useLovenseStore.getState().initForUser(h);
      set({
        isAuthenticated: true,
        currentUser: user
          ? {
              handle: user.handle,
              name: user.name,
              role: user.role,
              avatar: user.avatar,
              groupId: user.groupId,
              permissions: user.permissions,
            }
          : { handle: h, name, role: 'end_user' },
        isLoading: false,
      });
      useThemeStore.getState().fetchTheme();
      useDisplayPreferencesStore.getState().fetchPrefs();
      useSpeechPreferencesStore.getState().fetchPrefs();
      useGenerationStore.getState().fetchPrefs();
      usePersonaStore.getState().fetchPrefs();
      useConnectionProfileStore.getState().fetchPrefs();
      useChatHistoryRagStore.getState().fetchPrefs();
      useWorldInfoStore.getState().fetchPrefs();
      useBranchStore.getState().fetchPrefs();
      useChatStore.getState().fetchPrefs();
      useRegexScriptStore.getState().fetchPrefs();
      usePromptTemplateStore.getState().fetchPrefs();
      useImageGenStore.getState().fetchPrefs();
      useDataBankStore.getState().fetchPrefs();
      useExtensionStore.getState().fetchPrefs();
      useSummarizeStore.getState().fetchPrefs();
      useAutoMemoryStore.getState().fetchPrefs();
      useTranslateStore.getState().fetchPrefs();
      useQuickReplyStore.getState().fetchPrefs();
      useSummarizeStore.getState().fetchSummaries();
      syncGlobalVarsFromServer();
      useCharacterStore.getState().fetchLinkedBooks();
      useCharacterStore.getState().fetchFavorites();
      useMotionModeStore.getState().fetchPrefs();
      useUsageStore.getState().fetchPrefs();
      return true;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Registration failed',
      });
      return false;
    }
  },

  login: async (handle: string, password?: string) => {
    set({ isLoading: true, error: null });
    try {
      await api.login(handle, password);
      // Fetch real user data so role, permissions, and display name are correct.
      const user = await api.getCurrentUser();
      const h = user?.handle ?? handle;
      ensureUserScope(h);
      useWorldInfoStore.getState().initForUser(h);
      useExtensionStore.getState().initForUser(h);
      useSummarizeStore.getState().initForUser(h);
      useAutoMemoryStore.getState().initForUser(h);
      useTranslateStore.getState().initForUser(h);
      useQuickReplyStore.getState().initForUser(h);
      useExpressionsStore.getState().initForUser(h);
      useMotionModeStore.getState().initForUser(h);
      useUsageStore.getState().initForUser(h);
      useLovenseStore.getState().initForUser(h);
      set({
        isAuthenticated: true,
        currentUser: user
          ? {
              handle: user.handle,
              name: user.name,
              role: user.role,
              avatar: user.avatar,
              groupId: user.groupId,
              permissions: user.permissions,
            }
          : { handle, name: handle, role: 'end_user' },
        isLoading: false,
      });
      useThemeStore.getState().fetchTheme();
      useDisplayPreferencesStore.getState().fetchPrefs();
      useSpeechPreferencesStore.getState().fetchPrefs();
      useGenerationStore.getState().fetchPrefs();
      usePersonaStore.getState().fetchPrefs();
      useConnectionProfileStore.getState().fetchPrefs();
      useChatHistoryRagStore.getState().fetchPrefs();
      useWorldInfoStore.getState().fetchPrefs();
      useBranchStore.getState().fetchPrefs();
      useChatStore.getState().fetchPrefs();
      useRegexScriptStore.getState().fetchPrefs();
      usePromptTemplateStore.getState().fetchPrefs();
      useImageGenStore.getState().fetchPrefs();
      useDataBankStore.getState().fetchPrefs();
      useExtensionStore.getState().fetchPrefs();
      useSummarizeStore.getState().fetchPrefs();
      useAutoMemoryStore.getState().fetchPrefs();
      useTranslateStore.getState().fetchPrefs();
      useQuickReplyStore.getState().fetchPrefs();
      useSummarizeStore.getState().fetchSummaries();
      syncGlobalVarsFromServer();
      useCharacterStore.getState().fetchLinkedBooks();
      useCharacterStore.getState().fetchFavorites();
      useMotionModeStore.getState().fetchPrefs();
      useUsageStore.getState().fetchPrefs();
      return true;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Login failed',
      });
      return false;
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } finally {
      // Invalidate the cached CSRF token — it's tied to the session that was
      // just destroyed. Without this, the next login attempt uses the stale
      // token, ST rejects it, and the login silently fails.
      clearCsrfToken();
      set({ isAuthenticated: false, currentUser: null });

      // Reset every store's in-memory state and wipe the app-owned localStorage
      // keyspace so nothing leaks into the next account on a shared browser.
      resetAllUserState();
      try { localStorage.removeItem(ACTIVE_HANDLE_KEY); } catch { /* ignore */ }
    }
  },

  updateCurrentUser: (updates) => set(state => ({
    currentUser: state.currentUser ? { ...state.currentUser, ...updates } : null,
  })),

  clearError: () => set({ error: null }),
}));
