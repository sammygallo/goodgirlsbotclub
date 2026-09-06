import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Search,
  Cpu,
  Cloud,
  Server,
  Sparkles,
  ExternalLink,
  Check,
  Link as LinkIcon,
  Trash2,
  Loader2,
} from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { useCustomProviderStore } from '../../stores/customProviderStore';
import { hasMinRole } from '../../utils/permissions';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { showToastGlobal } from '../ui/Toast';
import {
  BUILTIN_CATALOG,
  type CatalogProvider,
  type ProviderCategory,
  type UserProvider,
} from '../../api/providerCatalog';
import { InstallProviderFromUrlModal } from './InstallProviderFromUrlModal';

type Tab = 'browse' | 'installed';

const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  frontier: 'Frontier',
  open: 'Open',
  aggregator: 'Aggregator',
  specialty: 'Specialty',
  local: 'Local',
};

const CATEGORY_ORDER: ProviderCategory[] = [
  'frontier',
  'specialty',
  'open',
  'aggregator',
  'local',
];

function CategoryIcon({ category }: { category: ProviderCategory }) {
  const iconProps = { size: 20, className: 'text-[var(--color-primary)]' };
  switch (category) {
    case 'frontier':
    case 'specialty':
      return <Sparkles {...iconProps} />;
    case 'open':
    case 'aggregator':
      return <Cloud {...iconProps} />;
    case 'local':
      return <Server {...iconProps} />;
    default:
      return <Cpu {...iconProps} />;
  }
}

function CatalogCard({
  provider,
  isConfigured,
  onInstall,
}: {
  provider: CatalogProvider;
  isConfigured: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
      <div className="flex items-start gap-3 p-4">
        <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
          <CategoryIcon category={provider.category} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
              {provider.name}
            </p>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
              {CATEGORY_LABELS[provider.category]}
            </span>
            {!provider.nativeRouted && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-500/15 text-blue-400"
                title="Routes via chat_completion_source: 'custom'"
              >
                Custom
              </span>
            )}
          </div>
          {provider.description && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">
              {provider.description}
            </p>
          )}
          {provider.docsUrl && (
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-[var(--color-primary)] hover:underline mt-1"
            >
              <ExternalLink size={10} />
              Docs
            </a>
          )}
        </div>

        <div className="flex-shrink-0">
          {isConfigured ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-green-500/15 text-green-400">
              <Check size={12} />
              Installed
            </span>
          ) : (
            <Button variant="primary" size="sm" onClick={onInstall} className="text-xs">
              Install
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function UserProviderCard({
  provider,
  isActive,
  onDelete,
}: {
  provider: UserProvider;
  isActive: boolean;
  onDelete: () => void;
}) {
  const activate = useCustomProviderStore((s) => s.activate);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function handleActivate() {
    try {
      await activate(provider.id);
      await useSettingsStore.getState().fetchSettings();
      showToastGlobal(`Activated ${provider.name}`, 'success');
    } catch (e) {
      showToastGlobal(e instanceof Error ? e.message : 'Failed to activate', 'error');
    }
  }

  return (
    <>
      <div
        className={`bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden border ${
          isActive ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]'
        }`}
      >
        <div className="flex items-start gap-3 p-4">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Server size={20} className="text-[var(--color-primary)]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                {provider.name}
              </p>
              {isActive && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-green-500/15 text-green-400">
                  Active
                </span>
              )}
            </div>
            <p className="text-[10px] font-mono text-[var(--color-text-secondary)] mt-0.5 truncate">
              {provider.baseUrl}
            </p>
            {provider.description && (
              <p className="text-xs text-[var(--color-text-secondary)] mt-1 line-clamp-2">
                {provider.description}
              </p>
            )}
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
              {provider.defaultModels.length} model
              {provider.defaultModels.length !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {!isActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleActivate}
                className="text-xs"
              >
                Activate
              </Button>
            )}
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-red-400 hover:text-red-300 transition-colors"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
        title="Delete provider"
        message={`Remove "${provider.name}" from your provider list? The API key in the custom slot stays until you overwrite it.`}
        confirmLabel="Delete"
        danger
      />
    </>
  );
}

