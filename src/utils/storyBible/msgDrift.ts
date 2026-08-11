// Upstream-drift detection for the bible's source chat (story-state
// phase 11).
//
// Phase 5's `resolveRefState` is deliberately NOT the tool for this. It
// returns `live` for anything not loaded and never returns `drifted` for
// a `chat_message` (see sourceRefs.ts) — correct for an evidence badge
// that must not cry wolf, useless for answering "did this chat change?".
// The comparison ladder that IS correct lived privately inside
// ContradictionCard; this module is that ladder, extracted, with a
// fourth verdict the badge never needed.
//
// WHAT THIS CAN AND CANNOT SEE (phase 11 plan §3.2). There is no stored
// per-message fingerprint prefix — adding one is a persisted field, and
// every backend model is `extra="forbid"`. So detection samples the refs
// that already exist: the watermark anchor, and each scene's
// `source.message_range` endpoints plus its `swipe_resolutions`. A
// message edited strictly INTERIOR to a scene — not a boundary, carrying
// no swipe resolution — is invisible here. That is a known, tested false
// negative, not an oversight; the remedy is full re-ingest, which is
// always available and always archive-backed.

import type {
  IngestWatermark,
  MessageRange,
  MsgRef,
  SwipeResolution,
} from '../../types/storyBible';
import { hashText } from './sourceRefs';

/**
 * Four verdicts, where phase 5's `RefState` had three.
 *
 * `unverifiable` is the whole reason this type exists. When the recorded
 * `hash_alg` differs from the one available now (djb2 gets recorded in a
 * non-secure context; sha256 when crypto.subtle is there), the two
 * digests disagree on identical text BY CONSTRUCTION, so a mismatch says
 * nothing at all. ContradictionCard hedges that case to `drifted` with
 * apologetic copy, which is fine for an inline badge and unacceptable
 * for a banner announcing "your chat history changed". Say only what is
 * true: we could not check.
 */
export type MsgDrift = 'live' | 'drifted' | 'dangling' | 'unverifiable';

/**
 * The minimal message shape drift comparison needs.
 *
 * `IngestMessage` (the walk's shape) satisfies this structurally, so a
 * gathered transcript can be passed straight in. `swipes` is optional
 * because that shape drops it: when it is absent we can only see the
 * ACTIVE swipe, which bounds what we are allowed to claim — see
 * `refText`.
 */
export interface DriftMessage {
  id: string;
  /** Text of the currently-active swipe. */
  content: string;
  /** Index of the currently-active swipe. */
  swipeIdx: number;
  timestamp: number;
  /** Every swipe's text, when the caller has it. */
  swipes?: readonly string[] | null;
}

/** Minimal scene shape for tier 2. A full `Scene` satisfies it. */
export interface DriftScene {
  id: string;
  sequence: number;
  source?:
    | {
        message_range?: MessageRange | null;
        swipe_resolutions?: readonly SwipeResolution[] | null;
      }
    | null
    | undefined;
}

/** Build the id → index map once; every tier reuses it. */
export function indexById(
  messages: readonly DriftMessage[]
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    // First occurrence wins. Ids are unique per chat file by contract;
    // if a restore ever duplicates one, preferring the earlier index
    // keeps ordering checks monotonic instead of jumping backwards.
    if (!map.has(messages[i].id)) map.set(messages[i].id, i);
  }
  return map;
}

/**
 * The text the ref actually names, or a verdict explaining why we can't
 * get it.
 *
 * `swipe_idx` IS the chosen swipe (sourceRefs' v1.1 amendment). With the
 * full `swipes` array in hand, an index past the end means the swipe the
 * ref came from is gone — real drift. Without it we can only see the
 * active swipe, so a ref naming a different one is `unverifiable`: the
 * content may be untouched and simply not currently shown, and calling
 * that "your history changed" would fire the banner every time a user
 * swipes.
 */
