// ---------------------------------------------------------------------------
// Server-side lore retrieval for single-chat generation
// ---------------------------------------------------------------------------
//
// Ports the client-side scan (scanMessagesForEntries, worldInfoStore.ts) to
// ggbc-backend's POST /retrieval/context activation-engine endpoint, for the
// subset of chats whose lore configuration the server can faithfully
// replicate. This module owns:
//
//   1. isChatEligibleForServerRetrieval — a pure, synchronous precondition
//      check. The server has no way to signal "your chat config isn't
//      representable here" from a response, so the CLIENT must decide not
//      to ask in the first place. Mirrors buildConversationContext's own
//      composition-input construction (chatStore.ts) exactly, so it can
//      never diverge from what the client would actually scan. Biased
//      conservative throughout: any ambiguous signal returns false. A false
//      "ineligible" just uses the (unchanged) client engine; a false
//      "eligible" would silently inject wrong or missing lore.
//   2. tryServerRetrieval — the fetch-and-fallback wrapper callers actually
//      use. Never throws: on ANY failure (ineligible config, network error,
//      non-2xx, timeout, malformed response) it resolves to null, meaning
//      "use the existing client-side engine this turn, unchanged."
//   3. commitServerRetrieval — fire-and-forget wrapper around the post-
//      generation commit call, mirroring saveWiTimers' call-only-after-a-
//      confirmed-successful-generation gating.
//   4. Session-scoped one-time migration guards (content import, per-chat
//      timer import) — plain module-level state, NOT persisted to
//      localStorage. Resetting on every page reload is intentional: the
//      backend's import endpoints are idempotent, so a redundant re-run
//      costs nothing.
//
// Scope: single-chat generation only (buildConversationContext's call
// sites). Group chat (buildGroupConversationContext) is untouched by design
// and must never import from this module.

import {
  api,
  type RetrievalContextEntryDTO,
  type RetrievalContextActivationDTO,
} from '../api/client';
import {
  useWorldInfoStore,
  loadWiTimers,
  type WorldInfoBook,
  type WorldInfoEntry,
  type WorldInfoPosition,
  type SelectiveLogic,
  type EntrySource,
  type EntryRevision,
  type MatchedEntry,
  type WiActivationReason,
} from '../stores/worldInfoStore';
import { useCharacterStore } from '../stores/characterStore';
import { useChatLoreConfigStore } from '../stores/chatLoreConfigStore';
import { usePersonaStore } from '../stores/personaStore';
import { ensureDataBankImportedAndIndexed } from '../stores/dataBankStore';

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Whether this (character, chat) pair's lore configuration is simple enough
 * for the server's native-table activation engine to faithfully replicate.
 * Pure — reads only store state, no I/O, safe to call on every generation.
 *
 * Ineligible whenever:
 *  0. sharedBooksStatus isn't 'loaded' — condition 4 below needs a
 *     confirmed-current view of shared/group world books, or it's checking
 *     against incomplete data.
 *  1. The persona active for this character links any books — no server
 *     model for persona-linked books at all.
 *  2. The character has any manually-linked book beyond its single embedded
 *     book (checked against the raw linkedBookIdsByAvatar map directly,
 *     not the filtered/derived getActiveBookIdsForCharacter() list, per the
 *     "bias conservative" rule).
 *  3. This chat has ANY v2 per-chat customization (linked books, excluded
 *     entries, overlays, or local entries) — any of these makes
 *     resolveEffectiveBooks diverge from the plain global-active scan,
 *     which is the only shape the server can replicate.
 *  4. Any of the user's own or group-shared WORLD books is not currently
 *     toggled active — the server's world scope is every such book
 *     unconditionally (no per-book active/inactive toggle server-side), so
 *     a toggled-off world book would be wrongly included by the server.
 *  4b. Any ACTIVE world book was sourced from wiState.sharedBooks (a group
 *     peer's book, not the caller's own) — GET /worldinfo/shared and POST
 *     /retrieval/context read two independently-populated backends for a
 *     peer's books: the former falls back to scanning the peer's raw
 *     stm_worldinfo blob whenever that peer has zero rows in the native
 *     `lorebooks` table, so an unmigrated peer's shared book is visible
 *     here; the latter's group-shared scope matches ONLY native
 *     `Lorebook.user_id` rows, with no blob fallback, so that same book's
 *     entries would be silently absent server-side. The client has no
 *     signal for whether a given peer has ever migrated, so bias
 *     conservative and treat any active shared-origin book as ineligible.
 *  5. activeBookIds contains a character-scoped book owned by a DIFFERENT
 *     character than the one generating — the server's character scope is
 *     exactly [characterAvatar]; a stray other-character book manually
 *     toggled active would be scanned client-side but never returned
 *     server-side.
 */
