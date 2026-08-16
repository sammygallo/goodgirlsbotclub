import { useEffect, useState } from 'react';
import { useImageGenStore } from '../../stores/imageGenStore';
import { imageGenApi, type HordeModelInfo, type ImageGenBackend } from '../../api/imageGenApi';

// Fallback used until the live /models fetch resolves (or if it errors).
// Pollinations' anonymous endpoint really only serves "sana" today; the
// dropdown repopulates from the server-side list as soon as it loads.
const POLLINATIONS_FALLBACK_MODELS = ['sana'];

// Horde fallback while the dynamic models call hasn't returned — a perennial
// high-worker-count entry. The real list overrides once the fetch completes.
const HORDE_FALLBACK_MODELS: HordeModelInfo[] = [
  { name: 'stable_diffusion', count: 0, queued: 0, eta: 0 },
];

const SIZE_PRESETS = [
  { label: 'Square 1024×1024', width: 1024, height: 1024 },
  { label: 'Portrait 768×1024', width: 768, height: 1024 },
  { label: 'Landscape 1024×768', width: 1024, height: 768 },
  { label: 'SD Square 512×512', width: 512, height: 512 },
  { label: 'SD Portrait 512×768', width: 512, height: 768 },
  { label: 'SD Landscape 768×512', width: 768, height: 512 },
];

const DALLE3_SIZE_PRESETS = [
  { label: 'Square 1024×1024', width: 1024, height: 1024 },
  { label: 'Landscape 1792×1024', width: 1792, height: 1024 },
  { label: 'Portrait 1024×1792', width: 1024, height: 1792 },
];

const DALLE2_SIZE_PRESETS = [
  { label: 'Small 256×256', width: 256, height: 256 },
  { label: 'Medium 512×512', width: 512, height: 512 },
  { label: 'Large 1024×1024', width: 1024, height: 1024 },
];

/**
 * The image-generation backend picker plus every per-backend config field
 * (model / key / URL / steps / CFG / size). Fully driven by `imageGenStore`,
 * so it can be dropped into both the in-chat Generate Image modal and the
 * AI Settings "Media Generation" section without either owning the state — a
 * change in one place is reflected in the other via the shared store.
 */
