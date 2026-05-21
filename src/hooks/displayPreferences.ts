/**
 * Persistent chat display preferences backed by localStorage.
 *
 * Follows the same pattern as speechLanguage.ts — plain getter/setter
 * functions with `stm:` key prefix, no reactive store needed since the
 * chat view remounts when navigating back from settings.
 */

export type ChatLayoutMode = 'bubbles' | 'flat' | 'document';
export type AvatarShape = 'circle' | 'square' | 'rounded-square';

const LAYOUT_MODE_KEY = 'stm:chat-layout-mode';
const AVATAR_SHAPE_KEY = 'stm:avatar-shape';
const FONT_SIZE_KEY = 'stm:chat-font-size';
const CHAT_WIDTH_KEY = 'stm:chat-max-width';

const VALID_LAYOUTS: ChatLayoutMode[] = ['bubbles', 'flat', 'document'];
const VALID_SHAPES: AvatarShape[] = ['circle', 'square', 'rounded-square'];

// ---- Layout Mode ----------------------------------------------------

export function getChatLayoutMode(): ChatLayoutMode {
  try {
    const v = localStorage.getItem(LAYOUT_MODE_KEY);
    if (v && VALID_LAYOUTS.includes(v as ChatLayoutMode)) return v as ChatLayoutMode;
  } catch { /* ignore */ }
  return 'bubbles';
}

export function setChatLayoutMode(mode: ChatLayoutMode): void {
  try { localStorage.setItem(LAYOUT_MODE_KEY, mode); } catch { /* ignore */ }
}

// ---- Avatar Shape ---------------------------------------------------

export function getAvatarShape(): AvatarShape {
  try {
    const v = localStorage.getItem(AVATAR_SHAPE_KEY);
    if (v && VALID_SHAPES.includes(v as AvatarShape)) return v as AvatarShape;
  } catch { /* ignore */ }
  return 'circle';
}

export function setAvatarShape(shape: AvatarShape): void {
  try { localStorage.setItem(AVATAR_SHAPE_KEY, shape); } catch { /* ignore */ }
}

// ---- Font Size (px) -------------------------------------------------

export function getChatFontSize(): number {
  try {
    const v = localStorage.getItem(FONT_SIZE_KEY);
    if (v) {
      const n = Number(v);
      if (n >= 12 && n <= 20) return n;
    }
  } catch { /* ignore */ }
  return 14;
}

export function setChatFontSize(px: number): void {
  const clamped = Math.max(12, Math.min(20, Math.round(px)));
  try { localStorage.setItem(FONT_SIZE_KEY, String(clamped)); } catch { /* ignore */ }
}

// ---- Chat Max Width (%) ---------------------------------------------

export function getChatMaxWidth(): number {
  try {
    const v = localStorage.getItem(CHAT_WIDTH_KEY);
    if (v) {
      const n = Number(v);
      if (n >= 60 && n <= 100) return n;
    }
  } catch { /* ignore */ }
  return 80;
}

export function setChatMaxWidth(pct: number): void {
  const clamped = Math.max(60, Math.min(100, Math.round(pct)));
  try { localStorage.setItem(CHAT_WIDTH_KEY, String(clamped)); } catch { /* ignore */ }
}

// ---- Visual Novel Mode ----------------------------------------------

const VN_MODE_KEY = 'stm:vn-mode';

export function getVnMode(): boolean {
  try { return localStorage.getItem(VN_MODE_KEY) === 'true'; } catch { return false; }
}

export function setVnMode(on: boolean): void {
  try { localStorage.setItem(VN_MODE_KEY, on ? 'true' : 'false'); } catch { /* ignore */ }
}

// ---- VN Background Image --------------------------------------------
//
// A3.2 — backgrounds live in /blobs/vn-bg/{key} for cross-device sync.
// localStorage stays as a synchronous cache for instant first paint;
// uploadVnBg fires write-through on every set/clear.

