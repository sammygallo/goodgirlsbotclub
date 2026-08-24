/**
 * @vitest-environment jsdom
 *
 * LivePortraitSetup — the avatar-provenance pre-gate. The backend 403s
 * /api/live-portrait/generate for uncleared avatars (the same content-bound
 * gate as selfies), so the generate action must be disabled with teaching
 * copy instead of dead-ending in the error panel. The gate is advisory: the
 * genError panel still renders the server's 403 detail for the
 * cleared-row-but-swapped-bytes case.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LivePortraitSetup } from './LivePortraitSetup';
import { fetchSupportedEmotions, generateClips } from '../../api/livePortraitGen';

vi.mock('../../api/livePortraitGen', () => ({
  fetchSupportedEmotions: vi.fn(),
  generateClips: vi.fn(),
}));

// This repo doesn't wire @testing-library/jest-dom, so assert on plain DOM
// props (.disabled) and query presence (getByText throws if absent).

function renderModal(overrides: Partial<Parameters<typeof LivePortraitSetup>[0]> = {}) {
  const props = {
    avatar: 'Ivy.png',
    characterName: 'Ivy',
    imageUrl: '/blobs/character/Ivy.png',
    avatarProvenance: 'generated' as string | undefined,
    isOpen: true,
    onClose: vi.fn(),
    ...overrides,
  };
  render(<LivePortraitSetup {...props} />);
  return { props };
}

function generateButton() {
  return screen.getByRole('button', { name: /Generate clips|Regenerate/ }) as HTMLButtonElement;
}

describe('LivePortraitSetup — avatar-provenance pre-gate', () => {
  beforeEach(() => {
    vi.mocked(fetchSupportedEmotions).mockResolvedValue(['happy', 'sad']);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each(['uploaded', 'unknown', undefined])(
    'disables Generate with teaching copy when provenance is %s',
    async (provenance) => {
      renderModal({ avatarProvenance: provenance });
      expect(await screen.findByText(/Not cleared/)).toBeTruthy();
      expect(screen.getByText(/Edit dialog/)).toBeTruthy();
      // Even after the emotions list loads, the button stays disabled.
      await waitFor(() => expect(fetchSupportedEmotions).toHaveBeenCalled());
      expect(generateButton().disabled).toBe(true);
    }
  );

  it.each(['generated', 'fictional-declared', 'grandfathered'])(
    'enables Generate once emotions load when provenance is %s',
    async (provenance) => {
      renderModal({ avatarProvenance: provenance });
      await waitFor(() => expect(generateButton().disabled).toBe(false));
      expect(screen.queryByText(/Not cleared/)).toBeNull();
    }
  );

  it('renders the exact server-403 detail when a cleared-looking row still gets rejected', async () => {
    // The pre-gate is advisory only (see the component's own comment): a row
    // can read as cleared client-side while the backend re-hashes the live
    // avatar bytes and 403s anyway (the byte-swap-after-clearing case). The
    // genError panel must keep surfacing that server detail text verbatim
    // rather than a generic message swallowing it.
    vi.mocked(generateClips).mockRejectedValue(
      new Error('Avatar is not cleared for generation'),
    );
    renderModal({ avatarProvenance: 'generated' });
    await waitFor(() => expect(generateButton().disabled).toBe(false));
    fireEvent.click(generateButton());
    expect(await screen.findByText('Avatar is not cleared for generation')).toBeTruthy();
  });
});