export function ImageGenSettingsFields() {
  const {
    backend,
    sdUrl,
    sdAuth,
    pollinationsModel,
    hordeModel,
    hordeApiKey,
    dalleModel,
    dalleQuality,
    width,
    height,
    steps,
    cfgScale,
    setConfig,
  } = useImageGenStore();

  const [pollinationsModels, setPollinationsModels] = useState<string[]>(
    POLLINATIONS_FALLBACK_MODELS,
  );
  const [hordeModels, setHordeModels] = useState<HordeModelInfo[]>(HORDE_FALLBACK_MODELS);

  // Lazy-load model lists when their backend is selected. Both endpoints are
  // cheap, and are skipped until the user actually lands on Pollinations/Horde.
  useEffect(() => {
    if (backend === 'pollinations') {
      void imageGenApi.getPollinationsModels().then((models) => {
        if (models.length > 0) setPollinationsModels(models);
      });
    } else if (backend === 'horde') {
      void imageGenApi.getHordeModels().then((models) => {
        if (models.length > 0) setHordeModels(models);
      });
    }
  }, [backend]);

  const activeSizePresets =
    backend === 'dalle'
      ? dalleModel === 'dall-e-3'
        ? DALLE3_SIZE_PRESETS
        : DALLE2_SIZE_PRESETS
      : SIZE_PRESETS;

  const sizeKey = `${width}x${height}`;

  return (
    <div className="space-y-3">
      {/* Backend */}
      <div>
        <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
          Backend
        </label>
        <select
          value={backend}
          onChange={(e) => setConfig({ backend: e.target.value as ImageGenBackend })}
          className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
        >
          <option value="pollinations">Pollinations (free, no setup)</option>
          <option value="horde">AI Horde (free, distributed)</option>
          <option value="sdwebui">SD WebUI (local)</option>
          <option value="dalle">OpenAI DALL-E (uses your OpenAI key)</option>
        </select>
      </div>

      {/* Pollinations model */}
      {backend === 'pollinations' && (
        <div>
          <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
            Model
          </label>
          <select
            value={pollinationsModel}
            onChange={(e) => setConfig({ pollinationsModel: e.target.value })}
            className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
          >
            {pollinationsModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!pollinationsModels.includes(pollinationsModel) && (
              <option value={pollinationsModel}>{pollinationsModel} (custom)</option>
            )}
          </select>
        </div>
      )}

      {/* Horde settings */}
      {backend === 'horde' && (
        <>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Model
              <span className="ml-1 text-[10px] text-zinc-500 font-normal">
                (sorted by available workers)
              </span>
            </label>
            <select
              value={hordeModel}
              onChange={(e) => setConfig({ hordeModel: e.target.value })}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
            >
              {hordeModels.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}{m.count > 0 ? ` — ${m.count} worker${m.count === 1 ? '' : 's'}` : ''}
                </option>
              ))}
              {!hordeModels.find((m) => m.name === hordeModel) && (
                <option value={hordeModel}>{hordeModel} (custom)</option>
              )}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              API Key
              <span className="ml-1 text-[10px] text-zinc-500 font-normal">
                (optional — leave blank for anonymous)
              </span>
            </label>
            <input
              type="password"
              value={hordeApiKey}
              onChange={(e) => setConfig({ hordeApiKey: e.target.value })}
              placeholder="0000000000 (anonymous)"
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
            />
            <p className="text-[10px] text-zinc-500 mt-1 leading-snug">
              Free key registration at{' '}
              <a
                href="https://aihorde.net"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-primary)] hover:underline"
              >
                aihorde.net
              </a>
              {' '}— gives you priority over anonymous requests.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Steps
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={steps}
                onChange={(e) =>
                  setConfig({ steps: Math.max(1, Math.min(50, parseInt(e.target.value) || 25)) })
                }
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                CFG Scale
              </label>
              <input
                type="number"
                min={1}
                max={30}
                step={0.5}
                value={cfgScale}
                onChange={(e) =>
                  setConfig({ cfgScale: Math.max(1, Math.min(30, parseFloat(e.target.value) || 7)) })
                }
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
              />
            </div>
          </div>
        </>
      )}

      {/* DALL-E settings */}
      {backend === 'dalle' && (
        <>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Model
            </label>
            <select
              value={dalleModel}
              onChange={(e) => setConfig({ dalleModel: e.target.value as 'dall-e-3' | 'dall-e-2' })}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
            >
              <option value="dall-e-3">DALL-E 3 (highest quality)</option>
              <option value="dall-e-2">DALL-E 2 (faster, cheaper)</option>
            </select>
          </div>
          {dalleModel === 'dall-e-3' && (
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Quality
              </label>
              <select
                value={dalleQuality}
                onChange={(e) => setConfig({ dalleQuality: e.target.value as 'standard' | 'hd' })}
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
              >
                <option value="standard">Standard</option>
                <option value="hd">HD (higher detail, slower)</option>
              </select>
            </div>
          )}
        </>
      )}

      {/* SD WebUI fields */}
      {backend === 'sdwebui' && (
        <>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              SD WebUI URL
            </label>
            <input
              type="text"
              value={sdUrl}
              onChange={(e) => setConfig({ sdUrl: e.target.value })}
              placeholder="http://localhost:7860"
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Auth <span className="font-normal text-zinc-500">(optional, user:pass)</span>
            </label>
            <input
              type="text"
              value={sdAuth}
              onChange={(e) => setConfig({ sdAuth: e.target.value })}
              placeholder="username:password"
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Steps
              </label>
              <input
                type="number"
                min={1}
                max={150}
                value={steps}
                onChange={(e) =>
                  setConfig({ steps: Math.max(1, Math.min(150, parseInt(e.target.value) || 20)) })
                }
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                CFG Scale
              </label>
              <input
                type="number"
                min={1}
                max={30}
                step={0.5}
                value={cfgScale}
                onChange={(e) =>
                  setConfig({ cfgScale: Math.max(1, Math.min(30, parseFloat(e.target.value) || 7)) })
                }
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
              />
            </div>
          </div>
        </>
      )}

      {/* Size */}
      <div>
        <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
          Size
        </label>
        <select
          value={sizeKey}
          onChange={(e) => {
            const preset = activeSizePresets.find((p) => `${p.width}x${p.height}` === e.target.value);
            if (preset) setConfig({ width: preset.width, height: preset.height });
          }}
          className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/40"
        >
          {activeSizePresets.map((p) => {
            const key = `${p.width}x${p.height}`;
            return (
              <option key={key} value={key}>
                {p.label}
              </option>
            );
          })}
          {!activeSizePresets.find((p) => p.width === width && p.height === height) && (
            <option value={sizeKey}>Custom {width}×{height}</option>
          )}
        </select>
      </div>
    </div>
  );
}
