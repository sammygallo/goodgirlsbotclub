import { create } from 'zustand';
import { settingsApi, PROVIDERS, type SecretsResponse } from '../api/client';

// Per-provider field inside oai_settings used to store the active model.
// Native-routed providers each have their own slot; adding a new native
// provider to the catalog means adding an entry here so the model persists
// across page reloads.
const PROVIDER_MODEL_FIELD: Record<string, string> = {
  openai: 'openai_model',
  claude: 'claude_model',
  makersuite: 'google_model',
  vertexai: 'vertexai_model',
  mistralai: 'mistralai_model',
  groq: 'groq_model',
  openrouter: 'openrouter_model',
  deepseek: 'deepseek_model',
  cohere: 'cohere_model',
  perplexity: 'perplexity_model',
  xai: 'xai_model',
  ai21: 'ai21_model',
  '01ai': 'zerooneai_model',
  moonshot: 'moonshot_model',
  zhipu: 'zhipu_model',
  nanogpt: 'nanogpt_model',
  blockentropy: 'blockentropy_model',
  pollinations: 'pollinations_model',
  aimlapi: 'aimlapi_model',
  electronhub: 'electronhub_model',
  custom: 'custom_model',
};

function modelFieldFor(provider: string): string {
  return PROVIDER_MODEL_FIELD[provider] ?? `${provider}_model`;
}

// Fallback provider/model now live inside the synced `oai_settings` blob so they
// follow the user across devices. Previously a local-only global key that leaked
// across accounts on a shared browser.
const FALLBACK_PROVIDER_FIELD = 'stm_fallback_provider';
const FALLBACK_MODEL_FIELD = 'stm_fallback_model';

/** Fire-and-forget: fold the fallback selection into oai_settings and save. */
function persistFallback(provider: string, model: string): void {
  void (async () => {
    try {
      const response = await settingsApi.getSettings();
      let settings: Record<string, unknown> = {};
      if (typeof response.settings === 'string') {
        try { settings = JSON.parse(response.settings); } catch { settings = {}; }
      } else if (response.settings) {
        settings = response.settings as Record<string, unknown>;
      }
      const oaiSettings = (settings.oai_settings as Record<string, unknown>) || {};
      oaiSettings[FALLBACK_PROVIDER_FIELD] = provider;
      oaiSettings[FALLBACK_MODEL_FIELD] = model;
      settings.oai_settings = oaiSettings;
      await settingsApi.saveSettings(settings);
    } catch { /* non-fatal */ }
  })();
}

interface SettingsState {
  secrets: SecretsResponse;
  activeProvider: string;
  activeModel: string;
  /** Base URL for the custom OpenAI-compatible endpoint (e.g. http://localhost:11434/v1). */
  customUrl: string;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  successMessage: string | null;
  globalSecrets: SecretsResponse;
  globalSharingEnabled: boolean;
  globalSharingSupported: boolean;
  /** Fallback provider/model used when the primary fails. Stored locally. */
  fallbackProvider: string;
  fallbackModel: string;

  // Actions
  fetchSecrets: () => Promise<void>;
  fetchSettings: () => Promise<void>;
  saveApiKey: (provider: string, apiKey: string) => Promise<void>;
  deleteApiKey: (secretKey: string) => Promise<void>;
  setActiveProvider: (provider: string) => Promise<void>;
  setActiveModel: (model: string) => Promise<void>;
  setCustomUrl: (url: string) => Promise<void>;
  clearMessages: () => void;
  fetchGlobalSecrets: () => Promise<void>;
  saveGlobalApiKey: (provider: string, apiKey: string) => Promise<void>;
  deleteGlobalApiKey: (secretKey: string) => Promise<void>;
  setGlobalSharing: (enabled: boolean) => Promise<void>;
  setFallbackProvider: (provider: string) => void;
  setFallbackModel: (model: string) => void;
  clearFallbackProvider: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  secrets: {},
  activeProvider: 'openai',
  activeModel: 'gpt-4o',
  customUrl: '',
  isLoading: false,
  isSaving: false,
  error: null,
  successMessage: null,
  globalSecrets: {},
  globalSharingEnabled: false,
  fallbackProvider: '',
  fallbackModel: '',
  globalSharingSupported: false,

  fetchSecrets: async () => {
    set({ isLoading: true, error: null });
    try {
      const secrets = await settingsApi.getSecrets();
      set({ secrets, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch secrets',
      });
    }
  },

