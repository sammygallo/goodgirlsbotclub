import { describe, expect, it, vi } from 'vitest';
import { runFinalDraft, runInterviewTurn } from './engine';
import {
  FINAL_DRAFT_REPAIR_INSTRUCTION,
  FINAL_DRAFT_SYSTEM,
  INTERVIEW_REPAIR_INSTRUCTION,
  INTERVIEW_SYSTEM,
  buildFinalDraftPrompt,
  buildInterviewStateBlock,
} from './prompts';
import { emptyCoverage, emptyDraft, initialInterviewState } from './types';
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
  say: 'What kind of character do you have in mind?',
  patch: { name: 'Aria' },
  coverage: { concept: 'partial' },
  done: false,
});

describe('runInterviewTurn', () => {
  it('happy path: sends the exact expected messages, with transcript kind stripped', async () => {
    const currentState: InterviewState = {
      ...initialInterviewState(),
      transcript: [
        { role: 'user', content: 'I want a knight character.', kind: 'text' },
        { role: 'assistant', content: 'Great, tell me more about her.' },
      ],
    };
    const llm = fakeLlmSequence([VALID_TURN_JSON]);

    const result = await runInterviewTurn(currentState, 'Her name is Aria.', llm, { messageKind: 'text' });

    expect(llm).toHaveBeenCalledTimes(1);
    const [messages, opts] = (llm as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages).toEqual([
      { role: 'system', content: INTERVIEW_SYSTEM },
      { role: 'user', content: buildInterviewStateBlock(currentState) },
      { role: 'user', content: 'I want a knight character.' },
      { role: 'assistant', content: 'Great, tell me more about her.' },
      { role: 'user', content: 'Her name is Aria.' },
    ]);
    // No `kind` field should have leaked through onto any replayed message.
    for (const m of messages) expect(m).not.toHaveProperty('kind');
    expect(opts).toEqual({ maxTokens: 2048, signal: undefined });

    expect(result.turn.say).toBe('What kind of character do you have in mind?');
    expect(result.nextState.draft.name).toBe('Aria');
    expect(result.nextState.coverage.concept).toBe('partial');
    expect(result.nextState.exchangeCount).toBe(1);

    // Transcript grows by the new user turn (kind preserved for the UI)
    // and the new assistant turn.
    expect(result.nextState.transcript).toHaveLength(4);
    expect(result.nextState.transcript[2]).toEqual({
      role: 'user',
      content: 'Her name is Aria.',
      kind: 'text',
    });
    expect(result.nextState.transcript[3]).toEqual({
      role: 'assistant',
      content: 'What kind of character do you have in mind?',
    });

    // currentState itself must not be mutated.
    expect(currentState.transcript).toHaveLength(2);
    expect(currentState.exchangeCount).toBe(0);
  });

  it('defaults messageKind to "text" when opts.messageKind is omitted', async () => {
    const currentState = initialInterviewState();
    const llm = fakeLlmSequence([VALID_TURN_JSON]);
    const result = await runInterviewTurn(currentState, 'Hello', llm, {});
    expect(result.nextState.transcript[0].kind).toBe('text');
  });

  it('repair-reask path: retries once on invalid JSON, succeeds on the second call', async () => {
    const currentState = initialInterviewState();
    const llm = fakeLlmSequence(['not json at all', VALID_TURN_JSON]);

    const result = await runInterviewTurn(currentState, 'Hi', llm);

    expect(llm).toHaveBeenCalledTimes(2);
    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls;
    const secondMessages = calls[1][0];
    // Same messages as the first call, plus the model's own failed response
    // as an assistant turn, plus the repair instruction as a user turn.
    expect(secondMessages.slice(0, -2)).toEqual(calls[0][0]);
    expect(secondMessages.at(-2)).toEqual({ role: 'assistant', content: 'not json at all' });
    expect(secondMessages.at(-1)).toEqual({ role: 'user', content: INTERVIEW_REPAIR_INSTRUCTION });
    expect(calls[1][1]).toEqual({ maxTokens: 2048, signal: undefined });

    expect(result.turn.say).toBe('What kind of character do you have in mind?');
    expect(result.nextState.draft.name).toBe('Aria');
  });

  it('double-failure path: falls back to raw text, does not throw, done is false', async () => {
    const currentState = initialInterviewState();
    const llm = fakeLlmSequence(['complete garbage, no json here', 'still garbage']);

    const result = await runInterviewTurn(currentState, 'Hi', llm);

    expect(llm).toHaveBeenCalledTimes(2);
    // Falls back to the ORIGINAL raw response, not the repair attempt's.
    expect(result.turn.say).toBe('complete garbage, no json here');
    expect(result.turn.done).toBe(false);
    expect(result.turn.patch).toBeUndefined();
    expect(result.turn.coverage).toBeUndefined();
    // The turn is still appended to the transcript and the exchange count
    // still advances — a degraded turn is still a turn.
    expect(result.nextState.exchangeCount).toBe(1);
    expect(result.nextState.transcript.at(-1)).toEqual({
      role: 'assistant',
      content: 'complete garbage, no json here',
    });
  });

  it('falls back to a static message when even the raw response is empty', async () => {
    const currentState = initialInterviewState();
    const llm = fakeLlmSequence(['   ', '']);

    const result = await runInterviewTurn(currentState, 'Hi', llm);

    expect(result.turn.say.length).toBeGreaterThan(0);
    expect(result.turn.say).not.toBe('   ');
  });

  it('double-failure path: falls back to a static message rather than dumping raw JSON when `say` is valid but empty on both attempts', async () => {
    const currentState = initialInterviewState();
    // Well-formed, non-truncated JSON on both calls, but `say` itself is
    // empty — parseInterviewTurn rejects it (patch.ts requires a non-empty
    // say), and lenientSay can't recover a usable value either. The raw
    // response IS JSON-shaped, so it must not be shown verbatim.
    const emptySayJson = JSON.stringify({ say: '', patch: { name: 'Aria' }, done: false });
    const llm = fakeLlmSequence([emptySayJson, emptySayJson]);

    const result = await runInterviewTurn(currentState, 'Hi', llm);

    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.turn.say).not.toContain('{');
    expect(result.turn.say).not.toContain('"patch"');
    expect(result.turn.say.length).toBeGreaterThan(0);
  });

  it('double-failure path: recovers just `say` from JSON truncated mid-patch instead of dumping the raw fragment', async () => {
    const currentState = initialInterviewState();
    // Cut off mid-`patch`, as an output-cap truncation would: no closing
    // brace, so firstJsonObject finds nothing balanced on either attempt.
    const truncated =
      '{"say":"Here\'s what I came up with — let me know if the tone lands.","patch":{"description":"A vampire of indeterminate';
    const llm = fakeLlmSequence([truncated, truncated]);

    const result = await runInterviewTurn(currentState, 'You decide.', llm);

    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.turn.say).toBe("Here's what I came up with — let me know if the tone lands.");
    expect(result.turn.done).toBe(false);
    expect(result.turn.patch).toBeUndefined();
    expect(result.nextState.transcript.at(-1)).toEqual({
      role: 'assistant',
      content: "Here's what I came up with — let me know if the tone lands.",
    });
  });

  it('propagates a thrown error from llm() rather than swallowing it', async () => {
    const currentState = initialInterviewState();
    const llm: LlmCall = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(runInterviewTurn(currentState, 'Hi', llm)).rejects.toThrow('network down');
  });

  it('appends new lore to stagedLore without mutating the input array', async () => {
    const currentState = initialInterviewState();
    const raw = JSON.stringify({
      say: 'Got it.',
      patch: { lore: [{ keys: ['keep'], content: 'A ruined keep on the hill.' }] },
      done: false,
    });
    const llm = fakeLlmSequence([raw]);
    const result = await runInterviewTurn(currentState, 'There is an old keep nearby.', llm);
    expect(result.nextState.stagedLore).toEqual([{ keys: ['keep'], content: 'A ruined keep on the hill.' }]);
    expect(currentState.stagedLore).toEqual([]);
  });
});

