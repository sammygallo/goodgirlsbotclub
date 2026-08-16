// Persona interview wizard — conversational engine store.
//
// Copy-and-adapted from characterInterviewStore.ts, trimmed to the persona
// scope. Like its sibling, it owns the interview conversation
// (transcript/draft/coverage) and the in-progress avatar — but NOT
// persistence of the finished persona: saving goes through
// usePersonaStore().createPersona() directly from the review component, the
// same seam CharacterInterview uses. `setPhase` lets that component drive
// 'review' <-> 'saving' around its own save call.
//
// Unlike the character interview, there is NO cross-session save/resume:
// personas are localStorage-only (no backend draft table), and the flow is
// short enough that closing simply discards (with a confirm prompt in the
// UI). That drops all the loadDraft/hydrate/persist plumbing here.
//
// The avatar is held as a data URL (not a File): imageGenStore.generate()
// already returns one, and personas store `avatarDataUrl` directly — no
// File round-trip like the character/sprites path needs.

import { create } from 'zustand';
import {
  type InterviewState,
  type PersonaDraft,
  type TopicId,
  type PersonaInterviewTurnResult,
  initialInterviewState,
} from '../utils/personaInterview/types';
import { runInterviewTurn, runFinalDraft } from '../utils/personaInterview/engine';
import { markTopicSkipped } from '../utils/personaInterview/coverage';
import {
  PERSONA_INTERVIEW_OPENING_PROMPT,
  CONTROL_MESSAGES,
  PERSONA_INTERVIEW_EXCHANGE_CAP,
} from '../utils/personaInterview/prompts';
import { makeLlmCall } from '../utils/storyIngest/llmBridge';

export type PersonaInterviewPhase = 'intro' | 'chat' | 'synthesizing' | 'avatar' | 'review' | 'saving';

const llm = makeLlmCall({ characterName: 'Persona interview' });

// Not part of the reactive store — an in-flight request has no business
// being serialized/diffed, and every action needs to both read and replace
// it, which a set()-held field would make awkward.
let activeAbortController: AbortController | null = null;

function freshAbort(): AbortSignal {
  activeAbortController?.abort();
  activeAbortController = new AbortController();
  return activeAbortController.signal;
}

interface PersonaInterviewStore {
  phase: PersonaInterviewPhase;
  interview: InterviewState;
  /** A turn or the final synthesis is in flight. */
  isGenerating: boolean;
  /** Last turn/synthesis error, if any — retryable via retryTurn(). */
  error: string | null;
  /** The chosen avatar as a bounded data URL, or null. */
  avatarDataUrl: string | null;
  /** Quick-reply chips from the most recent assistant turn, if it offered
   *  any — cleared once a new turn starts. */
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

  setAvatarDataUrl: (dataUrl: string | null) => void;
  /** avatar -> review. */
  proceedToReview: () => void;

  updateDraftField: <K extends keyof PersonaDraft>(field: K, value: PersonaDraft[K]) => void;

  /** Escape hatch for the host component's own save flow (review <-> saving). */
  setPhase: (phase: PersonaInterviewPhase) => void;

  /** Cancels any in-flight request. Does not change phase. */
  abort: () => void;
  /** Full reset to initial state, e.g. when the wizard closes. */
  reset: () => void;
}

export const usePersonaInterviewStore = create<PersonaInterviewStore>((set, get) => {
  /** Every retryable action is funneled through here so retryTurn() can just
   *  re-invoke whatever ran last, without a phase-by-phase switch. */
  let lastAttempt: (() => Promise<unknown>) | null = null;

  /** Returns whether the turn actually landed (updated `interview`) — false
   *  on error or abort, with no state change beyond isGenerating/error.
   *  skipTopic's coverage overlay checks this before applying itself. */
  async function runTurn(userMessage: string, messageKind: 'text' | 'control'): Promise<boolean> {
    const { interview } = get();
    set({ isGenerating: true, error: null, latestSuggestions: [] });
    const signal = freshAbort();
    let result: PersonaInterviewTurnResult;
    try {
      result = await runInterviewTurn(interview, userMessage, llm, { messageKind, signal });
    } catch (e) {
      if (signal.aborted) {
        set({ isGenerating: false });
        return false;
      }
      set({ isGenerating: false, error: e instanceof Error ? e.message : 'The interview stalled — try again.' });
      return false;
    }

    const shouldFinish = result.turn.done || result.nextState.exchangeCount >= PERSONA_INTERVIEW_EXCHANGE_CAP;
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
   *  itself the moment it starts, overriding whatever outer closure was
   *  previously registered there. */
  async function synthesize(state: InterviewState): Promise<void> {
    lastAttempt = () => synthesize(state);
    set({ phase: 'synthesizing', isGenerating: true, error: null });
    const signal = freshAbort();
    try {
      const result = await runFinalDraft(state, llm, signal);
      set({
        interview: { ...state, draft: result.draft },
        phase: 'avatar',
        isGenerating: false,
      });
    } catch (e) {
      if (signal.aborted) {
        set({ isGenerating: false });
        return;
      }
      set({
        isGenerating: false,
        error: e instanceof Error ? e.message : 'Could not put together the final persona — try again.',
      });
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
    avatarDataUrl: null,
    latestSuggestions: [],

    start: async () => {
      if (get().phase !== 'intro') return;
      set({ phase: 'chat' });
      await attempt(() => runTurn(PERSONA_INTERVIEW_OPENING_PROMPT, 'control'))();
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
        // Defensive: guarantee the topic reads as skipped even if the model's
        // own coverage delta didn't follow the instruction. Only applied when
        // the turn actually landed — 'skipped' is terminal and would
        // permanently mislabel a topic if overlaid onto a failed/aborted turn.
        if (!landed) return;
        const { interview } = get();
        set({ interview: { ...interview, coverage: markTopicSkipped(interview.coverage, topic) } });
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
        let result: PersonaInterviewTurnResult;
        try {
          result = await runInterviewTurn(get().interview, CONTROL_MESSAGES.finishNow, llm, {
            messageKind: 'control',
            signal,
          });
        } catch (e) {
          if (signal.aborted) {
            set({ isGenerating: false });
            return;
          }
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

    setAvatarDataUrl: (dataUrl) => set({ avatarDataUrl: dataUrl }),

    proceedToReview: () => {
      if (get().phase !== 'avatar') return;
      set({ phase: 'review' });
    },

    updateDraftField: (field, value) => {
      const { interview } = get();
      set({ interview: { ...interview, draft: { ...interview.draft, [field]: value } } });
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
        avatarDataUrl: null,
        latestSuggestions: [],
      });
    },
  };
});
