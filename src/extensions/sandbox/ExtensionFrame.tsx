/**
 * ExtensionFrame
 *
 * Owns the sandboxed <iframe> for a single server-side extension.
 * The iframe loads the extension's index.js with the shim already in scope,
 * then communicates back via postMessage.
 *
 * Mounting lifecycle:
 *   1. Iframe is created with srcdoc = shim + <script src="{scriptUrl}">.
 *   2. Extension's DOMContentLoaded runs → extension writes to #extensions_settings.
 *   3. window.load fires → shim posts ST_READY → component pushes current context.
 *   4. Thereafter, lifecycle events from sandboxEventBus are forwarded into the
 *      iframe as ST_LIFECYCLE messages, and the context is re-pushed on each one.
 *
 * Auto-resize:
 *   The shim posts ST_RESIZE with the body's scrollHeight whenever a ResizeObserver
 *   fires.  This component adjusts the iframe height accordingly so no scroll bars
 *   appear and the iframe blends into the settings card.
 */

import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { SHIM_CODE } from './extensionShim';
import { subscribeToSandboxEvents } from './sandboxEventBus';
import {
  SLOT_KINDS,
  useSandboxSlotStore,
  setFrameInvoker,
  clearFrameInvoker,
  type SlotKind,
} from './sandboxSlotRegistry';
import { useCharacterStore } from '../../stores/characterStore';
import { useChatStore } from '../../stores/chatStore';
import { usePersonaStore } from '../../stores/personaStore';
import { useAuthStore } from '../../stores/authStore';
import { showToastGlobal } from '../../components/ui/Toast';
import {
  useExtensionPopupStore,
  POPUP_TYPE,
  type PopupType,
  type PopupOptions,
} from '../../stores/extensionPopupStore';
import type { ExtensionManifestData } from '../../api/extensionsApi';

let _frameSeq = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtensionFrameProps {
  /** Extension name as returned by the discovery API, e.g. "third-party/my-ext". */
  extensionName: string;
  /**
   * URL of the extension's default entry script served by the ST backend.
   * Typically /scripts/extensions/third-party/{name}/index.js. Used as a
   * fallback when the manifest doesn't declare a `js` field.
   */
  scriptUrl: string;
  /**
   * Parsed manifest.json for this extension. When provided, `js` and `css`
   * fields are honored to load additional scripts and stylesheets into the
   * sandbox iframe. When omitted, only `scriptUrl` runs.
   */
  manifest?: ExtensionManifestData;
  /** Optional extra CSS classes on the iframe wrapper div. */
  className?: string;
  /** Called with true the first time the iframe reports non-zero content. */
  onHasContent?: (hasContent: boolean) => void;
  /**
   * Whether this frame is the authoritative source for slot items
   * (message-action buttons, chat-input extras). Only the global host should
   * pass `true`; the settings-page preview frame leaves this false so slot
   * registrations from its duplicate iframe are ignored — otherwise closing
   * the settings page would yank a slot item that's also wired into the
   * global frame.
   */
  allowSlots?: boolean;
}

// ---------------------------------------------------------------------------
// Context snapshot builder (reads Zustand state imperatively — safe outside render)
// ---------------------------------------------------------------------------

