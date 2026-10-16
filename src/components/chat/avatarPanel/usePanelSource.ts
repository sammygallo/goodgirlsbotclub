import { useCharacterSprites } from '../../../hooks/useCharacterSprites';
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion';
import { useExpressionsStore } from '../../../stores/expressionsStore';
import { useLivePortraitStore } from '../../../stores/livePortraitStore';
import { useMotionModeStore } from '../../../stores/motionModeStore';
import { resolvePanelMotionMode } from './portraitSource';

/**
 * Everything the panel needs to pick a source for one avatar (D-C5): its
 * sprites, its Live Portrait clips, its own motion mode, and reduced motion.
 * In a group chat this is the focused member's avatar.
 */
export function usePanelSource(avatar: string | null, costume: string | null | undefined) {
  const { getSpritePath, availableEmotions } = useCharacterSprites(avatar ?? undefined, costume);
  // Cached clips only: the panel runs no /blobs discovery of its own (D-E6S4-5).
  const enabled = useLivePortraitStore((s) => s.enabled);
  const clips = useLivePortraitStore((s) => (avatar ? s.getClips(avatar) : null));
  const hasClips = enabled && !!clips && 'idle' in clips;
  const mode = useMotionModeStore((s) => (avatar ? s.modesByAvatar[avatar] ?? 'auto' : 'auto'));
  const reducedMotion = usePrefersReducedMotion();
  const noFallback = useExpressionsStore((s) => s.noFallback);
  const hasSprites = availableEmotions.length > 0;

  return {
    resolved: resolvePanelMotionMode(mode, hasClips, hasSprites, reducedMotion),
    clips,
    hasClips,
    hasSprites,
    getSpritePath,
    availableEmotions,
    noFallback,
    reducedMotion,
  };
}