  fetchSettings: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await settingsApi.getSettings();

      // Settings is returned as a JSON string, need to parse it
      let settings: Record<string, unknown> = {};
      if (typeof response.settings === 'string') {
        try {
          settings = JSON.parse(response.settings);
        } catch {
          console.warn('[Settings] Failed to parse settings JSON');
        }
      } else if (response.settings) {
        settings = response.settings as Record<string, unknown>;
      }

      // Extract provider and model from oai_settings (where chat completion settings live)
      const oaiSettings = (settings.oai_settings as Record<string, unknown>) || {};
      const chatCompletionSource = (oaiSettings.chat_completion_source as string) || 'openai';

      // Try to find active model based on provider. Uses the generic
      // provider→oai_settings-field map so new native providers don't need
      // their own branch here.
      const modelField = modelFieldFor(chatCompletionSource);
      const providerInfo = PROVIDERS.find((p) => p.id === chatCompletionSource);
      const fallbackModel = providerInfo?.models[0] || 'gpt-4o';
      const model = (oaiSettings[modelField] as string) || fallbackModel;

      const customUrl = (oaiSettings.custom_url as string) || '';
      const fbProvider = (oaiSettings[FALLBACK_PROVIDER_FIELD] as string) || '';
      const fbModel = (oaiSettings[FALLBACK_MODEL_FIELD] as string) || '';

      console.log('[Settings] Loaded provider:', chatCompletionSource, 'model:', model);

