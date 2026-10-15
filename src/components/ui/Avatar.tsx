import { useState, useEffect } from 'react';
import { User } from 'lucide-react';

interface AvatarProps {
  src?: string;
  /** Fallback image URL to try when `src` fails to load. */
  fallbackSrc?: string;
  /** Called when `src` fails and we switch to `fallbackSrc`. */
  onFallback?: () => void;
  /** Pass "" to mark the image decorative (its name is the text beside it); leave it out to get "Avatar". */
  alt?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Phase 7.3: avatar shape — circle (default), square, or rounded square. */
  shape?: 'circle' | 'square' | 'rounded-square';
  className?: string;
}

export function Avatar({ src, fallbackSrc, onFallback, alt, size = 'md', shape = 'circle', className = '' }: AvatarProps) {
  // 'none' → showing src, 'primary-failed' → showing fallbackSrc, 'all-failed' → show icon
  const [errorStage, setErrorStage] = useState<'none' | 'primary-failed' | 'all-failed'>('none');

  // Reset error state when src changes
  useEffect(() => {
    setErrorStage('none');
  }, [src, fallbackSrc]);

  const sizes = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
    xl: 'w-16 h-16',
  };

  const iconSizes = {
    sm: 16,
    md: 20,
    lg: 24,
    xl: 32,
  };

  const shapes = {
    'circle': 'rounded-full',
    'square': 'rounded-none',
    'rounded-square': 'rounded-lg',
  };

  const shapeClass = shapes[shape];

  // Determine the active image source
  let activeSrc: string | undefined;
  if (errorStage === 'none') activeSrc = src;
  else if (errorStage === 'primary-failed' && fallbackSrc) activeSrc = fallbackSrc;

  if (!activeSrc || errorStage === 'all-failed') {
    return (
      <div
        className={`${sizes[size]} ${shapeClass} bg-[var(--color-bg-tertiary)] flex items-center justify-center ${className}`}
      >
        <User size={iconSizes[size]} className="text-[var(--color-text-secondary)]" />
      </div>
    );
  }

  return (
    <img
      src={activeSrc}
      alt={alt ?? 'Avatar'}
      className={`${sizes[size]} ${shapeClass} object-cover ${className}`}
      onError={() => {
        if (errorStage === 'none') {
          setErrorStage(fallbackSrc ? 'primary-failed' : 'all-failed');
          onFallback?.();
        } else {
          setErrorStage('all-failed');
        }
      }}
    />
  );
}
