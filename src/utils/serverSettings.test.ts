import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiRequestMock = vi.fn();

vi.mock('../api/client', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  putSection: vi.fn(),
  SectionConflictError: class SectionConflictError extends Error {},
}));

const { getSettingsBlob } = await import('./serverSettings');

beforeEach(() => {
  // maybeImportFromST's localStorage sentinel doesn't reliably work in
  // this test environment (Node's localStorage global here throws on
  // .setItem), so it runs its full existence-check-then-maybe-ST-import
  // flow on every call regardless — that's fine, it's not what these
  // tests are about. Every call in that flow hits apiRequestMock; resolve
  // /sync/sections to an empty map by default and let the (harmless,
  // caught) ST-proxy call reject.
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/sync/sections') return {};
    throw new Error(`no import source in tests: ${endpoint}`);
  });
});

describe('getSettingsBlob — Phase 3.3 memoization', () => {
  it('does not multiply network calls when callers overlap in time', async () => {
    await Promise.all([getSettingsBlob(), getSettingsBlob(), getSettingsBlob()]);
    const callsForABurstOfThree = apiRequestMock.mock.calls.length;

    apiRequestMock.mockClear();
    await getSettingsBlob();
    const callsForOneCall = apiRequestMock.mock.calls.length;

    expect(callsForABurstOfThree).toBe(callsForOneCall);
    expect(callsForABurstOfThree).toBeGreaterThan(0);
  });

  it('issues a fresh network fetch for a call made after the previous one settled', async () => {
    await getSettingsBlob();
    const callsAfterFirst = apiRequestMock.mock.calls.length;

    await getSettingsBlob();
    const callsAfterSecond = apiRequestMock.mock.calls.length;

    // Not memoized across settled calls — a "short-lived" shared promise
    // only dedupes callers that overlap in time, per the module comment.
    expect(callsAfterSecond).toBeGreaterThan(callsAfterFirst);
  });

  it('clears the in-flight promise on failure too, so the next call is not stuck reusing it', async () => {
    apiRequestMock.mockImplementation(async () => {
      throw new Error('network blip');
    });
    const failed = await getSettingsBlob();
    expect(failed).toEqual({}); // fetchSettingsBlob swallows the /sync/sections failure itself

    let secondCallSawSections = false;
    apiRequestMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/sync/sections') {
        secondCallSawSections = true;
        return {};
      }
      throw new Error('no import source in tests');
    });
    await getSettingsBlob();
    expect(secondCallSawSections).toBe(true);
  });

  it('carries section data (including server_ts) through the memoized path unchanged', async () => {
    apiRequestMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/sync/sections') {
        return {
          stm_theme: { section: 'stm_theme', data: { mode: 'dark' }, server_ts: 7, updated_at: '' },
        };
      }
      throw new Error('no import source in tests');
    });
    const blob = await getSettingsBlob();
    expect(blob).toEqual({ stm_theme: { mode: 'dark', _ts: 7 } });
  });
});