const VALID_FINAL_DRAFT_JSON = JSON.stringify({
  name: 'Aria',
  description: 'A brave knight who guards the old castle.',
  personality: 'Brave, loyal, a little stubborn.',
  first_mes: '*Aria draws her sword.* "Stay behind me."',
  scenario: 'A castle under siege at dusk.',
  mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Hello there.',
  alternate_greetings: [],
  tags: ['knight', 'fantasy'],
  creator_notes: '',
  lore: [{ title: 'The Old Keep', keys: ['keep'], content: 'A ruined keep on the hill.' }],
});

function stateWithTranscript(): InterviewState {
  return {
    transcript: [
      { role: 'user', content: 'I want a knight character.', kind: 'text' },
      { role: 'assistant', content: 'Great, tell me more.' },
    ],
    draft: { ...emptyDraft(), name: 'Aria (draft)' },
    coverage: emptyCoverage(),
    stagedLore: [{ keys: ['old-keep'], content: 'Staged mid-conversation.' }],
    exchangeCount: 2,
  };
}

describe('runFinalDraft', () => {
  it('happy path: sends FINAL_DRAFT_SYSTEM + buildFinalDraftPrompt, parses the full card', async () => {
    const state = stateWithTranscript();
    const llm = fakeLlmSequence([VALID_FINAL_DRAFT_JSON]);

    const result = await runFinalDraft(state, llm, undefined);

    expect(llm).toHaveBeenCalledTimes(1);
    const [messages, opts] = (llm as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages).toEqual([
      { role: 'system', content: FINAL_DRAFT_SYSTEM },
      { role: 'user', content: buildFinalDraftPrompt(state) },
    ]);
    expect(opts).toEqual({ maxTokens: 4096, signal: undefined });

    expect(result.draft.name).toBe('Aria');
    expect(result.draft.tags).toEqual(['knight', 'fantasy']);
    expect(result.lore).toEqual([{ title: 'The Old Keep', keys: ['keep'], content: 'A ruined keep on the hill.' }]);
  });

  it('defaults omitted fields to "" / [] rather than undefined', async () => {
    const state = stateWithTranscript();
    const llm = fakeLlmSequence([JSON.stringify({ name: 'Aria' })]);
    const result = await runFinalDraft(state, llm, undefined);
    expect(result.draft).toEqual({
      name: 'Aria',
      description: '',
      personality: '',
      first_mes: '',
      scenario: '',
      mes_example: '',
      alternate_greetings: [],
      tags: [],
      creator_notes: '',
    });
    expect(result.lore).toEqual([]);
  });

  it('repair path: retries once on invalid JSON, succeeds on the second call', async () => {
    const state = stateWithTranscript();
    const llm = fakeLlmSequence(['not json', VALID_FINAL_DRAFT_JSON]);

    const result = await runFinalDraft(state, llm, undefined);

    expect(llm).toHaveBeenCalledTimes(2);
    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls;
    const secondMessages = calls[1][0];
    expect(secondMessages.slice(0, -2)).toEqual(calls[0][0]);
    expect(secondMessages.at(-2)).toEqual({ role: 'assistant', content: 'not json' });
    expect(secondMessages.at(-1)).toEqual({ role: 'user', content: FINAL_DRAFT_REPAIR_INSTRUCTION });
    expect(result.draft.name).toBe('Aria');
  });

  it('total-failure path: falls back to the running draft/lore, does not throw', async () => {
    const state = stateWithTranscript();
    const llm = fakeLlmSequence(['garbage', 'still garbage']);

    const result = await runFinalDraft(state, llm, undefined);

    expect(llm).toHaveBeenCalledTimes(2);
    expect(result.draft).toBe(state.draft);
    expect(result.lore).toBe(state.stagedLore);
  });

  it('propagates a thrown error from llm() rather than swallowing it', async () => {
    const state = stateWithTranscript();
    const llm: LlmCall = vi.fn(async () => {
      throw new Error('aborted');
    });
    await expect(runFinalDraft(state, llm, undefined)).rejects.toThrow('aborted');
  });
});
