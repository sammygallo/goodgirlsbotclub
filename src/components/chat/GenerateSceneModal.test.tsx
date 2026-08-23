/**
 * @vitest-environment jsdom
 *
 * GenerateSceneModal — the avatar-provenance pre-gate. The backend 403s
 * /api/scene-video/generate for uncleared avatars (the same content-bound
 * gate as selfies), so the modal must short-circuit BEFORE the paid
 * summarizer LLM call and never offer a Generate button that can only fail.
 * The gate is advisory: ChatView's toast still renders the server's 403
 * detail for the cleared-row-but-swapped-bytes case.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { GenerateSceneModal } from './GenerateSceneModal';
import { fetchSceneDrivers } from '../../api/sceneVideoGen';
import { summarizeScene } from '../../utils/sceneFromTranscript';

vi.mock('../../api/sceneVideoGen', () => ({
  fetchSceneDrivers: vi.fn(),
}));
vi.mock('../../utils/sceneFromTranscript', () => ({
  summarizeScene: vi.fn(),
}));

// This repo doesn't wire @testing-library/jest-dom, so assert on plain DOM
// props (.disabled) and query presence (getByText throws if absent).

function renderModal(overrides: Partial<Parameters<typeof GenerateSceneModal>[0]> = {}) {
  const onGenerate = vi.fn();
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    messages: [],
    characterName: 'Ivy',
    avatarProvenance: 'generated' as string | undefined,
    fallbackPrompt: 'a quiet rooftop at dusk',
    onGenerate,
    ...overrides,
  };
  render(<GenerateSceneModal {...props} />);
  return { onGenerate, props };
}

describe('GenerateSceneModal — avatar-provenance pre-gate', () => {
  beforeEach(() => {
    vi.mocked(fetchSceneDrivers).mockResolvedValue([{ id: 'walk', label: 'Walk' }]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each(['uploaded', 'unknown', undefined])(
    'blocks with teaching copy and no pipeline calls when provenance is %s',
    async (provenance) => {
      renderModal({ avatarProvenance: provenance });
      expect(await screen.findByText(/Not cleared/)).toBeTruthy();
      expect(screen.getByText(/Edit dialog/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Generate/ })).toBeNull();
      // The whole point of pre-gating: neither the drivers fetch nor the paid
      // summarizer runs for a request the backend would 403.
      expect(fetchSceneDrivers).not.toHaveBeenCalled();
      expect(summarizeScene).not.toHaveBeenCalled();
    }
  );

  it.each(['generated', 'fictional-declared', 'grandfathered'])(
    'proceeds to the normal flow when provenance is %s',
    async (provenance) => {
      renderModal({ avatarProvenance: provenance });
      await waitFor(() => expect(fetchSceneDrivers).toHaveBeenCalled());
      expect(await screen.findByRole('button', { name: /Generate/ })).toBeTruthy();
      expect(screen.queryByText(/Not cleared/)).toBeNull();
    }
  );
});
