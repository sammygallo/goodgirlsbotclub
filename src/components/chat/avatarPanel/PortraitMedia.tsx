import { useEffect, useState, type ReactNode } from 'react';
import type { EmotionClips } from '../../../stores/livePortraitStore';
import type { ResolvedMotionMode } from '../../../stores/motionModeStore';
import { LivePortraitVideo } from '../LivePortraitVideo';

/** Speaker cross-fade (§6.4 motion tokens); 0 under reduced motion (D-C14). */
export const SPEAKER_FADE_MS = 200;

interface PortraitMediaProps {
  avatar: string;
  name: string;
  resolved: ResolvedMotionMode;
  clips: EmotionClips | null;
  /** Emotion Live Portrait plays on top of idle. */
  emotion: string | null;
  /** The still to show when not playing Live Portrait (sprite or default avatar). */
  imageUrl: string;
  /** Set when an error on `imageUrl` means this sprite key failed (ChatView's 404 fallback). */
  failedExpressionKey: string | null;
  onExpressionFailed: (key: string) => void;
  objectPosition: string;
  paused: boolean;
  reducedMotion: boolean;
}

/**
 * The panel's image (D-C4, D-C5): Live Portrait, a sprite, the static avatar,
 * or — when the static avatar itself fails — a placeholder with the initial.
 * Everything is `object-fit: cover` over the whole panel, so no source is ever
 * stretched. object-position is never animated (D-C14).
 */
export function PortraitMedia(props: PortraitMediaProps) {
  const { avatar, reducedMotion } = props;
  // The first avatar shown appears at once; each later speaker change fades in.
  const [mountAvatar] = useState(avatar);
  const [speakerChanged, setSpeakerChanged] = useState(false);
  if (!speakerChanged && avatar !== mountAvatar) setSpeakerChanged(true);

  return (
    <FadeLayer key={avatar} fadeIn={speakerChanged} durationMs={reducedMotion ? 0 : SPEAKER_FADE_MS}>
      <MediaContent {...props} />
    </FadeLayer>
  );
}

function MediaContent({
  avatar,
  name,
  resolved,
  clips,
  emotion,
  imageUrl,
  failedExpressionKey,
  onExpressionFailed,
  objectPosition,
  paused,
}: PortraitMediaProps) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

  if (resolved === 'liveportrait' && clips) {
    return (
      // The aside's label names the portrait; the video itself is decorative.
      <div aria-hidden="true" className="absolute inset-0">
        <LivePortraitVideo
          clips={clips}
          emotion={emotion}
          fill
          shape="rect"
          objectPosition={objectPosition}
          paused={paused}
        />
      </div>
    );
  }

  if (brokenSrc === imageUrl) {
    return (
      <div
        role="img"
        aria-label={name}
        className="absolute inset-0 flex items-center justify-center bg-[var(--color-bg-tertiary)] text-6xl font-semibold text-[var(--color-text-secondary)]"
      >
        {(name.trim()[0] ?? '?').toUpperCase()}
      </div>
    );
  }

  return (
    <img
      key={`${avatar}-${imageUrl}`}
      src={imageUrl}
      alt={name}
      draggable={false}
      className="absolute inset-0 w-full h-full object-cover select-none"
      style={{ objectPosition }}
      onError={() => {
        // A sprite that 404s is remembered as failed, so the next render falls
        // back to the default avatar — the same path the message avatars and the
        // mobile portrait use. A default avatar that fails shows the placeholder.
        if (failedExpressionKey) onExpressionFailed(failedExpressionKey);
        else setBrokenSrc(imageUrl);
      }}
    />
  );
}

function FadeLayer({ fadeIn, durationMs, children }: { fadeIn: boolean; durationMs: number; children: ReactNode }) {
  const [shown, setShown] = useState(!fadeIn || durationMs === 0);
  useEffect(() => {
    if (shown) return;
    // Two frames: the first commits opacity 0, the second starts the transition.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [shown]);

  return (
    <div
      data-testid="portrait-layer"
      className="absolute inset-0"
      style={{ opacity: shown ? 1 : 0, transition: `opacity ${durationMs}ms ease-out` }}
    >
      {children}
    </div>
  );
}
