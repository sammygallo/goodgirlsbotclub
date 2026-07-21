import { useEffect, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Eye, EyeOff, Globe, Key, LayoutGrid, Loader2, Plug, Server, Trash2 } from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useConnectionProfileStore } from '../../stores/connectionProfileStore';
import { useGenerationStore } from '../../stores/generationStore';
import { useCustomProviderStore } from '../../stores/customProviderStore';
import { PROVIDERS, settingsApi, apiRequest, type SecretState } from '../../api/client';
import { probeProviderModels } from '../../api/providerProbe';
import { useAuthStore } from '../../stores/authStore';
import { hasMinRole } from '../../utils/permissions';
import { Button, Input } from '../ui';
import { showToastGlobal } from '../ui/Toast';

type TestState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; count: number }
  | { kind: 'error'; message: string };

// Provider model-list loader. Strategy per provider:
//   - 'openrouter'                              → public `/api/v1/models` (no auth, CORS-friendly).
//   - providers in BACKEND_STATUS_PROVIDERS     → POST to `/api/backends/chat-completions/status`,
//                                                 which proxies to the provider's `/models` using
//                                                 the user's stored API key. Skipped when no key.
//   - everything else (Anthropic, Vertex AI,
//     Perplexity, AI21, 01.AI, Zhipu, Block
//     Entropy)                                  → static `defaultModels` (backend `/status` doesn't
//                                                 support these yet).
// Results are cached at module scope per provider id.
const BACKEND_STATUS_PROVIDERS: ReadonlySet<string> = new Set([
  'openai', 'makersuite', 'mistralai', 'groq', 'deepseek', 'cohere',
  'xai', 'moonshot', 'nanogpt', 'pollinations', 'aimlapi', 'electronhub',
]);

const modelsCache: Record<string, string[]> = {};
const inFlightLoads: Record<string, Promise<string[] | null>> = {};

