/**
 * Turns a `PromptBreakdown` (E2-S2 tasks 1/1b/2 — frozen, do not edit) into
 * something a panel can render without re-deriving any arithmetic of its own
 * (E2-S2 task 3, #456).
 *
 * BUCKETING RULE — read this before touching either mapping table below.
 * Every slice is bucketed by the SLOT IT WAS EMITTED IN, never by what kind
 * of content happens to be in it. `char_info_block` is the only slot that
 * ever carries character description, so it is the only thing under
 * "Character" — but `main_prompt` is bucketed under "Instructions" even
 * though a user is free to paste a character bio into it, and group's
 * `group_cards` slot is bucketed under "System" even though it is built from
 * the same description/personality fields `char_info_block` prices in solo.
 * The alternative (classify by content) would move a user's own tokens
 * between buckets depending on what they typed into a free-text field, with
 * zero change to what the model was sent — exactly the kind of drift AC 5's
 * reconciliation exists to make impossible. Bucketing by slot means the
 * three Records below are the WHOLE story: no slice's bucket can depend on
 * its content, its length, or anything computed at render time.
 *
 * Solo and group name their own slots (`PromptSectionId` / `GroupSlotId`)
 * because the two builders assemble differently — solo has a `promptOrder`
 * section map, group has one flat template — and `Record<K, BucketId>`
 * literals are used rather than a switch so that a new member of either id
 * union is a COMPILE ERROR here, not a silently-unbucketed slice.
 */

import type {
  BreakdownSlice,
  GroupSlotId,
  PromptBreakdown,
  SectionKind,
  StageBClass,
} from './promptBreakdown';
import type { TokenizerProfile } from './tokenizer';
import { PROMPT_SECTION_LABELS, type PromptSectionId } from '../stores/generationStore';
// Review round 4, R4-E/F5: the group builder's ONE definition of its history
// window (groupHistoryWindow.ts's own doc: "before E2-S2 task 1b those were
// two hand-synced copies... one function, imported by both, is the only
// shape in which they cannot drift again") — imported here rather than a
// second literal `30`, which is exactly the drift pattern that file exists to
// prevent and this module's own doc calls out for `conversationPriming` /
// `messageOverheadPerMessage` ("a second copy of the number is how the panel
// silently rots").
import { GROUP_HISTORY_WINDOW } from './groupHistoryWindow';

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/**
 * The ten concepts a user can spend tokens on. `system` exists only for
 * group — its flat template blends what solo keeps as three separate
 * buckets (Character, Persona, Instructions) into one un-split block, so
 * giving that block a solo bucket name would claim a precision group's
 * template doesn't have. `your_message` exists only for solo, for the
 * opposite reason: group hands the builder the user's own turn already
 * folded into `messages`, with no separate mechanism to pull it out (see
 * the "8 buckets, not 10" comment at chatStore.ts's `sliceForPushed` call
 * in the history loop — this type is what that comment is about).
 */
export type BucketId =
  | 'character'
  | 'persona'
  | 'system'
  | 'world_info'
  | 'chat_recall'
  | 'summary_notes'
  | 'instructions'
  | 'chat_history'
  | 'your_message';

/**
 * Display order. A single list serves both modes: solo never populates
 * `system` and group never populates `character` / `persona` /
 * `instructions` / `your_message`, so a panel that renders only the
 * non-zero buckets in this order gets solo's 10-item canonical order and
 * group's reduced 5-item one for free, with no mode branch of its own.
 */
export const BUCKET_ORDER: readonly BucketId[] = [
  'system',
  'character',
  'persona',
  'world_info',
  'chat_recall',
  'summary_notes',
  'instructions',
  'chat_history',
  'your_message',
];

export const BUCKET_LABELS: Record<BucketId, string> = {
  character: 'Character',
  persona: 'Persona',
  system: 'System',
  world_info: 'World Info / Lorebooks',
  chat_recall: 'Chat recall',
  summary_notes: 'Summary + Notes',
  instructions: 'Instructions',
  chat_history: 'Chat history',
  your_message: 'Your message',
};