function refText(
  ref: MsgRef,
  msg: DriftMessage
): { text: string } | { verdict: MsgDrift } {
  if (Array.isArray(msg.swipes)) {
    if (ref.swipe_idx < 0 || ref.swipe_idx >= msg.swipes.length) {
      return { verdict: 'drifted' };
    }
    const text = msg.swipes[ref.swipe_idx];
    return typeof text === 'string' ? { text } : { verdict: 'drifted' };
  }
  if (ref.swipe_idx === msg.swipeIdx) return { text: msg.content };
  return { verdict: 'unverifiable' };
}

/** Classify one ref against the live message it points at. */
export async function checkMsgDrift(
  ref: MsgRef,
  msg: DriftMessage | undefined
): Promise<MsgDrift> {
  if (!msg) return 'dangling';

  const resolved = refText(ref, msg);
  if ('verdict' in resolved) return resolved.verdict;

  const { sha, hash_alg } = await hashText(resolved.text);
  if (hash_alg !== ref.fingerprint.hash_alg) return 'unverifiable';
  return sha === ref.fingerprint.sha ? 'live' : 'drifted';
}

// ---------------------------------------------------------------------------
// Tier 1 — the anchor check
// ---------------------------------------------------------------------------

export type DivergenceReason =
  /** The last walked message is no longer in the chat. */
  | 'anchor_deleted'
  /** The last walked message is still there but its text changed. */
  | 'anchor_edited'
  /** The anchor is intact but messages appeared or vanished before it. */
  | 'count_mismatch';

export type WatermarkVerdict =
  | { kind: 'never_walked' }
  | { kind: 'unknown'; reason: 'no_anchor' | 'unverifiable_anchor' }
  | { kind: 'clean'; anchorIndex: number }
  | { kind: 'new_messages'; count: number; anchorIndex: number }
  | { kind: 'diverged'; reason: DivergenceReason; anchorIndex: number };

/**
 * Decide, in one hash, whether the chat has grown cleanly, diverged, or
 * neither.
 *
 * `message_count` counts the id-bearing population the walk can see
 * (`gatherIngestInputs` drops messages with no `extra.ggbc_id`), so the
 * caller MUST pass that same filtered array. It is deliberately the
 * corroborating signal rather than the primary one: a server heal that
 * mints ids for older messages raises the count without any message
 * being added, and anchor position is what keeps that from reading as
 * phantom growth.
 */
export async function checkWatermark(
  watermark: IngestWatermark | null | undefined,
  messages: readonly DriftMessage[],
  index?: ReadonlyMap<string, number>
): Promise<WatermarkVerdict> {
  if (!watermark || watermark.message_count <= 0) return { kind: 'never_walked' };
  const anchor = watermark.last_msg;
  if (!anchor) return { kind: 'unknown', reason: 'no_anchor' };

  const byId = index ?? indexById(messages);
  const anchorIndex = byId.get(anchor.msg_id);
  if (anchorIndex === undefined) {
    return { kind: 'diverged', reason: 'anchor_deleted', anchorIndex: -1 };
  }

  const verdict = await checkMsgDrift(anchor, messages[anchorIndex]);
  if (verdict === 'unverifiable') {
    // We cannot tell whether the anchor changed, so we cannot honestly
    // report divergence OR cleanliness. Stay silent rather than guess.
    return { kind: 'unknown', reason: 'unverifiable_anchor' };
  }
  if (verdict === 'drifted' || verdict === 'dangling') {
    return { kind: 'diverged', reason: 'anchor_edited', anchorIndex };
  }

  // The anchor is intact. If it no longer sits where the walk left it,
  // messages were inserted or removed BEFORE it — the chunk boundaries
  // behind it can no longer be trusted.
  if (anchorIndex + 1 !== watermark.message_count) {
    return { kind: 'diverged', reason: 'count_mismatch', anchorIndex };
  }

  const trailing = messages.length - (anchorIndex + 1);
  if (trailing > 0) {
    return { kind: 'new_messages', count: trailing, anchorIndex };
  }
  return { kind: 'clean', anchorIndex };
}

