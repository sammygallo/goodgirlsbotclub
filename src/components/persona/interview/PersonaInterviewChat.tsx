import { useEffect, useRef, useState } from 'react';
import { Send, RotateCcw, Sparkles, CheckCircle2, SkipForward } from 'lucide-react';
import { usePersonaInterviewStore } from '../../../stores/personaInterviewStore';
import { isReadyToFinish } from '../../../utils/personaInterview/coverage';
import { TOPIC_IDS, type TopicId } from '../../../utils/personaInterview/types';
import { PERSONA_INTERVIEW_OPENING_PROMPT } from '../../../utils/personaInterview/prompts';
import { TOPIC_LABELS } from './PersonaPreviewPanel';
import { Button } from '../../ui';

/** Control messages are injected into the transcript phrased as if the user
 *  said them (see CONTROL_MESSAGES in prompts.ts), so they aren't fit to
 *  show verbatim — surface a short label instead. The opening turn is also a
 *  'control' message but is filtered out of the transcript entirely (see the
 *  render loop), not labeled here. */
function controlLabel(content: string): string {
  if (content.startsWith('(Skip this topic')) {
    const match = content.match(/Mark "(\w+)" as skipped/);
    const topic = match?.[1] as TopicId | undefined;
    return topic && topic in TOPIC_LABELS ? `Skipped: ${TOPIC_LABELS[topic]}` : 'Skipped topic';
  }
  if (content.startsWith('(You decide')) return 'You decide';
  if (content.startsWith("(That's enough")) return 'Finishing up';
  return content;
}

export function PersonaInterviewChat() {
  const interview = usePersonaInterviewStore((s) => s.interview);
  const isGenerating = usePersonaInterviewStore((s) => s.isGenerating);
  const error = usePersonaInterviewStore((s) => s.error);
  const latestSuggestions = usePersonaInterviewStore((s) => s.latestSuggestions);
  const sendAnswer = usePersonaInterviewStore((s) => s.sendAnswer);
  const skipTopic = usePersonaInterviewStore((s) => s.skipTopic);
  const youDecide = usePersonaInterviewStore((s) => s.youDecide);
  const finishNow = usePersonaInterviewStore((s) => s.finishNow);
  const retryTurn = usePersonaInterviewStore((s) => s.retryTurn);

  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [interview.transcript.length, isGenerating]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || isGenerating) return;
    setText('');
    sendAnswer(trimmed);
  };

  const submitSuggestion = (suggestion: string) => {
    if (isGenerating) return;
    sendAnswer(suggestion);
  };

  const skippableTopics = TOPIC_IDS.filter(
    (t) => interview.coverage[t] === 'pending' || interview.coverage[t] === 'partial'
  );
  const readyToFinish = isReadyToFinish(interview.draft);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-3">
        {interview.transcript.length === 0 && !isGenerating && (
          <p className="text-sm text-[var(--color-text-secondary)] text-center py-8">Starting the interview…</p>
        )}
        {interview.transcript.map((msg, i) =>
          msg.kind === 'control' && msg.content === PERSONA_INTERVIEW_OPENING_PROMPT ? null : msg.kind === 'control' ? (
            <div key={i} className="flex justify-center">
              <span className="text-[11px] text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] rounded-full px-3 py-1">
                {controlLabel(msg.content)}
              </span>
            </div>
          ) : (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                }`}
              >
                {msg.content}
              </div>
            </div>
          )
        )}
        {isGenerating && (
          <div className="flex justify-start">
            <div className="bg-[var(--color-bg-tertiary)] rounded-2xl px-3.5 py-2.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-secondary)] animate-bounce" />
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 mx-4 mb-2 p-2.5 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-xs flex items-center justify-between gap-2">
          <span>{error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => retryTurn()}>
            <RotateCcw size={12} className="mr-1" />
            Retry
          </Button>
        </div>
      )}

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-[var(--color-border)] p-3 space-y-2">
        {/* Quick-reply chips for the most recent question, if it offered any */}
        {!isGenerating && latestSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {latestSuggestions.map((suggestion, i) => (
              <button
                key={i}
                type="button"
                onClick={() => submitSuggestion(suggestion)}
                className="text-xs px-2.5 py-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)]/50 transition-colors"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-end gap-2"
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Type your answer…"
            rows={1}
            disabled={isGenerating}
            className="flex-1 resize-none px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text-primary)] placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:opacity-50"
          />
          <Button type="submit" variant="primary" size="sm" disabled={isGenerating || !text.trim()}>
            <Send size={16} />
          </Button>
        </form>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <SkipForward size={12} className="text-[var(--color-text-secondary)] shrink-0" />
            <select
              disabled={isGenerating || skippableTopics.length === 0}
              value=""
              onChange={(e) => {
                const topic = e.target.value as TopicId;
                if (topic) skipTopic(topic);
              }}
              className="bg-transparent text-xs text-[var(--color-text-secondary)] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="" disabled>
                Skip topic…
              </option>
              {skippableTopics.map((t) => (
                <option key={t} value={t} className="bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]">
                  {TOPIC_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => youDecide()}
            disabled={isGenerating}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Sparkles size={12} />
            You decide
          </button>

          <button
            type="button"
            onClick={() => finishNow()}
            disabled={isGenerating || !readyToFinish}
            title={!readyToFinish ? 'Add at least a name before finishing' : undefined}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors ml-auto"
          >
            <CheckCircle2 size={12} />
            Finish now
          </button>
        </div>
      </div>
    </div>
  );
}