function uploadVnBgBlob(key: string, dataUrl: string | undefined): void {
  if (!dataUrl) {
    fetch(`/blobs/vn-bg/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => {});
    return;
  }
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return;
  const contentType = match[1];
  let bytes: Uint8Array;
  try {
    const binary = atob(match[2]);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return;
  }
  fetch(`/blobs/vn-bg/${encodeURIComponent(key)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': contentType },
    body: new Blob([bytes as BlobPart], { type: contentType }),
  }).catch(() => {});
}

/**
 * Fetch a VN background from /blobs/vn-bg/{key}, cache to localStorage, and
 * return the data URL. Called lazily by the chat view when the cached
 * localStorage entry is missing (e.g. first visit on a new device).
 */
export async function fetchVnBgBlob(key: string): Promise<string | null> {
  try {
    const resp = await fetch(`/blobs/vn-bg/${encodeURIComponent(key)}`, {
      credentials: 'include',
    });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const dataUrl: string | null = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    if (dataUrl) {
      try {
        localStorage.setItem(
          key === 'global' ? 'stm:vn-bg-global' : `stm:vn-bg-${key}`,
          dataUrl,
        );
      } catch { /* ignore */ }
    }
    return dataUrl;
  } catch {
    return null;
  }
}

export function getVnBgForCharacter(avatar: string): string | null {
  try { return localStorage.getItem(`stm:vn-bg-${avatar}`); } catch { return null; }
}

export function setVnBgForCharacter(avatar: string, dataUrl: string): void {
  try { localStorage.setItem(`stm:vn-bg-${avatar}`, dataUrl); } catch { /* ignore */ }
  uploadVnBgBlob(avatar, dataUrl);
}

export function clearVnBgForCharacter(avatar: string): void {
  try { localStorage.removeItem(`stm:vn-bg-${avatar}`); } catch { /* ignore */ }
  uploadVnBgBlob(avatar, undefined);
}

export function getVnBgGlobal(): string | null {
  try { return localStorage.getItem('stm:vn-bg-global'); } catch { return null; }
}

export function setVnBgGlobal(dataUrl: string): void {
  try { localStorage.setItem('stm:vn-bg-global', dataUrl); } catch { /* ignore */ }
  uploadVnBgBlob('global', dataUrl);
}

export function clearVnBgGlobal(): void {
  try { localStorage.removeItem('stm:vn-bg-global'); } catch { /* ignore */ }
  uploadVnBgBlob('global', undefined);
}

// ---- Standardize Message Formatting ---------------------------------

const STANDARDIZE_FMT_KEY = 'stm:standardize-message-formatting';

export function getStandardizeMessageFormatting(): boolean {
  try {
    const v = localStorage.getItem(STANDARDIZE_FMT_KEY);
    if (v === null) return true;
    return v === 'true';
  } catch {
    return true;
  }
}

export function setStandardizeMessageFormatting(on: boolean): void {
  try { localStorage.setItem(STANDARDIZE_FMT_KEY, on ? 'true' : 'false'); } catch { /* ignore */ }
}

// ---- Enter Key Send Behavior ----------------------------------------

export type EnterToSendMode = 'auto' | 'always' | 'never';

const ENTER_TO_SEND_KEY = 'stm:enter-to-send-mode';
const VALID_ENTER_MODES: EnterToSendMode[] = ['auto', 'always', 'never'];

export function getEnterToSendMode(): EnterToSendMode {
  try {
    const v = localStorage.getItem(ENTER_TO_SEND_KEY);
    if (v && VALID_ENTER_MODES.includes(v as EnterToSendMode)) return v as EnterToSendMode;
  } catch { /* ignore */ }
  return 'auto';
}

export function setEnterToSendMode(mode: EnterToSendMode): void {
  try { localStorage.setItem(ENTER_TO_SEND_KEY, mode); } catch { /* ignore */ }
}

// ---- Sprite Costume -------------------------------------------------

export function getCostume(avatar: string): string | null {
  try { return localStorage.getItem(`stm:costume-${avatar}`); } catch { return null; }
}

export function setCostume(avatar: string, name: string): void {
  try { localStorage.setItem(`stm:costume-${avatar}`, name); } catch { /* ignore */ }
}

export function clearCostume(avatar: string): void {
  try { localStorage.removeItem(`stm:costume-${avatar}`); } catch { /* ignore */ }
}
