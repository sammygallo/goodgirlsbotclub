/**
 * Per-section token accounting for one assembled prompt (E2-S2 task 1).
 *
 * WHAT THIS IS: an in/out collector, created at the call site and handed to
 * `buildConversationContext` / `buildGroupConversationContext`, which fill it
 * in as they assemble. Same house pattern as `WiScanOut` (chatStore.ts:950) —
 * and for the same reason: the numbers are only knowable *inside* the builder
 * (per-section costs cannot be recovered from the returned `context`, because
 * Stage A joins fourteen sections into one system message), but three of the
 * buckets are only knowable *outside* it. The continue/impersonate instruction
 * turns are pushed by the call site after the builder returns
 * (chatStore.ts:4175-4178 / :4296-4299), and image attachments never pass
 * through the builder at all — they are resolved separately and folded into
 * the request by `api.generateMessage` (client.ts:1483-1508). So the object
 * has to outlive the call and stay amendable: `recordCallSiteTurn` and
 * `recordAttachments` are how those three arrive.
 *
 * MEASUREMENT POINT: assembly time, per emitted piece — the roadmap's AC 1.
 * What E2-S3 shows is the POST-transform payload (after instruct-mode collapse
 * and generate-interceptors); that is a different number and a different story.
 *
 * WHAT IT MUST NOT DO: change a single byte of what the builders emit. Every
 * number here is read off strings the builder had already computed for its own
 * purposes. In particular nothing in this module (or in the instrumentation
 * that feeds it) may re-render world-info content to measure it — rendering
 * runs `{{setvar}}` writes that are persisted into the chat
 * (chatStore.ts:1130-1143).
 */

import {
  CONVERSATION_PRIMING_TOKENS,
  MESSAGE_OVERHEAD_TOKENS,
  estimateTokens,
} from './tokenizer';
import type { TokenizerProfile } from './tokenizer';
import type { PromptSectionId } from '../stores/generationStore';

// ---------------------------------------------------------------------------
// What a slice can be
// ---------------------------------------------------------------------------

/**
 * Group's slots. Group has no `promptOrder` and no section map — it emits one
 * flat system message built from a template — so its pieces are named here
 * instead.
 *
 * Named per EMITTED SLOT rather than per concept, deliberately. Group card
 * content differs by mode: `join` emits description + personality + scenario +
 * examples inside the per-member block (chatStore.ts:2054-2074), while `swap`
 * (the default) emits only description + personality there and routes the
 * scenario through `scenarioText` and the examples through `mesExample`. A
 * single "character info" slice would move tokens between buckets when the
 * user flips Card mode, with zero change to what the model is sent.
 */
export type GroupSlotId =
  | 'group_system_chrome'
  | 'group_cards'
  | 'group_scenario'
  | 'group_examples'
  | 'group_wi_before_char'
  | 'group_wi_after_char'
  | 'group_wi_before_an'
  | 'group_wi_after_an'
  | 'group_rag_context';

export type BreakdownSectionId = PromptSectionId | GroupSlotId;

/**
 * Stage B is the history block, and it is not all history: the builder
 * interleaves at-depth insertions into the same array
 * (`historyWithInsertions`, chatStore.ts:1443) and the trim then treats them
 * as history. Splitting them is the whole point of measuring Stage B here
 * rather than counting `context` entries by role — an at-depth author's note
 * with `role: 'user'` is indistinguishable from a real user turn afterwards.
 *
 * DISPLAY MAPPING (decided in the approved plan; audit §9 refused a separate
 * Extensions bucket, so do not re-litigate it): `ext_at_depth` displays under
 * "Summary + Notes" — the summarize extension is the only at-depth
 * contributor the app ships — and the four non-depth `ext_*` sections display
 * under "Instructions".
 */
export type StageBClass =
  | 'history'
  | 'authors_note'
  | 'characters_note'
  | 'persona_at_depth'
  | 'wi_at_depth'
  | 'ext_at_depth';

