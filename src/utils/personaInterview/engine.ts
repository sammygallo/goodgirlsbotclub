// Persona interview — pure engine over an injected LlmCall.
//
// Copy-and-adapted from characterInterview/engine.ts, scoped to a persona's
// name + description (no staged lore). Same contract: no store imports, no
// network; a parse failure degrades gracefully rather than throwing, and
// only a thrown error from `llm()` itself (network/abort) propagates to the
// caller (personaInterviewStore.ts), which already catches it.

import { firstJsonObject } from '../llm/json';
import {
  PERSONA_FINAL_DRAFT_REPAIR_INSTRUCTION,
  PERSONA_FINAL_DRAFT_SYSTEM,
  PERSONA_INTERVIEW_REPAIR_INSTRUCTION,
  PERSONA_INTERVIEW_SYSTEM,
  buildFinalDraftPrompt,
  buildInterviewStateBlock,
} from './prompts';
import { applyPatch, lenientSay, parseInterviewTurn } from './patch';
import { mergeCoverage } from './coverage';
import type {
  FinalDraftResult,
  InterviewMessage,
  InterviewState,
  LlmCall,
  PersonaDraft,
  PersonaInterviewTurnResult,
} from './types';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const FALLBACK_SAY = "Sorry, I lost my train of thought — could you say that again?";

/** Run one turn of the interview: build the call, parse the response (with
 *  one repair re-ask on a parse failure, degrading to a raw-text turn if
 *  that also fails), then fold the result into a new InterviewState. */
export async function runInterviewTurn(
  currentState: InterviewState,
  userMessage: string,
  llm: LlmCall,
  opts: { messageKind?: 'text' | 'control'; signal?: AbortSignal } = {}
): Promise<PersonaInterviewTurnResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PERSONA_INTERVIEW_SYSTEM },
    { role: 'user', content: buildInterviewStateBlock(currentState) },
    // Replay the transcript — `kind` is a UI-only rendering hint and must
    // never be sent to the model.
    ...currentState.transcript.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const raw = await llm(messages, { maxTokens: 1024, signal: opts.signal });
  let turn = parseInterviewTurn(raw);

  if (!turn) {
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: PERSONA_INTERVIEW_REPAIR_INSTRUCTION },
    ];
    const repairedRaw = await llm(repairMessages, { maxTokens: 1024, signal: opts.signal });
    turn = parseInterviewTurn(repairedRaw);

    if (!turn) {
      // Degrade gracefully: never throw for a parse failure. Try lenientSay
      // on the ORIGINAL raw response (the repair re-ask is prone to the same
      // truncation/malformed-escape failure, and `raw` is what the user's
      // turn was reacting to). If raw still LOOKS like JSON but lenientSay
      // couldn't pull a usable `say` out of it, use the static fallback
      // rather than dumping raw JSON into the chat.
      const trimmedRaw = raw.trim();
      const say = lenientSay(raw) ?? (trimmedRaw.startsWith('{') ? '' : trimmedRaw);
      turn = { say: say || FALLBACK_SAY, done: false };
    }
  }

  const transcript: InterviewMessage[] = [
    ...currentState.transcript,
    { role: 'user', content: userMessage, kind: opts.messageKind ?? 'text' },
  ];

  const draft = applyPatch(currentState.draft, turn.patch);
  const coverage = mergeCoverage(currentState.coverage, turn.coverage);

  transcript.push({ role: 'assistant', content: turn.say });

  const nextState: InterviewState = {
    transcript,
    draft,
    coverage,
    exchangeCount: currentState.exchangeCount + 1,
  };

  return { turn, nextState };
}

function fieldFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/** Synthesize the final, polished persona from the whole conversation. On a
 *  double parse failure (initial + one repair re-ask), falls back to the
 *  running draft rather than a dead end — never throws for a parse failure. */
export async function runFinalDraft(
  state: InterviewState,
  llm: LlmCall,
  signal?: AbortSignal
): Promise<FinalDraftResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PERSONA_FINAL_DRAFT_SYSTEM },
    { role: 'user', content: buildFinalDraftPrompt(state) },
  ];

  const raw = await llm(messages, { maxTokens: 1024, signal });
  let obj = firstJsonObject(raw);

  if (!obj) {
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: PERSONA_FINAL_DRAFT_REPAIR_INSTRUCTION },
    ];
    const repairedRaw = await llm(repairMessages, { maxTokens: 1024, signal });
    obj = firstJsonObject(repairedRaw);
  }

  if (!obj) {
    // Both attempts failed — fall back to the running draft so the user
    // still gets something to review.
    return { draft: state.draft };
  }

  // Fall back to the running draft's value (not empty) when the synthesis
  // omits a field, so a partial final pass never wipes good captured content.
  const draft: PersonaDraft = {
    name: fieldFallback(obj.name, state.draft.name),
    description: fieldFallback(obj.description, state.draft.description),
  };

  return { draft };
}
