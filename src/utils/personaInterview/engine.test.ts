import { describe, expect, it, vi } from 'vitest';
import { runFinalDraft, runInterviewTurn } from './engine';
import {
  PERSONA_FINAL_DRAFT_REPAIR_INSTRUCTION,
  PERSONA_INTERVIEW_REPAIR_INSTRUCTION,
  PERSONA_INTERVIEW_SYSTEM,
  buildInterviewStateBlock,
} from './prompts';
import { initialInterviewState } from './types';
import type { InterviewState, LlmCall } from './types';

function fakeLlmSequence(responses: string[]): LlmCall {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r;
  });
}

const VALID_TURN_JSON = JSON.stringify({
  say: 'What should I call you?',
  patch: { name: 'Mara' },
  coverage: { identity: 'partial' },
  done: false,
});

describe('runInterviewTurn', () => {
  it('sends the exact expected messages (transcript kind stripped) and folds the turn', async () => {
    const currentState: InterviewState = {
      ...initialInterviewState(),
      transcript: [
        { role: 'user', content: 'I want to play a medic.', kind: 'text' },
        { role: 'assistant', content: 'Nice — what should I call you?' },
      ],
    };
    const llm = fakeLlmSequence([VALID_TURN_JSON]);

    const result = await runInterviewTurn(currentState, 'Call me Mara.', llm, { messageKind: 'text' });

    expect(llm).toHaveBeenCalledTimes(1);
    const [messages, opts] = (llm as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages).toEqual([
      { role: 'system', content: PERSONA_INTERVIEW_SYSTEM },
      { role: 'user', content: buildInterviewStateBlock(currentState) },
      { role: 'user', content: 'I want to play a medic.' },
      { role: 'assistant', content: 'Nice — what should I call you?' },
      { role: 'user', content: 'Call me Mara.' },
    ]);
    for (const m of messages) expect(m).not.toHaveProperty('kind');
    expect(opts).toEqual({ maxTokens: 1024, signal: undefined });

    expect(result.turn.say).toBe('What should I call you?');
    expect(result.nextState.draft.name).toBe('Mara');
    expect(result.nextState.coverage.identity).toBe('partial');
    expect(result.nextState.exchangeCount).toBe(1);
    // The user turn is tagged with its kind; the assistant turn is appended.
    expect(result.nextState.transcript.at(-2)).toEqual({
      role: 'user',
      content: 'Call me Mara.',
      kind: 'text',
    });
    expect(result.nextState.transcript.at(-1)).toEqual({
      role: 'assistant',
      content: 'What should I call you?',
    });
  });

  it('re-asks once on a parse failure, then succeeds', async () => {
    const llm = fakeLlmSequence(['this is not json', VALID_TURN_JSON]);
    const result = await runInterviewTurn(initialInterviewState(), 'hi', llm, { messageKind: 'text' });

    expect(llm).toHaveBeenCalledTimes(2);
    const repairCall = (llm as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(repairCall.at(-1)).toEqual({
      role: 'user',
      content: PERSONA_INTERVIEW_REPAIR_INSTRUCTION,
    });
    expect(result.turn.say).toBe('What should I call you?');
    expect(result.nextState.draft.name).toBe('Mara');
  });

  it('degrades gracefully on a double parse failure, recovering say via lenientSay', async () => {
    // Truncated JSON — valid enough for lenientSay to recover the say, but
    // not a parseable object either time.
    const truncated = '{"say":"Tell me more about yourself.","patch":{"na';
    const llm = fakeLlmSequence([truncated, truncated]);
    const result = await runInterviewTurn(initialInterviewState(), 'hi', llm, { messageKind: 'text' });

    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.turn.say).toBe('Tell me more about yourself.');
    expect(result.turn.done).toBe(false);
    // No patch/coverage applied from an unparseable turn.
    expect(result.nextState.draft.name).toBe('');
    expect(result.nextState.exchangeCount).toBe(1);
  });

  it('never dumps raw JSON when it cannot recover a say', async () => {
    const jsonNoSay = '{"patch":{"name":"Mara"}}';
    const llm = fakeLlmSequence([jsonNoSay, jsonNoSay]);
    const result = await runInterviewTurn(initialInterviewState(), 'hi', llm, { messageKind: 'text' });
    expect(result.turn.say).not.toContain('{');
    expect(result.turn.say.length).toBeGreaterThan(0);
  });
});

describe('runFinalDraft', () => {
  it('parses a { name, description } object', async () => {
    const finalJson = JSON.stringify({
      name: 'Mara',
      description: 'a wry field medic who trusts slowly and jokes to deflect.',
    });
    const llm = fakeLlmSequence([finalJson]);
    const result = await runFinalDraft(initialInterviewState(), llm);
    expect(result.draft.name).toBe('Mara');
    expect(result.draft.description).toContain('field medic');
  });

  it('re-asks once, then falls back to the running draft on a double failure', async () => {
    const state: InterviewState = {
      ...initialInterviewState(),
      draft: { name: 'Mara', description: 'a running draft description' },
    };
    const llm = fakeLlmSequence(['garbage', 'still garbage']);
    const result = await runFinalDraft(state, llm);

    expect(llm).toHaveBeenCalledTimes(2);
    const repairCall = (llm as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(repairCall.at(-1)).toEqual({
      role: 'user',
      content: PERSONA_FINAL_DRAFT_REPAIR_INSTRUCTION,
    });
    expect(result.draft).toEqual(state.draft);
  });

  it('keeps running-draft values for fields the synthesis omits', async () => {
    const state: InterviewState = {
      ...initialInterviewState(),
      draft: { name: 'Mara', description: 'kept description' },
    };
    const llm = fakeLlmSequence([JSON.stringify({ name: 'Mara Vex' })]);
    const result = await runFinalDraft(state, llm);
    expect(result.draft.name).toBe('Mara Vex');
    expect(result.draft.description).toBe('kept description');
  });
});
