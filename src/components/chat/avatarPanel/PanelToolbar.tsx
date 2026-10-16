import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { Film, Move, PanelLeftClose, Pause, Play } from 'lucide-react';
import { MotionModePicker } from '../../character/MotionModePicker';

interface PanelToolbarProps {
  avatar: string;
  hasLivePortraitClips: boolean;
  hasExpressionSprites: boolean;
  /** Whether Live Portrait is what the panel is showing (gates Pause/Play). */
  livePortraitPlaying: boolean;
  paused: boolean;
  onTogglePaused: () => void;
  framing: boolean;
  onToggleFraming: () => void;
  onHide: () => void;
  framingButtonRef: Ref<HTMLButtonElement>;
  hideButtonRef: Ref<HTMLButtonElement>;
}

// Fixed colors, not themed: the toolbar sits on the image, not on a theme
// surface (§5.3). White on rgb(0 0 0 / .5) over any image.
const BUTTON =
  'flex h-8 w-8 items-center justify-center rounded-md text-white hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white';

/**
 * The panel's top-right controls (§5.3), always visible so touch and keyboard
 * users can find them, in this order: Motion mode, Adjust framing,
 * Pause/Play animation (only while Live Portrait plays, D-C6), Hide portrait.
 */
export function PanelToolbar({
  avatar,
  hasLivePortraitClips,
  hasExpressionSprites,
  livePortraitPlaying,
  paused,
  onTogglePaused,
  framing,
  onToggleFraming,
  onHide,
  framingButtonRef,
  hideButtonRef,
}: PanelToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [pickerOpen]);

  // Escape closes the popover and nothing behind it: document-level Escape
  // handlers (the drawer, sheets) must not also see it.
  const handlePickerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || !pickerOpen) return;
    e.stopPropagation();
    setPickerOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div
      role="group"
      aria-label="Portrait controls"
      className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-lg p-1"
      style={{ backgroundColor: 'rgb(0 0 0 / .5)' }}
    >
      {/* Unpositioned, so the popover anchors to the toolbar's right edge, and
          capped to the aside's width (@container/panel) so it never clips. */}
      <div ref={wrapperRef} onKeyDown={handlePickerKeyDown}>
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          aria-label="Motion mode"
          title="Motion mode"
          aria-expanded={pickerOpen}
          aria-controls={pickerId}
          className={BUTTON}
        >
          <Film size={16} />
        </button>
        <div
          id={pickerId}
          hidden={!pickerOpen}
          className="absolute right-0 top-full mt-2 w-72 max-w-[calc(100cqw-1.5rem)] rounded-lg p-2 shadow-xl"
          style={{ backgroundColor: 'rgb(0 0 0 / .85)' }}
        >
          <MotionModePicker
            avatar={avatar}
            hasLivePortraitClips={hasLivePortraitClips}
            hasExpressionSprites={hasExpressionSprites}
            variant="overlay"
          />
        </div>
      </div>
      <button
        ref={framingButtonRef}
        type="button"
        onClick={onToggleFraming}
        aria-label="Adjust framing"
        title="Adjust framing"
        aria-pressed={framing}
        className={`${BUTTON} ${framing ? 'bg-white/25' : ''}`}
      >
        <Move size={16} />
      </button>
      {livePortraitPlaying && (
        <button
          type="button"
          onClick={onTogglePaused}
          aria-label={paused ? 'Play animation' : 'Pause animation'}
          title={paused ? 'Play animation' : 'Pause animation'}
          className={BUTTON}
        >
          {paused ? <Play size={16} /> : <Pause size={16} />}
        </button>
      )}
      <button
        ref={hideButtonRef}
        type="button"
        onClick={onHide}
        aria-label="Hide portrait"
        title="Hide portrait"
        className={BUTTON}
      >
        <PanelLeftClose size={16} />
      </button>
    </div>
  );
}
