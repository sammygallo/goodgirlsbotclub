/**
 * Renders one `PromptCapture` (E2-S3) — the exact array `api.generateMessage`
 * received for one dispatch, after both chatStore transforms. Pure props-in,
 * like `PromptBreakdownView`: `PromptCaptureSheet` and `UsagePage` each
 * resolve their own capture (and, when it applies, their own attribution)
 * from `useGenerationStore` and hand both down.
 *
 * The body renders role-labelled blocks only when the array is non-empty and
 * every element is exactly `{ role, content }` with string values — an
 * interceptor can replace the array with anything JSON-serializable, and
 * falling back to `JSON.stringify` is the one rendering that stays honest
 * for any other shape, including an element carrying extra keys.
 */
import type { PromptCapture, CaptureAttribution } from '../../utils/promptCapture';

interface PromptCaptureViewProps {
  capture: PromptCapture;
  /** `null` when attribution wasn't computed or didn't verify — see
   *  `computeCaptureAttribution`'s own doc comment for when that happens. */
  attribution: CaptureAttribution | null;
}

function isRoleContentArray(
  messages: readonly unknown[]
): messages is { role: string; content: string }[] {
  if (messages.length === 0) return false;
  return messages.every((m) => {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
    const keys = Object.keys(m as Record<string, unknown>);
    return (
      keys.length === 2 &&
      typeof (m as Record<string, unknown>).role === 'string' &&
      typeof (m as Record<string, unknown>).content === 'string'
    );
  });
}

export function PromptCaptureView({ capture, attribution }: PromptCaptureViewProps) {
  const messages = capture.messages;
  // Defensive, on top of `computeCaptureAttribution` already refusing to
  // compute one for either transform path: a caller passing a stale or
  // mismatched attribution alongside a transformed capture must not make it
  // onto the screen as a section label.
  const effectiveAttribution =
    capture.collapsedByInstruct || capture.replacedByInterceptor ? null : attribution;
  const labelsByIndex = new Map<number, string[]>();
  if (effectiveAttribution) {
    for (const entry of effectiveAttribution) labelsByIndex.set(entry.index, entry.labels);
  }

  const capturedAtStr = new Date(capture.capturedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="space-y-3 text-sm text-[var(--color-text-primary)]">
      <div className="text-xs text-[var(--color-text-secondary)] space-y-0.5">
        <p>
          Seam: <span className="font-medium">{capture.seam}</span> · Provider:{' '}
          <span className="font-medium">
            {capture.provider}/{capture.model}
            {capture.usedFallback ? ' (fallback)' : ''}
          </span>{' '}
          · Captured {capturedAtStr}
        </p>
        {capture.imagesFolded > 0 && (
          <p>
            Image attachments: {capture.imagesFolded} — not part of the captured array, not shown
            below.
          </p>
        )}
      </div>

      <div className="space-y-1.5 text-xs">
        {capture.collapsedByInstruct && (
          <p className="text-[var(--color-text-secondary)]">
            Instruct mode collapsed this prompt into a single user turn before it was sent.
            Section attribution is unavailable — collapsed by instruct mode.
          </p>
        )}
        {capture.replacedByInterceptor && (
          <p className="text-[var(--color-text-secondary)]">
            An extension&apos;s generate-interceptor replaced this payload before it was sent.
            Section attribution is unavailable — payload was replaced.
          </p>
        )}
        {capture.textCompletionMode && (
          <p className="text-[var(--color-text-secondary)]">
            Text completion mode: the provider client joins these contents into a single prompt
            string after this capture. The array below is what it received.
          </p>
        )}
      </div>

      {isRoleContentArray(messages) ? (
        <div className="space-y-2">
          {messages.map((m, i) => (
            <div
              key={i}
              className="rounded-md bg-[var(--color-bg-tertiary)] p-2 text-xs font-mono whitespace-pre-wrap break-words"
            >
              <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">
                {m.role}
                {labelsByIndex.has(i) ? ` — ${labelsByIndex.get(i)!.join(', ')}` : ''}
              </div>
              {m.content}
            </div>
          ))}
        </div>
      ) : (
        <pre className="rounded-md bg-[var(--color-bg-tertiary)] p-2 text-xs font-mono whitespace-pre-wrap break-words overflow-x-auto">
          {JSON.stringify(messages, null, 2)}
        </pre>
      )}
    </div>
  );
}
