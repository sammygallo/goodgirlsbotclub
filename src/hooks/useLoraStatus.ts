import { useEffect } from 'react';
import { create } from 'zustand';
import {
  fetchLoraStatus,
  LORA_INFLIGHT_STATUSES,
  type LoraStatus,
} from '../api/loraTraining';

/**
 * Studio-tier training status, discovered and polled per character (Phase C1).
 *
 * Follows the codebase's reload-survival pattern (useLivePortraitDiscovery):
 * no jobId closures — the backend's status endpoint is keyed by CHARACTER, so
 * this hook simply (re)fetches on mount and keeps polling while a training is
 * in flight. A training started on another device, or before a reload, lights
 * up here identically to one started this session.
 *
 * The store is deliberately in-memory (NOT persisted): the status is one
 * cheap GET and the server is the only source of truth for a paid artifact —
 * a stale localStorage copy claiming "trained" would gate a paid mode on
 * fiction. (Contrast livePortraitStore, which persists actual clip URLs.)
 */

const POLL_INTERVAL_MS = 5000;

// Shared across hook consumers so simultaneously-mounted surfaces don't each
// fire their own initial fetch for the same character.
const inFlight = new Set<string>();

interface LoraStatusState {
  statusByAvatar: Record<string, LoraStatus>;
  setStatus: (avatar: string, status: LoraStatus) => void;
}

export const useLoraStore = create<LoraStatusState>()((set) => ({
  statusByAvatar: {},
  setStatus: (avatar, status) =>
    set((s) => ({ statusByAvatar: { ...s.statusByAvatar, [avatar]: status } })),
}));

const RETRY_DELAY_MS = 1500;

export function useLoraStatus(
  avatar: string | null | undefined,
  characterName: string | null | undefined,
): LoraStatus | null {
  const entry = useLoraStore((s) => (avatar ? s.statusByAvatar[avatar] : undefined));

  const inflight = !!entry && LORA_INFLIGHT_STATUSES.includes(entry.status);

  // Initial discovery on every mount/identity change — even when a status is
  // already cached (2026-08-20 review: refreshing only unknown entries left
  // a stale "none"/"succeeded" for the whole session after another device
  // trained, and gave a transiently-failed first fetch no second chance).
  // One retry on failure, mirroring useLivePortraitDiscovery; de-duped
  // across simultaneously-mounted consumers.
  useEffect(() => {
    if (!avatar || !characterName) return;
    if (inFlight.has(avatar)) return;
    inFlight.add(avatar);
    let cancelled = false;

    (async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const status = await fetchLoraStatus(characterName);
          if (!cancelled) useLoraStore.getState().setStatus(avatar, status);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else {
            console.warn(`[lora] status fetch failed for "${characterName}"`, err);
          }
        }
      }
    })().finally(() => inFlight.delete(avatar));

    return () => {
      cancelled = true;
      inFlight.delete(avatar);
    };
  }, [avatar, characterName]);

  // Active poll while a training runs — the worker updates the DB row and
  // this converges within one interval of any transition.
  useEffect(() => {
    if (!avatar || !characterName || !inflight) return;
    let cancelled = false;
    const id = setInterval(() => {
      void fetchLoraStatus(characterName)
        .then((status) => {
          if (!cancelled) useLoraStore.getState().setStatus(avatar, status);
        })
        .catch((err) => {
          console.warn(`[lora] status poll failed for "${characterName}"`, err);
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [avatar, characterName, inflight]);

  return entry ?? null;
}
