/**
 * @vitest-environment jsdom
 *
 * useModalFocus driven directly, over DOM the test builds by hand. Modal.test.tsx
 * covers the hook through Modal, whose root is always a direct child of <body>,
 * so the walk up through ancestors only ever ran one level there. The E6-S3
 * drawer is an in-tree surface, and these pin what the hook's docstring promises
 * it: every sibling at every level between the surface and <body> is made inert.
 *
 * jsdom does not implement `inert` (it ignores the attribute), so containment is
 * asserted on the attribute; the real-browser behaviour is QA's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useModalFocus } from './useModalFocus';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function add(tag: string, id: string, parent: HTMLElement): HTMLElement {
  const node = document.createElement(tag);
  node.id = id;
  parent.appendChild(node);
  return node;
}

/** Mounts the hook on a surface that already sits in the document, inactive until `rerender({ active: true })`. */
function mountOn(surface: HTMLElement, active = true) {
  const rootRef = { current: surface };
  return renderHook(({ active: on }) => useModalFocus({ active: on, rootRef }), { initialProps: { active } });
}

const inert = (el: Element) => el.hasAttribute('inert');

describe('the inert walk over an in-tree surface', () => {
  /**
   * body
   *   #app
   *     header            sibling of #shell
   *     #shell
   *       main            sibling of the surface
   *       aside#surface   <- the surface
   *       footer          sibling of the surface
   *     nav               sibling of #shell
   *   #portal-host        sibling of #app
   */
  function build() {
    const app = add('div', 'app', document.body);
    const header = add('header', 'header', app);
    const shell = add('div', 'shell', app);
    const main = add('main', 'main', shell);
    const surface = add('aside', 'surface', shell);
    const footer = add('footer', 'footer', shell);
    const nav = add('nav', 'nav', app);
    const host = add('div', 'portal-host', document.body);
    return { app, shell, surface, siblings: [header, nav, main, footer, host] };
  }

  it('makes every sibling at every level inert, and none of the surface\'s ancestors', () => {
    const { app, shell, surface, siblings } = build();
    mountOn(surface);

    for (const el of siblings) expect(inert(el), `#${el.id} should be inert`).toBe(true);
    for (const el of [app, shell, surface]) expect(inert(el), `#${el.id} should stay live`).toBe(false);
  });

  it('releases every one of them when the surface goes inactive', () => {
    const { surface, siblings } = build();
    const { rerender } = mountOn(surface);
    rerender({ active: false });

    for (const el of siblings) expect(inert(el), `#${el.id} should be released`).toBe(false);
  });

  it('releases every one of them when the surface unmounts while active', () => {
    const { surface, siblings } = build();
    const { unmount } = mountOn(surface);
    unmount();

    for (const el of siblings) expect(inert(el), `#${el.id} should be released`).toBe(false);
  });

  it('does not touch a sibling that was already inert for another reason, at any level', () => {
    const { surface, siblings } = build();
    const [header] = siblings;
    header.setAttribute('inert', '');
    const { rerender } = mountOn(surface);
    rerender({ active: false });

    expect(inert(header)).toBe(true);
  });
});
