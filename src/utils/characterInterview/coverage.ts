// Character interview — coverage merging.

import type { CoverageState, InterviewDraft, TopicId, TopicStatus } from './types';

const TERMINAL: readonly TopicStatus[] = ['done', 'skipped'];

/** Merge a turn's coverage delta into the running CoverageState. A topic
 *  already in a terminal state ('done'/'skipped') is never downgraded or
 *  overwritten by a later delta, no matter what that delta says — not
 *  even another 'done'/'skipped', since the point is that the FIRST
 *  terminal state wins and nothing after it can move the topic again.
 *  Everything else (pending/partial) takes whatever the delta says,
 *  including 'skipped' — see markTopicSkipped's own doc comment for why
 *  the model may legitimately emit that itself when reacting to a
 *  skip-topic control message. Returns the SAME `current` reference when
 *  nothing actually changed. */
export function mergeCoverage(
  current: CoverageState,
  delta: Partial<Record<TopicId, TopicStatus>> | undefined
): CoverageState {
  if (!delta) return current;

  let changed = false;
  let next: CoverageState = current;

  for (const key of Object.keys(delta) as TopicId[]) {
    const status = delta[key];
    if (!status) continue;
    if (TERMINAL.includes(current[key])) continue; // terminal — never downgraded/overwritten
    if (current[key] === status) continue; // no-op, avoid a spurious "changed"

    if (!changed) {
      next = { ...current };
      changed = true;
    }
    next[key] = status;
  }

  return changed ? next : current;
}

/** Unconditionally marks `topic` as 'skipped'. Returns a NEW object (never
 *  mutates `current`) unless the topic is already 'skipped', in which case
 *  it returns the same reference as a no-op. */
export function markTopicSkipped(current: CoverageState, topic: TopicId): CoverageState {
  if (current[topic] === 'skipped') return current;
  return { ...current, [topic]: 'skipped' };
}

/** Gates the UI's manual "Finish now" action — the minimum for a
 *  synthesizable card is a name and some sense of who the character is. */
export function isReadyToFinish(draft: InterviewDraft): boolean {
  return draft.name.trim().length > 0 && draft.description.trim().length > 0;
}
