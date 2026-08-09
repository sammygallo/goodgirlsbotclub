import { TOPIC_IDS, type TopicId, type TopicStatus } from '../../../utils/characterInterview/types';
import { useCharacterInterviewStore } from '../../../stores/characterInterviewStore';

/** Short UI labels per topic — derived from TOPIC_PROMPTS' descriptions in
 *  prompts.ts, but kept terse for chips/pills rather than the model-facing
 *  prose. Exported so InterviewChat's "Skip topic" picker uses the same
 *  wording as this panel's coverage dots. */
export const TOPIC_LABELS: Record<TopicId, string> = {
  concept: 'Concept',
  identity: 'Identity',
  appearance: 'Appearance',
  personality: 'Personality',
  voice: 'Voice',
  scenario: 'Scenario',
  relationship: 'Relationship',
  greeting: 'Greeting',
  examples: 'Examples',
  world: 'World',
  tags: 'Tags',
};

/** Four distinct visual states, per the status dot: pending (faint/hollow),
 *  partial (half-opacity fill), done (solid fill), skipped (faint + struck
 *  through label). */
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

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function PreviewField({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[11px] font-medium text-[var(--color-text-secondary)] mb-0.5">{label}</p>
      <p className="text-xs text-[var(--color-text-primary)] leading-relaxed whitespace-pre-wrap">{value}</p>
    </div>
  );
}

/** Read-only live view of the in-progress draft, plus a per-topic coverage
 *  strip. Used both in the desktop side panel and the mobile "View card"
 *  bottom sheet — same content either way. */
export function CardPreviewPanel() {
  const interview = useCharacterInterviewStore((s) => s.interview);
  const { draft, coverage, stagedLore } = interview;

  const hasAnyDraftContent =
    draft.name || draft.description || draft.personality || draft.scenario || draft.first_mes;

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
          Character so far
        </h3>

        {!hasAnyDraftContent && (
          <p className="text-xs text-[var(--color-text-secondary)]">Nothing captured yet — keep chatting.</p>
        )}

        <PreviewField label="Name" value={draft.name} />
        <PreviewField label="Description" value={truncate(draft.description, 240)} />
        <PreviewField label="Personality" value={truncate(draft.personality, 180)} />
        <PreviewField label="Scenario" value={truncate(draft.scenario, 160)} />
        <PreviewField label="Greeting" value={truncate(draft.first_mes, 200)} />

        {draft.tags.length > 0 && (
          <div>
            <p className="text-[11px] font-medium text-[var(--color-text-secondary)] mb-1">Tags</p>
            <div className="flex flex-wrap gap-1">
              {draft.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {stagedLore.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            World / Lore ({stagedLore.length})
          </h3>
          <ul className="space-y-1">
            {stagedLore.map((entry, i) => (
              <li key={i} className="text-xs text-[var(--color-text-secondary)] truncate">
                • {entry.title || entry.keys[0] || 'Untitled'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