export type SectionKind =
  | { stage: 'A'; id: BreakdownSectionId }
  | {
      stage: 'B';
      cls: StageBClass;
      /** Set only on `history` entries — the `ChatMessage.id` of the real
       *  turn. Injected notes have no message id, which is exactly why the
       *  recall boundary has to be defined as "oldest kept entry that HAS
       *  one" rather than "kept[0]". */
      messageId?: string;
      /**
       * Set only on `history` entries — the role the turn was EMITTED with,
       * read off the entry the builder had already pushed. This is what makes
       * "Your message" answerable from the breakdown alone: the newest
       * history slice with `role: 'user'`, with no join back to
       * `useChatStore.messages` (which has moved on by the time a panel
       * renders, and which is a different list anyway — hidden turns and
       * blank-turn skips mean not every stored message is an emitted one).
       *
       * DELIBERATELY NOT ON THE INSERTION CLASSES, even though they are all
       * emitted with a role too. An at-depth author's note is routinely
       * `role: 'user'` and sits AFTER the newest turn (the depth-0 slot), so
       * "the last user-role entry" over the emitted context is the note, not
       * the user. Confining the field to the class where it means "who wrote
       * this turn" makes that wrong query impossible to express rather than
       * merely wrong.
       */
      role?: 'user' | 'assistant' | 'system';
      /** Set only on `ext_at_depth` — which extension contributed it
       *  (registry.ts stamps `sourceExtensionId` on every contribution). */
      extensionId?: string;
    }
  | { stage: 'C'; id: BreakdownSectionId }
  | { stage: 'callSite'; turn: 'continue' | 'impersonate' }
  | { stage: 'attachments' };

export interface BreakdownSlice {
  kind: SectionKind;
  /** Tokens this piece costs, by the same estimator the trim budgets with.
   *  Stage B and Stage C are whole messages and carry the per-message
   *  overhead (`messageOverheadPerMessage`); Stage A sections are fragments of
   *  one message and do not (the single overhead for the joined message is
   *  `stageAMessageOverhead`). */
  tokens: number;
  chars: number;
}

/**
 * Stamp the emitted role onto a history-class Stage-B kind, leaving every
 * other class untouched.
 *
 * Exists so both builders acquire the role the same way — by READING the
 * entry they just pushed, never by re-deriving it from `msg.isUser` beside a
 * push that already did. The two would agree today and are exactly the kind of
 * pair that stops agreeing (group prefixes assistant turns with a speaker
 * name, solo does not; either could grow a third role first).
 */
export function withHistoryRole(
  kind: SectionKind,
  role: 'user' | 'assistant' | 'system'
): SectionKind {
  if (kind.stage !== 'B' || kind.cls !== 'history') return kind;
  return { ...kind, role };
}

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

export interface PromptBreakdown {
  mode: 'solo' | 'group';
  /** The tokenizer profile every number here was measured with — the REAL
   *  one (`profileForProvider(activeProvider)`), not the `generic` default. */
  profile: TokenizerProfile;
  /**
   * WHICH PROMPT THIS IS. `generationStore.lastPromptBreakdown` is one
   * last-write-wins slot, and a group round overwrites it once per speaker
   * (`sendGroupMessage` awaits `generateGroupTurn` per member, and each turn
   * publishes its own build). Without a stamp a consumer holding a breakdown
   * has no way to tell that it describes a different turn than the message it
   * is rendered against — the same hazard `FinishedConversation.overBudget`
   * avoids by returning through the call stack.
   *
   * `chatFile` is the chat the build ran against (null when there is no open
   * chat); `publishedAt` is when the collector was stamped, and is guaranteed
   * to differ between two builds even inside one millisecond (see
   * `nextPublishStamp`). Neither is ever emitted into a prompt.
   */
  chatFile: string | null;
  publishedAt: number;
  slices: BreakdownSlice[];

