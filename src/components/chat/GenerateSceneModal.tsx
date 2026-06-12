/**
 * GenerateSceneModal — review/edit the scene prompt before a paid render.
 *
 * Flow: on open, the active text model summarizes the recent transcript into
 * a video prompt (one call, a few seconds) → the user edits or rewrites it →
 * Generate hands the final prompt back to ChatView, which runs the existing
 * scene-video job. If summarization fails (no provider, stream error), the
 * raw message text is prefilled instead so the feature still works.
 *
 * The render itself is real Replicate spend (~30s of per-second-billed video),
 * which is why a confirm step sits between the menu tap and the job.
 */
import { useEffect, useRef, useState } from 'react';
import { Clapperboard, Loader2, Sparkles } from 'lucide-react';
import { Modal, Button, TextArea } from '../ui';
import { useSettingsStore } from '../../stores/settingsStore';
import { summarizeScene } from '../../utils/sceneFromTranscript';
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
  onGenerate: (prompt: string) => void;
}

type Phase = 'summarizing' | 'review';

export function GenerateSceneModal({
  isOpen,
  onClose,
  messages,
  characterName,
  characterDescription,
  fallbackPrompt,
  onGenerate,
}: GenerateSceneModalProps) {
  const [phase, setPhase] = useState<Phase>('summarizing');
  const [prompt, setPrompt] = useState('');
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
      setPrompt(result);
      setPhase('review');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setNotice(
        `Scene summary failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }. Starting from the message text instead — edit freely.`
      );
      setPrompt(fallbackPrompt);
      setPhase('review');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  // Fresh summary each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setPrompt('');
    void runSummarize();
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
            rows={7}
          />

          <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Renders three 10-second segments (~30s total) with {characterName}
            's portrait as the identity reference. Replicate bills per second
            of video output (currently ≈$3 per scene) and the render takes a
            few minutes — you can keep chatting while it runs.
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
              onClick={() => onGenerate(prompt.trim())}
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
