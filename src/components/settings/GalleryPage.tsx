import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useSettingsPanelStore } from '../../stores/settingsPanelStore';
import { useImageGenStore, type GalleryEntry } from '../../stores/imageGenStore';
import { ImageGenModal } from '../chat/ImageGenModal';

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function backendLabel(backend: string): string {
  switch (backend) {
    case 'pollinations': return 'Pollinations';
    case 'horde': return 'AI Horde';
    case 'sdwebui': return 'SD WebUI';
    case 'dalle': return 'DALL-E';
    case 'selfie': return 'Selfie';
    default: return backend;
  }
}

/**
 * Best-effort filename extension from a data URI. Falls back to "png" so the
 * downloaded file always has a sensible extension even on weird MIME types.
 */
function extensionFor(dataUrl: string): string {
  const match = /^data:image\/([a-z0-9+]+);/i.exec(dataUrl);
  if (!match) return 'png';
  const mime = match[1].toLowerCase();
  if (mime === 'jpeg') return 'jpg';
  if (mime === 'svg+xml') return 'svg';
  return mime;
}

function downloadEntry(entry: GalleryEntry) {
  const a = document.createElement('a');
  a.href = entry.dataUrl;
  // Take a few words of the prompt so the filename is recognizable. Strip
  // anything that's not safe for filesystems.
  const slug = entry.prompt
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'image';
  a.download = `${slug}-${entry.id}.${extensionFor(entry.dataUrl)}`;
  a.click();
}

interface LightboxProps {
  entry: GalleryEntry;
  onClose: () => void;
  onRemix: () => void;
  onCopy: () => void;
  copied: boolean;
}

function Lightbox({ entry, onClose, onRemix, onCopy, copied }: LightboxProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors z-10"
        aria-label="Close"
      >
        <X size={20} />
      </button>
      <div className="max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3">
        <img
          src={entry.dataUrl}
          alt={entry.prompt}
          className="max-w-full max-h-[70vh] object-contain rounded-lg"
        />
        <p className="text-sm text-zinc-300 text-center max-w-lg px-4 line-clamp-3">
          {entry.prompt}
        </p>
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors text-xs"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
          <button
            type="button"
            onClick={() => downloadEntry(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors text-xs"
          >
            <Download size={13} />
            Download
          </button>
          <button
            type="button"
            onClick={onRemix}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary)]/90 transition-colors text-xs font-medium"
          >
            <Sparkles size={13} />
            Remix
          </button>
        </div>
      </div>
    </div>
  );
}

type BackendFilter = 'all' | GalleryEntry['backend'];

