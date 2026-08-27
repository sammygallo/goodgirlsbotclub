import { useExtensionStore } from '../stores/extensionStore';
import type {
  ExtensionManifest,
  ContextBuildEvent,
  ContextContribution,
} from './types';

// ---------------------------------------------------------------------------
// Extension Registry — singleton that all built-in extensions register with
// ---------------------------------------------------------------------------

const extensions = new Map<string, ExtensionManifest>();
const initialized = new Set<string>();

export const extensionRegistry = {
  /** Register a built-in extension. Called once at module import time. */
  register(manifest: ExtensionManifest): void {
    if (extensions.has(manifest.id)) {
      console.warn(`[ExtensionRegistry] duplicate id "${manifest.id}", skipping`);
      return;
    }
    extensions.set(manifest.id, manifest);

    // Seed the store's enabled map with the default if the user hasn't toggled it.
    const store = useExtensionStore.getState();
    if (!(manifest.id in store.enabled)) {
      store.setEnabled(manifest.id, manifest.defaultEnabled ?? true);
    }
  },

  /** Look up a single extension by ID. */
  get(id: string): ExtensionManifest | undefined {
    return extensions.get(id);
  },

  /** All registered extensions, in registration order. */
  getAll(): ExtensionManifest[] {
    return Array.from(extensions.values());
  },

  /** Whether the user has this extension enabled. */
  isEnabled(id: string): boolean {
    return useExtensionStore.getState().enabled[id] ?? false;
  },

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Call onInit for all enabled extensions that haven't been initialized yet. */
  initAll(): void {
    for (const ext of extensions.values()) {
      if (this.isEnabled(ext.id) && !initialized.has(ext.id)) {
        ext.onInit?.();
        initialized.add(ext.id);
      }
    }
  },

  /** Call onDestroy for an extension and mark it uninitialized. */
  destroy(id: string): void {
    if (initialized.has(id)) {
      extensions.get(id)?.onDestroy?.();
      initialized.delete(id);
    }
  },

  // -----------------------------------------------------------------------
  // Context hooks — called by buildConversationContext in chatStore
  // -----------------------------------------------------------------------

  /** Collect ContextContributions from all enabled extensions. */
  runContextHooks(event: ContextBuildEvent): ContextContribution[] {
    const contributions: ContextContribution[] = [];
    for (const ext of extensions.values()) {
      if (!this.isEnabled(ext.id) || !ext.onBuildContext) continue;
      try {
        const items = ext.onBuildContext(event);
        for (const item of items) {
          contributions.push({
            ...item,
            order: item.order ?? 100,
            sourceExtensionId: ext.id,
          });
        }
      } catch (err) {
        console.error(`[ExtensionRegistry] onBuildContext error in "${ext.id}":`, err);
      }
    }
    return contributions.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  },

  // -----------------------------------------------------------------------
  // Message pipeline hooks
  // -----------------------------------------------------------------------

  /** Chain onBeforeUserMessage through all enabled extensions. */
  runBeforeUserMessage(text: string, charAvatar: string): string {
    let result = text;
    for (const ext of extensions.values()) {
      if (!this.isEnabled(ext.id) || !ext.onBeforeUserMessage) continue;
      try {
        result = ext.onBeforeUserMessage(result, charAvatar);
      } catch (err) {
        console.error(`[ExtensionRegistry] onBeforeUserMessage error in "${ext.id}":`, err);
      }
    }
    return result;
  },

  /** Chain onAfterAIMessage through all enabled extensions. */
  runAfterAIMessage(text: string, charAvatar: string): string {
    let result = text;
    for (const ext of extensions.values()) {
      if (!this.isEnabled(ext.id) || !ext.onAfterAIMessage) continue;
      try {
        result = ext.onAfterAIMessage(result, charAvatar);
      } catch (err) {
        console.error(`[ExtensionRegistry] onAfterAIMessage error in "${ext.id}":`, err);
      }
    }
    return result;
  },
};
