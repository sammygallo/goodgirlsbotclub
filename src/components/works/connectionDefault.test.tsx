/**
 * @vitest-environment jsdom
 *
 * One rule, pinned across both paid-pass preflights: the connection
 * picker opens on the CURRENT connection, never on a saved profile.
 *
 * `connectionProfileStore.activeProfileId` records the last profile
 * *applied* from Settings and nothing clears it when the user afterwards
 * edits provider or model in AI Settings. Seeding the picker from it — as
 * both modals did — silently ran the pass on a connection the user was not
 * looking at, on their own key.
 *
 * Worth a DOM test on the same grounds `RenderTab.test.tsx` states for
 * itself: the failure is invisible (the run looks normal and succeeds) and
 * it costs the user money in both directions — paying a provider they did
 * not choose, or a scripted stand-in returning fake output that reads as a
 * successful paid run. Caught by driving the local app on 2026-08-14, not
 * by any unit test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// A profile is APPLIED (so `activeProfileId` points at it) and its model
// differs from the live connection — the exact state that made the stale
// default observable.
const profileStore = {
  profiles: [
    { id: 'p-smoke', name: 'Smoke stand-in', model: 'scripted-smoke-1', provider: 'custom' },
  ],
  activeProfileId: 'p-smoke',
  getProfile: (id: string) =>
    profileStore.profiles.find((p) => p.id === id) ?? null,
};
vi.mock('../../stores/connectionProfileStore', () => ({
  useConnectionProfileStore: Object.assign(
    (selector?: (s: typeof profileStore) => unknown) =>
      selector ? selector(profileStore) : profileStore,
    { getState: () => profileStore }
  ),
}));

const settingsStore = { activeProvider: 'claude', activeModel: 'claude-opus-4-7' };
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: typeof settingsStore) => unknown) =>
      selector ? selector(settingsStore) : settingsStore,
    { getState: () => settingsStore }
  ),
}));

const { StartIngestModal } = await import('./StartIngestModal');
const { StartRenderModal } = await import('./StartRenderModal');

const ESTIMATE = {
  scenes: 3,
  inputTokens: 1000,
  maxOutputTokens: 2000,
  total: 3000,
  refusedScenes: 0,
  scenesWithDrops: 0,
  rulesNotActive: 0,
  scenesWithoutWindow: 0,
};

afterEach(() => cleanup());

describe('preflight connection picker defaults to the current connection', () => {
  beforeEach(() => {
    profileStore.activeProfileId = 'p-smoke';
  });

  it('the annotate/build preflight opens on the current connection', () => {
    render(
      <StartIngestModal
        mode="annotate"
        estimatedTokens={3000}
        onStart={() => {}}
        onClose={() => {}}
        busy={false}
      />
    );

    // '' is the "Current connection" option: downstream, a null profile id
    // resolves to `settings.activeProvider` / `activeModel`.
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  });

  it('the render preflight opens on the current connection', () => {
    render(
      <StartRenderModal
        estimate={ESTIMATE}
        sceneRangeLabel="The whole story — 3 scenes"
        onStart={() => {}}
        onClose={() => {}}
        busy={false}
      />
    );

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  });

  it('still offers the saved profiles as choices', () => {
    render(
      <StartRenderModal
        estimate={ESTIMATE}
        sceneRangeLabel="The whole story — 3 scenes"
        onStart={() => {}}
        onClose={() => {}}
        busy={false}
      />
    );

    // The default moved; the capability did not. Picking a cheap saved
    // profile for a long job is why this control exists.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'p-smoke']);
  });
});