export function GalleryPage(_props?: { params?: Record<string, string> }) {
  const { goBack } = useSettingsPanelStore();
  const gallery = useImageGenStore((s) => s.gallery);
  const removeFromGallery = useImageGenStore((s) => s.removeFromGallery);
  const clearGallery = useImageGenStore((s) => s.clearGallery);
  const [selectedEntry, setSelectedEntry] = useState<GalleryEntry | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [backendFilter, setBackendFilter] = useState<BackendFilter>('all');
  const [remixEntry, setRemixEntry] = useState<GalleryEntry | null>(null);
  // Track which entry was just copied so the button can flash a confirmation.
  // Keyed by entry id rather than a boolean so the indicator can survive
  // navigating between lightboxes if the user opens another card before the
  // timeout expires (rare, but the cost of supporting it is one extra word).
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return gallery.filter((entry) => {
      if (backendFilter !== 'all' && entry.backend !== backendFilter) return false;
      if (q && !entry.prompt.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [gallery, searchQuery, backendFilter]);

  // Backend filter chips only show backends actually present in the gallery —
  // no reason to offer "DALL-E" if the user has never used it.
  const presentBackends = useMemo(() => {
    const set = new Set<GalleryEntry['backend']>();
    for (const entry of gallery) set.add(entry.backend);
    return set;
  }, [gallery]);

  const handleCopy = async (entry: GalleryEntry) => {
    try {
      await navigator.clipboard.writeText(entry.prompt);
      setCopiedId(entry.id);
      setTimeout(() => {
        setCopiedId((curr) => (curr === entry.id ? null : curr));
      }, 1500);
    } catch {
      // Clipboard rarely fails in modern browsers; on permission denial
      // there's nothing useful we can show in-context — silently noop.
    }
  };

  const handleRemix = (entry: GalleryEntry) => {
    setSelectedEntry(null);
    setRemixEntry(entry);
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[var(--color-bg-primary)] border-b border-[var(--color-border)] px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => goBack()}
          className="p-2 -ml-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
          aria-label="Back"
        >
          <ArrowLeft size={20} className="text-[var(--color-text-primary)]" />
        </button>
        <div className="flex-1">
          <h1 className="text-base font-semibold text-[var(--color-text-primary)]">Image Gallery</h1>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {filtered.length === gallery.length
              ? `${gallery.length} image${gallery.length !== 1 ? 's' : ''} saved`
              : `${filtered.length} of ${gallery.length} shown`}
          </p>
        </div>
        {gallery.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (confirmClear) {
                clearGallery();
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
                setTimeout(() => setConfirmClear(false), 3000);
              }
            }}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              confirmClear
                ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]'
            }`}
          >
            {confirmClear ? 'Tap to confirm' : 'Clear all'}
          </button>
        )}
      </div>

      {/* Toolbar — search + backend filter */}
      {gallery.length > 0 && (
        <div className="px-3 pt-3 space-y-2">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] pointer-events-none"
            />
            <input
              type="text"
              id="gallery-prompt-search"
              name="gallery-prompt-search"
              autoComplete="off"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search prompts..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>
          {presentBackends.size > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              {(['all', 'pollinations', 'horde', 'sdwebui', 'dalle', 'selfie'] as const)
                .filter((k) => k === 'all' || presentBackends.has(k as GalleryEntry['backend']))
                .map((k) => {
                  const active = backendFilter === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setBackendFilter(k)}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        active
                          ? 'bg-[var(--color-primary)]/15 border-[var(--color-primary)]/40 text-[var(--color-primary)]'
                          : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                      }`}
                    >
                      {k === 'all' ? 'All' : backendLabel(k)}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {gallery.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
          <p className="text-sm text-[var(--color-text-secondary)]">
            No images generated yet. Use the image generation button in chat to create images.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
          <p className="text-sm text-[var(--color-text-secondary)]">
            No images match your filters.
          </p>
        </div>
      ) : (
        <div className="p-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {filtered.map((entry) => (
            <div
              key={entry.id}
              className="bg-[var(--color-bg-secondary)] rounded-xl overflow-hidden border border-[var(--color-border)] group"
            >
              {/* Thumbnail */}
              <button
                type="button"
                onClick={() => setSelectedEntry(entry)}
                className="block w-full aspect-square overflow-hidden"
              >
                <img
                  src={entry.dataUrl}
                  alt={entry.prompt}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                  loading="lazy"
                />
              </button>

              {/* Info */}
              <div className="p-2">
                <p className="text-xs text-[var(--color-text-primary)] line-clamp-2 leading-tight mb-1.5">
                  {entry.prompt}
                </p>
                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-primary)]/15 text-[var(--color-primary)] font-medium">
                      {backendLabel(entry.backend)}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)] truncate">
                      {formatDate(entry.timestamp)}
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => handleRemix(entry)}
                      className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 transition-colors"
                      aria-label="Remix"
                      title="Remix this prompt"
                    >
                      <Sparkles size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy(entry)}
                      className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                      aria-label="Copy prompt"
                      title="Copy prompt"
                    >
                      {copiedId === entry.id ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadEntry(entry)}
                      className="p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                      aria-label="Download"
                      title="Download image"
                    >
                      <Download size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFromGallery(entry.id)}
                      className="p-1 rounded text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      aria-label="Delete image"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {selectedEntry && (
        <Lightbox
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onRemix={() => handleRemix(selectedEntry)}
          onCopy={() => handleCopy(selectedEntry)}
          copied={copiedId === selectedEntry.id}
        />
      )}

      {/* Remix — opens the same image-gen modal pre-filled with the source
          prompt. Omitting onInsert puts the modal in "gallery mode": images
          still auto-save to the gallery on generate, but there's no chat to
          insert into. */}
      <ImageGenModal
        isOpen={!!remixEntry}
        onClose={() => setRemixEntry(null)}
        initialPrompt={remixEntry?.prompt ?? ''}
      />
    </div>
  );
}
