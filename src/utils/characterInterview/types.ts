// Character interview engine — shared type contract.
//
// The engine (prompts.ts/patch.ts/coverage.ts/engine.ts) is pure over an
// injected LlmCall — no store imports, no network — the same seam
// storyIngest's passes use (see storyIngest/types.ts's own LlmCall), so it
// stays unit-testable with a canned fake and the actual provider/model
// choice lives entirely with the caller (characterInterviewStore.ts).

/** Bound "messages in, text out" call — pre-resolved to a provider/model by
 *  whoever constructs it (mirrors storyIngest's LlmCall exactly; redeclared
 *  rather than imported since that module is story-specific by name, not
 *  by shape). */
export interface LlmCall {
  (
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    opts: { maxTokens?: number; signal?: AbortSignal }
  ): Promise<string>;
}

/** One "area" of the character the interview tries to cover. Drives both
 *  the interviewer's own sense of what's left to ask and the UI's progress
 *  indicator. Order here is advisory (a natural conversational sequence),
 *  not a hard state machine — the model can and will jump around based on
 *  what the author actually says. */
export type TopicId =
  | 'concept'
  | 'identity'
  | 'appearance'
  | 'personality'
  | 'voice'
  | 'scenario'
  | 'relationship'
  | 'greeting'
  | 'examples'
  | 'world'
  | 'tags';

export const TOPIC_IDS: readonly TopicId[] = [
  'concept',
  'identity',
  'appearance',
  'personality',
  'voice',
  'scenario',
  'relationship',
  'greeting',
  'examples',
  'world',
  'tags',
];

export type TopicStatus = 'pending' | 'partial' | 'done' | 'skipped';

export type CoverageState = Record<TopicId, TopicStatus>;

/** A world/lore fact the author mentioned in passing — staged into the
 *  character's embedded lorebook on save, never folded into `description`.
 *  `title` is optional editorial flavor; `keys`/`content` are what actually
 *  get written to the lorebook entry. */
export interface StagedLoreEntry {
  title?: string;
  keys: string[];
  content: string;
}

/** Card fields the model is allowed to patch. Deliberately a strict
 *  allowlist, not "whatever JSON keys showed up" — see patch.ts. `lore` is
 *  staged separately from every other field; it is never merged into
 *  `description`. */
export interface FieldPatch {
  name?: string;
  description?: string;
  personality?: string;
  first_mes?: string;
  scenario?: string;
  mes_example?: string;
  alternate_greetings?: string[];
  tags?: string[];
  creator_notes?: string;
  lore?: StagedLoreEntry[];
}

/** One parsed model turn, per the interview turn contract (see
 *  prompts.ts's INTERVIEW_SYSTEM for the exact instruction the model is
 *  given to produce this shape). */
export interface InterviewTurn {
  /** The conversational question/response shown to the author. */
  say: string;
  patch?: FieldPatch;
  /** Only the topics THIS turn's answer touched — coverage.ts merges this
   *  into the running CoverageState, it is never a full replacement. */
  coverage?: Partial<Record<TopicId, TopicStatus>>;
  /** Optional quick-reply chips the UI may render under the composer. */
  suggestions?: string[];
  /** The model's own signal that it has nothing further worth asking.
   *  Advisory — the engine caller also enforces the exchange cap and the
   *  user's own "Finish now" independently of this. */
  done?: boolean;
}

/** One line of the visible conversation. Assistant turns store only the
 *  `say` text (never the raw patch/coverage JSON) — that's what actually
 *  gets replayed back into the next call's transcript, keeping context
 *  linear-small instead of re-feeding the model its own tool-call-shaped
 *  output every turn.
 *
 *  `kind` distinguishes free text the creator typed from a UI action
 *  (Skip topic / You decide / Finish now) rendered as a "user" turn for
 *  the model's sake — both are replayed to the API identically, but the
 *  UI shows a 'control' message as a small action pill instead of a chat
 *  bubble, so "(Skip this topic for now...)" never has to visibly appear
 *  as if the creator typed it. Defaults to 'text' when omitted. */
export interface InterviewMessage {
  role: 'user' | 'assistant';
  content: string;
  kind?: 'text' | 'control';
}

/** The card-in-progress. Always fully populated (empty strings/arrays, not
 *  undefined) so form components can bind directly without null-checks. */
export interface InterviewDraft {
  name: string;
  description: string;
  personality: string;
  first_mes: string;
  scenario: string;
  mes_example: string;
  alternate_greetings: string[];
  tags: string[];
  creator_notes: string;
}

export function emptyDraft(): InterviewDraft {
  return {
    name: '',
    description: '',
    personality: '',
    first_mes: '',
    scenario: '',
    mes_example: '',
    alternate_greetings: [],
    tags: [],
    creator_notes: '',
  };
}

export function emptyCoverage(): CoverageState {
  const coverage = {} as CoverageState;
  for (const topic of TOPIC_IDS) coverage[topic] = 'pending';
  return coverage;
}

/** Everything the engine needs to build its next call. Owned by the store;
 *  the engine only ever reads it and returns a new one (or a delta) — it
 *  never mutates in place. */
export interface InterviewState {
  transcript: InterviewMessage[];
  draft: InterviewDraft;
  coverage: CoverageState;
  stagedLore: StagedLoreEntry[];
  /** Count of model turns so far (i.e. completed exchanges) — drives the
   *  "exchange N of CAP" context line and the wrap-up nudge near the cap. */
  exchangeCount: number;
}

export function initialInterviewState(): InterviewState {
  return {
    transcript: [],
    draft: emptyDraft(),
    coverage: emptyCoverage(),
    stagedLore: [],
    exchangeCount: 0,
  };
}

/** Result of one interview turn: the parsed turn plus the state it implies
 *  (transcript/draft/coverage/exchangeCount already advanced) — the store
 *  just assigns this over its current state rather than re-deriving it. */
export interface InterviewTurnResult {
  turn: InterviewTurn;
  nextState: InterviewState;
}

/** The finished card, synthesized from the whole conversation — same
 *  field set as InterviewDraft, plus the lore entries staged along the
 *  way (final draft synthesis may add more from anything mentioned but
 *  never explicitly staged mid-conversation — see engine.ts). */
export interface FinalDraftResult {
  draft: InterviewDraft;
  lore: StagedLoreEntry[];
}
