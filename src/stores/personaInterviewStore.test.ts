import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors characterInterviewStore.test.ts: the store constructs
// makeLlmCall(...) at module scope but never invokes it directly — every real
// call goes through engine.ts's runInterviewTurn/runFinalDraft, which this
// test mocks wholesale. Keeps the file scoped to the store's own
// orchestration (phase transitions, aborts, retries), not parsing/JSON
// (covered by the engine's own tests).
const runInterviewTurn = vi.fn();
const runFinalDraft = vi.fn();
vi.mock('../utils/personaInterview/engine', () => ({
  runInterviewTurn: (...a: unknown[]) => runInterviewTurn(...a),
  runFinalDraft: (...a: unknown[]) => runFinalDraft(...a),
}));

const { usePersonaInterviewStore } = await import('./personaInterviewStore');
const { initialInterviewState, emptyDraft } = await import('../utils/personaInterview/types');
const { PERSONA_INTERVIEW_EXCHANGE_CAP } = await import('../utils/personaInterview/prompts');

function turnResult(over: {
  say?: string;
  done?: boolean;
  coverageDelta?: Record<string, string>;
  exchangeCount?: number;
} = {}) {
  const state = initialInterviewState();
  return {
    turn: { say: over.say ?? 'Tell me more.', done: over.done ?? false, coverage: over.coverageDelta },
    nextState: {
      ...state,
      transcript: [...state.transcript, { role: 'assistant' as const, content: over.say ?? 'Tell me more.' }],
      exchangeCount: over.exchangeCount ?? state.exchangeCount + 1,
    },
  };
}

function draftResult() {
  return { draft: { ...emptyDraft(), name: 'Mara', description: 'A wry field medic.' } };
}

