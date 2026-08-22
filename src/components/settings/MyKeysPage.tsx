import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Eye, EyeOff, Globe, Key, Loader2, Trash2 } from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { PROVIDERS, type SecretState } from '../../api/client';
import { Button, Input } from '../ui';
import { EmbeddingsApiKeySection, ChatHistoryRagSection } from './EmbeddingsKeySettings';
import {
  getThemeMode,
  setThemeMode,
  setThemePreset,
  applyTheme,
  PRESET_SWATCHES,
  getActivePreset,
  setActivePreset,
  type ThemeMode,
  type ThemePreset,
  type ActivePreset,
} from '../../hooks/themePreferences';

export function MyKeysPage(_props?: { params?: Record<string, string> }) {
  const { goBack } = useSettingsPanelStore();
  const {
    secrets, globalSecrets, globalSharingEnabled,
    activeProvider, activeModel, isSaving, error, successMessage,
    fetchSecrets, fetchSettings, fetchGlobalSecrets,
    saveApiKey, deleteApiKey, setActiveProvider, setActiveModel, clearMessages,
  } = useSettingsStore();

  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});

  // Theme state
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getThemeMode());
  const [activePreset, setActivePresetState] = useState<ActivePreset>(() => getActivePreset());

  useEffect(() => {
    fetchSecrets();
    fetchSettings();
    fetchGlobalSecrets();
  }, [fetchSecrets, fetchSettings, fetchGlobalSecrets]);

  useEffect(() => {
    if (successMessage || error) {
      const timer = setTimeout(clearMessages, 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage, error, clearMessages]);

  const handleSaveApiKey = async (providerId: string) => {
    const key = apiKeyInputs[providerId];
    if (!key?.trim()) return;
    await saveApiKey(providerId, key.trim());
    setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
  };

  const hasPersonalKey = (secretKey: string): boolean => {
    const data = secrets[secretKey];
    return Array.isArray(data) && data.length > 0;
  };

  const hasGlobalKey = (secretKey: string): boolean => {
    if (!globalSharingEnabled) return false;
    const data = globalSecrets[secretKey];
    return Array.isArray(data) && data.length > 0;
  };

  const getSecretInfo = (secretKey: string): SecretState | null => {
    const data = secrets[secretKey];
    if (Array.isArray(data) && data.length > 0) {
      return data.find((s) => s.active) || data[0];
    }
    return null;
  };

  const currentProvider = PROVIDERS.find((p) => p.id === activeProvider);

  // Count providers with global keys
  const globalKeyCount = PROVIDERS.filter((p) => p.secretKey && hasGlobalKey(p.secretKey)).length;

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button variant="ghost" size="sm" onClick={() => goBack()} className="p-2" aria-label="Back">
          <ArrowLeft size={24} />
        </Button>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">My API Keys</h1>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-6">
        {/* Status Messages */}
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}
        {successMessage && (
          <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
            <p className="text-sm text-green-400">{successMessage}</p>
          </div>
        )}

        {/* Global Keys Banner */}
        {globalKeyCount > 0 && (
          <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg flex items-start gap-3">
            <Globe size={18} className="text-blue-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm text-blue-300 font-medium">Shared API keys available</p>
              <p className="text-xs text-blue-400/80 mt-0.5">
                Your admin has shared {globalKeyCount} provider{globalKeyCount > 1 ? 's' : ''}. Add your own key below to use a personal one instead.
              </p>
            </div>
          </div>
        )}
        {!globalKeyCount && (
          <div className="p-3 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg">
            <p className="text-sm text-[var(--color-text-secondary)]">
              Enter an API key from a provider like OpenAI, Anthropic, or Google to start chatting.
            </p>
          </div>
        )}

        {/* Active Provider */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Active Provider</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PROVIDERS.filter((p) => p.id !== 'custom').map((provider) => {
              const personal = hasPersonalKey(provider.secretKey);
              const global = hasGlobalKey(provider.secretKey);
              const available = personal || global;
              const isActive = activeProvider === provider.id;
              return (
                <button
                  key={provider.id}
                  onClick={() => setActiveProvider(provider.id)}
                  disabled={isSaving}
                  className={`relative p-3 rounded-lg text-left transition-all ${
                    isActive ? 'bg-[var(--color-primary)] text-white'
                      : available ? 'bg-[var(--color-bg-tertiary)] hover:bg-zinc-700'
                        : 'bg-[var(--color-bg-tertiary)] opacity-50'
                  }`}
                >
                  <span className="text-sm font-medium">{provider.name}</span>
                  {personal && (
                    <Check size={14} className={`absolute top-2 right-2 ${isActive ? 'text-white' : 'text-green-400'}`} />
                  )}
                  {!personal && global && (
                    <Globe size={14} className={`absolute top-2 right-2 ${isActive ? 'text-white' : 'text-blue-400'}`} />
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-[var(--color-text-secondary)]">
            <span className="flex items-center gap-1"><Check size={12} className="text-green-400" /> Your key</span>
            <span className="flex items-center gap-1"><Globe size={12} className="text-blue-400" /> Shared</span>
          </div>
        </section>

        {/* Model Selector */}
        {currentProvider && currentProvider.id !== 'custom' && currentProvider.models.length > 0 && (
          <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">Model</h2>
            <select
              value={activeModel}
              onChange={(e) => setActiveModel(e.target.value)}
              disabled={isSaving}
              className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              {currentProvider.models.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </section>
        )}

        {/* Personal API Keys */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">API Keys</h2>
          <div className="space-y-4">
            {PROVIDERS.filter((p) => p.id !== 'custom').map((provider) => {
              const secretInfo = getSecretInfo(provider.secretKey);
              const configured = !!secretInfo;
              const global = hasGlobalKey(provider.secretKey);
              const inputValue = apiKeyInputs[provider.id] || '';
              const showKey = showApiKey[provider.id] || false;
              return (
                <div key={provider.id} className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Key size={16} className="text-[var(--color-text-secondary)]" />
                      <span className="text-sm font-medium text-[var(--color-text-primary)]">{provider.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {configured && (
                        <>
                          <span className="text-xs text-green-400">Configured</span>
                          <Button variant="ghost" size="sm" onClick={() => deleteApiKey(provider.secretKey)} disabled={isSaving} className="p-1 text-red-400 hover:text-red-300">
                            <Trash2 size={14} />
                          </Button>
                        </>
                      )}
                      {!configured && global && (
                        <span className="text-xs text-blue-400">Using shared</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <Input
                        type={showKey ? 'text' : 'password'}
                        value={inputValue}
                        onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                        placeholder={configured ? 'Enter new key to replace...' : 'Enter API key...'}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                      >
                        {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <Button onClick={() => handleSaveApiKey(provider.id)} disabled={!inputValue.trim() || isSaving} className="shrink-0">
                      {isSaving ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <EmbeddingsApiKeySection />
        <ChatHistoryRagSection />

        {/* Appearance */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4 cyberpunk-card">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Appearance</h2>
          {/* Theme Mode */}
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-2">Theme</label>
            <div className="grid grid-cols-3 gap-2">
              {(['light', 'dark', 'auto'] as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    setThemeMode(mode);
                    setThemeModeState(mode);
                    applyTheme();
                  }}
                  className={`p-2 rounded-lg text-sm capitalize transition-colors ${
                    themeMode === mode
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          {/* Accent Color */}
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-2">Accent Color</label>
            <div className="flex gap-2">
              {(Object.entries(PRESET_SWATCHES) as [ThemePreset, string][]).map(([preset, swatch]) => (
                <button
                  key={preset}
                  onClick={() => {
                    setThemePreset(preset);
                    setActivePreset(preset);
                    setActivePresetState(preset);
                    applyTheme();
                  }}
                  className={`w-8 h-8 rounded-full transition-transform ${
                    activePreset === preset ? 'ring-2 ring-white scale-110' : 'hover:scale-105'
                  }`}
                  style={{ backgroundColor: swatch }}
                  aria-label={`${preset} theme`}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Help */}
        <section className="text-center py-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            API keys are stored securely on the server and never exposed to the frontend.
          </p>
        </section>
      </div>
    </div>
  );
}
