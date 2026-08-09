// Character interview wizard — conversational engine store.
//
// Scoped deliberately narrow: this store owns the interview conversation
// (transcript/draft/coverage/stagedLore) and the in-progress avatar file
// only. It does NOT own persistence — saving the finished draft as a real
// character goes through useCharacterStore().createCharacter() directly
// from the top-level wizard component, the same way CharacterCreation.tsx
// already does it. `setPhase` is the seam that lets the component drive
// 'review' <-> 'saving' around its own async save call without this store
// needing to know character/lorebook APIs exist.

import { create } from 'zustand';
import {
  type InterviewState,
  type InterviewDraft,
  type StagedLoreEntry,
  type TopicId,
  type InterviewTurnResult,
  initialInterviewState,
} from '../utils/characterInterview/types';
import { runInterviewTurn, runFinalDraft } from '../utils/characterInterview/engine';
import { INTERVIEW_OPENING_PROMPT, CONTROL_MESSAGES, INTERVIEW_EXCHANGE_CAP } from '../utils/characterInterview/prompts';
import { makeLlmCall } from '../utils/storyIngest/llmBridge';

export type InterviewPhase = 'intro' | 'chat' | 'synthesizing' | 'avatar' | 'review' | 'saving';

const llm = makeLlmCall({ characterName: 'Character interview' });

// Not part of the reactive store — an in-flight request has no business
// being serialized/diffed, and every action needs to both read and replace
// it, which a set()-held field would make awkward.
let activeAbortController: AbortController | null = null;

function freshAbort(): AbortSignal {
  activeAbortController?.abort();
  activeAbortController = new AbortController();
  return activeAbortController.signal;
}

interface CharacterInterviewStore {
  phase: InterviewPhase;
  interview: InterviewState;
  /** A turn or the final synthesis is in flight. */
  isGenerating: boolean;
  /** Last turn/synthesis error, if any — retryable via retryTurn(). */
  error: string | null;
  avatarFile: File | null;
  /** Quick-reply chips from the most recent assistant turn, if it offered
   *  any — cleared once a new turn starts so a stale chip never lingers
   *  under an answer it no longer applies to. */
  latestSuggestions: string[];

  /** intro -> chat; sends the opening turn. */
  start: () => Promise<void>;
  /** Free-text reply while in 'chat'. */
  sendAnswer: (text: string) => Promise<void>;
  skipTopic: (topic: TopicId) => Promise<void>;
  youDecide: () => Promise<void>;
  /** Sends a closing turn, then synthesizes: chat -> synthesizing -> avatar. */
  finishNow: () => Promise<void>;
  /** Re-runs whatever the last failed attempt was (a chat turn or synthesis). */
  retryTurn: () => Promise<void>;

  setAvatarFile: (file: File | null) => void;
  /** avatar -> review. */
  proceedToReview: () => void;

  updateDraftField: <K extends keyof InterviewDraft>(field: K, value: InterviewDraft[K]) => void;
  updateStagedLore: (entries: StagedLoreEntry[]) => void;

  /** Escape hatch for the host component's own save flow (review <-> saving). */
  setPhase: (phase: InterviewPhase) => void;

  /** Cancels any in-flight request. Does not change phase. */
  abort: () => void;
  /** Full reset to initial state, e.g. when the wizard modal closes. */
  reset: () => void;
}