function buildContextSnapshot() {
  const charState = useCharacterStore.getState();
  const chatState = useChatStore.getState();
  const personaState = usePersonaStore.getState();
  const authState = useAuthStore.getState();

  const activePersonaId = personaState.activePersonaId;
  const activePersona = activePersonaId
    ? personaState.personas.find((p) => p.id === activePersonaId) ?? null
    : null;

  const charIndex = charState.selectedCharacter
    ? charState.characters.findIndex((c) => c.avatar === charState.selectedCharacter?.avatar)
    : null;

  return {
    characters: charState.characters.map((c) => ({ name: c.name, avatar: c.avatar ?? '' })),
    characterId: charIndex !== -1 ? charIndex : null,
    groupId: charState.isGroupChatMode ? 'group' : null,
    chatId: chatState.currentChatFile,
    name1: activePersona?.name ?? authState.currentUser?.name ?? 'You',
    name2: charState.isGroupChatMode
      ? 'Group Chat'
      : (charState.selectedCharacter?.name ?? 'Assistant'),
    // Send the last 100 messages in ST's wire format
    chat: chatState.messages.slice(-100).map((m) => ({
      name: m.name,
      is_user: m.isUser,
      is_system: m.isSystem,
      mes: m.content,
    })),
    settings: {},
    extensionSettings: {},
    personas: personaState.personas.map((p) => ({ id: p.id, name: p.name })),
  };
}

// ---------------------------------------------------------------------------
// srcdoc builder
// ---------------------------------------------------------------------------

/** Escape a URL for safe use inside an HTML attribute. */
function escapeAttrUrl(url: string): string {
  return url.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
}

/** Coerce a manifest field that may be string | string[] | undefined into an array. */
function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Resolve a manifest-relative asset path to a backend-served URL. */
function resolveAssetUrl(extensionName: string, assetPath: string): string {
  if (/^https?:\/\//i.test(assetPath) || assetPath.startsWith('/')) return assetPath;
  const base = extensionName.replace(/^third-party\//, '');
  return `/scripts/extensions/third-party/${base}/${assetPath.replace(/^\.\/+/, '')}`;
}

type ScriptType = 'classic' | 'module';

/**
 * Detect whether an entry script is an ES module by fetching its source and
 * looking for top-level `import` / `export` statements. Cached per URL across
 * the session because the answer is stable for the lifetime of an extension
 * install — repeat detection would just waste a network round-trip.
 *
 * Falls back to 'classic' on any fetch error so a misbehaving network can't
 * permanently lock an extension out of mounting.
 */
const _scriptTypeCache = new Map<string, ScriptType>();

async function detectScriptType(url: string): Promise<ScriptType> {
  const cached = _scriptTypeCache.get(url);
  if (cached) return cached;
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      _scriptTypeCache.set(url, 'classic');
      return 'classic';
    }
    const source = await response.text();
    // Multiline mode: match `import` / `export` at the start of any line,
    // followed by a non-identifier character so we don't false-positive on
    // identifiers like `importantThing`.
    const isModule = /^[ \t]*(?:import|export)(?![a-zA-Z0-9_$])/m.test(source);
    const result: ScriptType = isModule ? 'module' : 'classic';
    _scriptTypeCache.set(url, result);
    return result;
  } catch {
    _scriptTypeCache.set(url, 'classic');
    return 'classic';
  }
}

/**
 * Build the iframe srcdoc.
 *
 * Script load order:
 *   1. shim (inline)
 *   2. manifest.js scripts in declared order — OR fallbackScriptUrl if manifest.js is empty
 *
 * Stylesheet load order:
 *   1. base iframe styles (inline)
 *   2. manifest.css stylesheets in declared order
 *
 * `scriptType` controls the `type` attribute on the entry-point script tag.
 * 'module' lets ES-module-style upstream extensions (Live2D etc.) parse their
 * top-level `import` statements; 'classic' preserves the legacy globals-leaking
 * semantics that pre-module extensions like Lovense Cloud rely on. Detection
 * happens before this is called — see {@link detectScriptType}.
 */
