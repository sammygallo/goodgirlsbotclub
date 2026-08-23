import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { applyTheme } from './hooks/themePreferences';
import { ImageCropModal } from './components/ui/ImageCropModal';

applyTheme();

function makeTestImage(w: number, h: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // Quadrant colors so panning is obvious.
  ctx.fillStyle = '#e11d48'; ctx.fillRect(0, 0, w / 2, h / 2);
  ctx.fillStyle = '#2563eb'; ctx.fillRect(w / 2, 0, w / 2, h / 2);
  ctx.fillStyle = '#16a34a'; ctx.fillRect(0, h / 2, w / 2, h / 2);
  ctx.fillStyle = '#eab308'; ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
  // Perfect circle at center — becomes an ellipse if output gets stretched.
  const r = Math.min(w, h) * 0.35;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.005);
  ctx.stroke();
  // Grid lines every 10% for scale/pan reference.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.002);
  for (let i = 1; i < 10; i++) {
    ctx.beginPath(); ctx.moveTo((w * i) / 10, 0); ctx.lineTo((w * i) / 10, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, (h * i) / 10); ctx.lineTo(w, (h * i) / 10); ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

const PRESETS: Record<string, [number, number]> = {
  'Large portrait (1664x2520)': [1664, 2520],
  'Landscape (1200x600)': [1200, 600],
  'Small (150x150, smaller than crop box)': [150, 150],
};

function Harness() {
  const [src, setSrc] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; w: number; h: number } | null>(null);

  const handleConfirm = (file: File) => {
    setSrc(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setResult({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  };

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', color: '#fff', background: '#0f0f0f', minHeight: '100vh' }}>
      <h1>ImageCropModal harness</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
        {Object.entries(PRESETS).map(([label, [w, h]]) => (
          <button key={label} onClick={() => { setResult(null); setSrc(makeTestImage(w, h)); }} style={{ padding: '8px 12px' }}>
            {label}
          </button>
        ))}
      </div>

      {result && (
        <div>
          <p>Result file: {result.w}x{result.h}</p>
          <img src={result.url} alt="result" style={{ width: 200, border: '1px solid #666' }} />
        </div>
      )}

      {src && <ImageCropModal imageSrc={src} onConfirm={handleConfirm} onClose={() => setSrc(null)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
