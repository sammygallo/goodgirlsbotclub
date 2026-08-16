// Persona interview — coverage merging. Copy-and-adapted from
// characterInterview/coverage.ts (same terminal-locking semantics), keyed
// to the persona topic set.

import type { CoverageState, PersonaDraft, TopicId, TopicStatus } from './types';

const TERMINAL: readonly TopicStatus[] = ['done', 'skipped'];

/** Merge a turn's coverage delta into the running CoverageState. A topic
 *  already in a terminal state ('done'/'skipped') is never downgraded or
 *  overwritten by a later delta — the FIRST terminal state wins. Everything
 *  else (pending/partial) takes whatever the delta says, including
 *  'skipped' (the model may legitimately emit that when reacting to a
 *  skip-topic control message). Returns the SAME `current` reference when
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
 *  mutates `current`) unless the topic is already 'skipped'. */
export function markTopicSkipped(current: CoverageState, topic: TopicId): CoverageState {
  if (current[topic] === 'skipped') return current;
  return { ...current, [topic]: 'skipped' };
}

/** Gates the UI's manual "Finish now" action — the minimum for a
 *  synthesizable persona is a name (createPersona itself only requires a
 *  name; the description is drafted/edited in review). */
export function isReadyToFinish(draft: PersonaDraft): boolean {
  return draft.name.trim().length > 0;
}
