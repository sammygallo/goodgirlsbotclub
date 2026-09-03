# Prompt injection audit — World Info/Lorebooks + chat-history RAG

**Story:** E2-S1 (roadmap `docs/product-roadmap-10.2-12.md`) · **Audited:** 2026-08-24
**Baseline:** frontend `668d3edb`, backend `aee3b06`. Line numbers cite that state — re-verify before relying on exact lines.

**Method:** four independent code-trace lanes (solo assembly · group assembly · WI activation engine · retrieval pipelines across both repos) plus an empirical marker-string harness that drove the real builders and dumped the assembled prompts. Every claim below was then fact-checked by three adversarial lenses (citations · omissions · consistency) with two independent skeptics per finding: **16 confirmed, 5 contested, 5 refuted**. Corrections from that pass are folded in; §9 records what was refuted so it is not re-litigated.

> **Why this doc exists:** E2-S2 (token breakdown) instruments the seams described here. A wrong claim in this doc becomes a wrong number in the user-facing UI, which is why it was verified rather than merely written.

---

## 1 · Architecture

**Two retrieval pipelines feed one prompt; "Data Bank" is no longer a pipeline.** Documents were dissolved into native Lorebooks (frontend `83905257`; UI retired `04a7f47b`): one lorebook per document, one keyless `semanticOnly: true` entry per ~500-char chunk (`dataBankStore.ts:251-271`, `chunker.ts:28`). There is no client-side embedding (`utils/embeddings.ts` deleted in `37da7edc`) and no `[From: docname]` provenance anywhere.

| | Lore retrieval (incl. Data Bank content) | Chat-history recall |
|---|---|---|
| Client entry | `tryServerRetrieval` (`serverRetrieval.ts:452`) → `serverMatchedEntries`; local fallback = `scanMessagesForEntries` | `resolveRagContext` (`chatStore.ts`) → `ragCtx` string |
| Backend | `POST /retrieval/context`; SQL/RRF stage `_retrieval.py` (k=60, cos-dist ≤ 0.3 at `:95,:102`) then the Python activation engine `_activation.py` | `POST /retrieval/messages`, `message_embeddings` (migration 0026), pure cosine, `limit=k` |
| Threshold | cos-dist ≤ 0.3 | `_MESSAGE_SIMILARITY_FLOOR = 0.5` → `_MAX_MESSAGE_COSINE_DISTANCE = 1.0 - floor` (`retrieval.py:401-402`; **note `:398` is the comment warning not to confuse this with the lorebook 0.3**) |
| k / budget | budget = `wiState.tokenBudget` (default 1024), passed to the server (`serverRetrieval.ts:485-492`) | k hardcoded 3 (the 4th argument of the `api.getRetrievalMessages` call in `resolveRagContext`); **no token budget** |
| Opt-in | always-on when eligible | `stm_rag_settings.enabled`, re-checked server-side (`retrieval.py:494`) |
| Group chats | **never** (`serverRetrieval.ts:32-34`, by design) | yes (identity = `characterAvatars[0]`, the group-identity block in `resolveRagContext`) |
| Prompt slot | the `wi_*` position sections + `at_depth` | the single `rag_context` section (solo) / flat-system tail (group) |

Shared only: the embedding provider chain (openai `text-embedding-3-small` → gemini `embedding-001` → cohere `embed-v4.0`, `embeddings_catalog.py:78-101`, dim 1536), the `embedding_jobs` queue and its polling worker, enqueued from `save_chat` (`chats.py:305-307`) plus two read-path sites. Staleness is checked three ways (worker diff, read-path opportunistic re-enqueue, query-time `content_hash` + model filter) and message text is always read live from the chat row, so a stale vector can never surface stale prose.

