import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store constructs `makeLlmCall(...)` at module scope but never invokes
// it directly — every actual call goes through engine.ts's runInterviewTurn/
// runFinalDraft, which this test mocks wholesale. So the real llmBridge is
// left in place (it's just a closure constructor, no eager side effects);
// only the engine layer — already covered by its own 64 tests — is faked
// here, keeping this file scoped to the store's own orchestration logic
// (phase transitions, aborts, retries) rather than re-testing parsing/JSON.
const runInterviewTurn = vi.fn();
const runFinalDraft = vi.fn();
vi.mock('../utils/characterInterview/engine', () => ({
  runInterviewTurn: (...a: unknown[]) => runInterviewTurn(...a),
  runFinalDraft: (...a: unknown[]) => runFinalDraft(...a),
}));

const { useCharacterInterviewStore } = await import('./characterInterviewStore');
const { initialInterviewState, emptyDraft } = await import('../utils/characterInterview/types');
const { INTERVIEW_EXCHANGE_CAP } = await import('../utils/characterInterview/prompts');

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
  return { draft: { ...emptyDraft(), name: 'Ivy', description: 'An archivist.' }, lore: [] };
}

/** A promise the test can resolve/reject on its own schedule, to simulate
 *  an in-flight request racing against an abort/reset. */
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
  // Every test starts the interview via start() before probing its own
  // scenario — give both a working default so that call succeeds, and let
  // individual tests override with a *Once variant for the turn they're
  // actually testing.
  runInterviewTurn.mockResolvedValue(turnResult());
  runFinalDraft.mockResolvedValue(draftResult());
  useCharacterInterviewStore.getState().reset();
});

describe('start/sendAnswer/youDecide — basic turn orchestration', () => {
  it('start() moves intro -> chat and sends the opening prompt', async () => {
    runInterviewTurn.mockResolvedValue(turnResult());
    await useCharacterInterviewStore.getState().start();
    expect(useCharacterInterviewStore.getState().phase).toBe('chat');
    expect(runInterviewTurn).toHaveBeenCalledTimes(1);
    expect(runInterviewTurn.mock.calls[0][3]).toMatchObject({ messageKind: 'control' });
  });

  it('sendAnswer() is a no-op outside the chat phase', async () => {
    await useCharacterInterviewStore.getState().sendAnswer('hello');
    expect(runInterviewTurn).not.toHaveBeenCalled();
  });

  it('sendAnswer() advances the draft/transcript on success', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ say: 'What do they look like?' }));
    await useCharacterInterviewStore.getState().sendAnswer('A quiet librarian.');
    const { interview, error, isGenerating } = useCharacterInterviewStore.getState();
    expect(error).toBeNull();
    expect(isGenerating).toBe(false);
    expect(interview.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'What do they look like?' });
  });

  it('surfaces the latest turn suggestions and clears them on the next turn', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValueOnce({
      ...turnResult(),
      turn: { say: 'Pick one', done: false, suggestions: ['A', 'B'] },
    });
    await useCharacterInterviewStore.getState().sendAnswer('go');
    expect(useCharacterInterviewStore.getState().latestSuggestions).toEqual(['A', 'B']);

    runInterviewTurn.mockResolvedValueOnce(turnResult());
    await useCharacterInterviewStore.getState().sendAnswer('A');
    expect(useCharacterInterviewStore.getState().latestSuggestions).toEqual([]);
  });

  it('a turn reaching done:true auto-triggers synthesis and lands on avatar', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ done: true }));
    runFinalDraft.mockResolvedValue(draftResult());
    await useCharacterInterviewStore.getState().sendAnswer('that is everything');
    expect(runFinalDraft).toHaveBeenCalledTimes(1);
    expect(useCharacterInterviewStore.getState().phase).toBe('avatar');
    expect(useCharacterInterviewStore.getState().interview.draft.name).toBe('Ivy');
  });

  it('hitting the exchange cap auto-triggers synthesis even without done:true', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ done: false, exchangeCount: INTERVIEW_EXCHANGE_CAP }));
    runFinalDraft.mockResolvedValue(draftResult());
    await useCharacterInterviewStore.getState().sendAnswer('ok');
    expect(runFinalDraft).toHaveBeenCalledTimes(1);
    expect(useCharacterInterviewStore.getState().phase).toBe('avatar');
  });
});

describe('skipTopic — defensive coverage overlay (regression: was applied unconditionally)', () => {
  it('marks the topic skipped when the turn succeeds', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult());
    await useCharacterInterviewStore.getState().skipTopic('voice');
    expect(useCharacterInterviewStore.getState().interview.coverage.voice).toBe('skipped');
  });

  it('does NOT mark the topic skipped when the underlying turn errors', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockRejectedValue(new Error('network down'));
    await useCharacterInterviewStore.getState().skipTopic('voice');
    const { interview, error } = useCharacterInterviewStore.getState();
    expect(interview.coverage.voice).toBe('pending');
    expect(error).toBe('network down');
  });

  it('does not resurrect a skipped topic into a store that was reset mid-flight', async () => {
    await useCharacterInterviewStore.getState().start();
    const pending = deferred<never>();
    runInterviewTurn.mockReturnValue(pending.promise);

    const skipPromise = useCharacterInterviewStore.getState().skipTopic('voice');
    // Simulate the wizard being closed while the skip request is in flight:
    // reset() aborts the controller runTurn is waiting on.
    useCharacterInterviewStore.getState().reset();
    // The aborted request's promise settles (rejecting, as an aborted fetch
    // would) only after reset() has already run — this is the exact race
    // the regression relied on.
    pending.reject(new DOMException('aborted', 'AbortError'));
    await skipPromise;

    expect(useCharacterInterviewStore.getState().interview).toEqual(initialInterviewState());
  });
});