/** The messages past the anchor — exactly what an incremental walk feeds
 *  on. Empty for every verdict that isn't `new_messages`. */
export function newMessagesSince(
  verdict: WatermarkVerdict,
  messages: readonly DriftMessage[]
): readonly DriftMessage[] {
  if (verdict.kind !== 'new_messages') return [];
  return messages.slice(verdict.anchorIndex + 1);
}

// ---------------------------------------------------------------------------
// Tier 2 — localise the divergence to a scene
// ---------------------------------------------------------------------------

export interface SceneDriftReport {
  /** First scene (by sequence) with a broken boundary, or null when the
   *  sampled refs all check out. */
  divergedSceneId: string | null;
  divergedSequence: number | null;
  /** The diverged scene and everything after it, in sequence order. */
  downstreamSceneIds: readonly string[];
  /** How many scenes carried checkable refs at all. */
  checkedScenes: number;
  /** Refs whose comparison was impossible (cross-algorithm, or a swipe we
   *  cannot see). High counts mean "we know less than usual", and the
   *  caller should soften its copy accordingly. */
  unverifiableRefs: number;
  /** Ids moved but content did not — a branch restore rekeying messages,
   *  not the user editing history. Scenes are NOT flagged in this case. */
  idChurnSuspected: boolean;
}

function sceneOrder(a: DriftScene, b: DriftScene): number {
  return a.sequence - b.sequence || a.id.localeCompare(b.id);
}

/** Every ref a scene exposes for checking, boundaries first. */
function sceneRefs(scene: DriftScene): MsgRef[] {
  const refs: MsgRef[] = [];
  const range = scene.source?.message_range;
  if (range?.start) refs.push(range.start);
  if (range?.end) refs.push(range.end);
  for (const sr of scene.source?.swipe_resolutions ?? []) {
    if (sr?.msg) refs.push(sr.msg);
  }
  return refs;
}

/**
 * Walk scenes in order and find the first one whose sampled refs no
 * longer match the live chat.
 *
 * Cost is a handful of hashes per scene, not a hash per message — which
 * is what makes this cheap enough to run whenever tier 1 reports
 * divergence.
 */
export async function localiseSceneDrift(
  scenes: readonly DriftScene[],
  messages: readonly DriftMessage[],
  index?: ReadonlyMap<string, number>
): Promise<SceneDriftReport> {
  const byId = index ?? indexById(messages);
  const ordered = [...scenes].sort(sceneOrder);

  let divergedAt = -1;
  let checkedScenes = 0;
  let unverifiableRefs = 0;
  const danglingRefs: MsgRef[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const refs = sceneRefs(ordered[i]);
    if (refs.length === 0) continue;
    checkedScenes++;

    let broken = false;
    for (const ref of refs) {
      const idx = byId.get(ref.msg_id);
      const verdict = await checkMsgDrift(ref, idx === undefined ? undefined : messages[idx]);
      if (verdict === 'unverifiable') {
        unverifiableRefs++;
        continue;
      }
      if (verdict === 'dangling') danglingRefs.push(ref);
      if (verdict !== 'live') broken = true;
    }

    if (broken && divergedAt === -1) divergedAt = i;
  }

  // A branch restore adopts ids by (timestamp, isUser, name) signature
  // rather than by content, so it can permute ids across
  // indistinguishable messages and leave the tail on snapshot ids. That
  // looks identical to deletion from the id side and identical to
  // nothing-happened from the content side. If every ref we lost still
  // has its exact text sitting in the chat under some other id, the ids
  // moved and the history did not — do not flag scenes for that.
  const idChurnSuspected =
    danglingRefs.length > 0 && (await allTextsStillPresent(danglingRefs, messages));

  if (divergedAt === -1 || idChurnSuspected) {
    return {
      divergedSceneId: null,
      divergedSequence: null,
      downstreamSceneIds: [],
      checkedScenes,
      unverifiableRefs,
      idChurnSuspected,
    };
  }

  const downstream = ordered.slice(divergedAt);
  return {
    divergedSceneId: ordered[divergedAt].id,
    divergedSequence: ordered[divergedAt].sequence,
    downstreamSceneIds: downstream.map((s) => s.id),
    checkedScenes,
    unverifiableRefs,
    idChurnSuspected: false,
  };
}

