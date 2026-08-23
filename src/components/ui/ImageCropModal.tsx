import { useRef, useState, useEffect, useCallback } from 'react';
import { X, Check, ZoomIn, ZoomOut } from 'lucide-react';

// Crop viewport matches the 2:3 portrait aspect ratio the app displays
// avatars at (see Sidebar.tsx's `aspect-[2/3]`) so what the user frames
// here is exactly what gets saved — no square-to-portrait stretch at apply time.
const CROP_W = 300;
const CROP_H = 450;
const OUTPUT_W = 400;
const OUTPUT_H = 600;

function minScaleFor(w: number, h: number) {
  return Math.max(CROP_W / w, CROP_H / h);
}

interface Props {
  imageSrc: string;
  onConfirm: (file: File) => void;
  onClose: () => void;
}

export function ImageCropModal({ imageSrc, onConfirm, onClose }: Props) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [imgNatural, setImgNatural] = useState({ w: 1, h: 1 });
  const dragRef = useRef<{ startX: number; startY: number; startOX: number; startOY: number } | null>(null);
  const imgEl = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setScale(minScaleFor(img.naturalWidth, img.naturalHeight));
      setOffset({ x: 0, y: 0 });
      imgEl.current = img;
    };
    img.src = imageSrc;
  }, [imageSrc]);

  const minScale = minScaleFor(imgNatural.w, imgNatural.h);
  const maxScale = minScale * 5;

  const clampOffset = useCallback((ox: number, oy: number, s: number) => {
    const displayW = imgNatural.w * s;
    const displayH = imgNatural.h * s;
    return {
      x: Math.min(0, Math.max(-(displayW - CROP_W), ox)),
      y: Math.min(0, Math.max(-(displayH - CROP_H), oy)),
    };
  }, [imgNatural]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOX: offset.x, startOY: offset.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset(clampOffset(dragRef.current.startOX + dx, dragRef.current.startOY + dy, scale));
  };

  const onPointerUp = () => { dragRef.current = null; };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const newScale = Math.max(minScale, Math.min(maxScale, scale - e.deltaY * 0.001));
    setScale(newScale);
    setOffset(prev => clampOffset(prev.x, prev.y, newScale));
  };

  const handleConfirm = () => {
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_W;
    canvas.height = OUTPUT_H;
    const ctx = canvas.getContext('2d');
    if (ctx && imgEl.current) {
      const srcX = -offset.x / scale;
      const srcY = -offset.y / scale;
      const srcW = CROP_W / scale;
      const srcH = CROP_H / scale;
      ctx.drawImage(imgEl.current, srcX, srcY, srcW, srcH, 0, 0, OUTPUT_W, OUTPUT_H);
    }
    canvas.toBlob((blob) => {
      if (blob) onConfirm(new File([blob], 'avatar.png', { type: 'image/png' }));
    }, 'image/png');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-[var(--color-bg-secondary)] rounded-2xl p-4 flex flex-col gap-4 w-full max-w-[360px] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Crop portrait</h3>
          <button type="button" onClick={onClose} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            <X size={18} />
          </button>
        </div>

        {/* Crop viewport */}
        <div
          className="relative overflow-hidden rounded-lg bg-black cursor-grab active:cursor-grabbing touch-none mx-auto"
          style={{ width: CROP_W, height: CROP_H }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <img
            src={imageSrc}
            alt="crop preview"
            draggable={false}
            style={{
              position: 'absolute',
              left: offset.x,
              top: offset.y,
              width: imgNatural.w * scale,
              height: imgNatural.h * scale,
              maxWidth: 'none',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          />
          <div className="absolute inset-0 border-2 border-white/30 pointer-events-none rounded-lg" />
        </div>

        {/* Zoom slider */}
        <div className="flex items-center gap-2">
          <ZoomOut size={14} className="text-[var(--color-text-secondary)] flex-shrink-0" />
          <input
            type="range"
            min={minScale}
            max={maxScale}
            step="0.01"
            value={scale}
            onChange={(e) => {
              const s = Number(e.target.value);
              setScale(s);
              setOffset(prev => clampOffset(prev.x, prev.y, s));
            }}
            className="flex-1 accent-[var(--color-primary)]"
          />
          <ZoomIn size={14} className="text-[var(--color-text-secondary)] flex-shrink-0" />
        </div>

        <p className="text-xs text-[var(--color-text-secondary)] text-center -mt-2">
          Drag to reposition · Scroll or slider to zoom
        </p>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 rounded-xl border border-[var(--color-border)] text-sm text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex-1 py-2 rounded-xl bg-[var(--color-primary)] text-white text-sm font-medium flex items-center justify-center gap-1.5"
          >
            <Check size={14} />
            Apply crop
          </button>
        </div>
      </div>
    </div>
  );
}
