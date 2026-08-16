import { AlertTriangle, Info, Sparkles, Check } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useImageGenStore } from '../../stores/imageGenStore';
import type { ImageGenBackend } from '../../api/imageGenApi';
import { PROVIDERS } from '../../api/client';
import { isImageCapableProvider } from '../../api/providerCatalog';

const OPENAI_SECRET_KEY = 'api_key_openai';

// Human labels for the current image engine, so notices can name what's
// actually handling image generation instead of leaving it abstract.
const BACKEND_LABELS: Record<ImageGenBackend, string> = {
  pollinations: 'Pollinations (free)',
  horde: 'AI Horde (free)',
  sdwebui: 'local SD WebUI',
  dalle: 'OpenAI DALL·E',
};

/**
 * Contextual guidance tying image generation to the user's main chat provider.
 * Tone is meaningful: amber = must-fix/blocking, blue = informational,
 * green = confirmed-good.
 *
 *  - If the main provider can also make images (today only OpenAI, via DALL-E
 *    reusing `api_key_openai`), offer a one-tap "use my main provider" shortcut,
 *    or confirm it's already in use — but only claim "no key needed" when a key
 *    is actually on file.
 *  - If the main provider is a chat model that can't generate images (Claude,
 *    Gemini, most of the catalog), explain — as info, not an alarm — that image
 *    generation runs on the separate engine selected below (which, by default,
 *    already works with zero setup).
 *  - Independently, if DALL-E is selected without an OpenAI key on file, warn
 *    (amber) — that's a genuinely blocking state.
 *
 * Rendered above {@link ImageGenSettingsFields} in AI Settings and in the
 * character-creator avatar step.
 */
export function ImageGenProviderNotice({ className }: { className?: string }) {
  const { activeProvider, secrets, globalSecrets, globalSharingEnabled } = useSettingsStore();
  const backend = useImageGenStore((s) => s.backend);
  const setConfig = useImageGenStore((s) => s.setConfig);

  const hasKey = (key: string): boolean => {
    const personal = secrets[key];
    if (Array.isArray(personal) && personal.length > 0) return true;
    if (globalSharingEnabled) {
      const shared = globalSecrets[key];
      if (Array.isArray(shared) && shared.length > 0) return true;
    }
    return false;
  };

  const providerName =
    PROVIDERS.find((p) => p.id === activeProvider)?.name || activeProvider || 'your chat model';
  const mainCanImage = isImageCapableProvider(activeProvider);
  const hasOpenAIKey = hasKey(OPENAI_SECRET_KEY);
  const backendLabel = BACKEND_LABELS[backend] ?? backend;

  const notices: React.ReactNode[] = [];

  if (mainCanImage) {
    // Main provider (OpenAI) can generate images via DALL-E.
    if (backend === 'dalle' && hasOpenAIKey) {
      notices.push(
        <div
          key="using-main"
          className="flex items-start gap-2 text-xs text-green-300 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2"
        >
          <Check size={14} className="shrink-0 mt-0.5 text-green-400" />
          <span>
            Using your main provider’s key — {providerName} DALL·E. No separate image key needed.
          </span>
        </div>,
      );
    } else if (backend !== 'dalle' && hasOpenAIKey) {
      notices.push(
        <div
          key="use-main"
          className="flex items-start gap-2 text-xs text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2"
        >
          <Sparkles size={14} className="shrink-0 mt-0.5 text-blue-400" />
          <span className="flex-1">
            Your main provider ({providerName}) can generate images with the key you already have.
          </span>
          <button
            type="button"
            onClick={() => setConfig({ backend: 'dalle' })}
            className="shrink-0 font-medium text-blue-200 hover:text-white underline underline-offset-2"
          >
            Use it
          </button>
        </div>,
      );
    } else if (backend !== 'dalle') {
      // OpenAI main but no key yet, and not already on DALL-E: informational.
      // (When backend IS dalle without a key, the amber nudge below covers it.)
      notices.push(
        <div
          key="main-needs-key"
          className="flex items-start gap-2 text-xs text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2"
        >
          <Info size={14} className="shrink-0 mt-0.5 text-blue-400" />
          <span>
            Your main provider ({providerName}) can make images via DALL·E — add your OpenAI key
            under Active Provider to use it, or keep the free {backendLabel} engine below.
          </span>
        </div>,
      );
    }
  } else {
    // Chat model that can't generate images. Informational, not an alarm —
    // image generation still works via the separate engine selected below.
    notices.push(
      <div
        key="text-only"
        className="flex items-start gap-2 text-xs text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2"
      >
        <Info size={14} className="shrink-0 mt-0.5 text-blue-400" />
        <span>
          Your chat provider ({providerName}) can’t generate images — Claude, Gemini, and most chat
          models are text-only. Image generation runs on the separate engine below (currently{' '}
          {backendLabel}).
        </span>
      </div>,
    );
  }

  // Independent, blocking: DALL-E selected but no OpenAI key on file.
  if (backend === 'dalle' && !hasOpenAIKey) {
    notices.push(
      <div
        key="dalle-needs-key"
        className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2"
      >
        <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-400" />
        <span>
          DALL·E needs your OpenAI API key. Add it under Active Provider → OpenAI, or switch to a
          free backend.
        </span>
      </div>,
    );
  }

  if (notices.length === 0) return null;

  return <div className={`space-y-2 ${className ?? ''}`}>{notices}</div>;
}