export const useCharacterInterviewStore = create<CharacterInterviewStore>((set, get) => {
  /** Every retryable action is funneled through here so retryTurn() can
   *  just re-invoke whatever ran last, without a phase-by-phase switch. */
  let lastAttempt: (() => Promise<unknown>) | null = null;

  /** Returns whether the turn actually landed (updated `interview`) — false
   *  on error or abort, with no state change beyond isGenerating/error.
   *  Callers that layer extra state on top of a turn (skipTopic's defensive
   *  coverage overlay) must check this before doing so, or they'll apply
   *  their overlay on top of a failed/aborted/reset turn. */
  async function runTurn(userMessage: string, messageKind: 'text' | 'control'): Promise<boolean> {
    const { interview } = get();
    set({ isGenerating: true, error: null, latestSuggestions: [] });
    const signal = freshAbort();
    let result: InterviewTurnResult;
    try {
      result = await runInterviewTurn(interview, userMessage, llm, { messageKind, signal });
    } catch (e) {
      if (signal.aborted) { set({ isGenerating: false }); return false; }
      set({ isGenerating: false, error: e instanceof Error ? e.message : 'The interview stalled — try again.' });
      return false;
    }

    const shouldFinish = result.turn.done || result.nextState.exchangeCount >= INTERVIEW_EXCHANGE_CAP;
    set({
      interview: result.nextState,
      isGenerating: false,
      latestSuggestions: shouldFinish ? [] : result.turn.suggestions ?? [],
    });
    if (shouldFinish) {
      await synthesize(result.nextState);
    }
    return true;
  }

  /** Retrying after a synthesis failure must re-run ONLY the synthesis, not
   *  resend the turn that led into it — so this claims `lastAttempt` for
   *  itself the moment it starts, overriding whatever outer closure
   *  (sendAnswer/finishNow/...) was previously registered there. If the
   *  synthesis then fails, retryTurn() resumes from here, not from the top. */
  async function synthesize(state: InterviewState): Promise<void> {
    lastAttempt = () => synthesize(state);
    set({ phase: 'synthesizing', isGenerating: true, error: null });
    const signal = freshAbort();
    try {
      const result = await runFinalDraft(state, llm, signal);
      set({
        interview: { ...state, draft: result.draft, stagedLore: result.lore },
        phase: 'avatar',
        isGenerating: false,
      });
    } catch (e) {
      if (signal.aborted) { set({ isGenerating: false }); return; }
      set({ isGenerating: false, error: e instanceof Error ? e.message : 'Could not put together the final card — try again.' });
    }
  }

  function attempt<T>(fn: () => Promise<T>): () => Promise<void> {
    return async () => {
      lastAttempt = fn;
      await fn();
    };
  }

  return {
    phase: 'intro',
    interview: initialInterviewState(),
    isGenerating: false,
    error: null,
    avatarFile: null,
    latestSuggestions: [],

    start: async () => {
      if (get().phase !== 'intro') return;
      set({ phase: 'chat' });
      await attempt(() => runTurn(INTERVIEW_OPENING_PROMPT, 'control'))();
    },

    sendAnswer: async (text) => {
      const trimmed = text.trim();
      if (!trimmed || get().phase !== 'chat' || get().isGenerating) return;
      await attempt(() => runTurn(trimmed, 'text'))();
    },

    skipTopic: async (topic) => {
      if (get().phase !== 'chat' || get().isGenerating) return;
      await attempt(async () => {
        const landed = await runTurn(CONTROL_MESSAGES.skipTopic(topic), 'control');
        // Defensive: guarantee the topic reads as skipped in the UI even if
        // the model's own coverage delta didn't follow the instruction. Only
        // applied when the turn actually landed — on error/abort, runTurn
        // already left `interview` untouched, and 'skipped' is a terminal
        // coverage state nothing can undo, so overlaying it onto a turn that
        // never happened would permanently mislabel a topic nobody skipped.
        if (!landed) return;
        const { interview } = get();
        set({
          interview: {
            ...interview,
            coverage: { ...interview.coverage, [topic]: 'skipped' },
          },
        });
      })();
    },

    youDecide: async () => {
      if (get().phase !== 'chat' || get().isGenerating) return;
      await attempt(() => runTurn(CONTROL_MESSAGES.youDecide, 'control'))();
    },

    finishNow: async () => {
      if (get().phase !== 'chat' || get().isGenerating) return;
      await attempt(async () => {
        set({ isGenerating: true, error: null, latestSuggestions: [] });
        const signal = freshAbort();
        let result: InterviewTurnResult;
        try {
          result = await runInterviewTurn(get().interview, CONTROL_MESSAGES.finishNow, llm, {
            messageKind: 'control',
            signal,
          });
        } catch (e) {
          if (signal.aborted) { set({ isGenerating: false }); return; }
          set({ isGenerating: false, error: e instanceof Error ? e.message : 'The interview stalled — try again.' });
          return;
        }
        set({ interview: result.nextState, isGenerating: false });
        await synthesize(result.nextState);
      })();
    },

    retryTurn: async () => {
      if (!lastAttempt || get().isGenerating) return;
      await lastAttempt();
    },

    setAvatarFile: (file) => set({ avatarFile: file }),

    proceedToReview: () => {
      if (get().phase !== 'avatar') return;
      set({ phase: 'review' });
    },

    updateDraftField: (field, value) => {
      const { interview } = get();
      set({ interview: { ...interview, draft: { ...interview.draft, [field]: value } } });
    },

    updateStagedLore: (entries) => {
      const { interview } = get();
      set({ interview: { ...interview, stagedLore: entries } });
    },

    setPhase: (phase) => set({ phase }),

    abort: () => {
      activeAbortController?.abort();
      set({ isGenerating: false });
    },

    reset: () => {
      activeAbortController?.abort();
      activeAbortController = null;
      lastAttempt = null;
      set({
        phase: 'intro',
        interview: initialInterviewState(),
        isGenerating: false,
        error: null,
        avatarFile: null,
        latestSuggestions: [],
      });
    },
  };
});
