/**
 * Contract tests for the Live Portrait clip-generation client — pins the
 * server-403 avatar-provenance detail message verbatim. The frontend's
 * provenance check (LivePortraitSetup's `provenanceBlocked`) is advisory
 * only; the backend re-hashes the live avatar bytes and is the real
 * enforcement, so its 403 detail text is what users actually see when a
 * cleared-looking row still gets rejected — it must render unmodified, not
 * get swallowed by a generic fallback. Also pins the 422 Pydantic
 * validation-array case (same "[object Object]" lesson already covered for
 * selfieGen.ts/loraTraining.ts's own errorMessage() helper — this is
 * livePortraitGen.ts's copy of the same guard, previously untested).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGenerate } from './livePortraitGen';

// getCsrfToken would otherwise fetch /csrf-token — mock it so the ONLY fetch
// traffic in these tests is livePortraitGen's own.
vi.mock('./client', () => ({ getCsrfToken: async () => 'csrf-test-token' }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('startGenerate error contract', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the exact server-403 detail on an uncleared avatar', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Avatar is not cleared for generation' }, false, 403),
    );
    await expect(startGenerate('Ivy', ['happy'])).rejects.toThrow(
      new Error('Avatar is not cleared for generation'),
    );
  });

  it('renders a readable message when detail is a 422 validation array, never "[object Object]"', async () => {
    // Pydantic validation failures put an ARRAY of error objects in `detail`;
    // `new Error(array)` would otherwise stringify to "[object Object]".
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { detail: [{ loc: ['body', 'x'], msg: 'field required' }] },
        false,
        422,
      ),
    );
    await expect(startGenerate('Ivy', ['happy'])).rejects.toThrow(
      new Error('Generation kickoff failed (HTTP 422)'),
    );
  });
});