/** A promise the test can resolve/reject on its own schedule, to simulate an
 *  in-flight request racing against an abort/reset. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  runInterviewTurn.mockReset();
  runFinalDraft.mockReset();
  runInterviewTurn.mockResolvedValue(turnResult());
  runFinalDraft.mockResolvedValue(draftResult());
  usePersonaInterviewStore.getState().reset();
});

describe('start/sendAnswer — basic turn orchestration', () => {
  it('start() moves intro -> chat and sends the opening prompt', async () => {
    await usePersonaInterviewStore.getState().start();
    expect(usePersonaInterviewStore.getState().phase).toBe('chat');
    expect(runInterviewTurn).toHaveBeenCalledTimes(1);
    expect(runInterviewTurn.mock.calls[0][3]).toMatchObject({ messageKind: 'control' });
  });

  it('sendAnswer() is a no-op outside the chat phase', async () => {
    await usePersonaInterviewStore.getState().sendAnswer('hello');
    expect(runInterviewTurn).not.toHaveBeenCalled();
  });

  it('sendAnswer() advances the draft/transcript on success', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ say: 'What are you like?' }));
    await usePersonaInterviewStore.getState().sendAnswer('Call me Mara.');
    const { interview, error, isGenerating } = usePersonaInterviewStore.getState();
    expect(error).toBeNull();
    expect(isGenerating).toBe(false);
    expect(interview.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'What are you like?' });
  });

  it('surfaces the latest turn suggestions and clears them on the next turn', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValueOnce({
      ...turnResult(),
      turn: { say: 'Pick one', done: false, suggestions: ['A', 'B'] },
    });
    await usePersonaInterviewStore.getState().sendAnswer('go');
    expect(usePersonaInterviewStore.getState().latestSuggestions).toEqual(['A', 'B']);

    runInterviewTurn.mockResolvedValueOnce(turnResult());
    await usePersonaInterviewStore.getState().sendAnswer('A');
    expect(usePersonaInterviewStore.getState().latestSuggestions).toEqual([]);
  });

  it('a turn reaching done:true auto-triggers synthesis and lands on avatar', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ done: true }));
    runFinalDraft.mockResolvedValue(draftResult());
    await usePersonaInterviewStore.getState().sendAnswer('that is everything');
    expect(runFinalDraft).toHaveBeenCalledTimes(1);
    expect(usePersonaInterviewStore.getState().phase).toBe('avatar');
    expect(usePersonaInterviewStore.getState().interview.draft.name).toBe('Mara');
  });

  it('hitting the exchange cap auto-triggers synthesis even without done:true', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ done: false, exchangeCount: PERSONA_INTERVIEW_EXCHANGE_CAP }));
    runFinalDraft.mockResolvedValue(draftResult());
    await usePersonaInterviewStore.getState().sendAnswer('ok');
    expect(runFinalDraft).toHaveBeenCalledTimes(1);
    expect(usePersonaInterviewStore.getState().phase).toBe('avatar');
  });
});

describe('skipTopic — defensive coverage overlay', () => {
  it('marks the topic skipped when the turn succeeds', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult());
    await usePersonaInterviewStore.getState().skipTopic('personality');
    expect(usePersonaInterviewStore.getState().interview.coverage.personality).toBe('skipped');
  });

  it('does NOT mark the topic skipped when the underlying turn errors', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockRejectedValue(new Error('network down'));
    await usePersonaInterviewStore.getState().skipTopic('personality');
    const { interview, error } = usePersonaInterviewStore.getState();
    expect(interview.coverage.personality).toBe('pending');
    expect(error).toBe('network down');
  });

  it('does not resurrect a skipped topic into a store that was reset mid-flight', async () => {
    await usePersonaInterviewStore.getState().start();
    const pending = deferred<never>();
    runInterviewTurn.mockReturnValue(pending.promise);

    const skipPromise = usePersonaInterviewStore.getState().skipTopic('personality');
    // Wizard closed while the skip request is in flight: reset() aborts the
    // controller runTurn is waiting on.
    usePersonaInterviewStore.getState().reset();
    pending.reject(new DOMException('aborted', 'AbortError'));
    await skipPromise;

    expect(usePersonaInterviewStore.getState().interview).toEqual(initialInterviewState());
  });
});

describe('retryTurn — resumes from the failed step, not the whole attempt', () => {
  it('after a turn failure, retries the SAME turn (not synthesis)', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockRejectedValueOnce(new Error('boom'));
    await usePersonaInterviewStore.getState().sendAnswer('hello');
    expect(usePersonaInterviewStore.getState().error).toBe('boom');
    expect(runInterviewTurn).toHaveBeenCalledTimes(2); // start() + failed sendAnswer

    runInterviewTurn.mockResolvedValueOnce(turnResult());
    await usePersonaInterviewStore.getState().retryTurn();
    expect(runInterviewTurn).toHaveBeenCalledTimes(3);
    expect(runFinalDraft).not.toHaveBeenCalled();
    expect(usePersonaInterviewStore.getState().error).toBeNull();
  });

  it('after a synthesis failure following a SUCCESSFUL turn, retry re-runs only synthesis', async () => {
    await usePersonaInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ done: true }));
    runFinalDraft.mockRejectedValueOnce(new Error('synthesis failed'));

    await usePersonaInterviewStore.getState().sendAnswer('wrap it up');
    const turnCallsAfterFirstAttempt = runInterviewTurn.mock.calls.length;
    expect(usePersonaInterviewStore.getState().error).toBe('synthesis failed');
    expect(usePersonaInterviewStore.getState().phase).toBe('synthesizing');

    runFinalDraft.mockResolvedValueOnce(draftResult());
    await usePersonaInterviewStore.getState().retryTurn();

    // The turn itself must NOT have been sent again — only synthesis retried.
    expect(runInterviewTurn).toHaveBeenCalledTimes(turnCallsAfterFirstAttempt);
    expect(runFinalDraft).toHaveBeenCalledTimes(2);
    expect(usePersonaInterviewStore.getState().phase).toBe('avatar');
    expect(usePersonaInterviewStore.getState().error).toBeNull();
  });

  it('after finishNow fails on the closing turn itself, retry resends the closing turn', async () => {
    await usePersonaInterviewStore.getState().start();
    usePersonaInterviewStore.setState((s) => ({
      interview: { ...s.interview, draft: { ...s.interview.draft, name: 'Mara', description: 'x' } },
    }));

    runInterviewTurn.mockRejectedValueOnce(new Error('closing turn failed'));
    await usePersonaInterviewStore.getState().finishNow();
    expect(usePersonaInterviewStore.getState().error).toBe('closing turn failed');
    expect(runFinalDraft).not.toHaveBeenCalled();

    runInterviewTurn.mockResolvedValueOnce(turnResult({ done: true }));
    runFinalDraft.mockResolvedValueOnce(draftResult());
    await usePersonaInterviewStore.getState().retryTurn();
    expect(runFinalDraft).toHaveBeenCalledTimes(1);
    expect(usePersonaInterviewStore.getState().phase).toBe('avatar');
  });
});

describe('proceedToReview / setAvatarDataUrl / reset', () => {
  it('proceedToReview only works from the avatar phase', () => {
    usePersonaInterviewStore.getState().proceedToReview();
    expect(usePersonaInterviewStore.getState().phase).toBe('intro');

    usePersonaInterviewStore.setState({ phase: 'avatar' });
    usePersonaInterviewStore.getState().proceedToReview();
    expect(usePersonaInterviewStore.getState().phase).toBe('review');
  });

  it('reset() clears phase, interview, avatarDataUrl, error, and suggestions', async () => {
    await usePersonaInterviewStore.getState().start();
    usePersonaInterviewStore.setState({
      phase: 'review',
      avatarDataUrl: 'data:image/png;base64,AAA',
      error: 'stale',
      latestSuggestions: ['x'],
    });
    usePersonaInterviewStore.getState().reset();
    const s = usePersonaInterviewStore.getState();
    expect(s.phase).toBe('intro');
    expect(s.interview).toEqual(initialInterviewState());
    expect(s.avatarDataUrl).toBeNull();
    expect(s.error).toBeNull();
    expect(s.latestSuggestions).toEqual([]);
  });

  it('updateDraftField and setAvatarDataUrl write through to state', () => {
    usePersonaInterviewStore.getState().updateDraftField('name', 'Mara');
    expect(usePersonaInterviewStore.getState().interview.draft.name).toBe('Mara');

    usePersonaInterviewStore.getState().setAvatarDataUrl('data:image/png;base64,BBB');
    expect(usePersonaInterviewStore.getState().avatarDataUrl).toBe('data:image/png;base64,BBB');
  });
});
