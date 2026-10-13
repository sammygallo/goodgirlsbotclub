import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Focus containment for modal surfaces, without a dependency (D-G5).
 *
 * While a surface is active the hook:
 *   (a) sets `inert` on everything that is not the surface — every sibling of
 *       the surface's root, and of each of its ancestors up to <body>, so it
 *       works for a portal into <body> (Modal) and for an in-tree surface (the
 *       E6-S3 drawer) alike. Inert content cannot be focused, clicked or read
 *       by a screen reader, which is the whole of the containment: there is no
 *       Tab-key interception to get wrong;
 *   (b) moves focus into the surface — the element marked `data-autofocus`,
 *       else the first focusable one, unless focus is already inside (so a body
 *       that uses `autoFocus` keeps the field it asked for);
 *   (c) on close, or on unmount while open, returns focus to the element that
 *       opened the surface — or, when the surface was opened from inside an
 *       outer surface that has already left, to that outer surface's opener
 *       (the hand-off); if that element is no longer connected, focus is left
 *       where it is;
 *   (d) closes the TOPMOST surface on Escape.
 *
 * Surfaces stack. Only the top one is interactive, and every surface below it
 * is inert too; closing the top makes the one beneath live again. Closing
 * out of order (a lower surface first) keeps the trap on whatever is still
 * open. Because the inert set is rebuilt from the stack on every push and pop,
 * and only ever releases attributes this module itself added, an element that
 * was already inert for some other reason is never un-inerted by us.
 *
 * A branch carrying `data-modal-exempt` is skipped by that walk, and so is
 * everything inside it: the attribute is for controls that must stay operable
 * above an open modal (the toasts, the onboarding chip), and nothing else may
 * use it without review.
 */

export interface UseModalFocusOptions {
  /** True while the surface is open AND mounted (its refs are set). */
  active: boolean;
  /** The surface's outermost element: everything outside its ancestry goes inert. */
  rootRef: RefObject<HTMLElement | null>;
  /** The element that holds focus and is searched for a target. Defaults to the root. */
  dialogRef?: RefObject<HTMLElement | null>;
  /** Called on Escape when this surface is the topmost one. */
  onEscape?: () => void;
}

interface Surface {
  root: HTMLElement;
  /**
   * See (c) in the module docstring. If this surface leaves first, a surface
   * stacked above it takes this opener over only when it is still connected and
   * the upper surface's own opener lies inside this dialog.
   */
  opener: HTMLElement | null;
  /** Read at keydown time, so a fresh inline callback never re-runs activation. */
  onEscape: { current: (() => void) | undefined };
  /** The elements THIS surface made inert, and so the only ones it may release. */
  added: Set<Element>;
}

const stack: Surface[] = [];

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);

export const MODAL_EXEMPT_ATTRIBUTE = 'data-modal-exempt';

const FOCUSABLE = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

function otherBranches(root: HTMLElement): Element[] {
  const out: Element[] = [];
  let node: HTMLElement = root;
  while (node !== document.body) {
    const parent = node.parentElement;
    if (!parent) break;
    for (const child of Array.from(parent.children)) {
      if (child !== node && !SKIP_TAGS.has(child.tagName) && !child.hasAttribute(MODAL_EXEMPT_ATTRIBUTE)) out.push(child);
    }
    node = parent;
  }
  return out;
}

/** Rebuilds the inert set so it reflects the stack as it stands right now. */
function syncInert() {
  for (const surface of stack) {
    for (const el of surface.added) el.removeAttribute('inert');
    surface.added.clear();
  }
  const top = stack[stack.length - 1];
  if (!top) return;
  for (const el of otherBranches(top.root)) {
    // Already inert for someone else's reason: not ours to set, so not ours to release.
    if (el.hasAttribute('inert')) continue;
    el.setAttribute('inert', '');
    top.added.add(el);
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  // Top only: a confirm dialog on top of a panel closes alone, and a second
  // press closes the panel. A top surface with no handler swallows the press
  // rather than letting it fall through to the one beneath.
  stack[stack.length - 1]?.onEscape.current?.();
}

function tabbable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.matches(':disabled') || el.getAttribute('tabindex') === '-1') return false;
    return !el.closest('[inert], [hidden]');
  });
}

function currentFocus(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

export function useModalFocus({ active, rootRef, dialogRef, onEscape }: UseModalFocusOptions) {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  // The opener is read DURING RENDER, on the render where `active` turns true,
  // and not in the activation effect below. By the time any effect runs, the
  // body's own `autoFocus` (applied in React's commit, before passive effects)
  // has already stolen focus into the surface — an effect would record that
  // field as the "opener" and restore focus to something that no longer exists.
  // Render is the last moment focus is still where the user left it.
  const [captured, setCaptured] = useState(() => ({ active, opener: active ? currentFocus() : null }));
  if (captured.active !== active) {
    setCaptured({ active, opener: active ? currentFocus() : null });
  }
  const opener = captured.opener;

  // Where the body put focus itself (an `autoFocus` field) when the surface
  // activated. StrictMode runs the effect, its cleanup and the effect again; the
  // cleanup hands focus back to the opener and React does not apply `autoFocus`
  // a second time, so the second run has to put it back.
  const initialFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) {
      initialFocus.current = null;
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const dialog = dialogRef?.current ?? root;

    const surface: Surface = { root, opener, onEscape: onEscapeRef, added: new Set() };
    stack.push(surface);
    if (stack.length === 1) document.addEventListener('keydown', handleKeyDown);
    syncInert();

    const marked = dialog.querySelector<HTMLElement>('[data-autofocus]');
    if (marked) {
      if (document.activeElement !== marked) marked.focus();
    } else if (dialog.contains(document.activeElement)) {
      if (document.activeElement instanceof HTMLElement) initialFocus.current = document.activeElement;
    } else {
      const remembered = initialFocus.current;
      const target = remembered?.isConnected && dialog.contains(remembered) ? remembered : (tabbable(dialog)[0] ?? dialog);
      target.focus();
    }

    return () => {
      const at = stack.indexOf(surface);
      const wasTop = at === -1 || at === stack.length - 1;
      if (at !== -1) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener('keydown', handleKeyDown);
      // The departing surface is no longer in the stack, so syncInert cannot
      // see what it set: release that here, then re-point the rest. All of this
      // happens BEFORE focus is restored, because an inert element cannot take
      // focus.
      for (const el of surface.added) el.removeAttribute('inert');
      surface.added.clear();
      syncInert();
      // Only the top surface hands focus back. A lower one closing out of order
      // must leave focus with the surface that is still open on top of it.
      if (wasTop) {
        if (surface.opener?.isConnected) surface.opener.focus();
      } else if (surface.opener?.isConnected) {
        // A surface above this one that was opened from inside its dialog (a
        // confirm over a panel) is about to lose its own opener with it. It takes
        // this surface's, so closing it later lands where the user was before
        // either opened. That includes a parent that unmounts both at once,
        // whose cleanup runs while the nested one is still on the stack.
        for (const above of stack.slice(at)) {
          if (above.opener && dialog.contains(above.opener)) above.opener = surface.opener;
        }
      }
    };
  }, [active, rootRef, dialogRef, opener]);
}