/** Solo's Stage-A/Stage-C sections. */
export const SECTION_BUCKET: Record<PromptSectionId, BucketId> = {
  main_prompt: 'instructions',
  persona_before_char: 'persona',
  wi_before_char: 'world_info',
  ext_before_char: 'instructions',
  char_info_block: 'character',
  wi_after_char: 'world_info',
  ext_after_char: 'instructions',
  persona_after_char: 'persona',
  wi_before_an: 'world_info',
  ext_before_an: 'instructions',
  jailbreak: 'instructions',
  emotion_instruction: 'instructions',
  selfie_instruction: 'instructions',
  rag_context: 'chat_recall',
  char_phi: 'instructions',
  user_phi: 'instructions',
  wi_after_an: 'world_info',
  ext_after_an: 'instructions',
};

/** Group's flat-template slots. */
export const GROUP_SLOT_LABELS: Record<GroupSlotId, string> = {
  group_system_chrome: 'Template chrome',
  group_cards: 'Character cards',
  group_scenario: 'Scenario',
  group_examples: 'Example dialogue',
  group_wi_before_char: 'World Info — before characters',
  group_wi_after_char: 'World Info — after characters',
  group_wi_before_an: "World Info — before Author's Note",
  group_wi_after_an: "World Info — after Author's Note",
  group_rag_context: 'Chat recall',
};

export const GROUP_SLOT_BUCKET: Record<GroupSlotId, BucketId> = {
  group_system_chrome: 'system',
  group_cards: 'system',
  group_scenario: 'system',
  group_examples: 'system',
  group_wi_before_char: 'world_info',
  group_wi_after_char: 'world_info',
  group_wi_before_an: 'world_info',
  group_wi_after_an: 'world_info',
  group_rag_context: 'chat_recall',
};

/**
 * Stage-B insertion classes. `history` maps here to `chat_history` for
 * exhaustiveness (every `StageBClass` must resolve to *some* bucket, so a
 * mapping test can walk this table alone), but `computeBreakdownView` never
 * actually reads `STAGE_B_BUCKET.history` — the newest user-authored turn is
 * pulled out into `your_message` by `selectYourMessageId` below, which is a
 * property of WHICH slice (the newest, and only in solo) rather than of the
 * class, and a static per-class table cannot express "newest of these".
 */
export const STAGE_B_BUCKET: Record<StageBClass, BucketId> = {
  history: 'chat_history',
  authors_note: 'summary_notes',
  characters_note: 'summary_notes',
  persona_at_depth: 'persona',
  wi_at_depth: 'world_info',
  ext_at_depth: 'summary_notes',
};

export const STAGE_B_CLASS_LABELS: Record<StageBClass, string> = {
  history: 'Chat history',
  authors_note: "Author's Note",
  characters_note: "Character's Note",
  persona_at_depth: 'Persona (at depth)',
  wi_at_depth: 'World Info (at depth)',
  ext_at_depth: 'Extension (at depth)',
};

function roleLabel(role: 'user' | 'assistant' | 'system' | undefined): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return 'Unknown'; // unreachable on a real breakdown — every history slice is stamped.
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface DrillDownSlice {
  label: string;
  /** Content-only tokens (Reading A — see `computeBreakdownView`'s doc). */
  tokens: number;
  /** Set only on Stage-B `history` rows. */
  role?: 'user' | 'assistant' | 'system';
  messageId?: string;
  /** Set on a Stage-C row: solo's "not counted by the trim" text, or
   *  group's "after history" note. Absent on every in-budget row. */
  badge?: string;
}

export interface BucketRow {
  id: BucketId;
  label: string;
  /** The bar-segment value: in solo, in-budget content only (Stage C is
   *  excluded — see `stageCTokens`); in group, all content, because group
   *  never trims and has nothing to exclude. */
  tokens: number;
  slices: DrillDownSlice[];
  /** Solo only. Present iff this bucket has post-history content. */
  stageCSlices?: DrillDownSlice[];
  /** Solo only. Σ `stageCSlices[].tokens`. */
  stageCTokens?: number;
}