describe('retryTurn — resumes from the failed step, not the whole attempt (regression: resent the turn)', () => {
  it('after a turn failure, retries the SAME turn (not synthesis)', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockRejectedValueOnce(new Error('boom'));
    await useCharacterInterviewStore.getState().sendAnswer('hello');
    expect(useCharacterInterviewStore.getState().error).toBe('boom');
    expect(runInterviewTurn).toHaveBeenCalledTimes(2); // start() + the failed sendAnswer

    runInterviewTurn.mockResolvedValueOnce(turnResult());
    await useCharacterInterviewStore.getState().retryTurn();
    expect(runInterviewTurn).toHaveBeenCalledTimes(3);
    expect(runFinalDraft).not.toHaveBeenCalled();
    expect(useCharacterInterviewStore.getState().error).toBeNull();
  });

  it('after a synthesis failure following a SUCCESSFUL turn, retry re-runs only synthesis — the turn is never resent', async () => {
    await useCharacterInterviewStore.getState().start();
    runInterviewTurn.mockResolvedValue(turnResult({ done: true }));
    runFinalDraft.mockRejectedValueOnce(new Error('synthesis failed'));

    await useCharacterInterviewStore.getState().sendAnswer('wrap it up');
    const turnCallsAfterFirstAttempt = runInterviewTurn.mock.calls.length;
    expect(useCharacterInterviewStore.getState().error).toBe('synthesis failed');
    expect(useCharacterInterviewStore.getState().phase).toBe('synthesizing');

    runFinalDraft.mockResolvedValueOnce(draftResult());
    await useCharacterInterviewStore.getState().retryTurn();

    // The turn itself must NOT have been sent again — only synthesis retried.
    expect(runInterviewTurn).toHaveBeenCalledTimes(turnCallsAfterFirstAttempt);
    expect(runFinalDraft).toHaveBeenCalledTimes(2);
    expect(useCharacterInterviewStore.getState().phase).toBe('avatar');
    expect(useCharacterInterviewStore.getState().error).toBeNull();
  });

  it('after finishNow fails on the closing turn itself, retry resends the closing turn', async () => {
    await useCharacterInterviewStore.getState().start();
    // Make the draft finishable so finishNow() isn't blocked by anything
    // upstream of the store (isReadyToFinish is a UI-level gate, not
    // enforced by the store itself, but keep state realistic).
    useCharacterInterviewStore.setState((s) => ({ interview: { ...s.interview, draft: { ...s.interview.draft, name: 'Ivy', description: 'x' } } }));

    runInterviewTurn.mockRejectedValueOnce(new Error('closing turn failed'));
    await useCharacterInterviewStore.getState().finishNow();
    expect(useCharacterInterviewStore.getState().error).toBe('closing turn failed');
    expect(runFinalDraft).not.toHaveBeenCalled();

    runInterviewTurn.mockResolvedValueOnce(turnResult({ done: true }));
    runFinalDraft.mockResolvedValueOnce(draftResult());
    await useCharacterInterviewStore.getState().retryTurn();
    expect(runFinalDraft).toHaveBeenCalledTimes(1);
    expect(useCharacterInterviewStore.getState().phase).toBe('avatar');
  });
});

describe('proceedToReview / setPhase / reset', () => {
  it('proceedToReview only works from the avatar phase', () => {
    useCharacterInterviewStore.getState().proceedToReview();
    expect(useCharacterInterviewStore.getState().phase).toBe('intro');

    useCharacterInterviewStore.setState({ phase: 'avatar' });
    useCharacterInterviewStore.getState().proceedToReview();
    expect(useCharacterInterviewStore.getState().phase).toBe('review');
  });

  it('reset() clears phase, interview, avatarFile, error, and suggestions', async () => {
    await useCharacterInterviewStore.getState().start();
    useCharacterInterviewStore.setState({
      phase: 'review',
      avatarFile: new File([''], 'a.png'),
      error: 'stale',
      latestSuggestions: ['x'],
    });
    useCharacterInterviewStore.getState().reset();
    const s = useCharacterInterviewStore.getState();
    expect(s.phase).toBe('intro');
    expect(s.interview).toEqual(initialInterviewState());
    expect(s.avatarFile).toBeNull();
    expect(s.error).toBeNull();
    expect(s.latestSuggestions).toEqual([]);
  });

  it('updateDraftField and updateStagedLore write through to interview state', () => {
    useCharacterInterviewStore.getState().updateDraftField('name', 'Ivy');
    expect(useCharacterInterviewStore.getState().interview.draft.name).toBe('Ivy');

    const lore = [{ keys: ['reach'], content: 'A ruined district.' }];
    useCharacterInterviewStore.getState().updateStagedLore(lore);
    expect(useCharacterInterviewStore.getState().interview.stagedLore).toEqual(lore);
  });
});