export function isChatEligibleForServerRetrieval(
  characterAvatar: string | undefined,
  chatFile: string | null | undefined
): boolean {
  if (!characterAvatar || !chatFile) return false;

  const wiState = useWorldInfoStore.getState();

  if (wiState.sharedBooksStatus !== 'loaded') return false;

  const persona = usePersonaStore.getState().getPersonaForContext(characterAvatar);
  if (persona?.linkedBookIds && persona.linkedBookIds.length > 0) return false;

  const linkedForChar =
    useCharacterStore.getState().linkedBookIdsByAvatar[characterAvatar] || [];
  if (linkedForChar.length > 0) return false;

  const chatConfig = useChatLoreConfigStore.getState().getEffectiveConfig(chatFile);
  if (chatConfig) {
    const hasLinked = chatConfig.linkedBookIds.length > 0;
    const hasExcluded = Object.values(chatConfig.excludedEntryIds).some(
      (ids) => Array.isArray(ids) && ids.length > 0
    );
    const hasOverlays = Object.keys(chatConfig.overlays).length > 0;
    const hasLocal = chatConfig.localEntries.length > 0;
    if (hasLinked || hasExcluded || hasOverlays || hasLocal) return false;
  }

  // getComposableBooks() = own books ∪ sharedBooks minus id collisions (own
  // wins a collision) — see worldInfoStore.ts. Recompute that same
  // non-colliding shared-id set here so condition 4b below can tell a
  // peer-owned book apart from the caller's own, without duplicating
  // getComposableBooks' merge logic.
  const ownBookIds = new Set(wiState.books.map((b) => b.id));
  const sharedBookIds = new Set(
    wiState.sharedBooks.filter((b) => !ownBookIds.has(b.id)).map((b) => b.id)
  );

  const composableBooks = wiState.getComposableBooks();
  for (const book of composableBooks) {
    if (book.scope !== 'world') continue;
    if (!wiState.activeBookIds.includes(book.id)) return false;
    // Condition 4b — see the doc comment above: a peer's shared book may be
    // visible here via GET /worldinfo/shared's blob fallback while still
    // being invisible to POST /retrieval/context's native-only scope query.
    if (sharedBookIds.has(book.id)) return false;
  }

  const booksById = new Map<string, WorldInfoBook>(
    composableBooks.map((b) => [b.id, b])
  );
  for (const id of wiState.activeBookIds) {
    const book = booksById.get(id);
    if (book && book.scope === 'character' && book.ownerCharacterAvatar !== characterAvatar) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// One-time migration guards — session-scoped, in-memory only. NEVER
// persisted (localStorage/sync blob/etc): resetting on every page reload is
// intentional, both endpoints are idempotent so a redundant re-run is free.
// ---------------------------------------------------------------------------

// A hung request must never stall message sending — abort well under
// anything a user would perceive as "stuck", so the client engine takes
// over the same turn instead of the send spinner hanging. tryServerRetrieval
// creates exactly ONE abortAfter(RETRIEVAL_TIMEOUT_MS) and shares its signal
// across every network call it makes (both one-time imports below, and the
// read itself further down) — this is a budget for the WHOLE call, not a
// fresh window per leg, so three sequential legs can't stack into a 3x-long
// stall before falling back.
const RETRIEVAL_TIMEOUT_MS = 6000;

function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timeoutId) };
}

let contentImportSucceeded = false;
let contentImportInFlight: Promise<boolean> | null = null;

/**
 * Ensures POST /lorebooks/import-from-blob has been called successfully at
 * least once this session. Only ever called from tryServerRetrieval, and
 * only once a chat has actually been found eligible — no point migrating
 * content nobody's about to use server-side. On failure the guard is NOT
 * set, so the next eligible turn retries.
 *
 * `signal` is tryServerRetrieval's own shared abort signal (one
 * RETRIEVAL_TIMEOUT_MS budget for the whole call, not a fresh window per
 * leg) — see the comment on tryServerRetrieval itself.
 */
