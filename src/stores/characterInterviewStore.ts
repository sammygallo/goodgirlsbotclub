// Character interview wizard — conversational engine store.
//
// Scoped deliberately narrow: this store owns the interview conversation
// (transcript/draft/coverage/stagedLore) and the in-progress avatar file.
// It does NOT own persistence of the FINISHED character — saving the
// finished draft as a real character goes through
// useCharacterStore().createCharacter() directly from the top-level wizard
// component, the same way CharacterCreation.tsx already does it. `setPhase`
// is the seam that lets the component drive 'review' <-> 'saving' around
// its own async save call without this store needing to know character/
// lorebook APIs exist.
//
// It DOES own save/resume for the IN-PROGRESS interview itself (a
// `character_drafts` row, kind='interview') — a different concern, aimed
// at letting someone leave mid-interview and come back. Autosaved only at
// phase transitions that land in a safe, resumable state ('chat' after a
// turn settles, 'avatar', 'review') — never mid 'synthesizing' (no
// persisted intermediate result to resume into) or 'saving' (the
// createCharacter call is already in flight).

import { create } from 'zustand';
import {
  type InterviewState,
  type InterviewDraft,
  type StagedLoreEntry,
  type TopicId,
  type InterviewTurnResult,
  initialInterviewState,
  emptyDraft,
  emptyCoverage,
} from '../utils/characterInterview/types';
import { runInterviewTurn, runFinalDraft } from '../utils/characterInterview/engine';
import { INTERVIEW_OPENING_PROMPT, CONTROL_MESSAGES, INTERVIEW_EXCHANGE_CAP } from '../utils/characterInterview/prompts';
import { makeLlmCall } from '../utils/storyIngest/llmBridge';
import { api, type CharacterDraft } from '../api/client';

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
  /** The caller's saved interview draft, if any — populated by loadDraft(). */
  resumableDraft: CharacterDraft | null;

  /** Pull the caller's saved interview draft (if any) from the backend. */
  loadDraft: () => Promise<void>;
  /** Rehydrate `interview`/`phase` from `resumableDraft`. No-op if there is
   *  none. Falls back to 'chat' if the saved phase isn't one of the safe
   *  resumable phases (defensive — shouldn't happen, autosave only ever
   *  writes a safe phase). */
  hydrateFromDraft: () => void;
  /** Clear the interview draft (after a successful create, or an explicit discard). */
  discardDraft: () => Promise<void>;

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

  /** Save-draft debounce for per-keystroke edits (updateDraftField/
   *  updateStagedLore during 'review') — module-scoped like
   *  activeAbortController, not a `set()`-held field, for the same reason. */
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelScheduledDraftSave(): void {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
  }

  /** Best-effort upsert — a failed autosave doesn't surface an error, the
   *  next checkpoint just retries. Only called with a phase this interview
   *  is safe to resume into (never 'intro'/'synthesizing'/'saving'). */
  async function persistDraft(
    state: InterviewState,
    phase: 'chat' | 'avatar' | 'review'
  ): Promise<void> {
    try {
      const draft = await api.saveCharacterDraft('interview', { ...state, phase });
      set({ resumableDraft: draft });
    } catch {
      // best-effort
    }
  }

  function scheduleDraftSave(state: InterviewState, phase: 'chat' | 'avatar' | 'review'): void {
    cancelScheduledDraftSave();
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      void persistDraft(state, phase);
    }, 1500);
  }

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
    } else {
      // Settled back into 'chat' — a safe resume checkpoint.
      void persistDraft(result.nextState, 'chat');
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
      const nextInterview = { ...state, draft: result.draft, stagedLore: result.lore };
      set({
        interview: nextInterview,
        phase: 'avatar',
        isGenerating: false,
      });
      void persistDraft(nextInterview, 'avatar');
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
    resumableDraft: null,

    loadDraft: async () => {
      try {
        const drafts = await api.listCharacterDrafts();
        set({ resumableDraft: drafts.find((d) => d.kind === 'interview') ?? null });
      } catch {
        // best-effort — no resume affordance if the fetch failed
      }
    },

    hydrateFromDraft: () => {
      const { resumableDraft } = get();
      if (!resumableDraft) return;
      const payload = resumableDraft.payload as Partial<InterviewState> & { phase?: string };
      const safePhase: InterviewPhase =
        payload.phase === 'review' || payload.phase === 'avatar' ? payload.phase : 'chat';
      set({
        interview: {
          transcript: payload.transcript ?? [],
          draft: payload.draft ?? emptyDraft(),
          coverage: payload.coverage ?? emptyCoverage(),
          stagedLore: payload.stagedLore ?? [],
          exchangeCount: payload.exchangeCount ?? 0,
        },
        phase: safePhase,
        error: null,
        latestSuggestions: [],
      });
    },

    discardDraft: async () => {
      cancelScheduledDraftSave();
      set({ resumableDraft: null });
      try {
        await api.deleteCharacterDraft('interview');
      } catch {
        // best-effort — a stale row left server-side just gets overwritten next save
      }
    },

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
        const next = {
          ...interview,
          coverage: { ...interview.coverage, [topic]: 'skipped' },
        };
        set({ interview: next });
        void persistDraft(next, 'chat');
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
      void persistDraft(get().interview, 'review');
    },

    updateDraftField: (field, value) => {
      const { interview, phase } = get();
      const next = { ...interview, draft: { ...interview.draft, [field]: value } };
      set({ interview: next });
      // Only autosave while actually editable in review — 'saving' means a
      // createCharacter call is already in flight for this same data.
      if (phase === 'review') scheduleDraftSave(next, 'review');
    },

    updateStagedLore: (entries) => {
      const { interview, phase } = get();
      const next = { ...interview, stagedLore: entries };
      set({ interview: next });
      if (phase === 'review') scheduleDraftSave(next, 'review');
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
      cancelScheduledDraftSave();
      // Deliberately leaves `resumableDraft` alone — reset() runs on every
      // close, including "Save & close", where the whole point is that the
      // backend row survives for next time. discardDraft() nulls it
      // explicitly on the paths where it should actually go away.
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
