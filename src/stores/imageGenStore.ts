import { create } from 'zustand';
import { imageGenApi, type ImageGenBackend } from '../api/imageGenApi';
import { getSettingsBlob, makeLocalTsKey, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection, clearLocalTs } from '../utils/serverSettings';

// ---------------------------------------------------------------------------
// Gallery entry — persisted alongside config
// ---------------------------------------------------------------------------

export interface GalleryEntry {
  id: string;
  // A data: URL for image-gen results, or a served /blobs/… URL for selfies.
  dataUrl: string;
  prompt: string;
  backend: ImageGenBackend | 'selfie';
  timestamp: number;
  // Character a selfie was generated for (selfie entries only) — for gallery
  // attribution. Absent on ordinary image-gen entries.
  character?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'sillytavern_imagegen_config';
const GALLERY_KEY = 'sillytavern_imagegen_gallery';
const SERVER_KEY = 'stm_imagegen_config';
const LOCAL_TS_KEY = makeLocalTsKey(SERVER_KEY);

let _persistEnabled = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(config: ImageGenConfig): void {
  if (!_persistEnabled) return;
  try { markSectionDirty(LOCAL_TS_KEY); } catch { /* ignore */ }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    patchServerKey(
      SERVER_KEY,
      config as unknown as Record<string, unknown>,
      LOCAL_TS_KEY,
    ).catch(() => {});
  }, 300);
}

interface ImageGenConfig {
  backend: ImageGenBackend;
  sdUrl: string;
  sdAuth: string;
  pollinationsModel: string;
  /** Selected AI Horde model (e.g. "Flux.1-Schnell fp8 (Compact)"). */
  hordeModel: string;
  /** Optional Horde API key — empty string falls back to the anonymous key. */
  hordeApiKey: string;
  dalleModel: 'dall-e-3' | 'dall-e-2';
  dalleQuality: 'standard' | 'hd';
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
}

const DEFAULT_CONFIG: ImageGenConfig = {
  backend: 'pollinations',
  sdUrl: 'http://localhost:7860',
  sdAuth: '',
  // 'sana' is what Pollinations' anonymous endpoint actually serves now;
  // older 'flux*' values get silently downgraded but render the same.
  pollinationsModel: 'sana',
  hordeModel: 'stable_diffusion',
  hordeApiKey: '',
  dalleModel: 'dall-e-3',
  dalleQuality: 'standard',
  width: 1024,
  height: 1024,
  steps: 20,
  cfgScale: 7,
};

function loadConfig(): ImageGenConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: ImageGenConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  schedulePersist(config);
}