async function ensureContentImported(signal: AbortSignal): Promise<boolean> {
  if (contentImportSucceeded) return true;
  if (contentImportInFlight) return contentImportInFlight;
  contentImportInFlight = (async () => {
    try {
      await api.importLorebooksFromBlob(signal);
      contentImportSucceeded = true;
      return true;
    } catch (err) {
      console.warn(
        '[serverRetrieval] import-from-blob failed — falling back to the client-side lore scan this turn',
        err
      );
      return false;
    } finally {
      contentImportInFlight = null;
    }
  })();
  return contentImportInFlight;
}

/**
 * Sibling to ensureContentImported for the Data Bank -> Lorebook migration
 * (POST /lorebooks/import-from-databank) — closes the same first-turn race:
 * a generation right after login can otherwise run through
 * /retrieval/context before dataBankStore.ts's own fetchPrefs-driven
 * migration has completed, silently missing just-migrated document content
 * for that one turn.
 *
 * Delegates entirely to dataBankStore.ts's ensureDataBankImportedAndIndexed
 * rather than calling the endpoint directly — that function is the shared
 * entrypoint BOTH this trigger and dataBankStore's own fetchPrefs go
 * through, on top of its own once-per-session guard, specifically so
 * whichever of the two triggers actually performs the network call is also
 * the one that updates the frontend's Data Bank registry (lorebookIds).
 * Calling the endpoint straight from here (bypassing that shared function,
 * as an earlier version of this code did) would let this trigger "win" the
 * one-shot import on a slow/early login without ever recording it, leaving
 * the Data Bank registry (lorebookIds) permanently unpopulated —
 * see that function's own docstring for the full failure mode. No local
 * guard/in-flight-dedup needed here anymore: the shared function's own
 * guard already makes a second call in the same session an instant no-op.
 *
 * Unlike ensureContentImported, a failure here does NOT abort the whole
 * tryServerRetrieval attempt for this turn (see the call site) — only
 * Data-Bank-sourced entries would be missing, not the character's actual
 * lorebooks, so falling all the way back to the client-side scan over a
 * Data Bank migration hiccup would throw out retrieval for content that has
 * nothing to do with it.
 */
async function ensureDataBankContentImported(): Promise<void> {
  try {
    await ensureDataBankImportedAndIndexed();
  } catch (err) {
    console.warn(
      '[serverRetrieval] import-from-databank failed — Data Bank documents may be missing from server-side retrieval this turn',
      err
    );
  }
}

const timerImportSucceededChats = new Set<string>();
const timerImportInFlight = new Map<string, Promise<boolean>>();

/**
 * Ensures POST /chats/wi-timers/import has been called successfully at
 * least once this session for this specific chat, seeded from that chat's
 * existing local timer blob (loadWiTimers). Same non-blocking-failure
 * semantics as ensureContentImported: failure doesn't set the guard, so the
 * next eligible turn for this chat retries. `signal` — see
 * ensureContentImported's doc comment.
 */
