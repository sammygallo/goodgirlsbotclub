// Persona interview — prompts.
//
// Unlike the character interview, this does NOT open with
// HOUSE_STYLE_SYSTEM_PREFIX: that block is about writing a fictional
// character card (it steers the model toward {{char}}/{{user}} macros and
// card-shaped prose). A persona is the USER's own profile — its description
// is injected verbatim as `[The user you're talking to is {name}. {desc}]`
// (see chatStore.ts), so it must be plain third-person prose about the user,
// with literal names and no macros.

import type { CoverageState, InterviewState, TopicId } from './types';

/** Model turns beyond this trigger a "wrap up" nudge in the state block; the
 *  UI's own cap enforcement happens a little past this — see
 *  personaInterviewStore.ts. Shorter than the character cap (10) because a
 *  persona has far less to cover. */
export const PERSONA_INTERVIEW_EXCHANGE_CAP = 6;

const TOPIC_PROMPTS: Record<TopicId, string> = {
  identity: 'their name, and who they are at a glance',
  personality: 'how they come across — temperament, how they speak and act',
  details: 'appearance, background, or anything else the AI should know about them',
};

export const PERSONA_INTERVIEW_SYSTEM = `You are helping someone create a "persona" — the profile of who THEY are in a roleplay chat. A persona is the user's self-insert: the person the AI treats as the one it's talking to, not a character on the other side of the conversation. You interview them one short exchange at a time and fill in just two fields: a name and a description.

How to run the interview:
- Ask ONE thing at a time. 1-3 sentences. Warm, curious, specific — react to what they just told you before moving on, don't just fire the next scripted question.
- Cover ground naturally, not in a fixed order: ${Object.entries(TOPIC_PROMPTS).map(([id, desc]) => `${id} (${desc})`).join('; ')}. Follow what they seem excited about; you don't need equal weight on every topic, and "details" is genuinely optional.
- The persona is the USER, not a character they're talking to — never write dialogue or a scene, and never invent a story partner. You're describing the person behind the keyboard as they want to be seen in chats.
- Write "description" as third-person profile prose about them ("a wry, guarded field medic who trusts slowly…"), phrased to read naturally right after the sentence "The user you're talking to is {name}." So do NOT restate their name at the start of the description, and don't use {{char}}/{{user}} style macros — use their actual name and plain prose.
- If an answer implies several things at once, capture all of it in one patch rather than asking three separate follow-ups for things they already told you.
- If the user says "you decide" (or anything like it) about the current topic, invent something that fits everything established so far, patch it in, and tell them what you went with in one line — don't ask them to confirm it.
- When you have a name and a real sense of who they are, you may set "done": true — but the user's own "Finish now" always overrides you, so don't stall waiting for a "perfect" interview.

Output contract — return ONLY a single JSON object, no prose outside it, no markdown fences:
{"say": "your next question or reaction, 1-3 sentences", "patch": {"name": "", "description": ""}, "coverage": {"identity": "done"}, "suggestions": ["short quick-reply", "another"], "done": false}
- "patch" only includes the field(s) THIS turn's answer actually informs — omit anything untouched, don't restate the whole draft every turn.
- "coverage" only includes the topic(s) this turn's answer touched, each set to "partial" (touched but thin) or "done" (solidly covered) — omit topics untouched this turn. Never set "skipped" yourself; that's the user's own action.
- "suggestions" are optional short quick-reply chips (2-4 words each) for the question you just asked — omit if nothing sensible fits.`;

/** Compact per-call context: draft summary + coverage + exchange count +
 *  wrap-up flag. Sent as the first user-role message each turn, ahead of the
 *  replayed transcript. */
export function buildInterviewStateBlock(
  state: InterviewState,
  cap: number = PERSONA_INTERVIEW_EXCHANGE_CAP
): string {
  const lines: string[] = [];
  lines.push(`[State — not shown to the user]`);
  lines.push(`Exchange ${state.exchangeCount + 1} of ~${cap}.`);
  if (state.exchangeCount >= cap - 2) {
    lines.push(
      `Getting close to the exchange budget — start steering toward a natural close over the next turn or two rather than opening new topics.`
    );
  }

  lines.push(`Coverage so far: ${formatCoverage(state.coverage)}`);

  const draftSummary = summarizeDraft(state);
  lines.push(draftSummary ? `Draft so far:\n${draftSummary}` : `Draft so far: nothing captured yet.`);

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
  if (draft.description) lines.push(`Description: ${truncate(draft.description, 400)}`);
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Sent as the first user-role message when the conversation is brand new
 *  (no transcript yet) — the model's very first turn has no user message to
 *  react to, so it needs an explicit "start the interview" nudge. */
export const PERSONA_INTERVIEW_OPENING_PROMPT = `The user just opened the persona wizard. Ask your first question — a warm, open invitation to tell you who they want to be in their chats (a name and a sketch of the person). Don't ask about anything else yet.`;

/** Control messages injected into the transcript as the user's own turn when
 *  they use a UI action instead of typing — phrased as if the user said
 *  them, so the model reacts the same way it would to typed text. */
export const CONTROL_MESSAGES = {
  skipTopic: (topic: TopicId) =>
    `(Skip this topic for now — move on to something else. Mark "${topic}" as skipped in coverage rather than done or partial.)`,
  youDecide: `(You decide — invent something that fits what's established so far, patch it in, and tell me what you went with.)`,
  finishNow: `(That's enough for now — wrap up. Set "done": true and use "say" to let me know you're finishing up, don't ask anything further.)`,
};

export const PERSONA_INTERVIEW_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object matching the required shape. Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;

/**
 * Final synthesis: reads the WHOLE conversation and produces one polished
 * name + description. This is where the description gets its coherent final
 * form — mid-interview patches are small and incremental; the final pass
 * makes the whole thing read as one profile.
 */
export const PERSONA_FINAL_DRAFT_SYSTEM = `You are writing the final version of a user's persona (their self-insert profile) from a full interview transcript. You have the whole conversation and the patches gathered along the way — use ALL of it, not just the running draft, since something mentioned in passing early on may not have made it into a patch.

Produce exactly two fields:
- "name": the persona's name.
- "description": third-person profile prose describing who the user is — who they are, how they come across, appearance, and any background that came up. Synthesize this from everything said; don't just concatenate patches. Write it to read naturally right after the sentence "The user you're talking to is {name}." — so do NOT begin by restating the name, and do NOT use {{char}}/{{user}} macros. Roughly 2-5 sentences. If the conversation was thin, write the best short description you can from what's there rather than padding with invention.

Output rule: return ONLY a JSON object, no prose, no markdown fences, shape {"name": "", "description": ""}.`;

export function buildFinalDraftPrompt(state: InterviewState): string {
  const transcript = state.transcript
    .map((m) => `${m.role === 'user' ? 'User' : 'Interviewer'}: ${m.content}`)
    .join('\n\n');
  const lines = [
    `Full interview transcript:`,
    transcript || '(no exchanges — the user finished immediately)',
    '',
    'Final persona (JSON object):',
  ];
  return lines.join('\n');
}

export const PERSONA_FINAL_DRAFT_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object matching the required shape. Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;
