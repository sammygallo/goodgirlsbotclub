/**
 * @vitest-environment jsdom
 *
 * `stm:sidebar-sections` (D-G7, D-S16): the defaults, the round trip, and a
 * reader that survives whatever is in the key — corrupt JSON, the wrong shape,
 * wrong-typed values, a `__proto__` key — and a storage that throws.
 *
 * Each test installs its own in-memory `localStorage`: under Node 25 the global
 * is Node's experimental one, which jsdom does not replace and which has no methods.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearAllAppStorage } from '../../../utils/serverSettings';
import { SIDEBAR_SECTIONS_KEY, readSections, useSidebarSections, writeSections } from './sidebarSections';

const DEFAULTS = { characters: true, groups: false, works: true, personal: true };

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readSections', () => {
  it('uses the D-G7 key', () => {
    expect(SIDEBAR_SECTIONS_KEY).toBe('stm:sidebar-sections');
  });

  it('gives the D-G7 defaults when nothing is stored', () => {
    expect(readSections()).toEqual(DEFAULTS);
  });

  it('round-trips what writeSections stored', () => {
    const chosen = { characters: false, groups: true, works: false, personal: false };
    writeSections(chosen);
    expect(readSections()).toEqual(chosen);
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['an array', '[true,false,true,true]'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"characters"'],
    ['a boolean', 'true'],
  ])('gives the defaults for %s', (_label, raw) => {
    storage.setItem(SIDEBAR_SECTIONS_KEY, raw);
    expect(readSections()).toEqual(DEFAULTS);
  });

  it('falls back to the default for a wrong-typed value, and for that key only', () => {
    storage.setItem(
      SIDEBAR_SECTIONS_KEY,
      JSON.stringify({ characters: 'no', groups: true, works: 0, personal: null }),
    );
    expect(readSections()).toEqual({ characters: true, groups: true, works: true, personal: true });
  });

  it('fills in the keys a partial object leaves out', () => {
    storage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify({ works: false }));
    expect(readSections()).toEqual({ characters: true, groups: false, works: false, personal: true });
  });

  it('returns exactly the four known keys, ignoring anything else stored', () => {
    storage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify({ characters: false, extra: 1, nested: { a: 1 } }));
    const sections = readSections();
    expect(Object.keys(sections).sort()).toEqual(['characters', 'groups', 'personal', 'works']);
    expect(sections.characters).toBe(false);
  });

  it('does not let a __proto__ key reach the result or Object.prototype', () => {
    storage.setItem(SIDEBAR_SECTIONS_KEY, '{"__proto__":{"polluted":true},"characters":false}');
    const sections = readSections();
    expect(sections.characters).toBe(false);
    expect(Object.getPrototypeOf(sections)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((sections as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns the defaults, without throwing, when reading the storage throws', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(readSections()).toEqual(DEFAULTS);
  });
});

describe('writeSections', () => {
  it('does not throw when writing the storage throws', () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => writeSections(DEFAULTS)).not.toThrow();
  });
});

describe('useSidebarSections', () => {
  it('starts from the stored value', () => {
    writeSections({ characters: true, groups: true, works: true, personal: false });
    const { result } = renderHook(() => useSidebarSections());
    expect(result.current.sections).toEqual({ characters: true, groups: true, works: true, personal: false });
  });

  it('toggle flips one section, persists it, and leaves the others', () => {
    const { result } = renderHook(() => useSidebarSections());
    act(() => result.current.toggle('works'));

    expect(result.current.sections).toEqual({ characters: true, groups: false, works: false, personal: true });
    expect(JSON.parse(storage.getItem(SIDEBAR_SECTIONS_KEY) ?? 'null')).toEqual(result.current.sections);
  });

  it('toggles back on a second call', () => {
    const { result } = renderHook(() => useSidebarSections());
    act(() => result.current.toggle('groups'));
    act(() => result.current.toggle('groups'));
    expect(result.current.sections.groups).toBe(false);
  });

  it('still flips the section for this session when the storage refuses the write', () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const { result } = renderHook(() => useSidebarSections());
    act(() => result.current.toggle('personal'));
    expect(result.current.sections.personal).toBe(false);
  });
});

describe('logout isolation', () => {
  it('clearAllAppStorage removes the key', () => {
    writeSections({ characters: false, groups: false, works: false, personal: false });
    expect(storage.getItem(SIDEBAR_SECTIONS_KEY)).not.toBeNull();

    clearAllAppStorage();
    expect(storage.getItem(SIDEBAR_SECTIONS_KEY)).toBeNull();
  });
});
