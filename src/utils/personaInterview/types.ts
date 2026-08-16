// Persona interview engine — shared type contract.
//
// Copy-and-adapted from characterInterview/types.ts, scoped down to a
// persona's two creative fields (name + self-description). Same pure-over-
// LlmCall design (no store/network imports) so the engine stays unit-
// testable with a canned fake and the provider/model choice lives with the
// caller (personaInterviewStore.ts). Deliberately smaller than the
// character engine: 2 fields, 3 topics, and no staged lore — a persona is
// the USER's own profile, not a full character card.

/** Bound "messages in, text out" call — pre-resolved to a provider/model by
 *  whoever constructs it. Same shape as characterInterview's LlmCall;
 *  redeclared rather than imported to keep the two engines independent. */
export interface LlmCall {
  (
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    opts: { maxTokens?: number; signal?: AbortSignal }
  ): Promise<string>;
}

/** One "area" of the persona the interview tries to cover. Advisory order,
 *  not a hard state machine — the model jumps around based on what the user
 *  actually says. */
export type TopicId = 'identity' | 'personality' | 'details';

export const TOPIC_IDS: readonly TopicId[] = ['identity', 'personality', 'details'];

export type TopicStatus = 'pending' | 'partial' | 'done' | 'skipped';

export type CoverageState = Record<TopicId, TopicStatus>;

/** The only fields the model is allowed to patch — a strict allowlist, not
 *  "whatever JSON keys showed up" (see patch.ts). */
export interface FieldPatch {
  name?: string;
  description?: string;
}

/** One parsed model turn, per the interview turn contract (see prompts.ts's
 *  PERSONA_INTERVIEW_SYSTEM for the exact instruction). */
export interface PersonaInterviewTurn {
  /** The conversational question/response shown to the user. */
  say: string;
  patch?: FieldPatch;
  /** Only the topics THIS turn's answer touched — coverage.ts merges this
   *  into the running CoverageState, it is never a full replacement. */
  coverage?: Partial<Record<TopicId, TopicStatus>>;
  /** Optional quick-reply chips the UI may render under the composer. */
  suggestions?: string[];
  /** The model's own signal that it has nothing further worth asking.
   *  Advisory — the caller also enforces the exchange cap and the user's
   *  own "Finish now" independently. */
  done?: boolean;
}

/** One line of the visible conversation. Assistant turns store only the
 *  `say` text (never the raw patch/coverage JSON) — that's what gets
 *  replayed into the next call's transcript. `kind` distinguishes free text
 *  from a UI action (Skip / You decide / Finish now) rendered as a "user"
 *  turn for the model's sake; both are replayed to the API identically, but
 *  the UI shows a 'control' message as a small pill. Defaults to 'text'. */
export interface InterviewMessage {
  role: 'user' | 'assistant';
  content: string;
  kind?: 'text' | 'control';
}

/** The persona-in-progress. Always fully populated (empty strings, not
 *  undefined) so form components bind directly without null-checks. */
export interface PersonaDraft {
  name: string;
  description: string;
}

export function emptyDraft(): PersonaDraft {
  return { name: '', description: '' };
}

export function emptyCoverage(): CoverageState {
  const coverage = {} as CoverageState;
  for (const topic of TOPIC_IDS) coverage[topic] = 'pending';
  return coverage;
}

/** Everything the engine needs to build its next call. Owned by the store;
 *  the engine only reads it and returns a new one — never mutates in place. */
export interface InterviewState {
  transcript: InterviewMessage[];
  draft: PersonaDraft;
  coverage: CoverageState;
  /** Count of model turns so far (completed exchanges) — drives the
   *  "exchange N of CAP" context line and the wrap-up nudge near the cap. */
  exchangeCount: number;
}

export function initialInterviewState(): InterviewState {
  return {
    transcript: [],
    draft: emptyDraft(),
    coverage: emptyCoverage(),
    exchangeCount: 0,
  };
}

/** Result of one interview turn: the parsed turn plus the state it implies
 *  (transcript/draft/coverage/exchangeCount already advanced). */
export interface PersonaInterviewTurnResult {
  turn: PersonaInterviewTurn;
  nextState: InterviewState;
}

/** The finished persona, synthesized from the whole conversation. */
export interface FinalDraftResult {
  draft: PersonaDraft;
}