**Server-retrieval eligibility is narrow** (`serverRetrieval.ts:100-159`) — any of these forces the local scan: **any manually character-linked lorebook** (`linkedBookIdsByAvatar[avatar]` non-empty, `:113-115` — in practice the most commonly hit disqualifier), persona-linked books, any per-chat lore customization, any inactive world book, shared-origin active books, foreign character-scoped books, unloaded shared-books state, or any network failure. `swipeRight`/`continueMessage` are always local (turn-index skew, documented at `chatStore.ts:3695-3707`).

---

## 2 · Emitted prompt order (empirically verified)

**Solo — `buildConversationContext` (`chatStore.ts:966`).** Three hard-coded stages; only the section order *within* stages A and C is user-reorderable (Phase 9 `promptOrder`).

- **Stage A — one system message** (`:1334-1337`), sections joined `\n\n`, default order: `main_prompt · persona_before_char · wi_before_char · ext_before_char · char_info_block · wi_after_char · ext_after_char · persona_after_char · wi_before_an · ext_before_an · jailbreak · emotion_instruction · selfie_instruction · rag_context`. **Chat recall is the last pre-history section, inside the system message** — wrapped `[Relevant background information]\n…`, chunks rendered `[Earlier in chat — User|Character]` joined `\n\n---\n\n` (`:927-933`, `:1304-1306`).
- **Stage B — history**, with a fixed interleave per depth-from-end (`:1480-1522`): character's note → author's note → persona@depth → WI `at_depth` (as system) → extension `at_depth` (the summary; summarize defaults to depth 999, so in practice the summary is the first element of history). Depth-0 copies land **after** the newest turn (`:1568-1579`); depths exceeding the window are unshifted to the front (`:1590-1640`).
- **Stage C — post-history**, one system message per section (`:1683-1689`): `char_phi · user_phi · wi_after_an · ext_after_an` (`POST_HISTORY_SECTIONS`, `generationStore.ts:160-165`). Stage membership is not reorderable — dragging `char_phi` to the top only moves it among the post-history four.
- **Appended at the call site, with no section id:** the continue instruction (`:3858-3861`) and the impersonate instruction (`:3985-3988`, a user-role turn). Also not sections: history itself, the user message, and every depth-controlled insertion above. Story-state contributes nothing to assembly.

**Group — `buildGroupConversationContext` (`:1746`).** One flat system message in hard-coded order (`:2003-2027`): header → `wi_before_char` → card block → `wi_after_char` → scenario → speaker example dialogue → `wi_before_an` → formatting rules (with a hard-coded 12-emotion list) → content rules → **recall appended raw at the tail**. Then history (fixed `slice(-30)`) with author's note and WI `at_depth` interleaved, then a trailing `wi_after_an`. **`promptOrder` is ignored entirely in group** (`:2110-2114`) — all 18 section toggles are inert.

**Post-assembly transforms (both run on every path, solo `:3712/:3870/:3991/:4215/:4616` and group `:2178`).** The builder's output is not what ships: `maybeApplyInstructMode` (`:2302-2313`) collapses the entire array into a single user-role message rendered through an instruct template whenever `instruct.enabled` or `completionMode === 'text'`, and `runGenerateInterceptors` (`:2327-2354`) POSTs the array to any server extension declaring `generate_interceptor: true` and replaces it wholesale with whatever comes back. Order and content survive the instruct transform (it concatenates in order, adding delimiters and the tokenizer's flat +4/message), but the message *structure* does not, and an interceptor may change anything. **E2-S2 and E2-S3 must decide explicitly whether they measure and display pre- or post-transform** — the honest answer for "show prompt" is post-transform.

---

## 3 · World Info activation — two different engines

The old memory note claiming List/Natural/Pooled strategies was wrong: those are **group speaker-selection** strategies (`chatStore.ts:146-158`), unrelated to lore.

### 3a · Client engine — `scanMessagesForEntries` (`worldInfoStore.ts:1309-1474`)