function buildSrcdoc(
  extensionName: string,
  fallbackScriptUrl: string,
  manifest: ExtensionManifestData | undefined,
  scriptType: ScriptType,
): string {
  const jsList = asArray(manifest?.js);
  const cssList = asArray(manifest?.css);

  const scriptUrls = (jsList.length > 0 ? jsList.map((p) => resolveAssetUrl(extensionName, p)) : [fallbackScriptUrl])
    .map(escapeAttrUrl);
  const styleUrls = cssList.map((p) => escapeAttrUrl(resolveAssetUrl(extensionName, p)));

  const typeAttr = scriptType === 'module' ? ' type="module"' : '';
  const scriptTags = scriptUrls.map((u) => `<script${typeAttr} src="${u}"></script>`).join('\n');
  const styleTags = styleUrls.map((u) => `<link rel="stylesheet" href="${u}">`).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    padding: 8px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    color: var(--color-text-primary, #e8e8e8);
    background: transparent;
  }
  * { box-sizing: border-box; }
  input, select, textarea, button {
    font-family: inherit;
    font-size: inherit;
  }
</style>
${styleTags}
<script>${SHIM_CODE}</script>
</head>
<body>
<!--
  Upstream ST has two separate settings containers: #extensions_settings for
  internal/built-in extensions (e.g. Lovense Cloud appends here) and
  #extensions_settings2 for third-party extensions (Live2D, etc.). Provide
  both so extensions of either flavor mount their UI without us having to
  know which container they target.
-->
<div id="extensions_settings" class="extensions_settings"></div>
<div id="extensions_settings2" class="extensions_settings"></div>
<div id="send_form" style="display:none"></div>
<div id="chat" style="display:none"></div>
${scriptTags}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExtensionFrame({
  extensionName,
  scriptUrl,
  manifest,
  className,
  onHasContent,
  allowSlots = false,
}: ExtensionFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);
  const readyRef = useRef(false);
  const hasContentReportedRef = useRef(false);
  const frameId = useMemo(
    () => `frame_${extensionName.replace(/[^a-zA-Z0-9_]/g, '_')}_${++_frameSeq}`,
    [extensionName],
  );

  // Stable ref so the event bus subscription (useEffect with [] deps) always
  // calls the current version of pushContext without needing re-subscription.
  const pushContextRef = useRef<() => void>(() => {});

  function pushContext() {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'ST_CONTEXT_UPDATE', context: buildContextSnapshot() },
      '*',
    );
  }

  // Keep ref in sync each render (in an effect: subscribers only fire
  // post-render, so they never observe a stale frame)
  useEffect(() => {
    pushContextRef.current = pushContext;
  });

  // ── RPC handler ──────────────────────────────────────────────────────────
  function handleRpc(msg: { id: string; method: string; args: unknown[] }) {
    const respond = (result?: unknown, error?: string) => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'ST_RPC_RESPONSE', id: msg.id, result, error },
        '*',
      );
    };

    switch (msg.method) {
      case 'saveMetadata':
      case 'saveSettings':
      case 'reloadCurrentChat':
        respond(null);
        break;
      case 'sendSystemMessage':
        respond(null);
        break;
      case 'callPopup': {
        const [html, rawType, inputValue, options] = msg.args as [
          string,
          number | string,
          string?,
          PopupOptions?,
        ];
        const type = (Number(rawType) as PopupType) || POPUP_TYPE.TEXT;
        useExtensionPopupStore
          .getState()
          .showPopup(String(html ?? ''), type, inputValue, options)
          .then((result) => respond(result));
        break;
      }
      default:
        respond(null, `Unsupported RPC method: ${msg.method}`);
    }
  }

  // ── postMessage handler ───────────────────────────────────────────────────
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const msg = event.data as { type?: string; [k: string]: unknown };
      if (!msg?.type || !String(msg.type).startsWith('ST_')) return;

      switch (msg.type) {
        case 'ST_READY':
          readyRef.current = true;
          pushContextRef.current();
          break;

        case 'ST_RESIZE': {
          const h = Number(msg.height) || 0;
          setHeight(h);
          if (h > 0 && !hasContentReportedRef.current) {
            hasContentReportedRef.current = true;
            onHasContent?.(true);
          }
          break;
        }

        case 'ST_TOAST':
          showToastGlobal(
            String(msg.message ?? ''),
            (msg.level as 'info' | 'warning' | 'error' | 'success') ?? 'info',
          );
          break;

        case 'ST_RPC':
          handleRpc(msg as { id: string; method: string; args: unknown[] });
          break;

        case 'ST_REGISTER_SLOT': {
          if (!allowSlots) break;
          const slot = String(msg.slot ?? '') as SlotKind;
          if (!SLOT_KINDS.includes(slot)) break;
          const item = msg.item as
            | { id?: string; label?: string; icon?: string; tooltip?: string }
            | undefined;
          if (!item || typeof item.id !== 'string') break;
          useSandboxSlotStore.getState().register(frameId, extensionName, slot, {
            id: item.id,
            label: String(item.label ?? item.id),
            icon: item.icon,
            tooltip: item.tooltip,
          });
          break;
        }

        case 'ST_UNREGISTER_SLOT': {
          if (!allowSlots) break;
          const slot = String(msg.slot ?? '') as SlotKind;
          if (!SLOT_KINDS.includes(slot)) break;
          const itemId = typeof msg.itemId === 'string' ? msg.itemId : null;
          if (!itemId) break;
          useSandboxSlotStore.getState().unregister(frameId, slot, itemId);
          break;
        }

        // Extension emitted an event — re-broadcast to the bus if desired.
        // For now, just ignore (extensions can emit to themselves).
        case 'ST_EVENT_EMIT':
          break;
      }
    },
    [onHasContent, allowSlots, frameId, extensionName],
  );

  // ── Wire up postMessage listener ──────────────────────────────────────────
  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  // ── Subscribe to sandboxEventBus for lifecycle events ─────────────────────
  useEffect(() => {
    return subscribeToSandboxEvents((eventName, args) => {
      if (!readyRef.current) return;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'ST_LIFECYCLE', event: eventName, args },
        '*',
      );
      // Re-push fresh context so extensions always have up-to-date data
      pushContextRef.current();
    });
  }, []);

  // ── Slot invoker: route slot clicks back to this iframe ──────────────────
  useEffect(() => {
    if (!allowSlots) return;
    setFrameInvoker(frameId, (itemId, payload) => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'ST_SLOT_INVOKE', itemId, payload },
        '*',
      );
    });
    return () => {
      clearFrameInvoker(frameId);
      useSandboxSlotStore.getState().unregisterFrame(frameId);
    };
  }, [allowSlots, frameId]);

  // ── Build srcdoc once detection completes ─────────────────────────────────
  // Detection is async (we fetch the entry script and check for `import` /
  // `export` at line start) so srcdoc lives in state, not a sync ref. The
  // iframe doesn't mount until detection resolves; subsequent renders keep
  // the same srcdoc to avoid reload-on-rerender. Callers that need to react
  // to a late-arriving manifest should remount via a key change.
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // The first script in the load list is what we probe. If manifest.js is
    // declared we use its first entry; otherwise scriptUrl is the entry.
    const firstJs = asArray(manifest?.js)[0];
    const probeUrl = firstJs ? resolveAssetUrl(extensionName, firstJs) : scriptUrl;
    detectScriptType(probeUrl).then((scriptType) => {
      if (cancelled) return;
      setSrcdoc(buildSrcdoc(extensionName, scriptUrl, manifest, scriptType));
    });
    return () => {
      cancelled = true;
    };
    // We intentionally only use the initial values — re-running on prop
    // changes would tear down the iframe and lose extension state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={className}
      style={{
        width: '100%',
        height: `${height}px`,
        overflow: 'hidden',
        transition: 'height 0.2s ease',
        minHeight: 0,
      }}
    >
      {srcdoc !== null && (
        <iframe
          ref={iframeRef}
          // Use srcDoc (React's camelCase spelling)
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-same-origin allow-forms"
          title={`Extension UI: ${extensionName}`}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
            background: 'transparent',
          }}
        />
      )}
    </div>
  );
}