// ---------------------------------------------------------------------------
// What the banner should say and offer
// ---------------------------------------------------------------------------

export interface DriftBannerState {
  /** 'none' renders nothing at all. */
  kind: 'none' | 'new_messages' | 'diverged';
  newMessageCount: number;
  staleSceneCount: number;
  /** Pick up the new messages incrementally. */
  canUpdate: boolean;
  /** Rebuild from scratch (archive-backed). */
  canReingest: boolean;
  /** Stamp `stale_source` on the affected scenes. */
  canFlag: boolean;
  /** Tier 2 could not check some refs, so the affected list may be short. */
  incompleteCheck: boolean;
}

/**
 * Map a drift result onto what the user is actually offered.
 *
 * Extracted from the component so the RULES are testable in plain node,
 * which is how everything else in this codebase is tested. The important
 * one is the lock:
 *
 * Re-ingest routes through `resetBible`, which is ungated and wipes
 * `meta` — including `canon_locked_at`. Offering it while canon is locked
 * would make a lock destroyable by a button whose own section promises no
 * auto-unlock. Flagging is suppressed for the same reason it is offered
 * at all: it is a write, and the lock is the mode where nothing writes.
 * Detection itself is a pure read and keeps running regardless, so the
 * user is still TOLD — they are just told to unlock first.
 */
export function driftBannerState(
  verdict: WatermarkVerdict | null | undefined,
  scenes: SceneDriftReport | null | undefined,
  opts: { canonLocked: boolean; canManage: boolean }
): DriftBannerState {
  const none: DriftBannerState = {
    kind: 'none',
    newMessageCount: 0,
    staleSceneCount: 0,
    canUpdate: false,
    canReingest: false,
    canFlag: false,
    incompleteCheck: false,
  };
  if (!verdict || !opts.canManage) return none;

  // `never_walked` and `unknown` deliberately show nothing. Silence is
  // the honest output when there is no watermark to measure from, or when
  // the anchor could not be verified — see §3.2 on not overclaiming.
  if (verdict.kind === 'never_walked' || verdict.kind === 'unknown') return none;
  if (verdict.kind === 'clean') return none;

  if (verdict.kind === 'new_messages') {
    return {
      ...none,
      kind: 'new_messages',
      newMessageCount: verdict.count,
      canUpdate: !opts.canonLocked,
    };
  }

  const staleSceneCount = scenes?.downstreamSceneIds.length ?? 0;
  return {
    ...none,
    kind: 'diverged',
    staleSceneCount,
    canReingest: !opts.canonLocked,
    canFlag: !opts.canonLocked && staleSceneCount > 0,
    incompleteCheck: (scenes?.unverifiableRefs ?? 0) > 0,
  };
}

/**
 * True when every dangling ref's fingerprint still appears somewhere in
 * the live chat — the id-churn signature.
 *
 * Only compares within a single hash algorithm: a ref recorded under
 * djb2 can never be matched against a sha256 digest, and pretending
 * otherwise would turn "we can't check" into a confident "nothing
 * changed".
 */
async function allTextsStillPresent(
  refs: readonly MsgRef[],
  messages: readonly DriftMessage[]
): Promise<boolean> {
  const wanted = new Set(refs.map((r) => `${r.fingerprint.hash_alg}:${r.fingerprint.sha}`));
  if (wanted.size === 0) return false;

  for (const msg of messages) {
    if (wanted.size === 0) break;
    const { sha, hash_alg } = await hashText(msg.content);
    wanted.delete(`${hash_alg}:${sha}`);
  }
  return wanted.size === 0;
}