function loadGallery(): GalleryEntry[] {
  try {
    const stored = localStorage.getItem(GALLERY_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return [];
}

function saveGallery(gallery: GalleryEntry[]) {
  localStorage.setItem(GALLERY_KEY, JSON.stringify(gallery));
}

// ---------------------------------------------------------------------------
// DALL-E size helpers
// ---------------------------------------------------------------------------

const DALLE3_SIZES = ['1024x1024', '1792x1024', '1024x1792'] as const;
const DALLE2_SIZES = ['256x256', '512x512', '1024x1024'] as const;

/** Map arbitrary w/h to the nearest valid DALL-E size string. */
function nearestDalleSize(
  w: number,
  h: number,
  model: 'dall-e-3' | 'dall-e-2'
): string {
  const sizes = model === 'dall-e-3' ? DALLE3_SIZES : DALLE2_SIZES;
  const aspect = w / h;
  let best: string = sizes[0];
  let bestDiff = Infinity;
  for (const s of sizes) {
    const [sw, sh] = s.split('x').map(Number);
    const diff = Math.abs(sw / sh - aspect);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ImageGenState extends ImageGenConfig {
  isGenerating: boolean;
  error: string | null;
  gallery: GalleryEntry[];

  setConfig: (patch: Partial<ImageGenConfig>) => void;
  /**
   * Generate an image and return its data URI, or null on failure.
   *
   * When `opts.freeFallback` is set and the *selected* backend is a free one
   * (Pollinations / AI Horde), a failure of the primary silently retries once
   * with the other free backend before surfacing an error — the flagship
   * Pollinations anonymous endpoint is flaky, so this keeps zero-setup flows
   * (e.g. the character-creator avatar step) from dead-ending. Deliberately
   * scoped to free backends: if the user picked DALL-E or a local SD server we
   * surface that backend's real error instead of silently swapping engines.
   */
  generate: (
    prompt: string,
    negativePrompt?: string,
    opts?: { freeFallback?: boolean },
  ) => Promise<string | null>;
  clearError: () => void;
  addToGallery: (entry: GalleryEntry) => void;
  removeFromGallery: (id: string) => void;
  clearGallery: () => void;

  /**
   * A3.1d — sync the image-gen config (backend choice, model, dims, etc.).
   * The gallery's base64 data URLs are too large for JSONB rows and defer
   * to A3.2's blob storage.
   */
  fetchPrefs: () => Promise<void>;
  /** Wipe this store's state + localStorage keys for the current user (logout/switch). */
  resetUser: () => void;
}

export const useImageGenStore = create<ImageGenState>((set, get) => ({
  ...loadConfig(),
  isGenerating: false,
  error: null,
  gallery: loadGallery(),

  setConfig: (patch) => {
    set((s) => {
      const next = { ...s, ...patch };
      const config: ImageGenConfig = {
        backend: next.backend,
        sdUrl: next.sdUrl,
        sdAuth: next.sdAuth,
        pollinationsModel: next.pollinationsModel,
        hordeModel: next.hordeModel,
        hordeApiKey: next.hordeApiKey,
        dalleModel: next.dalleModel,
        dalleQuality: next.dalleQuality,
        width: next.width,
        height: next.height,
        steps: next.steps,
        cfgScale: next.cfgScale,
      };
      saveConfig(config);
      return next;
    });
  },

  generate: async (prompt, negativePrompt, opts) => {
    const {
      backend, sdUrl, sdAuth, pollinationsModel, hordeModel, hordeApiKey,
      dalleModel, dalleQuality, width, height, steps, cfgScale,
    } = get();
    set({ isGenerating: true, error: null });

    // Dispatch a single generation on a specific backend using the current
    // config. Extracted so the free-fallback path can re-run against the
    // sibling free backend without duplicating the per-backend option maps.
    const runBackend = (b: ImageGenBackend) => {
      if (b === 'sdwebui') {
        return imageGenApi.generateSdWebui({
          url: sdUrl,
          auth: sdAuth || undefined,
          prompt,
          negativePrompt: negativePrompt || undefined,
          width,
          height,
          steps,
          cfgScale,
        });
      }
      if (b === 'horde') {
        return imageGenApi.generateHorde({
          prompt,
          negativePrompt: negativePrompt || undefined,
          model: hordeModel,
          width,
          height,
          steps,
          cfgScale,
          apiKey: hordeApiKey || undefined,
        });
      }
      if (b === 'dalle') {
        const size = nearestDalleSize(width, height, dalleModel);
        return imageGenApi.generateDalle({
          prompt,
          model: dalleModel,
          size,
          quality: dalleQuality,
        });
      }
      return imageGenApi.generatePollinations({
        prompt,
        negativePrompt: negativePrompt || undefined,
        model: pollinationsModel,
        width,
        height,
      });
    };

    // The other free backend to fall back to, or null when the selected
    // backend isn't a free one (DALL-E / SD errors surface as-is).
    const freeFallbackFor = (b: ImageGenBackend): ImageGenBackend | null =>
      b === 'pollinations' ? 'horde' : b === 'horde' ? 'pollinations' : null;

    try {
      let usedBackend = backend;
      let result;
      try {
        result = await runBackend(backend);
      } catch (primaryErr) {
        const fallback = opts?.freeFallback ? freeFallbackFor(backend) : null;
        if (!fallback) throw primaryErr;
        result = await runBackend(fallback);
        usedBackend = fallback;
      }

      const dataUrl = `data:image/${result.format};base64,${result.base64}`;

      // Auto-save to gallery — record the backend that actually produced it.
      const entry: GalleryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl,
        prompt,
        backend: usedBackend,
        timestamp: Date.now(),
      };
      get().addToGallery(entry);

      set({ isGenerating: false });
      return dataUrl;
    } catch (e) {
      set({ isGenerating: false, error: e instanceof Error ? e.message : 'Generation failed' });
      return null;
    }
  },

  clearError: () => set({ error: null }),

  addToGallery: (entry) => {
    set((s) => {
      const gallery = [entry, ...s.gallery];
      saveGallery(gallery);
      return { gallery };
    });
  },

  removeFromGallery: (id) => {
    set((s) => {
      const gallery = s.gallery.filter((e) => e.id !== id);
      saveGallery(gallery);
      return { gallery };
    });
  },

  clearGallery: () => {
    saveGallery([]);
    set({ gallery: [] });
  },

  resetUser: () => {
    _persistEnabled = false;
    set({ ...DEFAULT_CONFIG, gallery: [], isGenerating: false, error: null });
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(GALLERY_KEY); } catch { /* ignore */ }
    clearLocalTs(LOCAL_TS_KEY);
  },

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | (ImageGenConfig & { _ts?: number })
        | undefined;
      const serverTs = Number(stored?._ts || 0);

      const currentConfig = (): ImageGenConfig => {
        const s = get();
        return {
          backend: s.backend,
          sdUrl: s.sdUrl,
          sdAuth: s.sdAuth,
          pollinationsModel: s.pollinationsModel,
          hordeModel: s.hordeModel,
          hordeApiKey: s.hordeApiKey,
          dalleModel: s.dalleModel,
          dalleQuality: s.dalleQuality,
          width: s.width,
          height: s.height,
          steps: s.steps,
          cfgScale: s.cfgScale,
        };
      };

      if (!stored) {
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          currentConfig() as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      if (shouldReuploadSection(LOCAL_TS_KEY, serverTs)) {
        _persistEnabled = true;
        patchServerKey(
          SERVER_KEY,
          currentConfig() as unknown as Record<string, unknown>,
          LOCAL_TS_KEY,
        ).catch(() => {});
        return;
      }

      _persistEnabled = false;
      const merged: ImageGenConfig = { ...DEFAULT_CONFIG, ...stored };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        recordServerTs(LOCAL_TS_KEY, serverTs);
      } catch { /* ignore */ }
      set(merged);
      _persistEnabled = true;
    } catch {
      _persistEnabled = true;
    }
  },
}));
