import { create } from 'zustand';
import { imageGenApi, type ImageGenBackend } from '../api/imageGenApi';
import { getSettingsBlob, makeLocalTsKey, patchServerKey } from '../utils/serverSettings';

// ---------------------------------------------------------------------------
// Gallery entry — persisted alongside config
// ---------------------------------------------------------------------------

export interface GalleryEntry {
  id: string;
  dataUrl: string;
  prompt: string;
  backend: ImageGenBackend;
  timestamp: number;
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
  try { localStorage.setItem(LOCAL_TS_KEY, String(Date.now())); } catch { /* ignore */ }
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
  /** Generate an image and return its data URI, or null on failure. */
  generate: (prompt: string, negativePrompt?: string) => Promise<string | null>;
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

  generate: async (prompt, negativePrompt) => {
    const {
      backend, sdUrl, sdAuth, pollinationsModel, hordeModel, hordeApiKey,
      dalleModel, dalleQuality, width, height, steps, cfgScale,
    } = get();
    set({ isGenerating: true, error: null });
    try {
      let result;
      if (backend === 'sdwebui') {
        result = await imageGenApi.generateSdWebui({
          url: sdUrl,
          auth: sdAuth || undefined,
          prompt,
          negativePrompt: negativePrompt || undefined,
          width,
          height,
          steps,
          cfgScale,
        });
      } else if (backend === 'horde') {
        result = await imageGenApi.generateHorde({
          prompt,
          negativePrompt: negativePrompt || undefined,
          model: hordeModel,
          width,
          height,
          steps,
          cfgScale,
          apiKey: hordeApiKey || undefined,
        });
      } else if (backend === 'dalle') {
        const size = nearestDalleSize(width, height, dalleModel);
        result = await imageGenApi.generateDalle({
          prompt,
          model: dalleModel,
          size,
          quality: dalleQuality,
        });
      } else {
        result = await imageGenApi.generatePollinations({
          prompt,
          negativePrompt: negativePrompt || undefined,
          model: pollinationsModel,
          width,
          height,
        });
      }

      const dataUrl = `data:image/${result.format};base64,${result.base64}`;

      // Auto-save to gallery
      const entry: GalleryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl,
        prompt,
        backend,
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

  fetchPrefs: async () => {
    try {
      const settings = await getSettingsBlob();
      const stored = settings[SERVER_KEY] as
        | (ImageGenConfig & { _ts?: number })
        | undefined;
      const localTs = Number(localStorage.getItem(LOCAL_TS_KEY) || 0);
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

      if (localTs > serverTs) {
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
        localStorage.setItem(LOCAL_TS_KEY, String(serverTs));
      } catch { /* ignore */ }
      set(merged);
      _persistEnabled = true;
    } catch {
      _persistEnabled = true;
    }
  },
}));
