import { useEffect, useState } from 'react';
import { FEATURE_SLIDES_URL, parseFeatureSlides, type SlideConfig } from '../../utils/hero/featureSlides';

export interface FeatureSlidesState {
  /** False until the fetch has finished one way or the other. */
  settled: boolean;
  /** Validated entries, in file order. Empty on any failure. */
  slides: SlideConfig[];
}

/**
 * Loads the hero's slide config (D-H6) from `public/hero/feature-slides.json`.
 *
 * Contract: this NEVER rejects, throws or blocks. A network error, a non-2xx,
 * a body that is not JSON, or a file the validator rejects all settle as zero
 * slides, because a broken curation file must cost the hero its announcements,
 * not the hero.
 *
 * The non-JSON case is not hypothetical. nginx answers a MISSING static file
 * with a 200 and index.html (the SPA fallback), so `res.ok` alone proves
 * nothing: `res.json()` is what rejects the HTML, and it is covered by the same
 * try/catch as the fetch itself.
 */
export function useFeatureSlides(): FeatureSlidesState {
  const [state, setState] = useState<FeatureSlidesState>({ settled: false, slides: [] });

  useEffect(() => {
    // React StrictMode mounts, unmounts and re-mounts: the first request is
    // aborted and its late result must not overwrite the second's.
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      let slides: SlideConfig[] = [];
      try {
        const res = await fetch(FEATURE_SLIDES_URL, { cache: 'no-cache', signal: controller.signal });
        if (res.ok) slides = parseFeatureSlides(await res.json());
      } catch (err) {
        // Aborted or offline: silent. Unreadable JSON is the curator's problem
        // and worth one console line (the nginx 200-HTML fallback lands here).
        if (err instanceof SyntaxError) {
          console.warn(`[hero] ${FEATURE_SLIDES_URL} is not valid JSON; showing no feature slides.`);
        }
      }
      if (!cancelled) setState({ settled: true, slides });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return state;
}
