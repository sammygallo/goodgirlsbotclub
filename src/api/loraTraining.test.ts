/**
 * Contract tests for the Studio-tier training client — pins the exact wire
 * shapes the backend's lora_training router expects/returns (the
 * client↔backend-contract seam the adversarial-review memory flags as the
 * highest-defect zone), including the 409 duplicate-spend surface and the
 * 422-array error rendering (the Phase A "[object Object]" lesson).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteLoraTraining,
  fetchLoraStatus,
  startLoraTraining,
} from './loraTraining';

vi.mock('./client', () => ({ getCsrfToken: async () => 'csrf-test-token' }));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('loraTraining client contract', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the train kickoff with the exact body and CSRF header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'pending' }));
    await startLoraTraining('Mina Hope');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/selfie/lora/train');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('include');
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ 'X-CSRF-Token': 'csrf-test-token' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      characterName: 'Mina Hope',
    });
  });

  it('surfaces the 409 already-in-progress message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { detail: 'A training for this character is already in progress.' },
        false,
        409,
      ),
    );
    await expect(startLoraTraining('Mina Hope')).rejects.toThrow(
      'A training for this character is already in progress.',
    );
  });

  it('renders a readable message when detail is a 422 validation array', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: [{ type: 'string_too_short' }] }, false, 422),
    );
    await expect(startLoraTraining('')).rejects.toThrow(
      'Training kickoff failed (HTTP 422)',
    );
  });

  it('fetches character-keyed status with URL encoding', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 'training', error: null, updatedAt: '2026-08-20T01:00:00' }),
    );
    const status = await fetchLoraStatus('Mina Hope');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/selfie/lora/status/Mina%20Hope');
    expect(status).toEqual({
      status: 'training',
      error: null,
      updatedAt: '2026-08-20T01:00:00',
    });
  });

  it('passes through the "none" never-trained status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 'none', error: null, updatedAt: null }),
    );
    const status = await fetchLoraStatus('Ivy');
    expect(status.status).toBe('none');
  });

  it('sends steps in the kickoff body only when provided (Phase C3)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'pending' }));
    await startLoraTraining('Mina Hope', 500);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      characterName: 'Mina Hope',
      steps: 500,
    });
    // The no-steps body shape is pinned by the first test in this file.
  });

  it('DELETEs the training with CSRF and returns the report (Phase C3)', async () => {
    const report = {
      deletedRows: 2,
      blobsDeleted: 3,
      providerPayloadsDeleted: 1,
      providerPayloadsUnauthorized: 1,
      providerPayloadsFailed: 0,
      unresolvedRequestIds: ['req_b'],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(report));
    const result = await deleteLoraTraining('Mina Hope');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/selfie/lora/Mina%20Hope');
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).credentials).toBe('include');
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ 'X-CSRF-Token': 'csrf-test-token' });
    expect(result).toEqual(report);
  });

  it('surfaces the delete 409 while a training is in flight', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { detail: 'A training for this character is currently in progress — wait for it to finish (or fail) before deleting.' },
        false,
        409,
      ),
    );
    await expect(deleteLoraTraining('Mina Hope')).rejects.toThrow(
      /currently in progress/,
    );
  });
});
