import { useState, useEffect, useMemo } from 'react';
import {
  Download,
  Trash2,
  RefreshCw,
  Search,
  Loader2,
  Package,
  ExternalLink,
  Link,
  Check,
  Info,
  AlertCircle,
  LayoutPanelLeft,
} from 'lucide-react';
import { ExtensionFrame } from '../../extensions/sandbox/ExtensionFrame';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useServerExtensionStore } from '../../stores/serverExtensionStore';
import { useAuthStore } from '../../stores/authStore';
import { hasMinRole } from '../../utils/permissions';
import { showToastGlobal } from '../ui/Toast';
import { InstallFromUrlModal } from './InstallFromUrlModal';
import type { RegistryExtension, ExtensionManifestData } from '../../api/extensionsApi';
import type { InstalledExtensionInfo } from '../../stores/serverExtensionStore';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** ST backend URL for an extension's index.js */
function extensionScriptUrl(extName: string): string {
  const base = extName.replace(/^third-party\//, '');
  return `/scripts/extensions/third-party/${base}/index.js`;
}

function InstalledCard({
  ext,
  manifest,
  isAdmin,
}: {
  ext: InstalledExtensionInfo;
  manifest?: ExtensionManifestData;
  isAdmin: boolean;
}) {
  const operationInProgress = useServerExtensionStore((s) => s.operationInProgress);
  const updateExtension = useServerExtensionStore((s) => s.updateExtension);
  const deleteExtension = useServerExtensionStore((s) => s.deleteExtension);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Sandbox UI panel state
  const [uiExpanded, setUiExpanded] = useState(false);
  const [frameEverMounted, setFrameEverMounted] = useState(false);
  const [hasUi, setHasUi] = useState(false);

  function handleOpenUi() {
    if (!frameEverMounted) setFrameEverMounted(true);
    setUiExpanded((v) => !v);
  }

  const op = operationInProgress[ext.name];
  const folderName = ext.name.replace(/^third-party\//, '');
  const displayName = manifest?.display_name ?? folderName;
  const commitShort = ext.version?.currentCommitHash?.slice(0, 7);
  const isGlobal = ext.type === 'global';
  const slashCommands = manifest?.slash_commands ?? [];
  const hasInterceptor = manifest?.generate_interceptor === true;
  const hasCapabilities = slashCommands.length > 0 || hasInterceptor;
  const scriptUrl = extensionScriptUrl(ext.name);

  async function handleUpdate() {
    const success = await updateExtension(ext.name, isGlobal);
    if (success) {
      showToastGlobal('Extension updated', 'success');
    } else {
      showToastGlobal('Update failed', 'error');
    }
  }

  async function handleDelete() {
    const success = await deleteExtension(ext.name, isGlobal);
    if (success) {
      showToastGlobal('Extension deleted', 'success');
    } else {
      showToastGlobal('Delete failed', 'error');
    }
  }

  return (
    <>
      <div className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
        <div className="flex items-center gap-3 p-4">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0">
            <Package size={20} className="text-[var(--color-primary)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
              {displayName}
            </p>
            {displayName !== folderName && (
              <p className="text-[10px] font-mono text-[var(--color-text-secondary)] opacity-60 truncate">
                {folderName}
              </p>
            )}
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {commitShort && (
                <span className="text-[10px] font-mono text-[var(--color-text-secondary)]">
                  {commitShort}
                </span>
              )}
              {ext.version && !ext.version.isUpToDate && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-yellow-500/15 text-yellow-400">
                  Update available
                </span>
              )}
              {isGlobal && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-500/15 text-blue-400">
                  Global
                </span>
              )}
              {slashCommands.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-purple-500/15 text-purple-400">
                  {slashCommands.length} command{slashCommands.length !== 1 ? 's' : ''}
                </span>
              )}
              {hasInterceptor && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-green-500/15 text-green-400">
                  Gen hook
                </span>
              )}
              {hasUi && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-violet-500/15 text-violet-400">
                  UI
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Sandboxed UI toggle — always present; badge appears once content detected */}
            <button
              type="button"
              onClick={handleOpenUi}
              className={`p-1.5 rounded-lg transition-colors ${
                uiExpanded
                  ? 'bg-violet-500/20 text-violet-400'
                  : 'hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
              title={uiExpanded ? 'Hide extension UI' : 'Show extension UI'}
            >
              <LayoutPanelLeft size={16} />
            </button>
            {hasCapabilities && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                title={expanded ? 'Hide details' : 'Show capabilities'}
              >
                <Info size={16} />
              </button>
            )}
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={handleUpdate}
                  disabled={!!op}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Update"
                >
                  {op === 'updating' ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={!!op}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-red-400 hover:text-red-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Delete"
                >
                  {op === 'deleting' ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Expanded: manifest description + slash commands */}
        {expanded && hasCapabilities && (
          <div className="border-t border-[var(--color-border)] px-4 pb-3 pt-2 space-y-2">
            {manifest?.description && (
              <p className="text-xs text-[var(--color-text-secondary)]">{manifest.description}</p>
            )}
            {manifest?.author && (
              <p className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
                by {manifest.author}
              </p>
            )}
            {slashCommands.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide mb-1">
                  Slash Commands
                </p>
                <div className="space-y-1">
                  {slashCommands.map((cmd) => (
                    <div key={cmd.name} className="flex items-start gap-2">
                      <span className="text-xs font-mono text-[var(--color-primary)] shrink-0">
                        /{cmd.name}
                      </span>
                      {cmd.description && (
                        <span className="text-xs text-[var(--color-text-secondary)] opacity-70">
                          {cmd.description}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {hasInterceptor && (
              <p className="text-xs text-green-400 opacity-80">
                Hooks into generation pipeline (generate interceptor)
              </p>
            )}
          </div>
        )}

        {/* Sandboxed extension UI panel */}
        {frameEverMounted && (
          <div
            className={`border-t border-[var(--color-border)] transition-all duration-200 ${
              uiExpanded ? 'max-h-[600px] overflow-y-auto' : 'max-h-0 overflow-hidden'
            }`}
          >
            {uiExpanded && !hasUi && (
              <p className="px-4 py-3 text-xs text-[var(--color-text-secondary)] italic">
                Loading extension UI…
              </p>
            )}
            <ExtensionFrame
              extensionName={ext.name}
              scriptUrl={scriptUrl}
              manifest={manifest}
              onHasContent={(yes) => setHasUi(yes)}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Extension"
        message={`Are you sure you want to delete "${displayName}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
    </>
  );
}

