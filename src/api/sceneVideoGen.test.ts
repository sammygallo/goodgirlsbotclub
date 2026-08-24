/**
 * Contract tests for the scene-video generation client's error parsing.
 * Before 2026-08-24 this module threw `err.detail || err.error || fallback`
 * directly — unlike livePortraitGen.ts/selfieGen.ts/loraTraining.ts, which
 * all guard against FastAPI's 422 Pydantic validation shape (an ARRAY in
 * `detail`, which `new Error(array)` stringifies to "[object Object]" in the
 * toast). This pins the now-guarded behavior at both error sites: a string
 * detail still passes through verbatim, and an array detail falls back to
 * the generic HTTP-status message instead of "[object Object]".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSceneGenerate, pollSceneJob } from './sceneVideoGen';

// getCsrfToken would otherwise fetch /csrf-token — mock it so the ONLY fetch
// traffic in these tests is sceneVideoGen's own.
vi.mock('./client', () => ({ getCsrfToken: async () => 'csrf-test-token' }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('sceneVideoGen error contract', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('startSceneGenerate (kickoff)', () => {
    it('passes a string detail through verbatim', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: 'Avatar is not cleared for generation' }, false, 403),
      );
      await expect(startSceneGenerate('Ivy', 'a walk in the park')).rejects.toThrow(
        new Error('Avatar is not cleared for generation'),
      );
    });

    it('falls back to the generic HTTP message when detail is a 422 validation array', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { detail: [{ loc: ['body', 'prompt'], msg: 'field required' }] },
          false,
          422,
        ),
      );
      await expect(startSceneGenerate('Ivy', 'a walk in the park')).rejects.toThrow(
        new Error('Scene generation kickoff failed (HTTP 422)'),
      );
    });
  });

  describe('pollSceneJob (status)', () => {
    it('passes a string detail through verbatim', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: 'Job not found' }, false, 404),
      );
      await expect(pollSceneJob('job_123')).rejects.toThrow(
        new Error('Job not found'),
      );
    });

    it('falls back to the generic HTTP message when detail is a 422 validation array', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { detail: [{ loc: ['path', 'jobId'], msg: 'invalid format' }] },
          false,
          422,
        ),
      );
      await expect(pollSceneJob('job_123')).rejects.toThrow(
        new Error('Status poll failed (HTTP 422)'),
      );
    });
  });
});
