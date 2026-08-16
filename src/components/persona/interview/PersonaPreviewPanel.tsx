import { User } from 'lucide-react';
import { TOPIC_IDS, type TopicId, type TopicStatus } from '../../../utils/personaInterview/types';
import { usePersonaInterviewStore } from '../../../stores/personaInterviewStore';

/** Short UI labels per topic. Exported so PersonaInterviewChat's "Skip topic"
 *  picker uses the same wording as this panel's coverage dots. */
export const TOPIC_LABELS: Record<TopicId, string> = {
  identity: 'Identity',
  personality: 'Personality',
  details: 'Details',
};

/** Four visual states, per the status dot: pending (hollow), partial (half
 *  fill), done (solid fill), skipped (faint + struck-through label). */
const STATUS_DOT_CLASS: Record<TopicStatus, string> = {
  pending: 'bg-transparent border border-[var(--color-text-secondary)]/40',
  partial: 'bg-[var(--color-primary)]/50',
  done: 'bg-[var(--color-primary)]',
  skipped: 'bg-[var(--color-text-secondary)]/40',
};

const STATUS_LABEL_CLASS: Record<TopicStatus, string> = {
  pending: 'text-[var(--color-text-secondary)]/60',
  partial: 'text-[var(--color-text-primary)]',
  done: 'text-[var(--color-text-primary)]',
  skipped: 'text-[var(--color-text-secondary)]/60 line-through',
};

/** Read-only live view of the in-progress persona, plus a per-topic coverage
 *  strip. Used in both the desktop side panel and the mobile "View persona"
 *  bottom sheet. */
export function PersonaPreviewPanel() {
  const interview = usePersonaInterviewStore((s) => s.interview);
  const avatarDataUrl = usePersonaInterviewStore((s) => s.avatarDataUrl);
  const { draft, coverage } = interview;

  const hasAnyDraftContent = draft.name || draft.description;

  return (
    <div className="p-4 space-y-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
          Coverage
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {TOPIC_IDS.map((topic) => {
            const status = coverage[topic];
            return (
              <span
                key={topic}
                title={`${TOPIC_LABELS[topic]}: ${status}`}
                className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--color-border)] ${STATUS_LABEL_CLASS[status]}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT_CLASS[status]}`} />
                {TOPIC_LABELS[topic]}
              </span>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Persona so far
        </h3>

        {avatarDataUrl && (
          <div className="w-16 h-16 rounded-full overflow-hidden bg-[var(--color-bg-tertiary)] flex items-center justify-center border-2 border-[var(--color-border)]">
            <img src={avatarDataUrl} alt="Persona avatar" className="w-full h-full object-cover" />
          </div>
        )}

        {!hasAnyDraftContent && (
          <p className="text-xs text-[var(--color-text-secondary)] flex items-center gap-1.5">
            <User size={14} />
            Nothing captured yet — keep chatting.
          </p>
        )}

        {draft.name && (
          <div>
            <p className="text-[11px] font-medium text-[var(--color-text-secondary)] mb-0.5">Name</p>
            <p className="text-sm text-[var(--color-text-primary)]">{draft.name}</p>
          </div>
        )}
        {draft.description && (
          <div>
            <p className="text-[11px] font-medium text-[var(--color-text-secondary)] mb-0.5">Description</p>
            <p className="text-xs text-[var(--color-text-primary)] leading-relaxed whitespace-pre-wrap">
              {draft.description}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