  /**
   * Stage A's join residual, in tokens. DEFINITIONAL, never derived from
   * separator lengths:
   *
   *   joinResidual = estimateTokens(joined) − Σ estimateTokens(part_i)
   *
   * `estimateTokens` is not additive — it is `ceil(len / cpt) +
   * floor(whitespaceRuns * 0.05)` (tokenizer.ts:57-63), so every part
   * contributes its own ceiling, and a `'\n\n'` join MERGES the whitespace run
   * at each part's edge with the separator instead of adding one. Computing
   * this from `2 * (parts − 1)` characters would be wrong in both directions
   * and by a double-digit number of tokens on a full prompt.
   *
   * Displayed as its own line ("separator + rounding"), never absorbed into a
   * section: AC 5 requires the section counts to reconcile EXACTLY with the
   * reported total, and this is the difference.
   */
  stageAJoinResidual: number;
  /** The single per-message overhead the Stage-A system message costs
   *  (`estimateMessageTokens` adds 4 for role markers, tokenizer.ts:70). Its
   *  own line for the same reason as the residual. */
  stageAMessageOverhead: number;
  /**
   * The THIRD reconciliation quantity: the flat priming allowance
   * `estimateConversationTokens` adds once per conversation
   * (`CONVERSATION_PRIMING_TOKENS`, tokenizer.ts). Named here for the same
   * reason as the two above — Σ slices + residual + overhead is
   * `assembledTotal` MINUS this, in both modes, so a panel that summed only
   * the documented parts would be short by exactly this much and would either
   * show the discrepancy AC 5 forbids or absorb it into whichever row it drew
   * last. Copied from the tokenizer's own constant, never a literal: a second
   * copy of the number is how the panel silently rots when the estimator
   * changes.
   */
  conversationPriming: number;
  /**
   * The FOURTH reconciliation quantity: what `estimateMessageTokens` charges
   * per whole message on top of its content (`MESSAGE_OVERHEAD_TOKENS`).
   *
   * Every Stage-B and Stage-C slice already has this baked into its `tokens`
   * (Reading B: the per-message cost belongs to the piece that incurred it,
   * which is what makes Σ slices + residual + overhead + priming ===
   * assembledTotal hold). This field is what lets a panel render Reading A
   * instead — content-only rows plus ONE aggregate overhead line,
   * `messageOverheadPerMessage × (Stage-B slices + Stage-C slices) +
   * stageAMessageOverhead` — without a literal 4 on the render side. AC 5
   * requires that line to be shown rather than silently absorbed, and a
   * second copy of the number is how it would stop matching the estimator.
   *
   * Copied from the tokenizer's constant, never written as a literal here.
   */
  messageOverheadPerMessage: number;

  totals: {
    /** Σ Stage-A section slices — excludes the residual and the per-message
     *  overhead. */
    stageA: number;
    /** Σ Stage-B slices, measured POST-trim (on `keptHistory`). */
    stageB: number;
    /** Σ Stage-C slices. Not counted by the trim — see `flags`. */
    stageC: number;
    /**
     * What the trim actually charged: identical to `trimmed.usedTokens`, and
     * to `estimateConversationTokens(systemPrompts ++ kept)`. This is what the
     * panel reconciles against (PM resolution), and it EXCLUDES Stage C.
     */
    trimTotal: number;
    /**
     * `estimateConversationTokens(context)` — the whole assembled prompt,
     * Stage C included. `trimTotal + stageC === assembledTotal` identically.
     *
     * The two totals are not a redundancy: `lastTokenEstimate` is written from
     * `trimTotal` on the token-aware path (chatStore.ts:1675) and from
     * `assembledTotal` on the non-token-aware one (:1694-1696). Naming both is
     * how E2-S2 task 4 reconciles that without this task changing either.
     */
    assembledTotal: number;
    /** Call-site instruction turns (continue / impersonate). Pushed after the
     *  builder returned, so outside both totals above. */
    callSite: number;
  };

  wi: {
    /** Post-macro, post-`wrapWiContent` cost of every world-info string that
     *  actually reached the prompt — what the model is really charged. */
    emittedTokens: number;
    /**
     * What the WI budget itself charges: Σ `estimateTokens(entry.content)`
     * over the same entries, matching `applyTokenBudget`'s cost function
     * (worldInfoStore.ts:1325). Raw content — before macro expansion and
     * before the persona/owner attribution wrappers — so it under-counts
     * whatever those add. AC 6 requires BOTH numbers to be shown.
     */
    rawTokens: number;
    /** The budget those entries were measured against (0 on a server-path
     *  turn: the server returns no scan report). */
    budget: number;
    /** Entry ids the WI budget evicted during the scan. */
    droppedIds: string[];
    /**
     * Where the activation decision came from. AC 9: the drill-down renders
     * "reason unavailable (server-path turn)" off THIS, and never infers a
     * reason from the absence of `matchedKeyCount`.
     */
    activationSource: 'server' | 'client';
  };

  /**
   * The number behind `flags.hasReservedSlice`: the `responseReserve` this
   * build's trim actually subtracted from `maxTokens`, or null when no trim
   * consulted it (group, and a solo build with `tokenAware` off).
   *
   * WHY IT IS NOT LEFT TO THE RENDER SIDE. `flags.hasReservedSlice` says a
   * Reserved slice belongs on the chart but not how big it is, so a panel
   * drawing it would have to read `generationStore.context.responseReserve`
   * live — a value the user can change in Settings between the send and the
   * render, which would then size a slice of THIS prompt from a number this
   * prompt was never assembled against. That is the same staleness `chatFile`
   * and `publishedAt` exist to defend against, and unlike those two it would
   * be invisible: the chart would simply be quietly wrong.
   *
   * Null rather than 0 on the paths that never read it, for the reason
   * `hasReservedSlice` is not a mode test: 0 is a legal reserve, and a panel
   * cannot tell "reserved nothing" from "never asked" if both arrive as 0.
   */
  responseReserve: number | null;