async function ensureTimersImported(
  chatFile: string,
  characterAvatar: string,
  signal: AbortSignal
): Promise<boolean> {
  if (timerImportSucceededChats.has(chatFile)) return true;
  const inFlight = timerImportInFlight.get(chatFile);
  if (inFlight) return inFlight;

  const timers = loadWiTimers(chatFile);
  if (Object.keys(timers).length === 0) {
    // Nothing to migrate — trivially successful, no network call needed.
    timerImportSucceededChats.add(chatFile);
    return true;
  }

  const promise = (async () => {
    try {
      await api.importWiTimers(characterAvatar, chatFile, timers, signal);
      timerImportSucceededChats.add(chatFile);
      return true;
    } catch (err) {
      console.warn(
        '[serverRetrieval] wi-timers/import failed — falling back to the client-side lore scan this turn',
        err
      );
      return false;
    } finally {
      timerImportInFlight.delete(chatFile);
    }
  })();
  timerImportInFlight.set(chatFile, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// DTO -> MatchedEntry normalization
// ---------------------------------------------------------------------------

const VALID_POSITIONS = new Set<WorldInfoPosition>([
  'before_char',
  'after_char',
  'before_an',
  'after_an',
  'at_depth',
]);
const VALID_SELECTIVE_LOGIC = new Set<SelectiveLogic>([
  'AND_ANY',
  'AND_ALL',
  'NOT_ANY',
  'NOT_ALL',
]);
const VALID_SOURCES = new Set<EntrySource>([
  'manual',
  'auto_memory',
  'import',
  'generated',
  'fork',
]);
// Mirrors the backend's ActivationReason Literal (app/schemas/retrieval.py
// in ggbc-backend) — an unrecognized value (a future reason an older
// frontend build doesn't know about yet) is dropped to `undefined` rather
// than passed through, same treatment as every other allowlisted field
// below.
const VALID_ACTIVATION_REASONS = new Set<WiActivationReason>([
  'constant',
  'keyword',
  'semantic',
  'sticky',
]);

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Converts one server-provided entry (already validated server-side by
 * LorebookEntryOut, but never trusted blindly here — see the module note on
 * never throwing out to the caller) into a MatchedEntry. Returns null (skip
 * this one entry, don't crash the whole turn) when the entry is missing an
 * id or lorebook_id.
 *
 * `entry.position` is validated against the exact literal set
 * buildConversationContext indexes `wiByPosition` with
 * (chatStore.ts's `wiByPosition[m.entry.position]` indexing — named, not
 * line-cited, because the previous citation here had drifted ~320 lines)
 * — an unrecognized value there would throw
 * synchronously (`wiByPosition[unrecognized]` is undefined, `.push` throws),
 * which would defeat the entire fallback design. Every other field is
 * handled by one of several mechanisms. Four are allowlist-validated,
 * rewriting an unrecognized value to a documented default:
 * `activationReason` (VALID_ACTIVATION_REASONS), `position`
 * (VALID_POSITIONS), `selectiveLogic` (VALID_SELECTIVE_LOGIC) and `source`
 * (VALID_SOURCES). The rest use str/bool/num coercion, `strArr` (which
 * element-filters), a typeof-ternary, or — for `revisions` — a SHALLOW
 * `Array.isArray` cast whose elements are never validated at all.
 *
 * **No closed partition of the field set is stated here on purpose.** Four
 * successive attempts to summarize this contract (one in the build commit,
 * three in review fix rounds) were each confirmed false by a later round;
 * the enumeration above is illustrative, not exhaustive. Read the
 * construction below for the per-field truth.
 * Only `position` can actually CRASH downstream (wiByPosition indexing);
 * the other three are allowlisted because their consumers assume the
 * literal union, not because they are crash-capable — do not read the
 * crash rationale as the criterion for adding the next one.
 *
 * This paragraph previously said `position` was "the one validated against
 * an allowlist". That was false the day it was written (9ced3e43,
 * 2026-08-06 — the same commit already contained VALID_SELECTIVE_LOGIC and
 * VALID_SOURCES) and stood for 24 days. It is called out here because that
 * same commit also wrote the `captureWiFired` crosswalk comment whose rot
 * generated roadmap story E2-S5, and this claim was found by E2-S5's own
 * review round 4 — pointed at by a comment that had just told readers to
 * trust this docblock over a summary.
 *
 * `bookName` is set to '' — confirmed by reading every downstream consumer
 * of MatchedEntry.bookName in chatStore.ts (wrapWiContent keys off
 * `bookId`, not `bookName`; captureWiFired only reads `bookId`/`entry.id`)
 * that nothing renders or keys off it for this call path, so a real book
 * name isn't worth an extra GET /lorebooks round-trip here.
 *
 * `activations` is the sibling RetrievalContextDTO.activations map (absent
 * on a pre-E2-S2a backend — see RetrievalContextDTO's doc comment), looked
 * up by this entry's own (already-validated) id. `activationReason` is
 * kept only when it is one of VALID_ACTIVATION_REASONS, else dropped to
 * undefined — the allowlist, not RetrievalContextActivationDTO's `unknown`
 * type, is what actually guards against an unrecognized wire value.
 * `matchedKeyCount` is kept ONLY alongside a resolved `'keyword'` reason
 * (deliberate client-side narrowing — see MatchedEntry's own doc comment):
 * an incoherent pairing like `{activationReason: 'semantic',
 * matchedKeyCount: 3}` surfaces the reason but drops the count, rather
 * than propagating a count next to a reason it doesn't belong with.
 */
function dtoToMatchedEntry(
  dto: RetrievalContextEntryDTO,
  activations: Record<string, RetrievalContextActivationDTO> | undefined
): MatchedEntry | null {
  if (typeof dto.id !== 'string' || !dto.id) return null;
  if (typeof dto.lorebook_id !== 'string' || !dto.lorebook_id) return null;

  // Keyed by the SAME validated `dto.id` used everywhere below — never a
  // pre-guard raw value — so the lookup key can't diverge from the id this
  // MatchedEntry actually ends up carrying.
  const activation = activations?.[dto.id];
  const rawReason = activation?.activationReason;
  const activationReason = VALID_ACTIVATION_REASONS.has(rawReason as WiActivationReason)
    ? (rawReason as WiActivationReason)
    : undefined;
  const rawCount = activation?.matchedKeyCount;
  const matchedKeyCount =
    activationReason === 'keyword' &&
    typeof rawCount === 'number' &&
    Number.isFinite(rawCount) &&
    rawCount >= 1
      ? rawCount
      : undefined;

  const position = VALID_POSITIONS.has(dto.position as WorldInfoPosition)
    ? (dto.position as WorldInfoPosition)
    : 'before_char';
  const selectiveLogic = VALID_SELECTIVE_LOGIC.has(dto.selectiveLogic as SelectiveLogic)
    ? (dto.selectiveLogic as SelectiveLogic)
    : 'AND_ANY';
  const source = VALID_SOURCES.has(dto.source as EntrySource)
    ? (dto.source as EntrySource)
    : 'manual';

  const entry: WorldInfoEntry = {
    id: dto.id,
    keys: strArr(dto.keys),
    content: str(dto.content, ''),
    comment: str(dto.comment, ''),
    enabled: bool(dto.enabled, true),
    constant: bool(dto.constant, false),
    caseSensitive: bool(dto.caseSensitive, false),
    position,
    depth: num(dto.depth, 4),
    // Wire field is `order` (LorebookEntryOut aliases insertion_order ->
    // "order" via serialization_alias) — confirmed by reading
    // app/schemas/lorebook.py directly.
    order: num(dto.order, 100),
    keysSecondary: strArr(dto.keysSecondary),
    selective: bool(dto.selective, false),
    selectiveLogic,
    scanDepth: typeof dto.scanDepth === 'number' ? dto.scanDepth : null,
    probability: num(dto.probability, 100),
    useProbability: bool(dto.useProbability, false),
    group: str(dto.group, ''),
    groupOverride: bool(dto.groupOverride, false),
    groupWeight: num(dto.groupWeight, 100),
    preventRecursion: bool(dto.preventRecursion, false),
    excludeRecursion: bool(dto.excludeRecursion, false),
    sticky: num(dto.sticky, 0),
    cooldown: num(dto.cooldown, 0),
    delay: num(dto.delay, 0),
    critical: bool(dto.critical, false),
    semanticOnly: bool(dto.semanticOnly, false),
    category: str(dto.category, ''),
    relatedIds: strArr(dto.relatedIds),
    source,
    revisions: Array.isArray(dto.revisions) ? (dto.revisions as EntryRevision[]) : [],
    createdAt: num(dto.createdAt, 0),
    updatedAt: num(dto.updatedAt, 0),
  };

  return {
    entry,
    bookId: dto.lorebook_id,
    bookName: '',
    matchedKeyCount,
    activationReason,
  };
}

// ---------------------------------------------------------------------------
// tryServerRetrieval — the wrapper call sites actually use
// ---------------------------------------------------------------------------

export interface ServerRetrievalResult {
  matchedEntries: MatchedEntry[];
  turnNo: number;
  activatedEntryIds: string[];
}

/**
 * Attempts the server-side lore read for one generation turn. Returns null
 * (meaning: use the existing client-side scanMessagesForEntries path,
 * unchanged) whenever the chat is ineligible, the eligibility check itself
 * throws, the one-time content/timer import hasn't succeeded (this turn's
 * attempt included), or the read itself fails for any reason — timeout,
 * network error, non-2xx, or a malformed response. NEVER throws.
 *
 * All three network legs below (content import, timer import, the
 * retrieval read itself) share ONE abortAfter(RETRIEVAL_TIMEOUT_MS) budget
 * for the whole call, rather than each getting its own independent
 * RETRIEVAL_TIMEOUT_MS window — otherwise a slow-but-not-hung backend could
 * stall the caller for up to 3x RETRIEVAL_TIMEOUT_MS (each leg awaited
 * sequentially) before falling back, defeating the "abort well under
 * anything a user would perceive as stuck" goal whenever more than one leg
 * is slow.
 */
export async function tryServerRetrieval(
  characterAvatar: string,
  chatFile: string
): Promise<ServerRetrievalResult | null> {
  const { signal, cancel } = abortAfter(RETRIEVAL_TIMEOUT_MS);
  try {
    // Wrapped in this same try/catch (not left to run before it, as
    // before) so a throw from this synchronous eligibility check — or any
    // Zustand store getter it reads — degrades to the same silent
    // client-side fallback as every other failure mode here, honoring
    // this module's own "never throws" contract end-to-end rather than
    // only for the network legs.
    if (!isChatEligibleForServerRetrieval(characterAvatar, chatFile)) return null;

    const contentOk = await ensureContentImported(signal);
    if (!contentOk) return null;

    await ensureDataBankContentImported();

    const timersOk = await ensureTimersImported(chatFile, characterAvatar, signal);
    if (!timersOk) return null;

    // Re-check eligibility immediately before the read. The two import legs
    // above are real network calls that can together take up to the full
    // shared RETRIEVAL_TIMEOUT_MS budget — long enough for the user to
    // toggle a world book (or otherwise change the chat's lore config)
    // mid-flight. The server has no per-book active/inactive concept at
    // all, so a config that went stale during the imports would still be
    // read in full below; re-validating here shrinks that window down to
    // just the read itself instead of silently using the config as it was
    // when tryServerRetrieval started.
    if (!isChatEligibleForServerRetrieval(characterAvatar, chatFile)) return null;

    const tokenBudget = useWorldInfoStore.getState().tokenBudget;

    const dto = await api.getRetrievalContext(
      characterAvatar,
      chatFile,
      tokenBudget,
      signal
    );
    if (
      !dto ||
      !Array.isArray(dto.entries) ||
      !Array.isArray(dto.activatedEntryIds) ||
      typeof dto.turnNo !== 'number'
    ) {
      console.warn('[serverRetrieval] unexpected /retrieval/context response shape — falling back');
      return null;
    }
    const matchedEntries: MatchedEntry[] = [];
    for (const rawEntry of dto.entries) {
      // LANDMINE (do not "fix"): `dto.activations` is intentionally NOT
      // required by the malformed-response guard above. Requiring it would
      // make a pre-E2-S2a backend (which never sends the key at all) fall
      // through to `return null` -> the client-side scan takes over the
      // whole turn, which is not "behaves as today" and breaks the old-
      // backend compatibility contract. A malformed/missing value is
      // guarded HERE, at the point of use, instead.
      const matched = dtoToMatchedEntry(rawEntry, dto.activations);
      if (matched) matchedEntries.push(matched);
    }
    return {
      matchedEntries,
      turnNo: dto.turnNo,
      activatedEntryIds: dto.activatedEntryIds.filter((id): id is string => typeof id === 'string'),
    };
  } catch (err) {
    console.warn(
      '[serverRetrieval] failed — falling back to the client-side lore scan this turn',
      err
    );
    return null;
  } finally {
    cancel();
  }
}

/**
 * Fire-and-forget commit of this turn's server-side activations — the only
 * call allowed to advance server-side timed-effect state. Callers must only
 * invoke this after a confirmed-successful, non-empty generation, exactly
 * mirroring saveWiTimers' existing gating (see buildConversationContext's
 * call sites in chatStore.ts). Never throws and never delays the caller —
 * an ephemeral commit failure is logged and swallowed, not surfaced as a
 * chat error, matching the endpoint's own "fire and forget" contract
 * (204 No Content, GREATEST-guarded upsert server-side).
 */
export function commitServerRetrieval(
  characterAvatar: string,
  fileName: string,
  turnNo: number,
  activatedEntryIds: string[]
): void {
  api.commitRetrievalContext(characterAvatar, fileName, turnNo, activatedEntryIds).catch((err) => {
    console.warn('[serverRetrieval] /retrieval/context/commit failed (non-fatal)', err);
  });
}
