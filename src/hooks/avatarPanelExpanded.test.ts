/**
 * @vitest-environment jsdom
 *
 * `stm:chat-avatar-panel-expanded` (§5.3 Collapse): expanded by default, only
 * the exact string "false" collapses, and a storage that throws still leaves a
 * working toggle.
 *
 * Each test installs its own in-memory `localStorage`: under Node 25 the global
 * is Node's experimental one, which jsdom does not replace and which has no methods.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearAllAppStorage } from '../utils/serverSettings';
import {
  AVATAR_PANEL_EXPANDED_KEY,
  readAvatarPanelExpanded,
  useAvatarPanelExpanded,
} from './avatarPanelExpanded';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
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
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readAvatarPanelExpanded', () => {
  it('defaults to expanded', () => {
    expect(readAvatarPanelExpanded()).toBe(true);
  });

  it('is collapsed only by the exact string "false"', () => {
    storage.setItem(AVATAR_PANEL_EXPANDED_KEY, 'false');
    expect(readAvatarPanelExpanded()).toBe(false);
    for (const value of ['true', 'FALSE', '0', '', '{"x":1}', 'null']) {
      storage.setItem(AVATAR_PANEL_EXPANDED_KEY, value);
      expect(readAvatarPanelExpanded()).toBe(true);
    }
  });
});

describe('useAvatarPanelExpanded', () => {
  it('writes each toggle and a new mount reads it back', () => {
    const first = renderHook(() => useAvatarPanelExpanded());
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    expect(storage.getItem(AVATAR_PANEL_EXPANDED_KEY)).toBe('false');
    first.unmount();

    const second = renderHook(() => useAvatarPanelExpanded());
    expect(second.result.current[0]).toBe(false);
    act(() => second.result.current[1](true));
    expect(storage.getItem(AVATAR_PANEL_EXPANDED_KEY)).toBe('true');
  });

  it('falls back to expanded and still toggles when storage throws', () => {
    const throwing = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: throwing, setItem: throwing, removeItem: throwing });
    const { result } = renderHook(() => useAvatarPanelExpanded());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });
});

it('is removed with the rest of the app keyspace on logout', () => {
  storage.setItem(AVATAR_PANEL_EXPANDED_KEY, 'false');
  clearAllAppStorage();
  expect(storage.getItem(AVATAR_PANEL_EXPANDED_KEY)).toBeNull();
});
