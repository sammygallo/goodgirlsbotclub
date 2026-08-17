/**
 * Persistent chat display preferences backed by localStorage.
 *
 * Follows the same pattern as speechLanguage.ts — plain getter/setter
 * functions with `stm:` key prefix. Most of these are re-read fresh on every
 * render (e.g. getChatLayoutMode() at the top of ChatView), so staleness
 * isn't a concern. VN mode is the exception: it's mirrored into
 * displayPreferencesStore precisely so consumers can subscribe reactively
 * instead of caching a read in local state, which goes stale — ChatView
 * does NOT remount when Settings (an overlay, not a route change) toggles it.
 */

export type ChatLayoutMode = 'bubbles' | 'flat' | 'document';
export type AvatarShape = 'circle' | 'square' | 'rounded-square';
// 'default' preserves each layout's own baseline size (bubbles=md, flat=sm)
// so shipping this setting doesn't silently resize anyone's existing chat —
// it only takes effect once a user explicitly picks a size.
export type AvatarSize = 'default' | 'sm' | 'md' | 'lg' | 'xl';

const LAYOUT_MODE_KEY = 'stm:chat-layout-mode';
const AVATAR_SHAPE_KEY = 'stm:avatar-shape';
const AVATAR_SIZE_KEY = 'stm:avatar-size';
const FONT_SIZE_KEY = 'stm:chat-font-size';
const CHAT_WIDTH_KEY = 'stm:chat-max-width';

const VALID_LAYOUTS: ChatLayoutMode[] = ['bubbles', 'flat', 'document'];
const VALID_SHAPES: AvatarShape[] = ['circle', 'square', 'rounded-square'];
const VALID_SIZES: AvatarSize[] = ['default', 'sm', 'md', 'lg', 'xl'];

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

// ---- Avatar Size ------------------------------------------------------

export function getAvatarSize(): AvatarSize {
  try {
    const v = localStorage.getItem(AVATAR_SIZE_KEY);
    if (v && VALID_SIZES.includes(v as AvatarSize)) return v as AvatarSize;
  } catch { /* ignore */ }
  return 'default';
}

export function setAvatarSize(size: AvatarSize): void {
  try { localStorage.setItem(AVATAR_SIZE_KEY, size); } catch { /* ignore */ }
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
// Backgrounds are stored in localStorage and are device-local: one set on
// one device does not appear on another. uploadVnBgBlob still write-throughs
// a copy to /blobs/vn-bg on every set/clear, but nothing reads it back, so
// it does not currently provide cross-device restore (out of scope — #286).

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
