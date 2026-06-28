import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Send, Mic, Paperclip, Square, X, Image, Menu, Puzzle } from 'lucide-react';
import { CommandAutocomplete } from './CommandAutocomplete';
import { ContextMeter } from './ContextMeter';
import { Button } from '../ui';
import { useSlotItems, invokeSlotItem } from '../../extensions/sandbox/sandboxSlotRegistry';
import {
  compressImageFiles,
  ACCEPTED_IMAGE_MIMES,
  MAX_IMAGES_PER_MESSAGE,
} from '../../utils/images';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { haptic } from '../../utils/haptics';
import { getSpeechLanguage } from '../../hooks/speechLanguage';
import { getEnterToSendMode } from '../../hooks/displayPreferences';

interface ChatInputProps {
  /** Called with the trimmed text plus any staged image data URLs. */
  onSend: (message: string, images?: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  prefillText?: string;
  prefillNonce?: number;
  /** Phase 6.1: drag-dropped images from the chat scroll region. Parent
   *  passes a fresh array each time it wants to APPEND to the staged
   *  set; the nonce is bumped on every drop so the same payload retriggers
   *  the effect. Passing an empty array with a new nonce is a no-op. */
  droppedImages?: string[];
  droppedImagesNonce?: number;
  /** Called when the user presses ArrowUp in an empty input — edit last message. */
  onEditLast?: () => void;
  /** Phase 7.1: open the image generation modal. */
  onImageGen?: () => void;
  /** Open the chat options menu. Receives the trigger element for desktop positioning. */
  onOpenChatMenu?: (anchor: HTMLElement) => void;
}

/** How long a mic button press must be held before it flips from
 *  tap-to-toggle into push-to-talk mode. 300ms is long enough to avoid
 *  accidental PTT from slightly-long taps but short enough that holding
 *  down feels responsive. */
const LONG_PRESS_MS = 300;

/** Prefix a base message with a separator so appended dictation reads
 *  naturally. No space added if baseText is empty or already ends in
 *  whitespace. */
function composeWithBase(baseText: string, transcript: string): string {
  if (!baseText) return transcript;
  if (/\s$/.test(baseText)) return baseText + transcript;
  return baseText + ' ' + transcript;
}

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Type a message...',
  prefillText,
  prefillNonce,
  droppedImages,
  droppedImagesNonce,
  onEditLast,
  onImageGen,
  onOpenChatMenu,
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sandbox extension-contributed chat-input buttons
  const inputExtras = useSlotItems('chatInputExtras');

  // Phase 8.7: derive autocomplete prefix from message
  const autocompletePrefix = useMemo<string | null>(() => {
    if (!showAutocomplete) return null;
    const trimmed = message.trimStart();
    if (!trimmed.startsWith('/')) return null;
    // Extract text after / up to first space
    const match = trimmed.match(/^\/(\w*)$/);
    if (match) return match[1];
    return null;
  }, [message, showAutocomplete]);

  // Speech-to-text. Snapshot the textarea contents when start() fires so
  // dictation APPENDS rather than replacing. baseTextRef is the only place
  // this is tracked — message itself gets live-overwritten by interim
  // results while listening, and either reverts to baseText (abort/error)
  // or commits to baseText+finalText (normal stop).
  const baseTextRef = useRef('');
  // Flipped true whenever the hook emits a final transcript; read after
  // isListening→false to decide whether to preserve or discard interim.
  const gotFinalRef = useRef(false);
  const handleFinalResult = useCallback((transcript: string) => {
    gotFinalRef.current = true;
    setMessage(composeWithBase(baseTextRef.current, transcript));
  }, []);
  const {
    isSupported: isSpeechSupported,
    isListening,
    interimTranscript,
    permissionState,
    error: speechError,
    start: startListening,
    stop: stopListening,
    abort: abortListening,
  } = useSpeechRecognition({
    lang: getSpeechLanguage(),
    onFinalResult: handleFinalResult,
  });

  // Mirror interim transcript into the textarea as dictation streams in.
  // The hook clears interimTranscript on end, at which point the final
  // callback has already committed the real text — so we skip mirroring
  // once isListening flips false.
  useEffect(() => {
    if (isListening) {
      setMessage(composeWithBase(baseTextRef.current, interimTranscript));
    }
  }, [isListening, interimTranscript]);

  // Handle isListening transitions: reset the final-received flag on
  // start, and revert to baseText on end if no final was emitted (abort,
  // error, or empty dictation). Separate from the mirror effect so it
  // runs only at the edges.
  const prevListeningRef = useRef(false);
  useEffect(() => {
    const wasListening = prevListeningRef.current;
    prevListeningRef.current = isListening;
    if (isListening && !wasListening) {
      gotFinalRef.current = false;
    } else if (!isListening && wasListening) {
      if (!gotFinalRef.current) {
        setMessage(baseTextRef.current);
      }
    }
  }, [isListening]);

