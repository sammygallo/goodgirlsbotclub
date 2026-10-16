/**
 * @vitest-environment jsdom
 *
 * portraitPositionStore's desktop map (D-C8) is an additive field at persist
 * version 1 (D-E6S4-1): an old blob hydrates with an empty desktop map, a new
 * blob stays readable by main's store, and the two maps never write into each
 * other.
 *
 * `localStorage` is an in-memory stub (under Node 25 the global is Node's
 * experimental one, which has no methods); it is installed before the store
 * module loads, because persist binds `window.localStorage` at creation — which
 * is also why this suite needs a DOM environment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() {
      return data.size;
    },
  });
  return data;
});

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { usePortraitPositionStore, type PortraitPosition } from './portraitPositionStore';

const KEY = 'portrait-position';

beforeEach(() => {
  data.clear();
  usePortraitPositionStore.setState({ positionsByAvatar: {}, desktopPositionsByAvatar: {} });
});

describe('persist version 1 (D-E6S4-1)', () => {
  it('a stored blob without desktopPositionsByAvatar hydrates with the mobile map intact and an empty desktop map', async () => {
    data.set(KEY, JSON.stringify({ state: { positionsByAvatar: { 'a.png': { x: 10, y: 20 } } }, version: 1 }));

    await usePortraitPositionStore.persist.rehydrate();

    const state = usePortraitPositionStore.getState();
    expect(state.positionsByAvatar).toEqual({ 'a.png': { x: 10, y: 20 } });
    expect(state.desktopPositionsByAvatar).toEqual({});
    // The actions survive the merge.
    expect(typeof state.setDesktopPosition).toBe('function');
  });

  it('a blob this store writes, desktop map included, is readable by a store configured as on main', async () => {
    usePortraitPositionStore.getState().setPosition('a.png', { x: 10, y: 20 });
    usePortraitPositionStore.getState().setDesktopPosition('a.png', { x: 5, y: 6 });
    expect(JSON.parse(data.get(KEY) as string).state.desktopPositionsByAvatar).toEqual({ 'a.png': { x: 5, y: 6 } });

    // main's store: same name, version 1, no migrate — what a rollback runs.
    const mainStore = create<{ positionsByAvatar: Record<string, PortraitPosition> }>()(
      persist(() => ({ positionsByAvatar: {} }), { name: KEY, version: 1 }),
    );
    await mainStore.persist.rehydrate();

    expect(mainStore.getState().positionsByAvatar).toEqual({ 'a.png': { x: 10, y: 20 } });
  });
});

describe('desktop framing setters', () => {
  it('write only the desktop map and leave the mobile map untouched', () => {
    usePortraitPositionStore.getState().setPosition('a.png', { x: 30, y: 40 });
    const mobileBefore = usePortraitPositionStore.getState().positionsByAvatar;

    usePortraitPositionStore.getState().setDesktopPosition('a.png', { x: 5, y: 6 });
    expect(usePortraitPositionStore.getState().desktopPositionsByAvatar).toEqual({ 'a.png': { x: 5, y: 6 } });
    expect(usePortraitPositionStore.getState().positionsByAvatar).toBe(mobileBefore);

    usePortraitPositionStore.getState().resetDesktopPosition('a.png');
    expect(usePortraitPositionStore.getState().desktopPositionsByAvatar).toEqual({});
    expect(usePortraitPositionStore.getState().positionsByAvatar).toEqual({ 'a.png': { x: 30, y: 40 } });
  });
});