  flags: {
    /** The trim's verdict — the newest turn alone busted the budget. */
    overBudget: boolean;
    /** False in group, and on a solo build with `tokenAware` off. When false
     *  the history slice is badged "not trimmed" (AC 7). */
    historyTrimmed: boolean;
    /** History entries the trim dropped. */
    droppedFromHistory: number;
    /**
     * Whether a response reserve actually bound anything on this build, which
     * is what decides if the panel draws a Reserved slice (AC 7).
     *
     * FALSE IS NOT A MODE TEST. `ctxConfig.responseReserve` is read only
     * inside the token-aware branch (the `trimHistoryToBudget` call in
     * `finishConversationContext` and `ragBoundary.ts:128` — cited by construct,
     * not line: this comment's own commit moved the line once already),
     * so it constrains nothing in group — which has no history trim at all —
     * AND nothing on a solo build with `tokenAware` off. Deriving this from
     * `mode` would tell a solo user with trimming disabled that N tokens of
     * budget pressure existed when the assembly never consulted the number.
     * The builders set it; construction only supplies the safe default.
     */
    hasReservedSlice: boolean;
  };

  attachments: {
    count: number;
    /** Decoded byte size of the attached images. NOT tokens: nothing on the
     *  client counts image cost, in the trim or anywhere else (§4.4), which is
     *  why this bucket is badged "not counted anywhere" rather than folded
     *  into a total that would then be false. */
    bytes: number;
  };

  /**
   * The oldest KEPT entry that is a real chat message, by `ChatMessage.id`.
   * Null when the kept history is all injected notes, or when the entries
   * carry no ids. Task 1b's consumer — the real boundary that retires
   * `ragBoundary`'s re-simulation. Recorded now because it falls out of the
   * Stage-B classification for free; nothing reads it yet.
   */
  boundaryId: string | null;
}

/**
 * A stamp that is a real wall-clock time AND never repeats.
 *
 * `Date.now()` alone is not enough: a group round builds one prompt per
 * speaker back-to-back and synchronously, so two breakdowns routinely land in
 * the same millisecond — and two identical stamps are exactly as useless for
 * telling the turns apart as no stamp at all.
 */
let lastPublishStamp = 0;
function nextPublishStamp(): number {
  const now = Date.now();
  lastPublishStamp = now > lastPublishStamp ? now : lastPublishStamp + 1;
  return lastPublishStamp;
}

/**
 * `profile` is a placeholder: the builder overwrites it with the profile it
 * actually measured against (`profileForProvider(activeProvider)`). Call sites
 * must not guess it — a call site that resolved the provider a different way
 * than the builder did would produce a breakdown whose numbers silently came
 * from two tokenizers. The post-return amendments read it back off the object,
 * by which time it is the real one.
 *
 * `chatFile` is left null for the same reason: the builder knows which chat it
 * is assembling for, and stamps it in `beginBreakdownPass`.
 */
export function createPromptBreakdown(
  mode: 'solo' | 'group',
  profile: TokenizerProfile = 'generic'
): PromptBreakdown {
  return {
    mode,
    profile,
    chatFile: null,
    publishedAt: nextPublishStamp(),
    slices: [],
    stageAJoinResidual: 0,
    stageAMessageOverhead: 0,
    conversationPriming: CONVERSATION_PRIMING_TOKENS,
    messageOverheadPerMessage: MESSAGE_OVERHEAD_TOKENS,
    totals: {
      stageA: 0,
      stageB: 0,
      stageC: 0,
      trimTotal: 0,
      assembledTotal: 0,
      callSite: 0,
    },
    wi: {
      emittedTokens: 0,
      rawTokens: 0,
      budget: 0,
      droppedIds: [],
      activationSource: 'client',
    },
    responseReserve: null,
    flags: {
      overBudget: false,
      historyTrimmed: false,
      droppedFromHistory: 0,
      hasReservedSlice: false,
    },
    attachments: { count: 0, bytes: 0 },
    boundaryId: null,
  };
}

