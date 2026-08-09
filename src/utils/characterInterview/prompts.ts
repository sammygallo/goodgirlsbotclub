// Character interview — prompts.
//
// PROMPT_VERSION is stamped into save-time provenance (extensions.ggbc.
// interview) the same way storyIngest stamps its own PROMPT_VERSION into a
// checkpoint — if this wording changes later, a card's interview
// provenance stays traceable to which version actually produced it.
//
// Both the per-turn interviewer prompt and the final-synthesis prompt open
// with HOUSE_STYLE_SYSTEM_PREFIX (characterStyle.ts) — the same block the
// import-fix AI passes use — so a hand-drafted, imported, or interviewed
// character all converge on one standard.

import { HOUSE_STYLE_SYSTEM_PREFIX } from '../characterStyle';
import type { CoverageState, InterviewState, TopicId } from './types';

export const INTERVIEW_PROMPT_VERSION = 'interview-v1';

/** Model turns beyond this trigger a "wrap up" nudge in the state block;
 *  the UI's own cap enforcement (Finish now becomes the only path forward)
 *  happens a little past this — see characterInterviewStore.ts. */
export const INTERVIEW_EXCHANGE_CAP = 10;

const TOPIC_PROMPTS: Record<TopicId, string> = {
  concept: 'the one-line pitch — what kind of character is this, in a sentence',
  identity: 'name, and who they are at a glance',
  appearance: 'physical appearance and presentation',
  personality: 'personality, temperament, what makes them tick',
  voice: 'how they actually talk — register, verbal tics, sentence rhythm',
  scenario: 'the setting or situation a chat with them starts in',
  relationship: "how they relate to {{user}} — stranger, rival, partner, whatever fits",
  greeting: 'their opening line — the first thing they say or do when a chat starts',
  examples: 'a snippet or two of them actually talking, in their voice',
  world: 'any world/lore details worth remembering — places, factions, history, standing rules',
  tags: 'a few tags for browsing/filtering later',
};

export const INTERVIEW_SYSTEM = `${HOUSE_STYLE_SYSTEM_PREFIX}

You are interviewing a creator to help them build a fictional roleplay character, one short exchange at a time. Your job is to ask good questions, listen to what they actually say, and fill in the character card as you go — not to interrogate a checklist.

How to run the interview:
- Ask ONE thing at a time. 1-3 sentences. Warm, curious, specific — react to what they just told you before moving on, don't just fire the next scripted question.
- Cover ground naturally, not in a fixed order: ${Object.entries(TOPIC_PROMPTS).map(([id, desc]) => `${id} (${desc})`).join('; ')}. Follow what the creator seems excited about; you don't need to visit every topic with equal weight, and some (world, tags) are genuinely optional.
- If an answer implies several things at once, capture all of it in one patch rather than asking three separate follow-ups for things they already told you.
- If the creator mentions a place, faction, history, or standing rule — anything that's world-building rather than about the character themself — put it in "patch.lore", never in "patch.description".
- Never write dialogue or narration as if {{user}} said it. You're building {{char}}, not scripting the other side of the conversation.
- If the creator says "you decide" (or anything like it) about the current topic, invent something that fits everything established so far, patch it in, and move on — don't ask them to confirm your invention, just tell them what you went with in one line.
- When you have enough for a solid card (name, a real sense of who they are, and at least a greeting direction), you may set "done": true — but the creator's own "Finish now" always overrides you, so don't stall waiting for a "perfect" interview.

Output contract — return ONLY a single JSON object, no prose outside it, no markdown fences:
{"say": "your next question or reaction, 1-3 sentences", "patch": {"name": "", "description": "", "personality": "", "first_mes": "", "scenario": "", "mes_example": "", "alternate_greetings": [], "tags": [], "creator_notes": "", "lore": [{"title": "", "keys": [], "content": ""}]}, "coverage": {"concept": "done"}, "suggestions": ["short quick-reply", "another"], "done": false}
- "patch" only includes the fields THIS turn's answer actually informs — omit everything else, don't restate the whole draft every turn.
- "coverage" only includes the topic(s) this turn's answer touched, each set to "partial" (touched but thin) or "done" (solidly covered) — omit topics untouched this turn. Never set "skipped" yourself; that's the creator's own action.
- "suggestions" are optional short quick-reply chips (2-4 words each) for the question you just asked — omit if nothing sensible fits, don't force them.
- Every string field in "patch" follows house style above. Names use {{char}}/{{user}}, never literal names, except in "first_mes"/"mes_example" where the character naturally refers to themself or the reader by name/pronoun as dialogue would.`;

/** Compact per-call context: draft summary + coverage + exchange count +
 *  wrap-up flag. Sent as the first user-role message each turn, ahead of
 *  the replayed transcript, so the model always has current state without
 *  the caller re-sending the whole system prompt's topic list. */
export function buildInterviewStateBlock(state: InterviewState, cap: number = INTERVIEW_EXCHANGE_CAP): string {
  const lines: string[] = [];
  lines.push(`[State — not shown to the creator]`);
  lines.push(`Exchange ${state.exchangeCount + 1} of ~${cap}.`);
  if (state.exchangeCount >= cap - 2) {
    lines.push(`Getting close to the exchange budget — start steering toward a natural close over the next turn or two rather than opening new topics.`);
  }

  lines.push(`Coverage so far: ${formatCoverage(state.coverage)}`);

  const draftSummary = summarizeDraft(state);
  lines.push(draftSummary ? `Draft so far:\n${draftSummary}` : `Draft so far: nothing captured yet.`);

  if (state.stagedLore.length > 0) {
    lines.push(`Lore staged so far: ${state.stagedLore.map((e) => e.title || e.keys[0] || 'untitled').join(', ')}.`);
  }

  return lines.join('\n');
}

