import { describe, it, expect, vi, beforeEach } from 'vitest';

// E4-S0 / AC4 — `charactersLoaded` is the only thing standing between the
// orphaned-document report and accusing every character-scoped document on a
// cold start. It exists because the two fields next to it cannot answer the
// question: `characters` starts `[]` and `isLoading` starts false, so before
// the first fetch "this account has no characters" and "nobody has asked yet"
// are the same observable state. These pin the three transitions that matter.

// This vitest project runs with `environment: 'node'`, where the global
// `localStorage` exists as an inert object with no working methods — see the
// same note in dataBankStore.documentActivation.test.ts.
const memoryStorage = (() => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
})();
vi.stubGlobal('localStorage', memoryStorage);

vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

const getCharacters = vi.fn();
const fetchOwnership = vi.fn(async () => {});
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getCharacters: (...args: unknown[]) => getCharacters(...args),
    },
  };
});
vi.mock('./characterOwnershipStore', () => ({
  useCharacterOwnershipStore: {
    getState: () => ({ fetchOwnership }),
  },
}));

const { useCharacterStore } = await import('./characterStore');

beforeEach(() => {
  memoryStorage.clear();
  getCharacters.mockReset();
  useCharacterStore.setState({ characters: [], charactersLoaded: false });
});

describe('characterStore.charactersLoaded', () => {
  it('is false before anything has asked for the character list', () => {
    expect(useCharacterStore.getState().charactersLoaded).toBe(false);
  });

  it('rises on a successful fetch that returns NO characters', () => {
    // The case the flag exists for. An account with zero characters looks
    // identical to an un-hydrated store by every other measure, and it is
    // also the account most likely to have stranded character-scoped
    // documents — so "loaded and empty" has to be expressible.
    getCharacters.mockResolvedValue([]);
    return useCharacterStore
      .getState()
      .fetchCharacters()
      .then(() => {
        expect(useCharacterStore.getState().characters).toEqual([]);
        expect(useCharacterStore.getState().charactersLoaded).toBe(true);
      });
  });

  it('stays false when the fetch fails', async () => {
    // A network hiccup at login must never read as "this account has no
    // characters" — that is the shape that would strand-report the user's
    // whole library on one bad request.
    getCharacters.mockRejectedValue(new Error('offline'));
    await useCharacterStore.getState().fetchCharacters();
    expect(useCharacterStore.getState().error).toBeTruthy();
    expect(useCharacterStore.getState().charactersLoaded).toBe(false);
  });

  it('falls back to false on logout', async () => {
    getCharacters.mockResolvedValue([]);
    await useCharacterStore.getState().fetchCharacters();
    expect(useCharacterStore.getState().charactersLoaded).toBe(true);

    useCharacterStore.getState().resetUser();

    // The next account has to earn the flag itself rather than inheriting
    // the previous one's — otherwise the first render after a user switch
    // judges the new account's documents against the old one's characters.
    expect(useCharacterStore.getState().charactersLoaded).toBe(false);
  });
});
