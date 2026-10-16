/**
 * @vitest-environment jsdom
 *
 * portraitPositionStore's persist bump from version 1 to 2 (D-C8): the migrate
 * keeps users' mobile framing and adds an empty desktop map, and the two maps
 * never write into each other.
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

import {
  migratePortraitPositionState,
  usePortraitPositionStore,
} from './portraitPositionStore';

const KEY = 'portrait-position';

beforeEach(() => {
  data.clear();
  usePortraitPositionStore.setState({ positionsByAvatar: {}, desktopPositionsByAvatar: {} });
});

describe('migratePortraitPositionState', () => {
  it('keeps a version-1 mobile map exactly and adds an empty desktop map', () => {
    const v1 = { positionsByAvatar: { 'a.png': { x: 10, y: 20 }, 'b.png': { x: 0, y: 100 } } };
    expect(migratePortraitPositionState(v1, 1)).toEqual({
      positionsByAvatar: { 'a.png': { x: 10, y: 20 }, 'b.png': { x: 0, y: 100 } },
      desktopPositionsByAvatar: {},
    });
  });

  it('degrades anything that is not an object to empty maps instead of throwing', () => {
    for (const bad of [null, undefined, 'x', 42, [], { positionsByAvatar: 'nope' }, { positionsByAvatar: [1] }]) {
      expect(migratePortraitPositionState(bad, 1)).toEqual({
        positionsByAvatar: {},
        desktopPositionsByAvatar: {},
      });
    }
  });

  it('tolerates a version-0 blob the same way', () => {
    expect(migratePortraitPositionState({ positionsByAvatar: { 'a.png': { x: 1, y: 2 } } }, 0)).toEqual({
      positionsByAvatar: { 'a.png': { x: 1, y: 2 } },
      desktopPositionsByAvatar: {},
    });
  });
});

describe('rehydrating a stored version-1 blob', () => {
  it('loads the mobile map, adds the desktop map, and rewrites the key as version 2', async () => {
    data.set(KEY, JSON.stringify({ state: { positionsByAvatar: { 'a.png': { x: 10, y: 20 } } }, version: 1 }));

    await usePortraitPositionStore.persist.rehydrate();

    const state = usePortraitPositionStore.getState();
    expect(state.positionsByAvatar).toEqual({ 'a.png': { x: 10, y: 20 } });
    expect(state.desktopPositionsByAvatar).toEqual({});
    // The actions survive the merge.
    expect(typeof state.setDesktopPosition).toBe('function');

    const stored = JSON.parse(data.get(KEY) as string);
    expect(stored.version).toBe(2);
    expect(stored.state.positionsByAvatar).toEqual({ 'a.png': { x: 10, y: 20 } });
    expect(stored.state.desktopPositionsByAvatar).toEqual({});
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