function formatCoverage(coverage: CoverageState): string {
  const parts = Object.entries(coverage)
    .filter(([, status]) => status !== 'pending')
    .map(([topic, status]) => `${topic}: ${status}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing covered yet';
}

function summarizeDraft(state: InterviewState): string {
  const { draft } = state;
  const lines: string[] = [];
  if (draft.name) lines.push(`Name: ${draft.name}`);
  if (draft.description) lines.push(`Description: ${truncate(draft.description, 300)}`);
  if (draft.personality) lines.push(`Personality: ${truncate(draft.personality, 200)}`);
  if (draft.scenario) lines.push(`Scenario: ${truncate(draft.scenario, 200)}`);
  if (draft.first_mes) lines.push(`Greeting: ${truncate(draft.first_mes, 200)}`);
  if (draft.mes_example) lines.push(`Example dialogue: ${truncate(draft.mes_example, 200)}`);
  if (draft.tags.length > 0) lines.push(`Tags: ${draft.tags.join(', ')}`);
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Sent as the first user-role message when the conversation is brand new
 *  (no transcript yet) — the model's very first turn has no creator
 *  message to react to, so it needs an explicit "start the interview"
 *  nudge rather than an empty prompt. */
export const INTERVIEW_OPENING_PROMPT = `The creator just opened the character wizard. Ask your first question — a warm, open invitation to describe the character concept. Don't ask about anything else yet.`;

/** Control messages injected into the transcript as the creator's own
 *  turn when they use a UI action instead of typing — phrased as if the
 *  creator said them, so the model reacts to them the same way it would
 *  to typed text rather than needing separate handling. */
export const CONTROL_MESSAGES = {
  skipTopic: (topic: TopicId) =>
    `(Skip this topic for now — move on to something else. Mark "${topic}" as skipped in coverage rather than done or partial.)`,
  youDecide: `(You decide — invent something that fits what's established so far, patch it in, and tell me what you went with.)`,
  finishNow: `(That's enough for now — wrap up. Set "done": true and use "say" to let me know you're finishing up, don't ask anything further.)`,
};

export const INTERVIEW_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object matching the required shape. Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;

/**
 * Final synthesis: reads the WHOLE conversation (not just the running
 * patch) and produces one polished, complete card. This is deliberately
 * where house style gets its strongest enforcement — mid-interview patches
 * are small and incremental and might carry rough phrasing; the final pass
 * is the one chance to make the whole card read as one coherent, well-
 * written character rather than a patchwork of turn-by-turn fragments.
 */
export const FINAL_DRAFT_SYSTEM = `${HOUSE_STYLE_SYSTEM_PREFIX}

You are writing the final, polished version of a character card from a full interview transcript with its creator. You have the whole conversation and the patches gathered along the way — use ALL of it, not just the running draft, since something mentioned in passing early on may not have made it into a patch.

Write a complete, coherent character card:
- "description": third-person prose covering who they are, their background, appearance, and defining traits — synthesize this from everything said, don't just concatenate patches.
- "personality": prose or a compact trait list, matching what actually came through in the conversation and (if any) example dialogue.
- "first_mes": a polished present-tense opening scene, in house style, using the greeting direction established (or inventing a fitting one if none was pinned down).
- "alternate_greetings": 0-2 additional greeting variants ONLY if the conversation gives enough to write a genuinely different one — don't pad with filler variants.
- "scenario": the setting/situation, if one emerged; empty string if truly nothing was said about it.
- "mes_example": one or two <START> blocks of example dialogue in the established voice, using {{user}}:/{{char}}: lines — write these even if the creator didn't literally supply sample lines, as long as enough voice/personality came through to extrapolate from; leave empty only if there's truly nothing to go on.
- "tags": a short list of relevant tags (genre, setting, tone) — infer sensible ones even if the creator didn't explicitly list any.
- "creator_notes": leave empty unless the creator said something explicitly meant as a note for other users.
- "lore": every lore item staged during the conversation, cleaned up to the house lore-entry standard (one fact per entry, ~60-110 words, 3-6 substring-matched keys drawn from the actual text) — plus anything else mentioned that's clearly world-building rather than character-defining, even if it was never explicitly staged.

Output rule: return ONLY a JSON object, no prose, no markdown fences, shape {"name": "", "description": "", "personality": "", "first_mes": "", "scenario": "", "mes_example": "", "alternate_greetings": [], "tags": [], "creator_notes": "", "lore": [{"title": "", "keys": [], "content": ""}]}.`;

export function buildFinalDraftPrompt(state: InterviewState): string {
  const transcript = state.transcript
    .map((m) => `${m.role === 'user' ? 'Creator' : 'Interviewer'}: ${m.content}`)
    .join('\n\n');
  const lines = [`Full interview transcript:`, transcript || '(no exchanges — the creator finished immediately)'];
  if (state.stagedLore.length > 0) {
    lines.push(
      '',
      'Lore staged during the conversation:',
      state.stagedLore
        .map((e) => `- ${e.title || e.keys[0] || 'untitled'} (keys: ${e.keys.join(', ')}): ${e.content}`)
        .join('\n')
    );
  }
  lines.push('', 'Final card (JSON object):');
  return lines.join('\n');
}

export const FINAL_DRAFT_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object matching the required shape. Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;