export function ProviderCatalogPage() {
  const goBack = useSettingsPanelStore((s) => s.goBack);
  const userRole = useAuthStore((s) => s.currentUser?.role);
  const canManage = hasMinRole(userRole, 'admin');

  const [activeTab, setActiveTab] = useState<Tab>('browse');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ProviderCategory | null>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);

  const {
    list: userProviders,
    activeId: activeUserProviderId,
    fetch: fetchUserProviders,
    addOrUpdate,
    remove,
  } = useCustomProviderStore();

  const activeProvider = useSettingsStore((s) => s.activeProvider);
  const secrets = useSettingsStore((s) => s.secrets);
  const customUrl = useSettingsStore((s) => s.customUrl);
  const setActiveProvider = useSettingsStore((s) => s.setActiveProvider);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);

  useEffect(() => {
    fetchUserProviders();
  }, [fetchUserProviders]);

  // Which catalog entries are already configured? Native entries are
  // "configured" if their API key secret exists. Custom-routed entries are
  // "configured" if a user provider with the same baseUrl exists.
  const isCatalogProviderConfigured = (provider: CatalogProvider): boolean => {
    if (provider.nativeRouted) {
      const secretEntries = secrets[provider.secretKey];
      return Array.isArray(secretEntries) && secretEntries.length > 0;
    }
    return userProviders.some(
      (up) => up.baseUrl.replace(/\/+$/, '') === provider.baseUrl?.replace(/\/+$/, ''),
    );
  };

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return BUILTIN_CATALOG.filter((p) => {
      if (categoryFilter && p.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [searchQuery, categoryFilter]);

  const groupedCatalog = useMemo(() => {
    const groups: Record<ProviderCategory, CatalogProvider[]> = {
      frontier: [],
      specialty: [],
      open: [],
      aggregator: [],
      local: [],
    };
    for (const p of filteredCatalog) groups[p.category].push(p);
    return groups;
  }, [filteredCatalog]);

  async function handleInstall(provider: CatalogProvider) {
    if (!canManage) {
      showToastGlobal('Admin role required to install providers', 'error');
      return;
    }
    if (provider.nativeRouted) {
      // Native: set it as the active provider. The user still needs to enter
      // an API key in the AI settings page, but this gets them there.
      await setActiveProvider(provider.id);
      showToastGlobal(`${provider.name} selected — enter your API key`, 'success');
      return;
    }

    // Custom-routed: add it as a user provider with no key yet.
    try {
      await addOrUpdate({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        category: provider.category,
        nativeRouted: false,
        baseUrl: provider.baseUrl || '',
        secretKey: 'api_key_custom',
        defaultModels: [...provider.defaultModels],
        docsUrl: provider.docsUrl,
        description: provider.description,
      });
      showToastGlobal(`Added ${provider.name} — enter an API key in Installed tab`, 'success');
      setActiveTab('installed');
    } catch (e) {
      showToastGlobal(e instanceof Error ? e.message : 'Install failed', 'error');
    }
  }

  async function handleDeleteUserProvider(id: string) {
    try {
      await remove(id);
      await fetchSettings();
      showToastGlobal('Provider removed', 'success');
    } catch (e) {
      showToastGlobal(e instanceof Error ? e.message : 'Remove failed', 'error');
    }
  }

  const isCustomActive = activeProvider === 'custom';

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[var(--color-bg-primary)] border-b border-[var(--color-border)] px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => goBack()}
          className="p-2 -ml-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
          aria-label="Back"
        >
          <ArrowLeft size={20} className="text-[var(--color-text-primary)]" />
        </button>
        <div>
          <h1 className="text-base font-semibold text-[var(--color-text-primary)]">
            Provider Catalog
          </h1>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Browse or add new AI providers
          </p>
        </div>
      </div>

      <div className="p-4 space-y-3 max-w-xl mx-auto">
        {/* Tab bar */}
        <div className="flex gap-1 bg-[var(--color-bg-tertiary)] rounded-lg p-1">
          <button
            type="button"
            onClick={() => setActiveTab('browse')}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === 'browse'
                ? 'bg-[var(--color-primary)] text-white'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            Browse ({BUILTIN_CATALOG.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('installed')}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === 'installed'
                ? 'bg-[var(--color-primary)] text-white'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            Custom ({userProviders.length})
          </button>
        </div>

        {/* Browse tab */}
        {activeTab === 'browse' && (
          <div className="space-y-3">
            {/* Search */}
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]"
              />
              <Input
                type="text"
                id="provider-search"
                name="provider-search"
                autoComplete="off"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search providers..."
                className="pl-8"
              />
            </div>

            {/* Category chips */}
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setCategoryFilter(null)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  categoryFilter === null
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                All
              </button>
              {CATEGORY_ORDER.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat === categoryFilter ? null : cat)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    categoryFilter === cat
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>

            {/* Grouped catalog */}
            {CATEGORY_ORDER.map((cat) => {
              const providers = groupedCatalog[cat];
              if (providers.length === 0) return null;
              return (
                <div key={cat} className="space-y-2">
                  <h3 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide pt-2">
                    {CATEGORY_LABELS[cat]}
                  </h3>
                  {providers.map((p) => (
                    <CatalogCard
                      key={p.id}
                      provider={p}
                      isConfigured={isCatalogProviderConfigured(p)}
                      onInstall={() => handleInstall(p)}
                    />
                  ))}
                </div>
              );
            })}

            {filteredCatalog.length === 0 && (
              <div className="flex flex-col items-center justify-center text-center py-10">
                <Search size={32} className="text-[var(--color-text-secondary)] opacity-40 mb-3" />
                <p className="text-sm text-[var(--color-text-secondary)]">
                  No providers match your search.
                </p>
              </div>
            )}

            {/* Install from URL button */}
            {canManage && (
              <button
                type="button"
                onClick={() => setShowInstallModal(true)}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <LinkIcon size={16} />
                Add from URL...
              </button>
            )}
          </div>
        )}

        {/* Installed (custom) tab */}
        {activeTab === 'installed' && (
          <div className="space-y-2">
            {userProviders.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-12">
                <Server
                  size={40}
                  className="text-[var(--color-text-secondary)] opacity-40 mb-3"
                />
                <p className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
                  No custom providers yet
                </p>
                <p className="text-xs text-[var(--color-text-secondary)] max-w-xs mb-3">
                  Install one from the Browse tab or add a provider from its docs URL.
                </p>
                <Button variant="ghost" size="sm" onClick={() => setActiveTab('browse')}>
                  Browse catalog
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                  <Loader2 size={14} className="text-blue-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-400">
                    Only one custom provider's key can be active at a time (
                    <code className="font-mono">api_key_custom</code>). Switching requires
                    re-entering the new provider's API key from the AI Settings page.
                  </p>
                </div>
                {userProviders.map((p) => (
                  <UserProviderCard
                    key={p.id}
                    provider={p}
                    isActive={
                      isCustomActive &&
                      (activeUserProviderId === p.id ||
                        p.baseUrl.replace(/\/+$/, '') === customUrl.replace(/\/+$/, ''))
                    }
                    onDelete={() => handleDeleteUserProvider(p.id)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <InstallProviderFromUrlModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
      />
    </div>
  );
}
