// Character interview — pure engine over an injected LlmCall.
//
// No store imports, no network — mirrors storyIngest's own passes
// (coldStart.ts/transcriptWalk.ts): every model call goes through the
// injected `llm`, and a parse failure degrades gracefully rather than
// throwing. Only a thrown error from `llm()` itself (network/abort)
// propagates to the caller (characterInterviewStore.ts), which already
// catches it.

import { firstJsonObject } from '../llm/json';
import {
  FINAL_DRAFT_REPAIR_INSTRUCTION,
  FINAL_DRAFT_SYSTEM,
  INTERVIEW_REPAIR_INSTRUCTION,
  INTERVIEW_SYSTEM,
  buildFinalDraftPrompt,
  buildInterviewStateBlock,
} from './prompts';
import { applyPatch, normalizeLoreEntry, parseInterviewTurn } from './patch';
import { mergeCoverage } from './coverage';
import type {
  FinalDraftResult,
  InterviewDraft,
  InterviewMessage,
  InterviewState,
  InterviewTurnResult,
  LlmCall,
  StagedLoreEntry,
} from './types';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const FALLBACK_SAY = "Sorry, I lost my train of thought — could you say that again?";

/** Run one turn of the interview: build the call, parse the response
 *  (with one repair re-ask on a parse failure, degrading to a raw-text
 *  turn if that also fails), then fold the result into a new
 *  InterviewState. */
export async function runInterviewTurn(
  currentState: InterviewState,
  userMessage: string,
  llm: LlmCall,
  opts: { messageKind?: 'text' | 'control'; signal?: AbortSignal } = {}
): Promise<InterviewTurnResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: INTERVIEW_SYSTEM },
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
      { role: 'user', content: INTERVIEW_REPAIR_INSTRUCTION },
    ];
    const repairedRaw = await llm(repairMessages, { maxTokens: 1024, signal: opts.signal });
    turn = parseInterviewTurn(repairedRaw);

    if (!turn) {
      // Degrade gracefully: never throw for a parse failure. Use the
      // ORIGINAL raw response as the shown text (not the repair attempt's),
      // trimmed, falling back to a short static line if even that's empty.
      const trimmedRaw = raw.trim();
      turn = { say: trimmedRaw || FALLBACK_SAY, done: false };
    }
  }

  const transcript: InterviewMessage[] = [
    ...currentState.transcript,
    { role: 'user', content: userMessage, kind: opts.messageKind ?? 'text' },
  ];

  const { draft, newLore } = applyPatch(currentState.draft, turn.patch);
  const coverage = mergeCoverage(currentState.coverage, turn.coverage);

  transcript.push({ role: 'assistant', content: turn.say });

  const stagedLore = newLore.length > 0 ? [...currentState.stagedLore, ...newLore] : currentState.stagedLore;

  const nextState: InterviewState = {
    transcript,
    draft,
    coverage,
    stagedLore,
    exchangeCount: currentState.exchangeCount + 1,
  };

  return { turn, nextState };
}

function fieldFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function fieldListFallback(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Synthesize the final, polished card from the whole conversation. On a
 *  double parse failure (initial + one repair re-ask), falls back to
 *  returning the running draft/lore accumulated so far rather than a dead
 *  end — never throws for a parse failure. */
export async function runFinalDraft(
  state: InterviewState,
  llm: LlmCall,
  signal?: AbortSignal
): Promise<FinalDraftResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: FINAL_DRAFT_SYSTEM },
    { role: 'user', content: buildFinalDraftPrompt(state) },
  ];

  const raw = await llm(messages, { maxTokens: 4096, signal });
  let obj = firstJsonObject(raw);

  if (!obj) {
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: FINAL_DRAFT_REPAIR_INSTRUCTION },
    ];
    const repairedRaw = await llm(repairMessages, { maxTokens: 4096, signal });
    obj = firstJsonObject(repairedRaw);
  }

  if (!obj) {
    // Both attempts failed to produce valid JSON — fall back to the
    // running draft so the creator still gets something to review.
    return { draft: state.draft, lore: state.stagedLore };
  }

  const draft: InterviewDraft = {
    name: fieldFallback(obj.name, ''),
    description: fieldFallback(obj.description, ''),
    personality: fieldFallback(obj.personality, ''),
    first_mes: fieldFallback(obj.first_mes, ''),
    scenario: fieldFallback(obj.scenario, ''),
    mes_example: fieldFallback(obj.mes_example, ''),
    alternate_greetings: fieldListFallback(obj.alternate_greetings),
    tags: fieldListFallback(obj.tags),
    creator_notes: fieldFallback(obj.creator_notes, ''),
  };

  const lore: StagedLoreEntry[] = Array.isArray(obj.lore)
    ? obj.lore.map(normalizeLoreEntry).filter((e): e is StagedLoreEntry => e !== null)
    : [];

  return { draft, lore };
}