export interface OverheadBreakdown {
  /** Solo only — Stage A's join residual ("Separator + rounding"). Absent
   *  for group: group's chrome slice already folds its own residual in, so
   *  there is nothing left over to show as a second line. */
  separatorRounding?: number;
  /** `stageAMessageOverhead` plus one `messageOverheadPerMessage` per
   *  in-budget whole message (solo: history only; group: history + Stage C,
   *  since group has no post-history exclusion). */
  messageOverhead: number;
  conversationPriming: number;
  /** Sum of the fields above — the bar's final "Overhead" segment. */
  total: number;
}

/**
 * Labels for the two headline reconciliation rows (solo panel), shared
 * between the row itself and its explanatory note below
 * (`trimmedMeterNote` / `fullPromptNote`) so the note can name its row
 * without a second, independently-typed literal drifting from what the row
 * actually renders — review round 3, R3-A (F1/F2/F5/F7): round 2 made the
 * notes digit-free but left them with no subject, so positional adjacency
 * bound the trim note to the WRONG row (it renders after the assembled-
 * total row, not the trim row it describes).
 */
export const TRIMMED_METER_LABEL = 'Counted by the trim';
export const FULL_PROMPT_LABEL = 'Full assembled prompt';
/**
 * Row-1's label in Message Count mode (`flags.historyTrimmed === false`) —
 * review round 3, R3-B (F4). No trim ran in this mode (chatStore.ts sets
 * `historyTrimmed` from the token-aware toggle), so this row is just the
 * pre-Stage-C subtotal, not "the trim" — calling it that would contradict
 * the "Trim disabled (Message Count mode)" badge rendered two rows below.
 */
export const PRE_STAGE_C_LABEL = 'Before after-history sections';

export interface StageCReconciliation {
  /** `breakdown.totals.stageC` verbatim — Σ of the per-bucket `stageCTokens`
   *  plus `afterHistoryOverhead`, never recomputed independently of it. */
  tokens: number;
  /** `messageOverheadPerMessage × (Stage-C slice count)`. */
  afterHistoryOverhead: number;
  assembledTotal: number;
  /** Row-1's label: `TRIMMED_METER_LABEL` when a trim actually ran
   *  (`flags.historyTrimmed`), `PRE_STAGE_C_LABEL` in Message Count mode.
   *  Review round 3, R3-B/F4. */
  meterRowLabel: string;
  /** Present only when `flags.historyTrimmed` — there is nothing to say
   *  about "what the trim measures" when no trim ran (Message Count mode).
   *  Always begins with `${meterRowLabel} — `, i.e. `${TRIMMED_METER_LABEL}
   *  — `, so the note self-labels regardless of render position (review
   *  round 3, R3-A). */
  trimmedMeterNote?: string;
  /** Always begins with `${FULL_PROMPT_LABEL} — `. Wording is mode-
   *  dependent: "what it tracks when trimming is off" describes a
   *  hypothetical (trimming is currently ON) in token-aware mode; "what the
   *  in-chat meter tracks (token-aware trimming is off)" is the literal
   *  truth in Message Count mode (review round 3, R3-B/F4). */
  fullPromptNote: string;
}

export interface Reconciliation {
  /** What `bucketsTotal + overhead.total` must equal: `totals.trimTotal` in
   *  solo, `totals.assembledTotal` in group. */
  target: number;
  bucketsTotal: number;
  overhead: OverheadBreakdown;
  /** Solo only. */
  stageC?: StageCReconciliation;
}

