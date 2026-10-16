import { useCharacterSprites } from '../../../hooks/useCharacterSprites';
import { useLivePortraitDiscovery } from '../../../hooks/useLivePortraitDiscovery';
import { usePrefersReducedMotion } from '../../../hooks/usePrefersReducedMotion';
import { useExpressionsStore } from '../../../stores/expressionsStore';
import { useMotionModeStore } from '../../../stores/motionModeStore';
import { resolvePanelMotionMode } from './portraitSource';

/**
 * Everything the panel needs to pick a source for one avatar (D-C5): its
 * sprites, its Live Portrait clips, its own motion mode, and reduced motion.
 * In a group chat this is the focused member's avatar.
 */
export function usePanelSource(avatar: string | null, costume: string | null | undefined) {
  const { getSpritePath, availableEmotions } = useCharacterSprites(avatar ?? undefined, costume);
  const { clips, hasClips } = useLivePortraitDiscovery(avatar);
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
