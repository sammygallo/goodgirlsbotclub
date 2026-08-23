import { useEffect, useState } from 'react';
import { Sparkles, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { showToastGlobal } from '../ui/Toast';
import { useLivePortraitStore } from '../../stores/livePortraitStore';
import { LivePortraitVideo } from '../chat/LivePortraitVideo';
import { avatarProvenanceAllowsSelfies } from '../../utils/avatarProvenance';
import {
  fetchSupportedEmotions,
  generateClips,
} from '../../api/livePortraitGen';

/**
 * LivePortraitSetup — kicks off video-clip generation for a character via
 * the backend's Sieve integration. One click, generates ~6 short MP4s
 * (idle + per-emotion), stores their URLs in the persistent store, and
 * shows a preview of what will play in chat.
 *
 * Replaces the previous anchor-placement / mesh-warp setup flow entirely.
 * No interactive markers; the only user input is "generate" or "regenerate".
 */

interface LivePortraitSetupProps {
  /** Character avatar filename, e.g. "Mina Hope.png". Used as the storage key. */
  avatar: string;
  /** Character name (used as the path segment for backend storage). */
  characterName: string;
  /** Character's main avatar URL — shown as a preview before generation. */
  imageUrl: string;
  /** Server-side `avatar_provenance` — Live Portrait animates the avatar, so
   *  the backend applies the same content-bound provenance gate as selfies. */
  avatarProvenance: string | undefined;
  isOpen: boolean;
  onClose: () => void;
}

export function LivePortraitSetup({
  avatar,
  characterName,
  imageUrl,
  avatarProvenance,
  isOpen,
  onClose,
}: LivePortraitSetupProps) {
  const existingClips = useLivePortraitStore((s) => s.clipsByAvatar[avatar]);
  const setClipsInStore = useLivePortraitStore((s) => s.setClips);
  const clearClipsInStore = useLivePortraitStore((s) => s.clearClips);

  const [emotions, setEmotions] = useState<string[]>([]);
  const [emotionsError, setEmotionsError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [genError, setGenError] = useState<string | null>(null);
  // Preview emotion to play in the live preview after generation.
  const [previewEmotion, setPreviewEmotion] = useState<string | null>(null);

  // Fetch the backend's supported emotion list when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setGenError(null);
    setProgress(0);
    setProgressLabel('');
    fetchSupportedEmotions()
      .then((list) => {
        setEmotions(list);
        setEmotionsError(null);
      })
      .catch((err) => {
        setEmotionsError(err instanceof Error ? err.message : 'Could not reach backend');
      });
  }, [isOpen]);

  async function handleGenerate() {
    if (emotions.length === 0) return;
    setIsGenerating(true);
    setGenError(null);
    setProgress(0);
    setProgressLabel('queued');
    try {
      const clips = await generateClips(characterName, emotions, (state) => {
        setProgress(state.progress);
        const doneCount = Object.keys(state.clips).length;
        setProgressLabel(`${doneCount} / ${emotions.length} clips ready`);
      });
      setClipsInStore(avatar, clips);
      setPreviewEmotion(null);
      showToastGlobal('Live Portrait clips generated.', 'success');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  }

  function handleClear() {
    clearClipsInStore(avatar);
    showToastGlobal('Live Portrait clips cleared.', 'info');
    setPreviewEmotion(null);
  }

  const hasClips = !!existingClips && Object.keys(existingClips).length > 0;

  // Pre-gate on the row-level provenance the backend also enforces (its 403 on
  // /api/live-portrait/generate). The gate here is advisory only: a row can
  // read as cleared while generation still 403s (the backend re-hashes the
  // live avatar bytes and fails closed), so the genError panel below must keep
  // rendering the server's detail text as the fallback.
  const provenanceBlocked = !avatarProvenanceAllowsSelfies(avatarProvenance);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Live Portrait setup" size="lg">
      <div className="space-y-3">
        <p className="text-xs text-[var(--color-text-secondary)]">
          Generate a small set of animated clips for this character. They're saved once and
          played in chat — idle when the AI isn't talking, and a per-emotion clip when it is.
          Costs about $0.10–0.20 per character on the API; afterwards it's free per reply.
        </p>

        {provenanceBlocked && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <AlertCircle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-400">
              Not cleared — this character's avatar isn't a known fictional/AI-generated
              image, so animating it is blocked (the same avatar gate as selfies). To clear
              it, choose a new avatar in the Edit dialog and check the fictional/AI-generated
              attestation.
            </p>
          </div>
        )}

        {emotionsError && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-400">
              Backend not reachable: {emotionsError}. Make sure the SillyTavern server is
              running and the deployment includes the Live Portrait route.
            </p>
          </div>
        )}

        {genError && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-400">{genError}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-6">
          {/* Source preview */}
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-text-secondary)] mb-1">
              source avatar
            </p>
            <img
              src={imageUrl}
              alt={characterName}
              className="block max-h-[320px] rounded select-none"
              draggable={false}
            />
          </div>

          {/* Live preview — only available once clips exist */}
          {hasClips && existingClips && (
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wide text-[var(--color-text-secondary)] mb-1">
                live preview
              </p>
              <LivePortraitVideo
                clips={existingClips}
                emotion={previewEmotion}
                size={320}
                shape="square"
              />
              <div className="flex flex-wrap gap-1 mt-2 max-w-[320px]">
                <button
                  type="button"
                  onClick={() => setPreviewEmotion(null)}
                  className={`text-[10px] px-2 py-0.5 rounded ${
                    previewEmotion === null
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  idle
                </button>
                {Object.keys(existingClips)
                  .filter((e) => e !== 'idle')
                  .map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setPreviewEmotion(e)}
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        previewEmotion === e
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                      }`}
                    >
                      {e}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Progress */}
        {isGenerating && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
              <Loader2 size={12} className="animate-spin" />
              <span>{progressLabel || 'starting…'}</span>
            </div>
            <div className="h-1.5 rounded bg-[var(--color-bg-tertiary)] overflow-hidden">
              <div
                className="h-full bg-[var(--color-primary)] transition-[width] duration-500"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)]">
              Each clip takes ~30–90s. The whole set usually finishes in 3–8 minutes total.
            </p>
          </div>
        )}

        {hasClips && !isGenerating && (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle2 size={14} />
            <span>{Object.keys(existingClips!).length} clips saved.</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-[var(--color-border)]">
          {hasClips && !isGenerating && (
            <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
              Clear saved
            </Button>
          )}
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isGenerating}>
            {isGenerating ? 'Running…' : 'Close'}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleGenerate}
            disabled={isGenerating || emotions.length === 0 || provenanceBlocked}
          >
            {isGenerating ? (
              <>
                <Loader2 size={14} className="animate-spin mr-1.5" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles size={14} className="mr-1.5" />
                {hasClips ? 'Regenerate' : 'Generate clips'}
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