function AvailableCard({
  ext,
  isInstalled,
  isAdmin,
}: {
  ext: RegistryExtension;
  isInstalled: boolean;
  isAdmin: boolean;
}) {
  const operationInProgress = useServerExtensionStore((s) => s.operationInProgress);
  const installExtension = useServerExtensionStore((s) => s.installExtension);
  const op = operationInProgress[ext.url];

  async function handleInstall() {
    const success = await installExtension(ext.url);
    if (success) {
      showToastGlobal(`Installed ${ext.name}`, 'success');
    } else {
      const storeError = useServerExtensionStore.getState().error;
      showToastGlobal(storeError || `Failed to install ${ext.name}`, 'error');
    }
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] rounded-lg overflow-hidden cyberpunk-card">
      <div className="flex items-start gap-3 p-4">
        <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Package size={20} className="text-[var(--color-primary)]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
            {ext.name}
          </p>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">
            {ext.description}
          </p>
          <a
            href={ext.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-[var(--color-primary)] hover:underline mt-1"
          >
            <ExternalLink size={10} />
            GitHub
          </a>
        </div>

        <div className="flex-shrink-0">
          {isInstalled ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-green-500/15 text-green-400">
              <Check size={12} />
              Installed
            </span>
          ) : isAdmin ? (
            <Button
              variant="primary"
              size="sm"
              onClick={handleInstall}
              disabled={!!op}
              isLoading={op === 'installing'}
              className="text-xs"
            >
              <Download size={14} className={op ? 'hidden' : 'mr-1'} />
              Install
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type Tab = 'installed' | 'available';

export function ServerExtensionsSection() {
  const [activeTab, setActiveTab] = useState<Tab>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [registryFetched, setRegistryFetched] = useState(false);

  const userRole = useAuthStore((s) => s.currentUser?.role);
  const isAdmin = hasMinRole(userRole, 'admin');

  const {
    registry,
    installed,
    manifests,
    isLoadingRegistry,
    isLoadingInstalled,
    error,
    fetchRegistry,
    fetchInstalled,
    clearError,
  } = useServerExtensionStore();

  // Fetch installed list on mount
  useEffect(() => {
    fetchInstalled();
  }, [fetchInstalled]);

  // Fetch registry on first switch to "available" tab
  useEffect(() => {
    if (activeTab === 'available' && !registryFetched) {
      fetchRegistry();
      setRegistryFetched(true);
    }
  }, [activeTab, registryFetched, fetchRegistry]);

  // Set of installed extension repo URLs for cross-referencing
  const installedUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const ext of installed) {
      if (ext.version?.remoteUrl) {
        // Normalize: strip trailing .git and lowercase
        const normalized = ext.version.remoteUrl
          .replace(/\.git$/, '')
          .toLowerCase();
        urls.add(normalized);
      }
    }
    return urls;
  }, [installed]);

  // Filter available extensions by search
  const filteredRegistry = useMemo(() => {
    if (!searchQuery.trim()) return registry;
    const q = searchQuery.toLowerCase();
    return registry.filter(
      (ext) =>
        ext.name.toLowerCase().includes(q) ||
        ext.description.toLowerCase().includes(q),
    );
  }, [registry, searchQuery]);

  function isExtensionInstalled(ext: RegistryExtension): boolean {
    const normalized = ext.url.replace(/\.git$/, '').toLowerCase();
    return installedUrls.has(normalized);
  }

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
          Server Extensions
        </h2>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
        <Info size={14} className="text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-400">
          Server extensions run on the backend. Extensions that declare slash commands in their
          manifest are automatically available in the chat input. Use{' '}
          <span className="font-mono">/plugin</span> to call any extension's server API from
          STscript.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
          <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-red-400">{error}</p>
            {/already (installed|exists)/i.test(error) && (
              <p className="text-xs text-red-300 mt-1 opacity-80">
                A previous failed install may have left a partial folder. Delete the extension first, then retry.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={clearError}
            className="text-xs text-red-400 hover:text-red-300 underline flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 bg-[var(--color-bg-tertiary)] rounded-lg p-1">
        <button
          type="button"
          onClick={() => setActiveTab('installed')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'installed'
              ? 'bg-[var(--color-primary)] text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          Installed{installed.length > 0 ? ` (${installed.length})` : ''}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('available')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'available'
              ? 'bg-[var(--color-primary)] text-white'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          Available
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'installed' && (
        <div className="space-y-2">
          {isLoadingInstalled ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={24} className="animate-spin text-[var(--color-primary)]" />
            </div>
          ) : installed.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-12">
              <Package size={40} className="text-[var(--color-text-secondary)] opacity-40 mb-3" />
              <p className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
                No server extensions installed
              </p>
              <p className="text-xs text-[var(--color-text-secondary)] max-w-xs mb-3">
                Browse the Available tab to find and install extensions.
              </p>
              <Button variant="ghost" size="sm" onClick={() => setActiveTab('available')}>
                Browse Available
              </Button>
            </div>
          ) : (
            <>
              {!isAdmin && (
                <p className="text-xs text-[var(--color-text-secondary)] italic">
                  Contact an admin to manage server extensions.
                </p>
              )}
              {installed.map((ext) => (
                <InstalledCard
                  key={ext.name}
                  ext={ext}
                  manifest={manifests[ext.name]}
                  isAdmin={isAdmin}
                />
              ))}
            </>
          )}
        </div>
      )}

      {activeTab === 'available' && (
        <div className="space-y-2">
          {/* Search input */}
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]"
            />
            <input
              type="text"
              id="extension-search"
              name="extension-search"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search extensions..."
              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
            />
          </div>

          {isLoadingRegistry ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={24} className="animate-spin text-[var(--color-primary)]" />
            </div>
          ) : filteredRegistry.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-10">
              <Search size={32} className="text-[var(--color-text-secondary)] opacity-40 mb-3" />
              <p className="text-sm text-[var(--color-text-secondary)]">
                {searchQuery ? 'No extensions match your search.' : 'No extensions available.'}
              </p>
            </div>
          ) : (
            <>
              {!isAdmin && (
                <p className="text-xs text-[var(--color-text-secondary)] italic">
                  Contact an admin to install extensions.
                </p>
              )}
              {filteredRegistry.map((ext) => (
                <AvailableCard
                  key={ext.id}
                  ext={ext}
                  isInstalled={isExtensionInstalled(ext)}
                  isAdmin={isAdmin}
                />
              ))}
            </>
          )}

          {/* Install from URL */}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setShowInstallModal(true)}
              className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-primary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
            >
              <Link size={16} />
              Install from URL
            </button>
          )}
        </div>
      )}

      <InstallFromUrlModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
      />
    </div>
  );
}