  // Begin a dictation session. Factored out because tap, long-press, and
  // Ctrl+Space all funnel through it. We read `message` via a ref so the
  // callback identity stays stable across keystrokes — otherwise the
  // global keyboard-shortcut effect would re-run on every character
  // typed.
  const messageRef = useRef(message);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);
  const beginDictation = useCallback(() => {
    if (!isSpeechSupported || disabled) return;
    baseTextRef.current = messageRef.current;
    startListening();
  }, [isSpeechSupported, disabled, startListening]);

  // Long-press / pointer state for PTT. pttTimerRef is the arming timer;
  // if it fires we start listening and flip pttActiveRef so pointerup
  // becomes a PTT release rather than a second toggle.
  const pttTimerRef = useRef<number | null>(null);
  const pttActiveRef = useRef(false);

  const clearPttTimer = () => {
    if (pttTimerRef.current !== null) {
      window.clearTimeout(pttTimerRef.current);
      pttTimerRef.current = null;
    }
  };

  const handleMicPointerDown = (e: React.PointerEvent) => {
    if (!isSpeechSupported || disabled) return;
    // Ignore right-click and middle-click.
    if (e.button !== 0) return;
    // If already listening, the pointerdown is a stop-tap — handled on
    // pointerup to keep long-press logic simple.
    if (isListening) return;
    pttActiveRef.current = false;
    clearPttTimer();
    pttTimerRef.current = window.setTimeout(() => {
      pttActiveRef.current = true;
      beginDictation();
    }, LONG_PRESS_MS);
  };

  const handleMicPointerUp = () => {
    clearPttTimer();
    if (pttActiveRef.current) {
      // Long-press release: stop and commit.
      pttActiveRef.current = false;
      stopListening();
    } else if (isListening) {
      // Short tap while listening: stop and commit.
      stopListening();
    } else {
      // Short tap while idle: start.
      beginDictation();
    }
  };

  const handleMicPointerCancel = () => {
    clearPttTimer();
    if (pttActiveRef.current) {
      // Treat cancel (pointer left button, gesture interrupted) as PTT
      // release so the user's dictation still lands in the textarea.
      pttActiveRef.current = false;
      stopListening();
    }
  };

  const handleStopButtonClick = () => {
    stopListening();
  };

  // Ctrl+Space push-to-talk. Global listener so it works from anywhere
  // on the page, not just while the textarea is focused. kbdPttActiveRef
  // lives OUTSIDE the effect closure so re-runs (due to beginDictation
  // identity changes) don't wipe the in-flight PTT state.
  const kbdPttActiveRef = useRef(false);
  useEffect(() => {
    if (!isSpeechSupported) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !e.ctrlKey) return;
      if (e.repeat) return; // ignore auto-repeat while held
      if (disabled) return;
      e.preventDefault();
      if (!kbdPttActiveRef.current) {
        kbdPttActiveRef.current = true;
        beginDictation();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Release on any Ctrl or Space keyup so partial chord release still
      // ends the session cleanly.
      if (!kbdPttActiveRef.current) return;
      if (e.code === 'Space' || e.key === 'Control') {
        kbdPttActiveRef.current = false;
        stopListening();
      }
    };
    // Tabbing away while holding Ctrl+Space swallows the keyup, which
    // would strand kbdPttActiveRef=true until the user pressed the chord
    // again. Release PTT on blur to recover.
    const onBlur = () => {
      if (kbdPttActiveRef.current) {
        kbdPttActiveRef.current = false;
        stopListening();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [isSpeechSupported, disabled, beginDictation, stopListening]);

  // Abort any active dictation if the input becomes disabled (e.g. AI
  // started streaming a response) so the user's speech isn't captured
  // into a textarea they can't submit from. The transition effect above
  // handles the baseText revert once isListening flips false.
  useEffect(() => {
    if (disabled && isListening) {
      abortListening();
    }
  }, [disabled, isListening, abortListening]);

  // Handle prefill text (e.g. from impersonate) - nonce lets parent trigger re-prefill
  useEffect(() => {
    if (prefillText !== undefined && prefillNonce !== undefined) {
      setMessage(prefillText);
      textareaRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  // Merge drag-dropped images from parent, respecting the per-message cap.
  useEffect(() => {
    if (droppedImagesNonce === undefined) return;
    if (!droppedImages || droppedImages.length === 0) return;
    setImages((prev) => {
      const next = [...prev, ...droppedImages].slice(0, MAX_IMAGES_PER_MESSAGE);
      if (
        prev.length + droppedImages.length > MAX_IMAGES_PER_MESSAGE &&
        next.length === MAX_IMAGES_PER_MESSAGE
      ) {
        setAttachmentError(
          `Max ${MAX_IMAGES_PER_MESSAGE} images per message`
        );
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedImagesNonce]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    }
  }, [message]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const hasText = message.trim().length > 0;
    const hasImages = images.length > 0;
    if ((hasText || hasImages) && !disabled && !isCompressing && !isListening) {
      haptic();
      onSend(message.trim(), hasImages ? images : undefined);
      setMessage('');
      setImages([]);
      setAttachmentError(null);
    }
  };

  // Treat as touch if any of: coarse pointer, no hover, touch points, or mobile UA.
  // Errs toward "newline on Enter" for ambiguous hybrid devices (Surface, Chromebook
  // with touchscreen) — minor inconvenience for those, but the right default for
  // every actual phone/tablet, including Samsung Internet, Android in DeX mode,
  // and Android Chrome with a paired stylus that reports hover capability.
  const isTouchDevice =
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(hover: none)').matches ||
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
      (typeof navigator !== 'undefined' &&
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 'auto' (default): keep prior heuristic — desktop sends, touch devices newline.
      // 'always': Enter sends on every device. Shift+Enter still inserts a newline.
      // 'never': Enter always inserts a newline; user must tap the send button.
      const mode = getEnterToSendMode();
      const shouldSend =
        mode === 'always' || (mode === 'auto' && !isTouchDevice);
      if (shouldSend) {
        e.preventDefault();
        handleSubmit(e);
      }
    }
    if (e.key === 'ArrowUp' && !message.trim() && onEditLast) {
      e.preventDefault();
      onEditLast();
    }
  };

  const handlePickFiles = () => {
    if (disabled || isCompressing) return;
    fileInputRef.current?.click();
  };

  const handleFilesSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = Array.from(e.target.files ?? []);
    // Reset the input value so picking the SAME file twice in a row still
    // fires change (useful after a user cancels a preview and re-picks).
    e.target.value = '';
    if (files.length === 0) return;

    const remainingSlots = Math.max(0, MAX_IMAGES_PER_MESSAGE - images.length);
    if (remainingSlots === 0) {
      setAttachmentError(`Max ${MAX_IMAGES_PER_MESSAGE} images per message`);
      return;
    }
    const accepted = files.slice(0, remainingSlots);
    const overflow = files.length - accepted.length;

    setAttachmentError(null);
    setIsCompressing(true);
    try {
      const { dataUrls, errors } = await compressImageFiles(accepted);
      if (dataUrls.length > 0) {
        setImages((prev) =>
          [...prev, ...dataUrls].slice(0, MAX_IMAGES_PER_MESSAGE)
        );
      }
      const parts: string[] = [];
      if (overflow > 0) {
        parts.push(
          `Only kept first ${accepted.length} of ${files.length} (max ${MAX_IMAGES_PER_MESSAGE}).`
        );
      }
      if (errors.length > 0) {
        parts.push(errors.join('; '));
      }
      if (parts.length > 0) setAttachmentError(parts.join(' '));
    } finally {
      setIsCompressing(false);
    }
  };

  const handleRemoveImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
    setAttachmentError(null);
  };

  const canSubmit =
    (message.trim().length > 0 || images.length > 0) &&
    !isCompressing &&
    !isListening;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex-shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 pb-4 input-safe-bottom"
    >
      {/* Hidden file picker, driven by the paperclip button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_MIMES.join(',')}
        multiple
        onChange={handleFilesSelected}
        className="hidden"
        aria-hidden="true"
      />

      {/* Preview strip for staged images. Shown above the input row so the
          send button alignment stays consistent when attachments exist. */}
      {images.length > 0 && (
        <div
          className="flex gap-2 mb-2 overflow-x-auto pb-1"
          aria-label="Staged image attachments"
        >
          {images.map((dataUrl, idx) => (
            <div
              key={idx}
              className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]"
            >
              <img
                src={dataUrl}
                alt={`Attachment ${idx + 1}`}
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => handleRemoveImage(idx)}
                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 hover:bg-black/90 flex items-center justify-center transition-colors"
                aria-label={`Remove attachment ${idx + 1}`}
                title="Remove"
              >
                <X size={12} className="text-white" />
              </button>
            </div>
          ))}
          {isCompressing && (
            <div className="flex-shrink-0 w-16 h-16 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] flex items-center justify-center">
              <span className="text-[10px] text-[var(--color-text-secondary)]">...</span>
            </div>
          )}
        </div>
      )}

      {attachmentError && (
        <div className="mb-2 text-xs text-red-400" role="alert">
          {attachmentError}
        </div>
      )}

      {/* Speech errors surface here — the most actionable case is a
          denied mic permission, which persists across presses until the
          user fixes it in browser settings. */}
      {speechError && (
        <div className="mb-2 text-xs text-red-400" role="alert">
          {speechError}
          {permissionState === 'denied' && (
            <span className="block text-[11px] text-[var(--color-text-secondary)] mt-0.5">
              Click the mic/lock icon in your browser's address bar to re-enable.
            </span>
          )}
        </div>
      )}

      {/* Context-window fill meter — shows while composing, dismissible */}
      <ContextMeter draft={message} />

      <div className="flex items-end gap-2">
        {/* Chat Options Menu Button */}
        {onOpenChatMenu && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="p-2 flex-shrink-0"
            aria-label="Chat options"
            title="Chat options"
            onClick={(e) => onOpenChatMenu(e.currentTarget)}
            disabled={disabled && false}
          >
            <Menu size={20} />
          </Button>
        )}

        {/* Attachment Button */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="p-2 flex-shrink-0"
          aria-label="Attach image"
          onClick={handlePickFiles}
          disabled={disabled || isCompressing || images.length >= MAX_IMAGES_PER_MESSAGE || isListening}
        >
          <Paperclip size={20} />
        </Button>

        {/* Extension-contributed chat-input buttons */}
        {inputExtras.map((item) => (
          <Button
            key={`${item.frameId}:${item.itemId}`}
            type="button"
            variant="ghost"
            size="sm"
            className="p-2 flex-shrink-0"
            aria-label={item.label}
            title={item.tooltip ?? item.label}
            onClick={() =>
              invokeSlotItem(item.frameId, item.itemId, {
                text: message,
                hasImages: images.length > 0,
              })
            }
            disabled={disabled || isListening}
          >
            <Puzzle size={20} />
          </Button>
        ))}

        {/* Image Generation Button */}
        {onImageGen && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="p-2 flex-shrink-0"
            aria-label="Generate image"
            title="Generate image with AI"
            onClick={onImageGen}
            disabled={disabled || isListening}
          >
            <Image size={20} />
          </Button>
        )}

        {/* Input Area */}
        <div className="flex-1 min-w-0 flex items-end bg-[var(--color-bg-tertiary)] rounded-2xl px-4 py-2 relative">
          {/* Phase 8.7: Slash command autocomplete */}
          <CommandAutocomplete
            prefix={autocompletePrefix}
            onSelect={(name) => {
              setMessage('/' + name + ' ');
              setShowAutocomplete(false);
              textareaRef.current?.focus();
            }}
            onDismiss={() => setShowAutocomplete(false)}
          />
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              const val = e.target.value;
              setMessage(val);
              // Show autocomplete when typing a / command (no spaces yet)
              const trimmed = val.trimStart();
              setShowAutocomplete(trimmed.startsWith('/') && !trimmed.includes(' '));
            }}
            onKeyDown={handleKeyDown}
            enterKeyHint={isTouchDevice ? 'enter' : 'send'}
            placeholder={isListening ? 'Listening…' : placeholder}
            disabled={disabled || isListening}
            rows={1}
            className="flex-1 bg-transparent text-[var(--color-text-primary)] placeholder-zinc-500 resize-none focus:outline-none text-sm max-h-[150px]"
          />
        </div>

        {/* Voice / Stop / Send Button — mutually exclusive:
             - Listening → pulsing red stop
             - Ready to send → primary send
             - Speech supported, idle → mic (tap or long-press for PTT)
             - Speech unsupported, idle → nothing (send button wasn't
               going to render here anyway since canSubmit is false) */}
        {isListening ? (
          <button
            type="button"
            onClick={handleStopButtonClick}
            onPointerUp={handleMicPointerUp}
            onPointerCancel={handleMicPointerCancel}
            onPointerLeave={handleMicPointerCancel}
            className="p-2 rounded-full flex-shrink-0 bg-red-600 text-white animate-pulse hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-[var(--color-bg-primary)]"
            aria-label="Stop recording"
            title="Stop recording"
          >
            <Square size={20} fill="currentColor" />
          </button>
        ) : canSubmit ? (
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={disabled || isCompressing}
            className="p-2 rounded-full flex-shrink-0"
            aria-label="Send message"
          >
            <Send size={20} />
          </Button>
        ) : isSpeechSupported ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="p-2 flex-shrink-0 touch-none select-none"
            aria-label="Voice input (tap to dictate, hold for push-to-talk)"
            title="Tap to dictate · hold for push-to-talk · Ctrl+Space from anywhere"
            disabled={disabled}
            onPointerDown={handleMicPointerDown}
            onPointerUp={handleMicPointerUp}
            onPointerCancel={handleMicPointerCancel}
            onPointerLeave={handleMicPointerCancel}
          >
            <Mic size={20} />
          </Button>
        ) : null}
      </div>
    </form>
  );
}