export interface Badges {
  /** Names the drop count too, when there is one (Message Count mode) — see
   *  `historyBadge`. */
  history: string;
  /** Present only when `flags.droppedFromHistory > 0` — the TOKEN-AWARE
   *  trim's drop count. */
  droppedFromHistory?: number;
  /** Present only when `flags.droppedByMessageWindow > 0` — messages
   *  Message Count mode's fixed window discarded before the trim (which
   *  never ran in this mode) could ever see them. A DIFFERENT mechanism
   *  from `droppedFromHistory`: a window cut, not a trim decision (review
   *  round 4, R4-B/F3). Same underlying `breakdown.flags` value `history`'s
   *  string embeds, so the two cannot drift apart. */
  droppedFromWindow?: number;
}

export interface WiSummary {
  emittedTokens: number;
  rawTokens: number;
  gapExplanation: string;
  /** Client-path only. */
  budget?: number;
  evictedCount?: number;
  /** Server-path only — AC 9: rendered instead of budget/evicted, never
   *  inferred from their absence. */
  unavailableNote?: string;
}

export interface CallSiteLine {
  turn: 'continue' | 'impersonate';
  label: string;
  tokens: number;
  note: string;
}

export interface Provenance {
  mode: 'solo' | 'group';
  chatFile: string | null;
  publishedAt: number;
  profile: TokenizerProfile;
}

