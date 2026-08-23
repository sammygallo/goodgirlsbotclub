/**
 * Wire-contract tests for the Phase 3 avatar content binding: whenever
 * createCharacter/editCharacter save with an avatarFile, the character
 * POST/PUT must carry `avatar_sha256` — the lowercase-hex sha256 of the EXACT
 * bytes putAvatarBlob uploads — alongside `avatar_provenance_source`, and must
 * omit it on avatarless saves. The backend pins this hash on cleared rows and
 * every generation path re-hashes the live blob against it (the byte-swap
 * NCII fix), so a drifted field name or encoding here silently bricks selfie
 * clearance for every new avatar — the classic client↔backend-contract seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

const AVATAR_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
// Precomputed OUT-OF-BAND (python hashlib) so the expectation can't share a
// bug with the client's own crypto.subtle implementation:
//   sha256(89504e4701020304) — a fixed constant for fixed bytes.
const AVATAR_SHA = 'cc1cdcbcf0bdb70801a2f0777e9f9c85571461df7f96d1d3f1476f420df37e38';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('avatar_sha256 wire contract (Phase 3 content binding)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/csrf-token') return jsonResponse({ token: 'csrf-test' });
      if (url === '/characters' && init?.method === 'POST') {
        return jsonResponse({ avatar: 'Ivy.png', name: 'Ivy', data: {} });
      }
      if (url.startsWith('/characters/') && init?.method === 'PUT') {
        return jsonResponse({ avatar: 'Ivy.png', name: 'Ivy', data: {} });
      }
      if (url.startsWith('/blobs/character/')) return jsonResponse({});
      throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function characterCall(method: 'POST' | 'PUT') {
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        (init as RequestInit | undefined)?.method === method &&
        (url as string).startsWith('/characters'),
    );
    expect(call, `no ${method} /characters call captured`).toBeDefined();
    return JSON.parse((call![1] as RequestInit).body as string);
  }

  it('createCharacter sends the sha256 of the uploaded avatar bytes', async () => {
    const file = new File([AVATAR_BYTES], 'Ivy.png', { type: 'image/png' });
    await api.createCharacter({ ch_name: 'Ivy', avatarProvenance: 'generated' }, file);
    const body = characterCall('POST');
    expect(body.avatar_provenance_source).toBe('generated');
    expect(body.avatar_sha256).toBe(AVATAR_SHA);
    expect(body.avatar_sha256).toMatch(/^[0-9a-f]{64}$/);
    // And the blob PUT really uploads those same bytes — the pinned hash and
    // the stored content must describe the same content.
    const blobCall = fetchMock.mock.calls.find(([url]) =>
      (url as string).startsWith('/blobs/character/'),
    );
    expect(blobCall).toBeDefined();
    const uploaded = new Uint8Array(blobCall![1].body as ArrayBuffer);
    expect(Array.from(uploaded)).toEqual(Array.from(AVATAR_BYTES));
  });

  it('createCharacter omits avatar_sha256 without an avatarFile', async () => {
    await api.createCharacter({ ch_name: 'Ivy' });
    const body = characterCall('POST');
    expect(body).not.toHaveProperty('avatar_sha256');
    expect(body).not.toHaveProperty('avatar_provenance_source');
  });

  it('editCharacter sends the sha256 when the avatar is replaced', async () => {
    const file = new File([AVATAR_BYTES], 'Ivy.png', { type: 'image/png' });
    await api.editCharacter(
      { ch_name: 'Ivy', avatar_url: 'Ivy.png', avatarProvenance: 'fictional-declared' },
      file,
    );
    const body = characterCall('PUT');
    expect(body.avatar_provenance_source).toBe('fictional-declared');
    expect(body.avatar_sha256).toBe(AVATAR_SHA);
  });

  it('editCharacter omits avatar_sha256 on a text-only edit', async () => {
    await api.editCharacter({ ch_name: 'Ivy', avatar_url: 'Ivy.png' });
    const body = characterCall('PUT');
    expect(body).not.toHaveProperty('avatar_sha256');
    expect(body).not.toHaveProperty('avatar_provenance_source');
  });
});
