import { useEffect, useState } from 'react';
import { fetchExistingClips } from '../api/livePortraitGen';
import { useLivePortraitStore, type EmotionClips } from '../stores/livePortraitStore';

/**
 * Auto-discovers server-side Live Portrait clips for a character and populates
 * the local store, so the portrait shows on any device — not just the one that
 * ran generation.
 *
 * This used to live as an inline effect in ChatView only. That meant the
 * desktop layout (where the portrait renders in the Sidebar, not ChatView's
 * `lg:hidden` panel) had no way to recover an empty cache on its own, and a
 * single transient `/blobs` failure was swallowed silently with no retry —
 * leaving the static avatar showing until some unrelated re-render happened to
 * re-fire the fetch. Both ChatView and Sidebar now call this hook, so whichever
 * layout is active drives discovery.
 *
 * - De-duped across consumers: ChatView and Sidebar are both always mounted, so
 *   a module-level in-flight set ensures only one `/blobs` fetch per avatar runs
 *   at a time.
 * - Retries once on failure (transient auth/session/network), then logs instead
 *   of failing silently.
 * - Exposes `loading` so callers can avoid committing to the static fallback
 *   before discovery has had a chance to resolve.
 */

const MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1500;

// Shared across all hook consumers so simultaneously-mounted layouts don't each
// fire their own /blobs request for the same character.
const inFlight = new Set<string>();

export interface LivePortraitDiscovery {
  /** Clip URL map for this character, or null if none cached yet. */
  clips: EmotionClips | null;
  /** True when the feature is enabled and a playable (idle-bearing) clip set is cached. */
  hasClips: boolean;
  /** True while discovery is in progress and the cache is still empty. */
  loading: boolean;
}

export function useLivePortraitDiscovery(
  avatar: string | null | undefined,
): LivePortraitDiscovery {
  const enabled = useLivePortraitStore((s) => s.enabled);
  const clips = useLivePortraitStore((s) => (avatar ? s.getClips(avatar) : null));
  const [loading, setLoading] = useState(false);

  const hasLocalClips = !!clips && Object.keys(clips).length > 0;

  useEffect(() => {
    if (!avatar || !enabled) return;
    if (hasLocalClips) return; // cache already populated
    if (inFlight.has(avatar)) return; // another consumer is already fetching

    inFlight.add(avatar); // this invocation owns the in-flight marker
    let cancelled = false;
    setLoading(true);

    (async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const fetched = await fetchExistingClips(avatar);
          if (cancelled) return;
          if (Object.keys(fetched).length > 0) {
            useLivePortraitStore.getState().setClips(avatar, fetched);
          }
          return; // success — an empty result just means this character has no clips
        } catch (err) {
          if (cancelled) return;
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
          } else {
            // Final failure: surface it once rather than swallowing silently,
            // so a recurring /blobs problem is diagnosable instead of invisible.
            console.warn(
              `[LivePortrait] clip discovery failed for "${avatar}" after ${MAX_ATTEMPTS} attempts; showing static avatar`,
              err,
            );
          }
        }
      }
    })().finally(() => {
      inFlight.delete(avatar);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      inFlight.delete(avatar);
    };
  }, [avatar, enabled, hasLocalClips]);

  const hasClips = enabled && !!clips && 'idle' in clips;
  return { clips: clips ?? null, hasClips, loading: loading && !hasLocalClips };
}