export interface BreakdownViewModel {
  provenance: Provenance;
  /** Canonical order, non-zero buckets only (a bucket with only Stage-C
   *  content still counts as non-zero via `stageCTokens`). */
  buckets: BucketRow[];
  reconciliation: Reconciliation;
  badges: Badges;
  wi: WiSummary;
  /** Null unless `flags.hasReservedSlice` — never derived from mode. */
  reserved: { tokens: number } | null;
  /** Null when nothing was attached. Bytes, never tokens (nothing on the
   *  client counts image cost) — badged "not counted anywhere" by the
   *  renderer, not by this module. */
  attachments: { count: number; bytes: number } | null;
  /** Empty when no continue/impersonate turn was recorded. */
  callSite: CallSiteLine[];
  /** Set iff mode is solo and `totals.stageA === 0` (every pre-history
   *  section disabled) — the app still sends an empty system message
   *  (audit §4.4). Explains the overhead line; does not change emission. */
  emptySystemNote: string | null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The newest Stage-B `history` slice emitted with `role: 'user'`, by
 * `messageId` — group returns null unconditionally (no Your-message bucket
 * there; see `STAGE_B_BUCKET`'s doc).
 *
 * Walks forward and keeps the LAST match rather than reversing the array:
 * slices are recorded in emission order (chatStore.ts pushes history oldest
 * to newest), so the last `history` slice with `role: 'user'` in that order
 * already IS the newest one. Checking `cls === 'history'` before `role` is
 * what makes a `role: 'user'` author's note ineligible — insertion classes
 * carry a role too (`withHistoryRole`'s doc), and only `history` entries are
 * real turns.
 */
function selectYourMessageId(breakdown: PromptBreakdown): string | null {
  if (breakdown.mode !== 'solo') return null;
  let found: string | null = null;
  for (const slice of breakdown.slices) {
    const k = slice.kind;
    if (k.stage === 'B' && k.cls === 'history' && k.role === 'user') {
      found = k.messageId ?? null;
    }
  }
  return found;
}

function historyBadge(
  mode: 'solo' | 'group',
  historyTrimmed: boolean,
  overBudget: boolean,
  droppedByMessageWindow: number,
  messageWindowSize: number | null
): string {
  if (!historyTrimmed) {
    // NEVER "within budget" here — nothing was measured against a budget:
    // solo's Message Count mode skips the trim outright, and group has none.
    if (mode === 'group') {
      return `History not trimmed (fixed ${GROUP_HISTORY_WINDOW}-message window)`;
    }
    // Review round 4, R4-B/F3: "Trim disabled" alone implied nothing was
    // ever cut — but Message Count mode pre-windows history to a fixed
    // count BEFORE the (skipped) trim would have run, and that window can
    // silently drop plenty. Name the drop whenever there is one; keep the
    // old (still true, still the common case — "the window covers the
    // whole chat") wording when there is not.
    //
    // Review round 5, R5-A/F1/F2/F9: round 4's first wording ("last N
    // messages kept") was itself wrong — `messageWindowSize` is the RAW
    // window setting applied to `visibleMessages` BEFORE the isSystem
    // filter (chatStore.ts), not a count of what was actually kept, and a
    // second history-reducing mechanism (summary compaction) can drop
    // still more without ever touching `windowSkew`. This module cannot
    // know the true kept count from `flags` alone — PM decision: report
    // only what was actually MEASURED (the window's own drop,
    // `droppedByMessageWindow`) and the mechanism (`messageWindowSize`),
    // never a derived "kept" claim. The real kept count is what the
    // drill-down rows already show, one section down, and any
    // compaction-covered turns are disclosed by the Summary slice, not
    // this badge.
    if (messageWindowSize !== null && droppedByMessageWindow > 0) {
      return `Trim disabled (Message Count mode) — ${droppedByMessageWindow} older message${droppedByMessageWindow === 1 ? '' : 's'} beyond the ${messageWindowSize}-message window`;
    }
    return 'Trim disabled (Message Count mode)';
  }
  return overBudget
    ? 'Over budget — the pinned content alone (newest turn + critical lore + system block) exceeded the trim budget'
    : 'Within budget';
}

function buildWiSummary(breakdown: PromptBreakdown): WiSummary {
  const base = {
    emittedTokens: breakdown.wi.emittedTokens,
    rawTokens: breakdown.wi.rawTokens,
    gapExplanation:
      'The gap is macro expansion and the attribution wrapper the app adds before injecting each entry — both counted in what reaches the prompt, neither charged by the WI budget, which measures the raw entry text.',
  };
  // AC 9: rendered instead of budget/evicted, never inferred from
  // `matchedKeyCount`'s absence — that field belongs to the scan report, not
  // to this breakdown, and a server-path turn has no scan report at all.
  if (breakdown.wi.activationSource === 'server') {
    return { ...base, unavailableNote: 'Activation details unavailable (server-path turn)' };
  }
  return { ...base, budget: breakdown.wi.budget, evictedCount: breakdown.wi.droppedIds.length };
}

const CALL_SITE_LABELS: Record<'continue' | 'impersonate', string> = {
  continue: 'Continue instruction',
  impersonate: 'Impersonate instruction',
};

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

/**
 * READING A vs READING B. The collector bills Stage-B/C slices with their
 * per-message overhead already baked in (`slice.tokens` — Reading B, the
 * cost belongs to the piece that incurred it; see promptBreakdown.ts). A
 * panel showing every section on its own row while ALSO showing "message
 * overhead" as its own line needs the other presentation — content-only
 * rows plus one aggregate overhead line — so every Stage-B/C `tokens` value
 * below is `slice.tokens − messageOverheadPerMessage`. Stage-A rows are
 * fragments of one joined message and never carried the overhead to begin
 * with, so they are used as-is.
 */
export function computeBreakdownView(breakdown: PromptBreakdown): BreakdownViewModel {
  const { mode } = breakdown;
  const perMessage = breakdown.messageOverheadPerMessage;
  const yourMessageId = selectYourMessageId(breakdown);

  const rows = new Map<BucketId, BucketRow>();
  const rowFor = (id: BucketId): BucketRow => {
    let row = rows.get(id);
    if (!row) {
      row = { id, label: BUCKET_LABELS[id], tokens: 0, slices: [] };
      rows.set(id, row);
    }
    return row;
  };
  const stageALabel = (id: string): string =>
    mode === 'group' ? GROUP_SLOT_LABELS[id as GroupSlotId] : PROMPT_SECTION_LABELS[id as PromptSectionId];
  const stageABucket = (id: string): BucketId =>
    mode === 'group' ? GROUP_SLOT_BUCKET[id as GroupSlotId] : SECTION_BUCKET[id as PromptSectionId];

  let nB = 0;
  let nC = 0;
  // Moved up from the reconciliation block below (review round 4, R4-A/F1)
  // so the Stage-C loop can read it too — the badge it stamps has to be
  // mode-conditional for the exact reason the reconciliation row's label
  // already is (R3-B/F4): no trim ran in Message Count mode, so nothing may
  // claim content was excluded FROM one.
  const historyTrimmed = breakdown.flags.historyTrimmed;

  for (const slice of breakdown.slices as BreakdownSlice[]) {
    const kind: SectionKind = slice.kind;

    if (kind.stage === 'A') {
      const row = rowFor(stageABucket(kind.id));
      row.tokens += slice.tokens;
      row.slices.push({ label: stageALabel(kind.id), tokens: slice.tokens });
      continue;
    }

    if (kind.stage === 'B') {
      nB++;
      const content = slice.tokens - perMessage;
      if (kind.cls === 'history') {
        const isYourMessage =
          mode === 'solo' && yourMessageId !== null && kind.messageId === yourMessageId;
        const row = rowFor(isYourMessage ? 'your_message' : 'chat_history');
        row.tokens += content;
        row.slices.push({
          label: roleLabel(kind.role),
          tokens: content,
          role: kind.role,
          messageId: kind.messageId,
        });
      } else {
        const label =
          kind.cls === 'ext_at_depth' && kind.extensionId
            ? `${STAGE_B_CLASS_LABELS[kind.cls]} (${kind.extensionId})`
            : STAGE_B_CLASS_LABELS[kind.cls];
        const row = rowFor(STAGE_B_BUCKET[kind.cls]);
        row.tokens += content;
        row.slices.push({ label, tokens: content });
      }
      continue;
    }

    if (kind.stage === 'C') {
      nC++;
      const content = slice.tokens - perMessage;
      const row = rowFor(stageABucket(kind.id));
      const label = stageALabel(kind.id);
      if (mode === 'group') {
        // Group never trims, so post-history content is just more content:
        // in the bucket total and in the bar, labeled by where it landed
        // rather than pulled out of the reconciliation the way solo pulls it.
        row.tokens += content;
        row.slices.push({ label, tokens: content, badge: 'after history' });
      } else {
        row.stageCTokens = (row.stageCTokens ?? 0) + content;
        (row.stageCSlices ??= []).push({
          label,
          tokens: content,
          // Review round 4, R4-A/F1/F6/F7: mode-conditional, matching the
          // reconciliation row's label/note (R3-B/F4) — in Message Count
          // mode there is no trim to have excluded this content FROM, and
          // the in-chat meter counts it (fullPromptNote says so three rows
          // up on the same panel).
          badge: historyTrimmed
            ? 'not counted by the trim — sent after the history'
            : 'sent after the history',
        });
      }
      continue;
    }

    // 'callSite' and 'attachments' slices are not bucketed — see below.
  }

  // Filtered to buckets a slice actually targeted — NOT to non-zero
  // `tokens`. A section that rendered to nothing still measured something
  // (e.g. an empty `group_scenario` slot is still one `addSlice` call, at 0
  // tokens), and dropping that row here would silently lose it from the
  // drill-down along with every other slice in a bucket that happened to sum
  // to zero. "Non-zero token buckets" (the bar's own rule) is a decision the
  // renderer makes when it picks bar segments, not something baked in here.
  const buckets = BUCKET_ORDER
    .map((id) => rows.get(id))
    .filter(
      (row): row is BucketRow =>
        !!row && (row.slices.length > 0 || (row.stageCSlices?.length ?? 0) > 0)
    );
  const bucketsTotal = buckets.reduce((n, r) => n + r.tokens, 0);

  const overhead: OverheadBreakdown =
    mode === 'solo'
      ? {
          separatorRounding: breakdown.stageAJoinResidual,
          messageOverhead: breakdown.stageAMessageOverhead + perMessage * nB,
          conversationPriming: breakdown.conversationPriming,
          total:
            breakdown.stageAJoinResidual +
            breakdown.stageAMessageOverhead +
            perMessage * nB +
            breakdown.conversationPriming,
        }
      : {
          messageOverhead: breakdown.stageAMessageOverhead + perMessage * (nB + nC),
          conversationPriming: breakdown.conversationPriming,
          total:
            breakdown.stageAMessageOverhead +
            perMessage * (nB + nC) +
            breakdown.conversationPriming,
        };

  // Review round 3, R3-B/F4: Message Count mode (no token-aware trim) still
  // reaches this branch — reconciliation.stageC is gated on mode alone, never
  // on historyTrimmed — so row 1's label/note have to be honest about
  // whether a trim actually measured anything. (`historyTrimmed` itself is
  // declared above, before the slice loop — R4-A/F1 needs it there too.)
  const reconciliation: Reconciliation =
    mode === 'solo'
      ? {
          target: breakdown.totals.trimTotal,
          bucketsTotal,
          overhead,
          stageC: {
            tokens: breakdown.totals.stageC,
            afterHistoryOverhead: perMessage * nC,
            assembledTotal: breakdown.totals.assembledTotal,
            meterRowLabel: historyTrimmed ? TRIMMED_METER_LABEL : PRE_STAGE_C_LABEL,
            // Review round 3, R3-A/F1/F2/F5/F7: self-labeling again (each
            // note begins with the SAME constant its row renders), after
            // round 2's digit-free fix left both notes as orphan sentences
            // that read — by simple positional adjacency — as describing the
            // LAST row (Full assembled prompt) instead of their own.
            trimmedMeterNote: historyTrimmed
              ? `${TRIMMED_METER_LABEL} — what the in-chat meter tracks while token-aware trimming is on.`
              : undefined,
            fullPromptNote: historyTrimmed
              ? `${FULL_PROMPT_LABEL} — what it tracks when trimming is off.`
              : `${FULL_PROMPT_LABEL} — what the in-chat meter tracks (token-aware trimming is off).`,
          },
        }
      : { target: breakdown.totals.assembledTotal, bucketsTotal, overhead };

  const badges: Badges = {
    history: historyBadge(
      mode,
      breakdown.flags.historyTrimmed,
      breakdown.flags.overBudget,
      breakdown.flags.droppedByMessageWindow,
      breakdown.flags.messageWindowSize
    ),
    droppedFromHistory:
      breakdown.flags.droppedFromHistory > 0 ? breakdown.flags.droppedFromHistory : undefined,
    droppedFromWindow:
      breakdown.flags.droppedByMessageWindow > 0 ? breakdown.flags.droppedByMessageWindow : undefined,
  };

  const callSite: CallSiteLine[] = breakdown.slices
    .filter((s): s is BreakdownSlice & { kind: Extract<SectionKind, { stage: 'callSite' }> } =>
      s.kind.stage === 'callSite'
    )
    .map((s) => ({
      turn: s.kind.turn,
      label: CALL_SITE_LABELS[s.kind.turn],
      tokens: s.tokens,
      note: `sent in addition to the assembled prompt above, with its own ${perMessage}-token overhead`,
    }));

  return {
    provenance: {
      mode,
      chatFile: breakdown.chatFile,
      publishedAt: breakdown.publishedAt,
      profile: breakdown.profile,
    },
    buckets,
    reconciliation,
    badges,
    wi: buildWiSummary(breakdown),
    reserved: breakdown.flags.hasReservedSlice ? { tokens: breakdown.responseReserve ?? 0 } : null,
    attachments:
      breakdown.attachments.count > 0
        ? { count: breakdown.attachments.count, bytes: breakdown.attachments.bytes }
        : null,
    callSite,
    emptySystemNote:
      mode === 'solo' && breakdown.totals.stageA === 0
        ? `includes ${perMessage} tokens for an empty system message: the app sends the system slot even when every pre-history section is empty or disabled`
        : null,
  };
}
