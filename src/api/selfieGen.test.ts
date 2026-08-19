/**
 * Contract tests for the selfie generation client — pins the exact POST body
 * the backend's SelfieGenerateIn expects (field names `characterName` /
 * `prompt` / `tier` / `mode`), and that omitting mode/tier sends the
 * backward-compatible defaults. This is the client↔backend-contract seam the
 * adversarial-review memory flags as the highest-defect zone, so the wire
 * shape gets pinned here rather than trusted to review alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSelfie } from './selfieGen';

// getCsrfToken would otherwise fetch /csrf-token — mock it so the ONLY fetch
// traffic in these tests is selfieGen's own.
vi.mock('./client', () => ({ getCsrfToken: async () => 'csrf-test-token' }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('generateSelfie request contract', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Queue a successful kickoff + a completed first poll. */
  function queueHappyPath() {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobId: 'sf_123_abc' }))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'completed', imageUrl: '/blobs/selfie/x/1.png', error: null }),
      );
  }

  async function runToCompletion(promise: Promise<string>) {
    // generateSelfie sleeps POLL_INTERVAL_MS (3s) before its first poll.
    await vi.advanceTimersByTimeAsync(3000);
    return promise;
  }

  it('sends mode "scene" and the scene prompt in the POST body', async () => {
    queueHappyPath();
    const url = await runToCompletion(
      generateSelfie('Ivy', 'full-body mirror selfie in her penthouse', 'sfw', 'scene'),
    );
    expect(url).toBe('/blobs/selfie/x/1.png');

    const [kickoffUrl, kickoffInit] = fetchMock.mock.calls[0];
    expect(kickoffUrl).toBe('/api/selfie/generate');
    expect(JSON.parse((kickoffInit as RequestInit).body as string)).toEqual({
      characterName: 'Ivy',
      prompt: 'full-body mirror selfie in her penthouse',
      tier: 'sfw',
      mode: 'scene',
    });
  });

  it('defaults to tier "sfw" and mode "closeup" when omitted (auto-trigger shape)', async () => {
    queueHappyPath();
    await runToCompletion(generateSelfie('Ivy', 'playful smirk'));

    const [, kickoffInit] = fetchMock.mock.calls[0];
    expect(JSON.parse((kickoffInit as RequestInit).body as string)).toEqual({
      characterName: 'Ivy',
      prompt: 'playful smirk',
      tier: 'sfw',
      mode: 'closeup',
    });
  });

  it('surfaces the backend detail message on a kickoff 400', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'No fal.ai API key configured. Add it in AI Settings.' }, false, 400),
    );
    await expect(
      generateSelfie('Ivy', 'on the beach', 'sfw', 'scene'),
    ).rejects.toThrow('No fal.ai API key configured. Add it in AI Settings.');
  });

  it('renders a readable message when detail is a 422 validation array', async () => {
    // Pydantic validation failures (e.g. a >400-char prompt) put an ARRAY in
    // detail — that must fall through to the generic message, never
    // "[object Object]" (2026-08-19 review).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: [{ type: 'string_too_long', loc: ['body', 'prompt'] }] }, false, 422),
    );
    await expect(
      generateSelfie('Ivy', 'x'.repeat(500), 'sfw', 'scene'),
    ).rejects.toThrow('Selfie generation kickoff failed (HTTP 422)');
  });
});
