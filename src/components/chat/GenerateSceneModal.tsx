/**
 * GenerateSceneModal — confirm a scene render before real GPU spend.
 *
 * Two modes, decided by the backend's motion menu (`GET /api/scene-video/drivers`):
 *
 * - **Motion-menu mode** (self-hosted Wan-Animate backend active): the user
 *   picks a motion from the curated driver menu and generates. No LLM
 *   summarization runs — on this path the worker builds the keyframe from the
 *   character's portrait server-side and the driver clip supplies ALL motion,
 *   so scene text and beats have nothing to steer (free-form motion prompts
 *   were the old approach and lost to the base model's covering prior).
 *
 * - **Beats mode** (Replicate path, menu empty): the active text model
 *   summarizes the recent transcript into a scene description + an ordered
 *   motion-beat shot list → the user edits the scene text (beats render
 *   read-only) → Generate hands scene + beats back to ChatView. If
 *   summarization fails, the raw message text is prefilled with no beats.
 */
import { useEffect, useRef, useState } from 'react';
import { Clapperboard, Loader2, PersonStanding, Sparkles } from 'lucide-react';
import { Modal, Button, TextArea } from '../ui';
import { useSettingsStore } from '../../stores/settingsStore';
import { summarizeScene } from '../../utils/sceneFromTranscript';
import { fetchSceneDrivers, type SceneDriver } from '../../api/sceneVideoGen';
import type { TranscriptMsg } from '../../utils/lorebookFromTranscript';

interface GenerateSceneModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Transcript tail ending at the chosen message, macros already resolved. */
  messages: TranscriptMsg[];
  characterName: string;
  characterDescription?: string;
  /** The chosen message's processed text — used when summarization fails. */
  fallbackPrompt: string;
  onGenerate: (prompt: string, beats: string[], driverId?: string) => void;
}

type Phase = 'preparing' | 'summarizing' | 'review' | 'motion';

export function GenerateSceneModal({
  isOpen,
  onClose,
  messages,
  characterName,
  characterDescription,
  fallbackPrompt,
  onGenerate,
}: GenerateSceneModalProps) {
  const [phase, setPhase] = useState<Phase>('preparing');
  const [prompt, setPrompt] = useState('');
  const [beats, setBeats] = useState<string[]>([]);
  const [drivers, setDrivers] = useState<SceneDriver[]>([]);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSummarize = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('summarizing');
    setNotice(null);

    try {
      const { activeProvider, activeModel } = useSettingsStore.getState();
      const result = await summarizeScene(messages, characterName, {
        characterDescription,
        provider: activeProvider,
        model: activeModel,
        signal: controller.signal,
      });
      setPrompt(result.scene);
      setBeats(result.beats);
      setPhase('review');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setNotice(
        `Scene summary failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }. Starting from the message text instead — edit freely.`
      );
      setPrompt(fallbackPrompt);
      setBeats([]);
      setPhase('review');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  // On open: ask the backend for the motion menu first. Non-empty → the
  // self-hosted animate path (no LLM call, pick a motion); empty → the
  // Replicate beats flow with the transcript summarizer.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setPhase('preparing');
    setPrompt('');
    setBeats([]);
    setDriverId(null);
    setNotice(null);
    void (async () => {
      const menu = await fetchSceneDrivers();
      if (cancelled) return;
      if (menu.length > 0) {
        setDrivers(menu);
        // The API contract still requires a prompt; the message text rides
        // along for logging even though the driver supplies the motion.
        setPrompt(fallbackPrompt);
        setPhase('motion');
      } else {
        setDrivers([]);
        void runSummarize();
      }
    })();
    return () => {
      cancelled = true;
    };
    // Inputs are snapshotted by ChatView when it opens the modal;
    // intentionally only re-run on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Abort any in-flight summary if the modal unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleClose = () => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Generate scene video" size="lg">
      {phase === 'preparing' && (
        <div className="flex items-center gap-3 py-4 text-[var(--color-text-primary)]">
          <Loader2 size={20} className="animate-spin text-[var(--color-primary)]" />
          <span className="text-sm">Checking the render pipeline…</span>
        </div>
      )}

      {phase === 'motion' && (
        <div className="space-y-4">
          <div>
            <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">
              Motion
            </div>
            <div className="flex flex-wrap gap-2">
              {drivers.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setDriverId(d.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-colors ${
                    driverId === d.id
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/15 text-[var(--color-text-primary)]'
                      : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)]/60'
                  }`}
                >
                  <PersonStanding size={16} />
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Builds a scene keyframe from {characterName}'s portrait, then renders
            the chosen motion onto it on GGBC's own GPU (≈$1 per scene). A cold
            render takes 10–15 minutes — you can keep chatting while it runs.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={() => onGenerate(prompt.trim() || fallbackPrompt, [], driverId ?? undefined)}
              disabled={driverId === null}
            >
              <Clapperboard size={16} className="mr-2" />
              Generate
            </Button>
          </div>
        </div>
      )}

      {phase === 'summarizing' && (
        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3 text-[var(--color-text-primary)]">
            <Loader2 size={20} className="animate-spin text-[var(--color-primary)]" />
            <span className="text-sm">
              Summarizing the scene from the last {messages.length} message
              {messages.length === 1 ? '' : 's'}…
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                abortRef.current?.abort();
                setNotice(null);
                setPrompt(fallbackPrompt);
                setBeats([]);
                setPhase('review');
              }}
            >
              Skip — use message text
            </Button>
          </div>
        </div>
      )}

      {phase === 'review' && (
        <div className="space-y-4">
          {notice && (
            <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
              {notice}
            </div>
          )}

          <TextArea
            label="Scene prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
          />

          {beats.length > 0 && (
            <div>
              <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                Shot list ({beats.length} shots) — re-summarize to regenerate
              </div>
              <ol className="space-y-1">
                {beats.map((beat, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-xs text-[var(--color-text-secondary)]"
                  >
                    <span className="text-[var(--color-primary)] font-semibold flex-shrink-0">
                      {i + 1}.
                    </span>
                    <span>{beat}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Builds a scene keyframe from {characterName}'s portrait, then
            animates it through {beats.length > 0 ? `${beats.length} shots` : 'the scene'}{' '}
            (~15s) via Replicate (currently ≈$0.18 per scene). The render takes
            a few minutes — you can keep chatting while it runs.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button variant="ghost" onClick={() => void runSummarize()}>
              <Sparkles size={16} className="mr-2" />
              Re-summarize
            </Button>
            <Button
              onClick={() => onGenerate(prompt.trim(), beats)}
              disabled={prompt.trim().length === 0}
            >
              <Clapperboard size={16} className="mr-2" />
              Generate
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