      set({
        activeProvider: chatCompletionSource,
        activeModel: model,
        customUrl,
        fallbackProvider: fbProvider,
        fallbackModel: fbModel,
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch settings',
      });
    }
  },

  saveApiKey: async (providerId: string, apiKey: string) => {
    set({ isSaving: true, error: null, successMessage: null });
    try {
      const provider = PROVIDERS.find((p) => p.id === providerId);
      if (!provider) {
        throw new Error('Unknown provider');
      }

      // Delete any existing secrets for this provider first to avoid stale entries
      const { secrets } = get();
      const existingSecrets = secrets[provider.secretKey];
      if (Array.isArray(existingSecrets) && existingSecrets.length > 0) {
        // Delete all existing secrets for this key
        for (const secret of existingSecrets) {
          try {
            await settingsApi.deleteSecret(provider.secretKey, secret.id);
          } catch {
            // Ignore delete errors, continue with save
          }
        }
      }

      // Now save the new secret
      await settingsApi.writeSecret(provider.secretKey, apiKey, provider.name);

      // Refresh secrets
      await get().fetchSecrets();

      set({
        isSaving: false,
        successMessage: `${provider.name} API key saved successfully`,
      });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save API key',
      });
    }
  },

  deleteApiKey: async (secretKey: string) => {
    set({ isSaving: true, error: null, successMessage: null });
    try {
      await settingsApi.deleteSecret(secretKey);
      await get().fetchSecrets();
      set({
        isSaving: false,
        successMessage: 'API key deleted',
      });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to delete API key',
      });
    }
  },

  setActiveProvider: async (provider: string) => {
    set({ isSaving: true, error: null });
    try {
      const providerInfo = PROVIDERS.find((p) => p.id === provider);
      // For custom, there's no preset model list — preserve whatever is in custom_model.
      const defaultModel = provider === 'custom' ? get().activeModel : (providerInfo?.models[0] || 'gpt-4o');

      // Get current settings first to merge properly
      const response = await settingsApi.getSettings();
      let settings: Record<string, unknown> = {};
      if (typeof response.settings === 'string') {
        try {
          settings = JSON.parse(response.settings);
        } catch {
          settings = {};
        }
      }

      // Update oai_settings with new provider
      const oaiSettings = (settings.oai_settings as Record<string, unknown>) || {};
      oaiSettings.chat_completion_source = provider;

      // Also set the appropriate model for this provider. For 'custom',
      // custom_url / custom_model are managed by setCustomUrl / setActiveModel
      // (or customProviderStore.activate) separately.
      if (provider !== 'custom') {
        oaiSettings[modelFieldFor(provider)] = defaultModel;
        // Switching to a native provider clears the "which user provider is
        // currently in the custom slot" marker — it's no longer active.
        oaiSettings.stm_active_custom_provider = null;
      }

      settings.oai_settings = oaiSettings;

      await settingsApi.saveSettings(settings);

      console.log('[Settings] Saved provider:', provider, 'model:', defaultModel);

      set({
        activeProvider: provider,
        activeModel: defaultModel,
        isSaving: false,
      });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save provider',
      });
    }
  },

  setActiveModel: async (model: string) => {
    set({ isSaving: true, error: null });
    try {
      const { activeProvider } = get();

      // Get current settings first to merge properly
      const response = await settingsApi.getSettings();
      let settings: Record<string, unknown> = {};
      if (typeof response.settings === 'string') {
        try {
          settings = JSON.parse(response.settings);
        } catch {
          settings = {};
        }
      }

      // Update oai_settings with new model — generic mapping covers all
      // native providers + 'custom'.
      const oaiSettings = (settings.oai_settings as Record<string, unknown>) || {};
      oaiSettings[modelFieldFor(activeProvider)] = model;
      settings.oai_settings = oaiSettings;

      await settingsApi.saveSettings(settings);

      set({ activeModel: model, isSaving: false });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save model',
      });
    }
  },

  setCustomUrl: async (url: string) => {
    set({ isSaving: true, error: null });
    try {
      const response = await settingsApi.getSettings();
      let settings: Record<string, unknown> = {};
      if (typeof response.settings === 'string') {
        try {
          settings = JSON.parse(response.settings);
        } catch {
          settings = {};
        }
      }
      const oaiSettings = (settings.oai_settings as Record<string, unknown>) || {};
      oaiSettings.custom_url = url;
      settings.oai_settings = oaiSettings;
      await settingsApi.saveSettings(settings);
      set({ customUrl: url, isSaving: false, successMessage: 'Endpoint URL saved' });
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save endpoint URL',
      });
    }
  },

  clearMessages: () => set({ error: null, successMessage: null }),

  fetchGlobalSecrets: async () => {
    try {
      const [globalSecrets, sharingStatus] = await Promise.all([
        settingsApi.getGlobalSecrets(),
        settingsApi.getGlobalSharingStatus(),
      ]);
      set({
        globalSecrets,
        globalSharingEnabled: sharingStatus.enabled,
        globalSharingSupported: true,
      });
    } catch {
      set({ globalSecrets: {}, globalSharingEnabled: false, globalSharingSupported: false });
    }
  },

  saveGlobalApiKey: async (providerId: string, apiKey: string) => {
    set({ isSaving: true, error: null, successMessage: null });
    try {
      const provider = PROVIDERS.find((p) => p.id === providerId);
      if (!provider) throw new Error('Unknown provider');

      const { globalSecrets } = get();
      const existing = globalSecrets[provider.secretKey];
      if (Array.isArray(existing) && existing.length > 0) {
        for (const secret of existing) {
          try { await settingsApi.deleteGlobalSecret(provider.secretKey, secret.id); } catch { /* ignore */ }
        }
      }

      await settingsApi.writeGlobalSecret(provider.secretKey, apiKey, provider.name);
      await get().fetchGlobalSecrets();
      set({ isSaving: false, successMessage: `${provider.name} global API key saved` });
    } catch (error) {
      set({ isSaving: false, error: error instanceof Error ? error.message : 'Failed to save global API key' });
    }
  },

  deleteGlobalApiKey: async (secretKey: string) => {
    set({ isSaving: true, error: null, successMessage: null });
    try {
      await settingsApi.deleteGlobalSecret(secretKey);
      await get().fetchGlobalSecrets();
      set({ isSaving: false, successMessage: 'Global API key deleted' });
    } catch (error) {
      set({ isSaving: false, error: error instanceof Error ? error.message : 'Failed to delete global API key' });
    }
  },

  setGlobalSharing: async (enabled: boolean) => {
    set({ isSaving: true, error: null });
    try {
      await settingsApi.setGlobalSharing(enabled);
      set({ globalSharingEnabled: enabled, isSaving: false });
    } catch (error) {
      set({ isSaving: false, error: error instanceof Error ? error.message : 'Failed to toggle global sharing' });
    }
  },

  setFallbackProvider: (provider: string) => {
    const { fallbackModel } = get();
    set({ fallbackProvider: provider });
    persistFallback(provider, fallbackModel || '');
  },

  setFallbackModel: (model: string) => {
    const { fallbackProvider } = get();
    set({ fallbackModel: model });
    persistFallback(fallbackProvider, model);
  },

  clearFallbackProvider: () => {
    set({ fallbackProvider: '', fallbackModel: '' });
    persistFallback('', '');
  },
}));