/**
 * Start a measurement pass: clear whatever a previous pass left behind and
 * stamp this one's identity. Called by each builder before its first
 * `addSlice`.
 *
 * WHY THE CLEAR. `addSlice` appends, and nothing else empties `slices`, so a
 * collector handed to two builds accumulates both — in group that doubles
 * `totals.stageA` (the stage totals are summed from `slices`) while
 * `assembledTotal` is recomputed from `context`, which breaks AC 5's
 * reconciliation outright; in solo the totals stay right and the panel simply
 * renders every section twice. Neither is reachable from today's six call
 * sites, each of which creates its own collector — this is a trap laid for
 * task 1b's two-pass finish and for task 3, and it is cheaper to close than to
 * document. The semantics match `sectionContent.rag_context`, which the second
 * half of the solo builder also OVERWRITES rather than appends to: a re-entered
 * collector describes the last pass, not the union of all of them.
 */
export function beginBreakdownPass(
  out: PromptBreakdown | undefined,
  chatFile: string | null
): void {
  if (!out) return;
  out.chatFile = chatFile;
  out.publishedAt = nextPublishStamp();
  out.slices.length = 0;
  out.stageAJoinResidual = 0;
  out.stageAMessageOverhead = 0;
  out.totals.stageA = 0;
  out.totals.stageB = 0;
  out.totals.stageC = 0;
  out.totals.trimTotal = 0;
  out.totals.assembledTotal = 0;
  out.totals.callSite = 0;
  out.wi.emittedTokens = 0;
  out.wi.rawTokens = 0;
  out.wi.budget = 0;
  out.wi.droppedIds = [];
  out.wi.activationSource = 'client';
  // `responseReserve` is deliberately NOT cleared here: both builder tails
  // assign it unconditionally on every pass, and the collector-reuse test in
  // chatStore.breakdown.test.ts is what guards that invariant — a future tail
  // that assigns conditionally fails it. (The fifth-round review proved the
  // clear that used to sit here was unobservable and its rationale described
  // an unreachable ordering — the round's one false claim.) `conversationPriming`
  // and `messageOverheadPerMessage` are the tokenizer's constants, identical
  // on every pass.
  out.flags.overBudget = false;
  out.flags.historyTrimmed = false;
  out.flags.droppedFromHistory = 0;
  out.flags.hasReservedSlice = false;
  out.attachments.count = 0;
  out.attachments.bytes = 0;
  out.boundaryId = null;
}

/**
 * Append one measured piece.
 *
 * `tokens` and `chars` are both passed in rather than derived from a string
 * here: the caller decides whether the per-message overhead applies (Stage A
 * sections are fragments of one message and it does not; Stage B and C
 * entries are whole messages and it does), and the group's chrome slice is a
 * residual with no string of its own at all.
 */
export function addSlice(
  out: PromptBreakdown | undefined,
  kind: SectionKind,
  tokens: number,
  chars: number
): void {
  if (!out) return;
  out.slices.push({ kind, tokens, chars });
}

/**
 * The continue / impersonate instruction turn, pushed onto `context` by the
 * call site after the builder returned (chatStore.ts:4175-4178, :4296-4299).
 *
 * It is a real user-role turn the model is charged for, and no total inside
 * the builder can see it — `assembledTotal` was computed before it existed.
 * Kept out of `assembledTotal` rather than added to it, so that total keeps
 * meaning "what the builder assembled" and stays the number the identity
 * `trimTotal + stageC === assembledTotal` is checked against.
 */
export function recordCallSiteTurn(
  out: PromptBreakdown | undefined,
  turn: 'continue' | 'impersonate',
  content: string
): void {
  if (!out) return;
  const tokens = estimateTokens(content, out.profile) + MESSAGE_OVERHEAD_TOKENS;
  out.slices.push({
    kind: { stage: 'callSite', turn },
    tokens,
    chars: content.length,
  });
  out.totals.callSite += tokens;
}

/**
 * Image attachments — their own bucket, explicitly badged "not counted
 * anywhere" (audit §4.4 / AC 2).
 *
 * They are never added to a token total because there is no honest number to
 * add: `client.ts:1483-1508` folds them into the last user turn as content
 * parts long after the trim has run, and the trim's estimator scores an image
 * part at zero. Folding a guess in here would make the panel's total agree
 * with nothing.
 */
export function recordAttachments(
  out: PromptBreakdown | undefined,
  images: { base64: string }[] | undefined
): void {
  if (!out || !images || images.length === 0) return;
  let bytes = 0;
  for (const img of images) {
    // base64 → bytes, without decoding: 4 chars per 3 bytes, minus padding.
    const b64 = img.base64 ?? '';
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    bytes += Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
  }
  out.attachments.count += images.length;
  out.attachments.bytes += bytes;
  out.slices.push({
    kind: { stage: 'attachments' },
    tokens: 0,
    chars: 0,
  });
}