function extractModelIds(payload: unknown): string[] {
  if (!payload) return [];
  const p = payload as { data?: unknown; models?: unknown };
  // Upstream shapes: OpenAI-style { data: [{id}] }, Cohere { models: [{name}] },
  // bare arrays, or the backend's error wrapper { data: { data: [] } }.
  const candidates: unknown[] = [
    p.data,
    p.models,
    (p.data as { data?: unknown } | undefined)?.data,
    Array.isArray(payload) ? payload : null,
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) {
      const ids = list
        .map((m) => (m && typeof m === 'object' ? ((m as { id?: unknown; name?: unknown }).id ?? (m as { name?: unknown }).name) : null))
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

async function fetchOpenrouterModels(): Promise<string[] | null> {
  const res = await probeProviderModels('https://openrouter.ai/api/v1');
  return res.ok && res.models.length > 0 ? [...new Set(res.models)].sort() : null;
}

async function fetchBackendModels(providerId: string): Promise<string[] | null> {
  try {
    const data = await apiRequest<unknown>('/api/backends/chat-completions/status', {
      method: 'POST',
      body: JSON.stringify({ chat_completion_source: providerId }),
    });
    const ids = extractModelIds(data);
    return ids.length > 0 ? [...new Set(ids)].sort() : null;
  } catch {
    return null;
  }
}

async function loadProviderModels(providerId: string, hasKey: boolean): Promise<string[] | null> {
  const cached = modelsCache[providerId];
  if (cached) return cached;
  const existing = inFlightLoads[providerId];
  if (existing) return existing;

  let promise: Promise<string[] | null>;
  if (providerId === 'openrouter') {
    promise = fetchOpenrouterModels();
  } else if (BACKEND_STATUS_PROVIDERS.has(providerId)) {
    if (!hasKey) return null;
    promise = fetchBackendModels(providerId);
  } else {
    return null;
  }

  inFlightLoads[providerId] = promise
    .then((list) => {
      if (list) modelsCache[providerId] = list;
      return list;
    })
    .finally(() => { delete inFlightLoads[providerId]; });
  return inFlightLoads[providerId];
}

function isDynamicProvider(providerId: string): boolean {
  return providerId === 'openrouter' || BACKEND_STATUS_PROVIDERS.has(providerId);
}

interface LocalPreset { name: string; url: string; defaultModel?: string }
const LOCAL_PRESETS: LocalPreset[] = [
  { name: 'Ollama', url: 'http://localhost:11434/v1', defaultModel: 'llama3' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
  { name: 'KoboldCpp', url: 'http://localhost:5001/v1' },
  { name: 'llama.cpp', url: 'http://localhost:8080/v1' },
  { name: 'TabbyAPI', url: 'http://localhost:5000/v1' },
];

// Inline key-entry field rendered below the Active Provider grid when a user
// provider is active. Kept tiny so switching providers is a two-click flow:
// click the chip → re-enter the key.
function UserProviderKeyInput({
  providerId,
  onSave,
}: {
  providerId: string;
  onSave: (key: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  // Reset on provider change
  useEffect(() => { setValue(''); setShow(false); }, [providerId]);

  return (
    <div className="flex gap-2">
      <div className="flex-1 relative">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Re-enter API key..."
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <Button
        onClick={async () => {
          if (!value.trim()) return;
          setSaving(true);
          try {
            await onSave(value.trim());
            setValue('');
          } finally {
            setSaving(false);
          }
        }}
        disabled={!value.trim() || saving}
        size="sm"
        className="shrink-0"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
      </Button>
    </div>
  );
}

// Self-contained per-provider API key entry. Owns its own input/visibility
// state so it can be dropped anywhere (Active Provider, Fallback Provider)
// without leaking state up to the parent.
function ProviderApiKeyInput({
  providerName,
  secretKey,
  configured,
  isSaving,
  onSave,
  onDelete,
}: {
  providerName: string;
  secretKey: string;
  configured: boolean;
  isSaving: boolean;
  onSave: (key: string) => Promise<void> | void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  useEffect(() => { setValue(''); setShow(false); }, [secretKey]);
  return (
    <div className="mt-4 p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Key size={14} className="text-[var(--color-text-secondary)]" />
          <span className="text-xs font-medium text-[var(--color-text-primary)]">{providerName} API Key</span>
        </div>
        {configured && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-green-400">Configured</span>
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={isSaving} className="p-1 text-red-400 hover:text-red-300">
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <Input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={configured ? 'Enter new key to replace...' : 'Enter API key...'}
            className="pr-10"
          />
          <button type="button" onClick={() => setShow((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <Button
          onClick={async () => {
            if (!value.trim()) return;
            await onSave(value.trim());
            setValue('');
          }}
          disabled={!value.trim() || isSaving}
          className="shrink-0"
        >
          {isSaving ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
        </Button>
      </div>
    </div>
  );
}

// Model dropdown that prefers the live-fetched model catalog for a provider and
// falls back to the static `provider.models` list when no live data is available.
// Shared by the Active Provider and Fallback Provider sections so both pickers
// surface the same options for the same provider.
function ProviderModelSelect({
  providerId,
  value,
  onChange,
  disabled,
  dynamicModels,
  modelsLoadingFor,
  modelsErrorFor,
}: {
  providerId: string;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  dynamicModels: Record<string, string[] | null>;
  modelsLoadingFor: Record<string, boolean>;
  modelsErrorFor: Record<string, string>;
}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return null;
  const liveList = dynamicModels[providerId];
  const useLive = !!(liveList && liveList.length > 0);
  const baseList = useLive ? liveList! : (provider.models as readonly string[]);
  const modelList = value && !baseList.includes(value) ? [value, ...baseList] : baseList;
  const isLoading = !!modelsLoadingFor[providerId];
  const errorMsg = modelsErrorFor[providerId];
  const liveSource = providerId === 'openrouter'
    ? 'openrouter.ai/api/v1/models'
    : `${provider.name} /models`;
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-[var(--color-text-secondary)]">Model</label>
        {isLoading && (
          <span className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-1">
            <Loader2 size={10} className="animate-spin" /> Loading models…
          </span>
        )}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
      >
        {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {useLive && (
        <p className="mt-1.5 text-xs text-[var(--color-text-secondary)]">
          {liveList!.length} models from <code>{liveSource}</code>.
        </p>
      )}
      {errorMsg && !useLive && (
        <p className="mt-1.5 text-xs text-amber-400">{errorMsg}</p>
      )}
    </div>
  );
}

export function AISettingsPage(_props?: { params?: Record<string, string> }) {
  const { goBack, pushPage } = useSettingsPanelStore();
  const {
    secrets, globalSecrets, globalSharingEnabled, globalSharingSupported,
    activeProvider, activeModel, customUrl,
    isSaving, error, successMessage,
    fetchSecrets, fetchSettings, fetchGlobalSecrets,
    saveApiKey, deleteApiKey, saveGlobalApiKey, deleteGlobalApiKey,
    setActiveProvider, setActiveModel, setCustomUrl, setGlobalSharing, clearMessages,
    fallbackProvider, fallbackModel, setFallbackProvider, setFallbackModel, clearFallbackProvider,
  } = useSettingsStore();
  const userRole = useAuthStore((s) => s.currentUser?.role);
  const isOwner = hasMinRole(userRole, 'owner');
  const canManageProviders = hasMinRole(userRole, 'admin');

  // User-added (custom-routed) providers — merged into the Active Provider grid.
  const userProviders = useCustomProviderStore((s) => s.list);
  const activeUserProviderId = useCustomProviderStore((s) => s.activeId);
  const fetchUserProviders = useCustomProviderStore((s) => s.fetch);
  const activateUserProvider = useCustomProviderStore((s) => s.activate);
  const setUserProviderApiKey = useCustomProviderStore((s) => s.setApiKey);

  const [globalKeyInputs, setGlobalKeyInputs] = useState<Record<string, string>>({});
  const [showGlobalKey, setShowGlobalKey] = useState<Record<string, boolean>>({});
  const [globalKeysOpen, setGlobalKeysOpen] = useState(false);

  // Connection profiles
  const { profiles, activeProfileId, saveProfile, deleteProfile, renameProfile, setActiveProfileId } = useConnectionProfileStore();
  const generationSampler = useGenerationStore((s) => s.sampler);
  const loadGenerationPreset = useGenerationStore((s) => s.setSampler);
  const [profileNameInput, setProfileNameInput] = useState('');
  const [renamingProfileId, setRenamingProfileId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');

  // Custom endpoint
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [customModelInput, setCustomModelInput] = useState('');
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);

  // Live model catalog per provider. `undefined` = not loaded; `null` = fetch failed/skipped.
  const [dynamicModels, setDynamicModels] = useState<Record<string, string[] | null>>(() => ({ ...modelsCache }));
  const [modelsLoadingFor, setModelsLoadingFor] = useState<Record<string, boolean>>({});
  const [modelsErrorFor, setModelsErrorFor] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchSecrets();
    fetchSettings();
    fetchUserProviders();
    if (isOwner) fetchGlobalSecrets();
  }, [fetchSecrets, fetchSettings, fetchUserProviders, fetchGlobalSecrets, isOwner]);
  useEffect(() => {
    if (successMessage || error) {
      const timer = setTimeout(clearMessages, 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage, error, clearMessages]);
  useEffect(() => { setCustomUrlInput(customUrl); }, [customUrl]);
  useEffect(() => { setCustomModelInput(activeModel); }, [activeModel]);
  useEffect(() => { setTestState({ kind: 'idle' }); setDiscoveredModels([]); }, [customUrlInput]);

  // Lazily load live model catalogs for any currently selected provider (active + fallback).
  // Re-runs when the user adds an API key for a key-gated provider.
  useEffect(() => {
    const targets = Array.from(new Set([activeProvider, fallbackProvider].filter((id): id is string => !!id && isDynamicProvider(id))));
    let cancelled = false;
    for (const providerId of targets) {
      if (dynamicModels[providerId] !== undefined) continue;
      const provider = PROVIDERS.find((p) => p.id === providerId);
      const secret = provider ? secrets[provider.secretKey] : undefined;
      const hasKey = Array.isArray(secret) && secret.length > 0;
      // Backend `/status` requires a key; OpenRouter's public endpoint doesn't.
      if (providerId !== 'openrouter' && !hasKey) continue;

      setModelsLoadingFor((prev) => ({ ...prev, [providerId]: true }));
      setModelsErrorFor((prev) => { const { [providerId]: _, ...rest } = prev; return rest; });
      loadProviderModels(providerId, hasKey).then((list) => {
        if (cancelled) return;
        if (list && list.length > 0) {
          setDynamicModels((prev) => ({ ...prev, [providerId]: list }));
        } else {
          setDynamicModels((prev) => ({ ...prev, [providerId]: null }));
          setModelsErrorFor((prev) => ({ ...prev, [providerId]: "Couldn't load this provider's model list — using defaults." }));
        }
      }).finally(() => {
        if (cancelled) return;
        setModelsLoadingFor((prev) => { const { [providerId]: _, ...rest } = prev; return rest; });
      });
    }
    return () => { cancelled = true; };
  }, [activeProvider, fallbackProvider, secrets, dynamicModels]);

  const handleSaveGlobalKey = async (providerId: string) => {
    const key = globalKeyInputs[providerId];
    if (!key?.trim()) return;
    await saveGlobalApiKey(providerId, key.trim());
    setGlobalKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
  };

  const getGlobalSecretInfo = (secretKey: string): SecretState | null => {
    const data = globalSecrets[secretKey];
    if (Array.isArray(data) && data.length > 0) {
      return data.find((s) => s.active) || data[0];
    }
    return null;
  };

  const hasApiKey = (secretKey: string): boolean => {
    const secretData = secrets[secretKey];
    return Array.isArray(secretData) && secretData.length > 0;
  };

  const currentProvider = PROVIDERS.find((p) => p.id === activeProvider);
  const isProviderConfigured = (provider: typeof PROVIDERS[number]) =>
    provider.id === 'custom' ? !!customUrl : hasApiKey(provider.secretKey);

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      <header className="h-14 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] flex items-center pl-4 pr-14 gap-3 safe-top sticky top-0 z-10">
        <Button variant="ghost" size="sm" onClick={() => goBack()} className="p-2" aria-label="Back">
          <ArrowLeft size={24} />
        </Button>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">AI Settings</h1>
      </header>

      <div className="max-w-2xl mx-auto p-4 space-y-6">
        {/* Status */}
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

        {/* Active Provider */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Active Provider</h2>
            <button
              type="button"
              onClick={() => pushPage('ai-catalog')}
              className="inline-flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline"
            >
              <LayoutGrid size={12} />
              Browse catalog
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PROVIDERS.map((provider) => {
              const configured = isProviderConfigured(provider);
              const isActive = activeProvider === provider.id && !(provider.id === 'custom' && activeUserProviderId);
              return (
                <button
                  key={provider.id}
                  onClick={() => setActiveProvider(provider.id)}
                  disabled={isSaving}
                  className={`relative p-3 rounded-lg text-left transition-all ${
                    isActive ? 'bg-[var(--color-primary)] text-white'
                      : configured ? 'bg-[var(--color-bg-tertiary)] hover:bg-zinc-700'
                        : 'bg-[var(--color-bg-tertiary)] opacity-50'
                  }`}
                >
                  <span className="text-sm font-medium">{provider.name}</span>
                  {configured && (
                    <Check size={14} className={`absolute top-2 right-2 ${isActive ? 'text-white' : 'text-green-400'}`} />
                  )}
                </button>
              );
            })}
            {/* User-added providers appear alongside the built-ins */}
            {userProviders.map((up) => {
              const isActive = activeProvider === 'custom' && activeUserProviderId === up.id;
              return (
                <button
                  key={up.id}
                  onClick={async () => {
                    try {
                      await activateUserProvider(up.id);
                      await fetchSettings();
                    } catch (e) {
                      showToastGlobal(e instanceof Error ? e.message : 'Activation failed', 'error');
                    }
                  }}
                  disabled={isSaving}
                  className={`relative p-3 rounded-lg text-left transition-all ${
                    isActive
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-[var(--color-bg-tertiary)] hover:bg-zinc-700'
                  }`}
                  title={up.baseUrl}
                >
                  <div className="flex items-center gap-1.5">
                    <Server size={12} className="flex-shrink-0 opacity-70" />
                    <span className="text-sm font-medium truncate">{up.name}</span>
                  </div>
                </button>
              );
            })}
          </div>
          {activeProvider === 'custom' && !activeUserProviderId && !customUrl && (
            <p className="mt-2 text-xs text-[var(--color-text-secondary)]">Enter the endpoint URL below to use a local or custom model server</p>
          )}
          {activeProvider === 'custom' && activeUserProviderId && (
            <div className="mt-3 p-2 rounded-lg bg-[var(--color-bg-tertiary)] space-y-2">
              <p className="text-[10px] text-[var(--color-text-secondary)]">
                Active user provider. Re-save the API key here if you switched from another custom provider.
              </p>
              <UserProviderKeyInput
                providerId={activeUserProviderId}
                onSave={async (key) => {
                  try {
                    await setUserProviderApiKey(activeUserProviderId, key);
                    showToastGlobal('API key saved', 'success');
                  } catch (e) {
                    showToastGlobal(e instanceof Error ? e.message : 'Save failed', 'error');
                  }
                }}
              />
            </div>
          )}
          {canManageProviders && userProviders.length === 0 && (
            <p className="mt-2 text-[10px] text-[var(--color-text-secondary)]">
              Add more providers from the catalog to expand this list.
            </p>
          )}
          {currentProvider && activeProvider !== 'custom' && (
            <>
              <ProviderApiKeyInput
                providerName={currentProvider.name}
                secretKey={currentProvider.secretKey}
                configured={hasApiKey(currentProvider.secretKey)}
                isSaving={isSaving}
                onSave={(key) => saveApiKey(currentProvider.id, key)}
                onDelete={() => deleteApiKey(currentProvider.secretKey)}
              />
              <ProviderModelSelect
                providerId={activeProvider}
                value={activeModel}
                onChange={setActiveModel}
                disabled={isSaving}
                dynamicModels={dynamicModels}
                modelsLoadingFor={modelsLoadingFor}
                modelsErrorFor={modelsErrorFor}
              />
            </>
          )}
        </section>

        {/* Fallback Provider */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Fallback Provider</h2>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                Automatically retried if the primary provider fails.
              </p>
            </div>
            {fallbackProvider && (
              <button
                type="button"
                onClick={clearFallbackProvider}
                className="text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PROVIDERS.filter((p) => p.id !== 'custom').map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => {
                  if (fallbackProvider === provider.id) {
                    clearFallbackProvider();
                  } else {
                    setFallbackProvider(provider.id);
                    if (!fallbackModel) setFallbackModel(provider.models[0] || '');
                  }
                }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors
                  ${fallbackProvider === provider.id
                    ? 'bg-[var(--color-primary)]/15 border-[var(--color-primary)]/40 text-[var(--color-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-secondary)]/40 hover:text-[var(--color-text-primary)]'
                  }`}
              >
                <span className="truncate">{provider.name}</span>
              </button>
            ))}
          </div>
          {fallbackProvider && (() => {
            const fbProvider = PROVIDERS.find((p) => p.id === fallbackProvider);
            if (!fbProvider) return null;
            return (
              <>
                <ProviderApiKeyInput
                  providerName={fbProvider.name}
                  secretKey={fbProvider.secretKey}
                  configured={hasApiKey(fbProvider.secretKey)}
                  isSaving={isSaving}
                  onSave={(key) => saveApiKey(fbProvider.id, key)}
                  onDelete={() => deleteApiKey(fbProvider.secretKey)}
                />
                <ProviderModelSelect
                  providerId={fallbackProvider}
                  value={fallbackModel}
                  onChange={setFallbackModel}
                  dynamicModels={dynamicModels}
                  modelsLoadingFor={modelsLoadingFor}
                  modelsErrorFor={modelsErrorFor}
                />
              </>
            );
          })()}
        </section>

        {/* Custom Endpoint */}
        {activeProvider === 'custom' && (
          <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Globe size={16} className="text-[var(--color-text-secondary)]" />
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Custom Endpoint</h2>
            </div>
            <div>
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Quick presets</label>
              <div className="flex flex-wrap gap-1.5">
                {LOCAL_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => {
                      setCustomUrlInput(preset.url);
                      if (preset.defaultModel && !customModelInput.trim()) setCustomModelInput(preset.defaultModel);
                    }}
                    className="px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] hover:text-[var(--color-text-primary)] transition-colors"
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Base URL</label>
              <div className="flex gap-2">
                <Input type="url" value={customUrlInput} onChange={(e) => setCustomUrlInput(e.target.value)} placeholder="http://localhost:11434/v1" className="flex-1" />
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const url = customUrlInput.trim();
                    if (!url) return;
                    setTestState({ kind: 'pending' });
                    const result = await probeProviderModels(url);
                    if (result.ok) { setTestState({ kind: 'success', count: result.models.length }); setDiscoveredModels(result.models); }
                    else { setTestState({ kind: 'error', message: result.error }); setDiscoveredModels([]); }
                  }}
                  disabled={testState.kind === 'pending' || !customUrlInput.trim()}
                  className="shrink-0"
                >
                  {testState.kind === 'pending' ? <Loader2 size={16} className="animate-spin" /> : 'Test'}
                </Button>
                <Button onClick={() => setCustomUrl(customUrlInput.trim())} disabled={isSaving || !customUrlInput.trim() || customUrlInput.trim() === customUrl} className="shrink-0">
                  {isSaving ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
                </Button>
              </div>
              {testState.kind === 'success' && (
                <p className="mt-1.5 text-xs text-green-400 flex items-center gap-1"><Check size={12} /> Connected. Found {testState.count} model{testState.count !== 1 ? 's' : ''}.</p>
              )}
              {testState.kind === 'error' && <p className="mt-1.5 text-xs text-red-400">{testState.message}</p>}
              <div className="mt-2 text-xs text-[var(--color-text-secondary)] leading-relaxed">
                <p className="mb-1">OpenAI-compatible base URL. Ends in <code>/v1</code> for most tools.</p>
                <p><strong className="text-[var(--color-text-primary)]">CORS:</strong> your local server must allow browser requests.</p>
              </div>
            </div>
            <div>
              <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Model name</label>
              {discoveredModels.length > 0 ? (
                <>
                  <select
                    value={discoveredModels.includes(customModelInput) ? customModelInput : '__custom__'}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === '__custom__') { setDiscoveredModels([]); return; }
                      setCustomModelInput(value);
                      if (value !== activeModel) setActiveModel(value);
                    }}
                    className="w-full text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  >
                    {discoveredModels.map((m) => <option key={m} value={m}>{m}</option>)}
                    <option value="__custom__">Custom...</option>
                  </select>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Discovered from <code>{customUrlInput}/models</code>.</p>
                </>
              ) : (
                <>
                  <Input value={customModelInput} onChange={(e) => setCustomModelInput(e.target.value)} onBlur={() => { if (customModelInput !== activeModel) setActiveModel(customModelInput); }} placeholder="e.g. llama3, mistral, codellama" />
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Click Test to discover available models.</p>
                </>
              )}
            </div>
          </section>
        )}

        {/* Connection Profiles */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center gap-2 mb-3">
            <Plug size={16} className="text-[var(--color-text-secondary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Connection Profiles</h2>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mb-3">Save the current provider, model, and sampler settings as a named profile.</p>
          {profiles.length > 0 && (
            <div className="space-y-2 mb-3">
              {profiles.map((profile) => (
                <div key={profile.id} className={`flex items-center gap-2 p-2.5 rounded-lg border transition-colors ${activeProfileId === profile.id ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10' : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]'}`}>
                  {renamingProfileId === profile.id ? (
                    <input type="text" value={renameInput} onChange={(e) => setRenameInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { renameProfile(profile.id, renameInput); setRenamingProfileId(null); } else if (e.key === 'Escape') setRenamingProfileId(null); }}
                      onBlur={() => { renameProfile(profile.id, renameInput); setRenamingProfileId(null); }}
                      className="flex-1 min-w-0 bg-transparent text-sm text-[var(--color-text-primary)] border-b border-[var(--color-primary)] focus:outline-none" autoFocus />
                  ) : (
                    <button className="flex-1 min-w-0 text-left" onClick={() => {
                      setActiveProfileId(profile.id); setActiveProvider(profile.provider); setActiveModel(profile.model);
                      if (profile.provider === 'custom' && profile.customUrl) setCustomUrl(profile.customUrl);
                      loadGenerationPreset(profile.sampler);
                    }}>
                      <span className="text-sm font-medium text-[var(--color-text-primary)] truncate block">{profile.name}</span>
                      <span className="text-[10px] text-[var(--color-text-secondary)]">{profile.provider} · {profile.model || 'custom'}</span>
                    </button>
                  )}
                  <button onClick={() => { setRenamingProfileId(profile.id); setRenameInput(profile.name); }} className="p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]" title="Rename">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  <button onClick={() => { deleteProfile(profile.id); if (activeProfileId === profile.id) setActiveProfileId(null); }} className="p-1 text-[var(--color-text-secondary)] hover:text-red-400" title="Delete">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input type="text" value={profileNameInput} onChange={(e) => setProfileNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && profileNameInput.trim()) { saveProfile(profileNameInput, activeProvider, activeModel, customUrl, generationSampler); setProfileNameInput(''); } }}
              placeholder="Profile name..." className="flex-1 min-w-0 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
            <button onClick={() => { if (!profileNameInput.trim()) return; saveProfile(profileNameInput, activeProvider, activeModel, customUrl, generationSampler); setProfileNameInput(''); }}
              disabled={!profileNameInput.trim()} className="px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-40 transition-colors whitespace-nowrap">
              Save
            </button>
          </div>
        </section>

        {/* Live Portrait (Replicate) */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center gap-2 mb-1">
            <Key size={16} className="text-[var(--color-text-secondary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Live Portrait</h2>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mb-3">
            Replicate API key for generating per-emotion character animation clips via{' '}
            <span className="font-mono">wan-video/wan-2.2-i2v-fast</span>.
            Videos are generated from the character's portrait — no driving videos needed.
          </p>
          <ProviderApiKeyInput
            providerName="Replicate"
            secretKey="api_key_replicate"
            configured={hasApiKey('api_key_replicate')}
            isSaving={isSaving}
            onSave={async (key) => {
              try {
                await settingsApi.writeSecret('api_key_replicate', key, 'Replicate');
                await fetchSecrets();
              } catch (e) {
                showToastGlobal(e instanceof Error ? e.message : 'Failed to save key', 'error');
              }
            }}
            onDelete={() => deleteApiKey('api_key_replicate')}
          />
        </section>

        {/* Scene Video (self-hosted RunPod) */}
        <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
          <div className="flex items-center gap-2 mb-1">
            <Key size={16} className="text-[var(--color-text-secondary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Scene Video</h2>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mb-3">
            RunPod API key for the self-hosted scene-video renderer (motion-menu
            scenes). Only used when the instance has a scene endpoint configured;
            without it, Generate Scene falls back to Replicate.
          </p>
          <ProviderApiKeyInput
            providerName="RunPod"
            secretKey="api_key_runpod"
            configured={hasApiKey('api_key_runpod')}
            isSaving={isSaving}
            onSave={async (key) => {
              try {
                await settingsApi.writeSecret('api_key_runpod', key, 'RunPod');
                await fetchSecrets();
              } catch (e) {
                showToastGlobal(e instanceof Error ? e.message : 'Failed to save key', 'error');
              }
            }}
            onDelete={() => deleteApiKey('api_key_runpod')}
          />
        </section>

        {/* Global API Keys — Owner only */}
        {isOwner && globalSharingSupported && (
          <section className="bg-[var(--color-bg-secondary)] rounded-lg p-4 cyberpunk-card">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setGlobalKeysOpen((v) => !v)}
                className="flex items-center gap-2 flex-1"
              >
                <Globe size={16} className="text-[var(--color-text-secondary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Global API Keys</h2>
                <ChevronDown size={16} className={`text-[var(--color-text-secondary)] transition-transform ml-1 ${globalKeysOpen ? 'rotate-180' : ''}`} />
              </button>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-text-secondary)]">Share with all users</span>
                <button
                  role="switch"
                  aria-checked={globalSharingEnabled}
                  onClick={() => setGlobalSharing(!globalSharingEnabled)}
                  disabled={isSaving}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${
                    globalSharingEnabled ? 'bg-[var(--color-primary)]' : 'bg-zinc-600'
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                    globalSharingEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </div>
            </div>
            {globalKeysOpen && <>
            <p className="text-xs text-[var(--color-text-secondary)] mt-3 mb-3">
              Keys set here are used as defaults for users who haven't entered their own. Your personal keys above always take priority.
            </p>
            <div className="space-y-4">
              {PROVIDERS.filter((p) => p.id !== 'custom').map((provider) => {
                const globalInfo = getGlobalSecretInfo(provider.secretKey);
                const configured = !!globalInfo;
                const inputValue = globalKeyInputs[provider.id] || '';
                const showKey = showGlobalKey[provider.id] || false;
                return (
                  <div key={provider.id} className="p-3 bg-[var(--color-bg-tertiary)] rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Globe size={16} className="text-[var(--color-text-secondary)]" />
                        <span className="text-sm font-medium text-[var(--color-text-primary)]">{provider.name}</span>
                      </div>
                      {configured && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-blue-400">Shared</span>
                          <Button variant="ghost" size="sm" onClick={() => deleteGlobalApiKey(provider.secretKey)} disabled={isSaving} className="p-1 text-red-400 hover:text-red-300">
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <Input type={showKey ? 'text' : 'password'} value={inputValue}
                          onChange={(e) => setGlobalKeyInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                          placeholder={configured ? 'Enter new key to replace...' : 'Enter global API key...'} className="pr-10" />
                        <button type="button" onClick={() => setShowGlobalKey((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                          {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                      <Button onClick={() => handleSaveGlobalKey(provider.id)} disabled={!inputValue.trim() || isSaving} className="shrink-0">
                        {isSaving ? <Loader2 size={16} className="animate-spin" /> : 'Save'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            </>}
          </section>
        )}
      </div>
    </div>
  );
}