Runs on group chats always, and on solo turns whenever server retrieval is ineligible (§1). Order: book filter → candidate flatten (skips disabled/empty; `semanticOnly` is *not* filtered, it simply never matches — see F1) → timed gates (`delay`/`cooldown`, applied before everything including constants) → initial pass (constants still roll probability; `Math.random()`) → inclusion-group resolution (`groupOverride` entries, when present, replace the pool entirely; equal weights → deterministic winner by order → matched-key count → alphabetical; unequal → weighted random) → recursion (≤3 steps; haystack is only the previous pass's additions; excludes `excludeRecursion`, `preventRecursion`, `critical`, and `constant`) → sticky carry-over (since E4-S0, also subject to inclusion-group exclusivity) → `relatedIds` transitive pull-in (bypasses keys, probability and group competition by design; timers still apply — but since E4-S0 it can *not* reach a sticky carry-over that just lost its group, see F3) → token budget → `outActivatedIds` = freshly-activated ∩ budget survivors, minus every sticky carry-over (the order was the other way round before E4-S0 — see F3) → final sort by `order`.

**Scan surface** (`:1084-1091`): the last `scanDepth` non-system messages (global default 4, user-settable, per-entry override), hidden messages excluded (`chatStore.ts:998`), the pending user message **included** (except on `swipeRight`). Recall chunks, card fields, notes and summaries are **not** scanned.

**`critical` = three guarantees:** never budget-evicted (`:1252`), never recursion-triggered (`:1395`), and pinned through the history trim when at-depth (`chatStore.ts:1658-1664`). `category` is inert for activation. Composition (v2 books, overlays, exclusions, per-chat entries) resolves strictly *before* the frozen scanner (`worldInfoComposition.ts:160-293`); ids are never re-minted, so timers stay valid.

### 3b · Server engine — `_activation.py` (the default path for eligible solo chats)

When `tryServerRetrieval` returns non-null, the client **skips the local scan entirely** (`chatStore.ts:1071-1079`) — the server result already is the turn's fully resolved, budget-trimmed activation. That engine deliberately differs from §3a, and the differences are load-bearing for anyone instrumenting or debugging activation:

- **No recursion and no `relatedIds` co-firing** — both scoped out (`_activation.py:51-66`; the only mentions of either in the file are that gap list).
- **Semantic-only activation exists, with no client equivalent:** an entry can fire with zero keyword matches via the SQL stage's semantic/FTS legs, gated `sql_hit_eligible = sql_hit and (entry.semantic_only or not entry.keys)` (`:466-468`). This is how Data Bank chunks activate at all.
- **Seeded RNG** per `(chat_id, turn_no)` instead of `Math.random()` (`:20-30`) — probability rolls are reproducible per turn.
- **Fixed scan depth 4** (`:86`) — the user's scan-depth setting is never sent, so a user who sets depth 10 gets 4 on every server-path turn.
- **Fixed `generic` tokenizer profile** (3.8 chars/token, `:91`) for budget math, regardless of the active provider.

Consequence for F3 below: **neither** timer/sticky ordering bug is client-engine only — the Python engine ports both, verified against `_activation.py`. E4-S0 fixes them in both engines against one shared spec ([#452](https://github.com/sammygallo/goodgirlsbotclub/issues/452)), so the two keep deciding alike.

---

## 4 · Budgets — four mechanisms, and where they lie

1. **WI token budget** (`wiState.tokenBudget`, default 1024). Applies on the client scan path (solo-local **and group** — see 4.3) and is passed to the server on server turns. **It is measured on raw stored content:** `applyTokenBudget` costs `estimateTokens(entry.content)` (`worldInfoStore.ts:1250`) *before* macros expand and *before* `wrapWiContent` prepends attribution lines (`chatStore.ts:1126-1134`, group `:1898-1901`). It therefore systematically undercounts emitted bytes, and `pinnedOverBudget` / the fail-loud toast are computed against the same undercount. **E2-S2 will measure post-substitution content, so its World Info number will not reconcile with this budget** — surface both, or explain the gap.
2. **History trim** (`trimHistoryToBudget`, solo only). Budget = `max(256, maxTokens − responseReserve)` minus the whole Stage-A system block, which is charged as fixed overhead and never trimmed (recall included — a large recall block silently shrinks the history window; `tokenizer.ts:150-152` acknowledges this). Pinned: newest turn + critical at-depth insertions. Fill is contiguous newest→oldest, so one oversized message ends the walk for everything older.
3. **Summary compaction** — a third history-shaping mechanism, independent of the trim. `compactWhenSummarized` defaults **true** (`summarizeStore.ts:170`); when a summary exists, the oldest `summary.messageCount` turns are dropped outright (`chatStore.ts:1414-1421`), floored by `MIN_RAW_TAIL = 6`. E2-S2's history number is unexplainable without attributing this.
4. **Blind spots:**
   - **Stage C is emitted after the trim and never counted** (`:1683-1689`) — `char_phi`/`user_phi`/`wi_after_an`/`ext_after_an` can push the dispatched request past the budget silently.
   - **Image attachments are never counted at all.** They are folded into the last user message as content parts by `api.generateMessage` (`client.ts:1478-1507`), and an image-only message is deliberately kept with empty text (`chatStore.ts:1527-1533`). `estimateTokens`/`estimateMessageTokens` count characters only (`tokenizer.ts:51-69`), so real and often large model-side cost contributes zero to every number, including the trim's.
   - `overBudget` is always false when `tokenAware: false` (`:1643`, `:1677-1679`), and its doc comment describes stale semantics (it can now fire for pinned lore, not just an oversized user message).
   - If every pre-history section is empty, an empty-content system message still ships (`:1334` is unconditional).

**4.3 · What group actually lacks.** Group **does** enforce the WI token budget — it passes `tokenBudget: wiState.tokenBudget` into the scan (`chatStore.ts:1838`), populates `wiScanReport` (`:1844-1846`) and fires the same once-per-chat pinned-over-budget toast as solo (`:1849-1858`). What group lacks is the **history trim** (mechanism 2): a fixed `slice(-30)` window, no `tokenAware`, no `responseReserve`, no `overBudget`. A 30-message group history with large cards and lore can exceed the model window with no guard and no signal.

---

## 5 · Deduplication — absent (proven empirically)

The same sentence planted in a WI entry and in the recall fixture appears **twice** in the assembled prompt, in both solo and group (harness marker count = 2). There is no cross-pipeline dedup, suppression, or shared ranking anywhere on the client.

> **SUPERSEDED (2026-08-27, E2-S2 task 1b):** everything below describes machinery that no longer exists. `ragBoundary.ts` was **deleted**; the real trim boundary is threaded out of the builder via an uncommitted probe pass (`prepareConversationContext` → `finishConversationContext({commit:false})`) and sent to the server, and the group window lives in one shared `groupHistoryWindow()` used by builder and recall path alike. Both defect bullets were resolved: the tokenizer-profile under-exclusion died with the re-simulation, and the server fail-open now reports `reason: "boundary_not_found"` (ggbc-backend#81), which the client warns on. The residual is under-recall proportional to recall's budget share — the safe direction. Kept for the historical record:

The one overlap control is **recall vs. raw history**: `computeRagBoundary` (`ragBoundary.ts:93-137`) reproduces the builder's post-trim kept set so the server can exclude messages already in the prompt (group branch = last 30). Its known divergences:

- Hand-synced constant pairs with the real builder (`MIN_RAW_TAIL` 6, `GROUP_WINDOW` 30) — no compile-time link.
- The `pureChatMode` offset is not replicated (documented at `:42-49`; over-exclusion, safe direction).
- The boundary is computed before the WI scan, so it cannot know critical at-depth pins (over-exclusion, safe).
- **Not safe:** the tokenizer profile is omitted (`:125-130`), defaulting to `generic` at 3.8 chars/token, while the real trim uses `profileForProvider` (4.0 for GPT and Gemini families, `chatStore.ts:1665-1672`). The simulation prices messages ~5% high, keeps fewer, and returns a **newer** boundary — **under-exclusion**, meaning recall can return a message that is also present verbatim in raw history.
- **Server-side fail-open:** if `boundary_id` does not match a live message in the persisted chat row, the backend logs and falls back to excluding only the newest `_TAIL_SKIP = 4` embeddable messages (`retrieval.py:391`, `:405-453`). The client sees a normal 200 and cannot tell.

Its docstring's stated long-term fix — thread the real kept-history boundary out of the builder instead of re-simulating it — **was done** (E2-S2 task 1b, 2026-08-27; see the supersession note above).

---

## 6 · The original open questions, answered

1. **Dual-lookup efficiency:** both pipelines run per eligible turn, sequentially and independently; neither conditions on the other.
2. **Semantic overlap detection:** none (§5).
3. **Scope:** lore is book-composition scoped (world ∪ character ∪ persona ∪ per-chat); recall is strictly this chat's messages before the boundary.
4. **Precedence:** recall sits below all pre-history lore inside the Stage-A system message. The lore that lands *after* both recall and the newest turn is `wi_after_an` (Stage C) **and depth-0 `at_depth` entries** (`:1568-1579`). All of this is subject to user reordering of `promptOrder`.
5. **User visibility:** none today — that is E2-S2's job. The existing hooks to build on are the fired-WI telemetry (`chatStore.ts:1709-1739`) and `wiScanReport`.

---

## 7 · Findings

| # | Severity | Summary | Issue |
|---|---|---|---|
| F1 | **High** | Data Bank content silently never activates on local-scan turns | [#450](https://github.com/sammygallo/goodgirlsbotclub/issues/450) |
| F2 | Medium | Group assembly runs no macro substitution; one un-guarded empty-content case | [#451](https://github.com/sammygallo/goodgirlsbotclub/issues/451) |
| F3 | Medium | WI timer/budget ordering + sticky escapes group competition (**both** engines; fixed in E4-S0) | [#452](https://github.com/sammygallo/goodgirlsbotclub/issues/452) |
| F4 | Medium | Token-budget blind spots: Stage C, image attachments, `overBudget` semantics | [#453](https://github.com/sammygallo/goodgirlsbotclub/issues/453) |
| F5 | Medium | Group feature-parity debt (no history trim, no extension hooks, no persona) | [#454](https://github.com/sammygallo/goodgirlsbotclub/issues/454) |
| F6 | Low | Recall's `no_key` reason never surfaced to the user (fixed in E9-S7) | [#455](https://github.com/sammygallo/goodgirlsbotclub/issues/455) |
| F7 | Low | 14 stale docs/comments, incl. two user-visible labels | [#456](https://github.com/sammygallo/goodgirlsbotclub/issues/456) |

**F1 — Data Bank content never activates on local-scan turns.** In group chats (which never call server retrieval) and on any solo turn that falls back to the local scan (§1 eligibility — most commonly a character-linked lorebook), Data Bank chunks cannot fire. Two distinct mechanisms: for **globally-scoped** documents the keyless entry simply scores zero (`worldInfoStore.ts:1142`); for **character-scoped** documents the book is never even a candidate — `addDocument` creates a *second* book owned by that avatar, but `getCharacterBook` resolves `books.find(b => b.ownerCharacterAvatar === avatar)`, first match only (`:3385-3389`), and the new book appears in neither `activeBookIds` nor `linkedBookIdsByAvatar`. Feature death by migration drift.

**F2 — group assembly runs no macro substitution.** Card fields, author's note and history turns are all pushed raw (`chatStore.ts:1938-1948`, `:2053`, `:2065-2071`), so `{{user}}`/`{{char}}` and `{{setvar::…}}` ship as literal text in group chats while solo substitutes all of them. *Correction from verification:* the two provider-400 scenarios originally claimed here do **not** hold — `getAuthorNote` returns null for blank/whitespace content (`:3143-3147`), and a blank assistant turn still renders as `[Name]: `, non-empty. The genuinely un-guarded case is a **blank user turn**; solo guards it explicitly (`:1524-1539`), group does not.

**F3 — WI timer/budget ordering (*correction:* **both** engines, not client-only — see §3b).** `outActivatedIds` is populated before `applyTokenBudget` runs (`worldInfoStore.ts:1459-1471`), so an entry evicted by the budget — which never reached the prompt — still starts its cooldown and sticky window, and therefore also refuses to fire next turn. Sticky matches are appended after `resolveGroups` and never checked against `wonGroups` (`:1420-1431`), so a sticky entry and its own group's fresh winner can both inject, defeating the documented one-per-group contract — and two sticky siblings of one group both inject when neither freshly matched. `relatedIds` pull-ins are budget-evictable but timer-registering, compounding the first bug. `_activation.py` carries the same two, so E4-S0 fixes both engines against one shared spec: a timer registers only on the intersection of *freshly activated* and *survived the budget trim* (never sticky carry-overs, or they would re-stamp their window every turn and become permanent), and sticky carry-overs join inclusion-group exclusivity with a deterministic tie-break of **three** keys, `(order, label, content)` ascending, where `label` is `comment || keys[0] || id` case-folded. Both string keys compare by unicode **code point**, not UTF-16 code unit: Python's `<` on `str` already does this and JavaScript's does not, so an emoji in a comment is enough to split the two engines, and `localeCompare` is no substitute — it is locale- and ICU-version-dependent collation the backend cannot mirror. `content` is the final key because it is the one field both engines hold identically; neither engine's own candidate order is mutually computable (the backend's is SQL `ORDER BY (insertion_order, id)` over random UUIDs, which a browser cannot reproduce). *One landmine the first cut of that fix stepped on, recorded so neither engine re-opens it:* excluding group-losing carry-overs from the matched set also removes them from the set that guards the `relatedIds` walk, so a loser could be pulled straight back in, land in the freshly-activated set, and re-stamp its own sticky window every turn — permanent injection, by a new path. A sticky group-loser must be unreachable to `relatedIds` **and** barred from timer registration; the client does both. Frontend decision vectors for the shared rules live in `worldInfoStore.test.ts`'s `cross-engine decision vectors` block and are mirrored verbatim in `tests/test_retrieval_context.py`; the byte-identical shared fixture both repos check out is `e4s0_lockstep_vectors.json`, sha256-pinned in each suite so neither copy can be edited alone. **Emission order — reconciled 2026-08-25 (`49cb80b9`).** The two engines used to emit sticky matches in different orders (the client kept candidate/book order, `_activation.py` label-sorted), and since `applyTokenBudget` sorts by `order` alone with a stable sort, emission order is what decides which of two equal-`order` carry-overs the trim evicts — the same chat state put opposite lore in the prompt, measured rather than hypothesised. Both engines now emit in the same `(order, label, content)` order they admit in, and the rule is **in** the shared vector table rather than excluded from it: V8 and V10 pin the emission order, V13 the case fold, V14 the label's code-point ordering, and V10/V12 the `content` key. **Accepted unpinned residual:** Python's `str.lower()` and JavaScript's `String.toLowerCase()` disagree on a handful of exotic characters — U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE) is the usual example — so two labels differing only there could still fold apart. Recorded in the fixture's `_readme` and deliberately left unpinned; out of scope for E4-S0.

**F4 — token-budget blind spots.** See §4.4: Stage C uncounted, image attachments uncounted anywhere, `overBudget` false under `tokenAware: false` with a stale doc comment, empty-system edge case. The WI budget's raw-vs-emitted undercount (§4.1) belongs here too.

**F5 — group feature-parity debt.** *Corrected:* group **does** have the WI budget; what it lacks is the history trim (§4.3). Also absent in group: extension context hooks (so no summary — long group chats have no memory beyond the 30-message window plus recall), persona injection, selfie teaching string, character's note, `main_prompt`/`jailbreak`/`char_phi`/`user_phi`, pure-chat mode, and any `promptOrder` control; emotions are hard-coded. Group-only addition (intentional): owner-attribution wrappers on member-owned lore.

**F6 — `reason: "no_key"` never surfaced.** The backend distinguishes "no embedding key configured" from "no matches", but the client discards the field (`chatStore.ts:925` region), so a user with recall enabled and no key sees silence. E9-S7 fixed this by surfacing `no_key` as a once-per-session toast plus a console.warn on each `no_key` response.

**F7 — stale docs and comments (14 items).** User-visible: `generationStore.ts:181,202` still label the recall slot "Data Bank / RAG Context" and describe it as Data Bank chunks. Worst offender: `docs/lorebook-migration-pickup.md` describes the shipped system as unbuilt. Also `docs/memory-consolidation-plan.md:101` (self-contradiction), `workers/embeddings.py:39-42` ("ships genuinely dark" — false since `8bcfac8`), `_messages.py` parity comments pointing at deleted client constants, `chunker.ts` header. Separately: group identity is `characterAvatars[0]`, which member reorder can change, orphaning a whole `message_embeddings` set without a cascade.

---

## 8 · Section taxonomy for E2-S2 — **approved 2026-08-24**

> Approved by the owner as the spec E2-S2 builds against, with the open fork resolved: **E2-S2 measures at assembly time** for the per-section breakdown, and **E2-S3's show-prompt displays the post-transform payload** (after instruct-mode collapse and generate-interceptors), with a notice when a transform changed the structure. Note that text-completion mode is already live and already routes through the instruct collapse, so that display has real users from day one.

Mirror the emission structure, then group for display.

**Measure at assembly, per emitted piece:** each Stage-A section (relabeling `rag_context` → **"Chat recall"** and the WI sections → **"World Info / Lorebooks (incl. Data Bank docs)"** — fixing the stale labels is part of E2-S2), Stage B split into raw history vs. each at-depth insertion class (author's note · character's note · persona · WI@depth · summary), Stage C per section **badged "not counted by the trim"**, plus the user message, the call-site instruction turns (continue / impersonate), and **image attachments** as their own bucket with an explicit "not counted" marker.

**Display grouping (pie):** Character · Persona · World Info/Lorebooks · Chat recall · Summary + Notes · Instructions · Chat history · Your message · Attachments · Reserved.

**Drill-down:** per-WI-entry via the fired telemetry; per-chunk for recall; per-book rollup. On server-path turns, activation reasons come from the server engine (§3b) — a semantic-only firing has no keyword to show, so the UI needs a "matched semantically" state.

**Group chats:** reduced taxonomy — flat system · WI · recall · history · **author's note** (it is a separate context entry with a user-selectable role, `:2049-2056`). Omit the "Reserved" slice in group: `responseReserve` genuinely does not bind there. Badge the history slice "not trimmed", not the whole view "un-budgeted" — the WI slice *is* budgeted.

**Implementation notes:** instrument at the `sectionContent` / `historyWithInsertions` seams; decide pre- vs post-transform measurement explicitly (§2); seed golden-prompt tests from the saved E2-S1 harness; decide the builder test seam (permanent export vs test-only accessor) — the harness needed a worktree-local `export`; and thread the real kept-history boundary out to the recall call while at that seam (§5 — **done**, task 1b: `ragBoundary` is deleted, not patched).

---

## 9 · Refuted during verification — do not re-litigate

Five candidate findings were checked and rejected: that the default Data Bank flow is itself the switch forcing the local-scan fallback; that the Stage-B overflow ordering is inverted relative to the documented interleave (the doc is correct); that the taxonomy needs a distinct bucket for extension-injected sections beyond the existing ones; that §6's precedence answer misstates `promptOrder` as fixed; and one duplicate framing of the post-assembly-transform omission (accepted in §2 on the strength of the other two lenses, with materiality noted as contested).
