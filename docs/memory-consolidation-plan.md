# Memory Consolidation & Message Embeddings Plan

**Status:** Draft v2 (adversarially reviewed against code, 2026-08-21). **Phase 0 done** (ggbc-backend@1d3af97, 2026-08-21). **Phase 1 done** (ggbc-backend@795f185, 2026-08-21) — migration + worker branch only, deliberately dark. **Phase 2 done** (ggbc-backend@8bcfac8 + goodgirlsbotclub@37da7edc, 2026-08-22) — enqueue hook, retrieval endpoint, and client cutover shipped together; server-side embedding is live end-to-end in production (deployed + verified 2026-08-22 — see rollout note below). **Phase 3 done except one explicitly-scoped-out step** (ggbc-backend@6010155+663c698 + goodgirlsbotclub@dee9dd17+81202da8+23b64977, 2026-08-22): 3.1, 3.2 (backend + frontend toast), 3.3's `stm_data_bank` exclusion + `getSettingsBlob` memoization + the legacy id-map's persist (a) and prefer (b) steps, 3.4, and 3.5 all shipped. **3.3's step (c) — stripping `stm_worldinfo.books` from hydration — is the one item left, and deliberately still not done:** the persisted map only covers books/entries imported after step (a) shipped, so the existing user base still needs the heuristic fallback (and the legacy blob it reads from) until a backfill or long enough runway makes step (c) safe. See that section for the full reasoning.
**Supersedes:** `pgvector-migration-plan.md` Phase 4 ("Actual vector storage") and `docs/v2/ROADMAP.md`'s `message_embeddings` item. When work starts, mark both with a pointer here. Carry the pgvector plan's sizing numbers, **not** the ROADMAP's — the ROADMAP's "<200 bytes stored in pgvector" claim is wrong (a `vector(1536)` row is ~6 KB: 4 bytes × 1536 dims), and its ivfflat prescription conflicts with the standing measure-first rule.
**Prereq reading:** `lorebook-migration-pickup.md` (validation item 2), the 2026-08-20 token-bloat audit (artifact "The 12K-Token Exchange").

## What this plan covers

1. **Phase 0** — three groundwork fixes for pre-existing defects the new work must not inherit.
2. **Phases 1–2** — server-side chat-history message embeddings: a `message_embeddings` pgvector table, worker extension, retrieval endpoint, and client cutover of `chatHistoryRagStore`. This is the twice-planned, never-built work item; it also fixes the RAG↔raw-history double-pay bug.
3. **Phase 3** — finishing the memory consolidation: revisions payload strip, the pinned-budget guard, dead-weight hydration cleanup, auto-memory bounds + semantic-floor scoping, character-embedding shutdown.

### Locked cost decisions

| # | Decision |
|---|----------|
| 1 | Embeddings stay on the **user-supplied OpenAI key** — resolved server-side via the existing `resolve_credential` chain: `api_key_openai_embeddings` → `api_key_openai`, user secret first, then the owner's sharing-enabled global secret (`secrets.py:266-293`). Note this chain means "user key" can silently be the shared pool key; `hasEmbeddingsKey()` on the client mirrors the same chain, so UI and server agree. |
| 2 | **Lazy backfill**, mirroring `ensureEmbedded`: embedding happens as a side effect of chat saves plus a catch-up for users with RAG enabled (state-checked, not transition-only — see Phase 2). A toast tells the user indexing is running and roughly what it costs on their key. |
| 3 | **Retention is explicitly punted.** Production today: 2,875 total messages across all users, 5.3 MB of message text, 220 MB database. Full embedding coverage ≈ 17 MB of vectors; 10× growth ≈ 170 MB. Chat-scoped exact scans at this size don't even need an ANN index. **Revisit trigger (write it in the ops notes):** revisit retention/pruning + `halfvec(1536)` + index benchmarking when `message_embeddings` exceeds ~50K rows, the DB exceeds ~1 GB, or the instance passes ~25 users — whichever comes first. |
| 4 | **Edit/hide consistency is enforced server-side at query time** — the retrieval query trusts only the live `chats.messages` row (see Phase 2). |

---

## Phase 0 — Groundwork (small, independent, ship first)

**Done — ggbc-backend@1d3af97 (2026-08-21).** All three items below shipped in one commit; full backend suite (717 tests) green, ruff clean.

### 0.1 Fix the no-key recovery bug in the existing pipeline — done

Today a job whose owner has no OpenAI key goes straight to `failed` (no retry — `workers/embeddings.py:242-263`), but `content_hash` was already written eagerly at enqueue time (`embeddings.py:183`). The only re-enqueue paths are hash-gated (`sync_content_hash_and_maybe_enqueue` no-ops on match), so **when the user later adds a key, neither a re-save of identical content nor `POST /admin/embeddings/backfill` ever re-queues the row** — the backfill docstring claims to cover exactly this case and doesn't.

Fix: staleness for backfill (and any future recovery path) must be **`embedding IS NULL OR content_hash mismatch`**, not hash mismatch alone. Concretely: give `sync_content_hash_and_maybe_enqueue` a `force_if_unembedded: bool = False` parameter that enqueues when the row has no embedding even if the hash matches, and pass it from `admin_embeddings.py`'s walk. The `message_embeddings` design below never copies the eager-hash pattern in the first place (its row only exists once an embedding does).

### 0.2 Centralize the embeddings constants — done

The secret-key names, model name (`text-embedding-3-small`), and dimension (1536) are independently declared in **four** places today: `generation.py:359-361`, `workers/embeddings.py:64-66`, `retrieval.py:82-84` (`_CONTEXT_*`), and `lorebooks.py:99-101` (`_SEARCH_*`) — the worker's copy even carries a comment acknowledging the drift risk. This plan adds a fifth consumer. Sweep **all four** existing sites into one module (suggest `app/embeddings_config.py`) before Phase 1 lands; the new code imports from there.

### 0.3 Server-side hidden-message filtering in `/retrieval/context` — done

The client scrupulously filters `!m.hidden` before every model-facing read (`chatStore.ts:949-954`), but the backend's `_non_system_message_texts` and `_turn_no` (`retrieval.py:123-153`) ignore `extra.hidden` entirely — a #414-hidden message still feeds the keyword/semantic recall window today, and hidden AI messages still advance `turn_no`. Fix both to skip messages where `m.get("extra", {}).get("hidden") is True`. This is the baseline for decision 4; the Phase 2 endpoint reuses the same helper.

> `turn_no` caveat (direction matters — get the PR description right): skipping hidden AI messages **lowers** `turn_no`, while stored `last_activated_turn` values are GREATEST-guarded and never come down. So for chats containing hidden AI messages this is a one-time **lengthening** of in-flight sticky and cooldown windows (`turn_no <= last + sticky` / `<= last + cooldown` stay true for up to H extra turns, H = hidden-AI count), and delay-gated entries (`turn_no < delay`) can **re-lock** until new AI turns accumulate (`_activation.py:186, 191, 511`). Bounded and acceptable at current scale, but state the real direction in the PR.

---

## Phase 1 — `message_embeddings` table + worker (genuinely dark) — done

**Done — ggbc-backend@795f185 (2026-08-21).** Migration 0026 + the worker's `'chat'` branch (`app/routers/_messages.py`, `_process_chat_job`, `_embed_page` poison-pill bisection, `_claim_batch` transient-retry backoff) shipped in one commit; 9 new tests, full backend suite (726 tests) green, ruff clean, migration verified upgrade+downgrade+upgrade against the real test Postgres. `/retrieval/context`'s Phase 0.3 hidden-message filtering was refactored to import the new shared helper instead of duplicating it, per this section's original note. Not yet deployed to production — no enqueue hook exists yet (see below), so there's nothing live to migrate around, but the standing "fresh backup before deploying this migration" rule still applies whenever this ships.

Phase 1 deploys the migration and the worker branch **only**. The `save_chat` enqueue hook ships with Phase 2 — this is deliberate: `stm_rag_settings.enabled = true` rows already exist in production (the live client-side RAG feature syncs the flag), so a Phase-1 hook would immediately start embedding those users' chats on their keys, silently, with no toast, while the client-side `ensureEmbedded` still runs every session — double spend on the same key. With the hook held back, nothing enqueues `'chat'` jobs and the deploy is truly dark.

### Migration (next free number — 0026 at time of writing; re-check the head, `0025_add_lora_trainings` today)

```
message_embeddings
  chat_id          uuid    NOT NULL REFERENCES chats(id) ON DELETE CASCADE
  ggbc_id          text    NOT NULL      -- extra.ggbc_id; unique per chat only, ≤128 UTF-16 units
  is_user          boolean NOT NULL
  content_hash     varchar NOT NULL      -- sha256 of the text that was actually embedded
  embedding        vector(1536) NOT NULL
  embedding_model  varchar NOT NULL
  embedded_at      timestamp NOT NULL DEFAULT now()
  PRIMARY KEY (chat_id, ggbc_id)
```

Design points, each load-bearing:

- **Key by `chats.id` + `extra.ggbc_id`, never by file name or index.** `_ensure_message_ids` (`chats.py:95-126`) guarantees every non-header message carries a unique-per-chat `extra.ggbc_id` after any save, by any writer (including the unload beacon). `chats.id` survives renames (`/chats/rename` mutates `file_name` in place); `ON DELETE CASCADE` gives deletion cleanup for free (the `lorebook_entry_timed_state` precedent, migration 0019). The old client scheme (`${chatFile}#${index}`) is positional and rename-orphaned — do not port it.
- **No stored text.** The live `chats.messages` row stays the only source of message text; the retrieval query returns live text. Edited/deleted/hidden content can therefore never leak from a stale embedding row — at worst a stale row fails its hash check and is skipped.
- **Row exists only once embedded** (`embedding NOT NULL`). Unlike the lorebook cache-columns pattern, there is no "hash written before embedding exists" state — this is what makes the 0.1 bug structurally impossible here. Staleness = *no row for a live (chat, ggbc_id), or `content_hash` ≠ hash of live text*.
- **`content_hash` is the hash of the text the worker actually embedded** (worker re-reads at process time, mirroring `_process_job`'s current behavior), not the text at enqueue time.
- **No ANN index, no FTS index.** Same documented measure-first decision as migration 0019 (1 vCPU / 1 GB droplet; per-chat filtered exact scans; HNSW build doesn't fit `maintenance_work_mem`). Only the PK and the implicit chat_id prefix. Revisit at the decision-3 trigger.
- Widen the `embedding_jobs_target_type_check` CHECK constraint (`drop_constraint` + `create_check_constraint`) to add **`'chat'`** — jobs are **per-chat**, `target_id = chats.id`, which fits the polymorphic UUID column (message ggbc_ids are strings, not UUIDs, and would not). The existing partial unique index `(target_type, target_id) WHERE status IN ('pending','processing')` coalesces duplicate enqueues for free. Update the ORM `__table_args__` in `models/embedding_job.py` in lockstep.
- Take a **fresh DB backup immediately before deploying this migration** — pgvector plan's own "rollback stops being cheap here" rule applies from this point.

### Canonical message text + eligibility (one shared helper)

Add one backend helper (suggest `app/routers/_messages.py`) used by the worker, the retrieval endpoint, and Phase 0.3:

- **Active text** = `swipes[swipe_id]` when `swipes` + `swipe_id` are present and valid, else `mes` — byte-matching the frontend's `normalizeMessage` resolution. (`mes` and `swipes[swipe_id]` can legitimately disagree for foreign/legacy writers; the frontend trusts swipes, so we do too.)
- **Embeddable** = non-header (index > 0), dict, not `is_system`, not `extra.hidden`, active text ≥ 40 chars (`MIN_CHARS` port — sub-40-char messages have too little signal and are cheap to keep raw).
- **Hash** = sha256 of active text (reuse `compute_content_hash`) — computed on the **truncated** text (next section) so staleness stays consistent.

### Worker: the `'chat'` branch

The primary dispatch point is **`_process_job`** — branch on `target_type == 'chat'` *before* the existing single-text flow and route to a new diff/batch/upsert routine. Do not try to express this through `embedding_text_for_target` (it returns one string for one target and cannot represent a multi-text diff), and never let a Chat row reach the single-text tail: that tail assigns `target.embedding`/`content_hash`/`embedded_at`, attributes `Chat` doesn't have — SQLAlchemy would silently set transient Python attributes, persist nothing, and mark the job done. Extend `_load_target` and `_owner_user_id` (owner = `chat.user_id` directly) as the supporting arms.

Processing a `'chat'` job:

1. Load the chat row; walk messages with the shared helper; compute `(ggbc_id, hash)` for every embeddable message. **Truncate each text to the embedding model's per-input token cap before hashing/embedding** (30K chars is the existing client-side cap; keep it).
2. Diff against `message_embeddings` rows for this chat: **missing or hash-stale → embed; orphaned rows (ggbc_id no longer live, or message no longer embeddable) → delete.** Orphan cleanup rides along in the same pass — covers truncating edits, branch-restore re-minting, and messages later hidden.
3. **Batch the OpenAI calls**: `call_openai_embeddings` already accepts `list[str]` (the proxy passes batches through today) — embed in pages of ~100 texts per call. Do not port the worker's current one-text-per-call loop (~1.6 embeddings/sec ceiling). **Poison-pill guard:** a single over-limit input 400s the whole batch, and `OpenAIEmbeddingError` would burn all 5 attempts and permanently fail the job while every subsequent save re-enqueues it — so on a batch 400, split the page (binary or per-text) and continue, letting one bad message fail alone rather than blocking the chat.
4. Upsert rows with the hash of the embedded text; one commit per job (existing pattern).
5. No key resolves → `failed` with the existing message. This is *expected* for RAG-disabled users and surfaced to enabled users by the Phase 2 toast flow; no retry burn.
6. Transient-failure backoff (new, cheap): the claim query additionally requires `attempts = 0 OR updated_at < now() - interval '30 seconds'`. Without it, a persistent OpenAI 429 burns all 5 attempts in ~25 seconds. (`updated_at` is ORM-maintained only — fine, the worker always updates via ORM.)

---

## Phase 2 — Retrieval endpoint + client cutover + enqueue hook (one release) — done

**Done — ggbc-backend@8bcfac8 + goodgirlsbotclub@37da7edc (2026-08-22).** Backend: the `save_chat` enqueue hook, `POST /retrieval/messages` (+ `/ensure`, `+ GET /status`), 12 new tests, full backend suite (738 tests) green. Frontend: `computeRagBoundary` (`src/utils/ragBoundary.ts`), `resolveRagContext` rewritten to a never-throws `/retrieval/messages` call, `chatHistoryRagStore.ts`'s client-side embedding machinery removed, the Data Bank counter now reads live server status (plus a `failed`-jobs warning the old path left silent), 18 new/changed tests, full frontend suite (1417 tests) green, tsc/eslint clean. Not yet deployed to production — see the rollout note at the bottom of this doc.

### Enqueue hook — server-side in `save_chat`, gated on RAG opt-in — done

`POST /chats/save` is the **single** write path for `chats.messages` (whole-array replace; the unload beacon and 409-retry paths all land here), so the hook lives there and needs no client cooperation: after a successful save, if the user has RAG enabled, `enqueue_embedding_job('chat', chat.id)` — the partial unique index makes repeat enqueues free, and the worker's diff decides what (if anything) to embed.

**Gate on `stm_rag_settings.enabled`** (one `UserDocument` SELECT; absent row = disabled, matching the client default of `false`). RAG is opt-in and embedding spends the *user's* key — never embed for users who didn't opt in. A client-side enqueue call is explicitly rejected: it would miss the unload-beacon save and could enqueue for a save the server 409-rejects. Shipping the hook in the same release as the client cutover closes the double-embedding window: the client-side `ensureEmbedded` path is deleted by the same deploy that turns server-side embedding on.

### `POST /retrieval/messages` — done

Request: `{ characterAvatar, fileName, query, k?: number = 3, boundaryId?: string }`
Response: `{ chunks: [{ ggbcId, text, isUser, score }] }` — **text is read live from the chat row**, never from storage.

Server behavior, in order:

1. Resolve the chat exactly like `/retrieval/context` (`_resolve_chat`, `_strip_ext` normalization — clients send file names with and without `.jsonl`). Works identically for solo and group chats since both live in `chats`.
2. Check `stm_rag_settings.enabled` server-side; disabled/absent → `{chunks: []}` (not an error).
3. Resolve the key (`resolve_credential` chain). No key → `{chunks: [], reason: "no_key"}` — additive field, safe to deploy backend-first (frontend has no runtime validator; unknown fields pass through).
4. Embed `query` with one proxy-style call.
5. Eligibility + staleness are computed **in Python from the already-loaded chat row** (the row is in hand from step 1): walk messages with the shared helper, compute live `(ggbc_id, hash)` pairs for embeddable messages outside the boundary window. Don't attempt the hash check in SQL — `content_hash` is Python `hashlib.sha256` and pgcrypto isn't enabled (migration 0017 enables pgvector only), and swipe-resolution of active text in SQL is not worth building.
6. **Exclude the raw-history window via `boundaryId`**: the client sends the `ggbc_id` of the *oldest message in its kept raw tail*; the server excludes that message and everything newer. A count was rejected deliberately: on swipe/continue paths the client's window excludes the in-flight message while the persisted row still contains it, so any "newest N" count is off by one — a boundary *id* is exact on every path, including the two paths the lore cutover had to skip. `boundaryId` missing or not found in the row → conservative fallback: exclude the newest 4 embeddable messages (TAIL_SKIP parity) and log.
7. Query: join the eligible `(ggbc_id, hash)` pairs into the SQL (VALUES list / array params) against `message_embeddings` for this chat — a row participates only when its `ggbc_id` is in the eligible set **and** its stored `content_hash` equals the live hash — then `ORDER BY embedding <=> :q LIMIT :k` **in SQL** (push the limit down; don't copy the lorebook recall's fetch-all-then-rank shape to a bigger table). Stale/missing rows found during step 5 → opportunistically enqueue a `'chat'` refresh job — **with an explicit `await db.commit()`** (or a background task): `enqueue_embedding_job` deliberately doesn't commit and `get_db` never commits, so inside this otherwise-pure-read endpoint the INSERT would silently roll back.
8. **Similarity floor is a deliberate new constant, not a copied `0.3`.** The client store floors at cosine *similarity* > 0.3 (loose); the lorebook leg floors at cosine *distance* ≤ 0.3 = similarity ≥ 0.7 (strict). These collide in name and mean opposite things. Start at **similarity ≥ 0.5**, named constant, comment explaining both neighbors. Expect recall to feel different from the old client store either way; tune from there.
9. Semantic-only for now — no FTS leg (query is one user message; FTS over live JSONB prose costs a per-query tsvector scan for marginal gain). Noted as a future option.

### Client cutover — boundary computation is the hard part; get the frame right — done

**The naive frame is a feature-killing bug** (caught in review): computing the boundary from the pre-trim "visible→non-system→compaction" frame returns the chat's *oldest* message in the app's **default configuration** (`tokenAware: true`, `autoSummarize: false` — where compaction never applies and the pre-trim pool is the whole history), which excludes everything and makes `/retrieval/messages` return zero chunks, permanently, for exactly the long-chat users the feature serves. The only thing bounding raw history in that config is `trimHistoryToBudget`, which runs *later*, inside `buildConversationContext`.

So: extract an **exported, testable helper** `computeRagBoundary(messages, ctxConfig, summaryState, isGroup)` that reproduces the *post-trim kept set*:

- **Solo:** visible (`!hidden`) → non-system → compaction slice (when a summary exists and `compactWhenSummarized`) → **`trimHistoryToBudget` with the real token budget and `systemCost = 0`** → boundary = oldest survivor's `ggbc_id`. Zero system-cost makes the simulated trim keep *more* history than the real one, so the boundary errs older — a bounded over-exclusion (roughly the system block's ~2-3K tokens' worth of messages), in the safe direction; retrieval still reaches everything genuinely outside the prompt. In short chats where everything fits, the boundary is the oldest message and zero chunks come back — *correct*: nothing has left the prompt, so there is nothing to recall.
- **Group:** the group builder uses a different frame — `messages.filter(!hidden).slice(-30).filter(!isSystem)`, no token-aware trim, no compaction (`chatStore.ts:2001`) — so the helper must branch: boundary = oldest non-system message inside the last-30-visible window.
- A cleaner long-term shape is to thread the actual kept-history boundary out of `buildConversationContext` itself; the helper is the pragmatic v1 since `resolveRagContext` runs before the builder at every call site.

**Implementation notes (found during the build, not caught in review):** `trimHistoryToBudget` has no `systemCost` parameter — "`systemCost = 0`" above means calling it with an empty `systemPrompts` array (systemCost is derived by summing that array), not passing a numeric arg. Known accepted gap: `buildConversationContext`'s solo branch also has a `pureChatMode` path that shifts the summary-compaction offset by `pureChatRemoved` (leading non-user messages dropped before the first user turn); `computeRagBoundary` doesn't replicate it — the direction analysis says this skews further into the "over-exclusion, safe" side, not the unsafe one, so it's punted rather than fixed. Revisit only if `pureChatMode` chats show materially worse recall than plain ones.

`resolveRagContext` (`chatStore.ts:860-896`) becomes: compute `boundaryId` via the helper, then one `POST /retrieval/messages` in a **never-throws wrapper** (mirror `tryServerRetrieval`: resolve `[]` on any failure, single 6s abort budget). Formatting (`[Earlier in chat — User/Character]`) stays client-side. All six call sites — send, swipe, continue, impersonate, edit-regenerate, **and the group path** — go through it unchanged.

**Group identity:** `resolveRagContext` receives only `(messages, chatFile)` and at the group call site the in-scope `character` is the current *speaker* — but the save/load identity is `groupCharacters[0].avatar` (`chatStore.ts:2378-2380, 3426`). The wrapper must resolve `characterAvatar` itself: `getGroupChatByFile(chatFile)?.characterAvatars[0] ?? selectedCharacter.avatar`. Threading the speaker's avatar 404s for every non-first speaker and the never-throws wrapper would silently turn that into empty recall — add a test asserting the group request carries `characterAvatars[0]`.

### Enable-time backfill + notification — state-checked, not transition-only — done

Users whose `enabled` flag is *already true* at cutover never call `setEnabled` again (`fetchPrefs` just applies the synced value), so hooking backfill only to `setEnabled(true)` would leave the most invested users with empty recall for old chats. Trigger from a **state check**: on session start (or first `resolveRagContext` call) when `enabled` is true, fire a session-guarded `POST /retrieval/messages/ensure` (enqueues `'chat'` jobs for the user's chats) plus the `showToastGlobal` info toast — same module-level-Set guard pattern as the WI budget toast: *"Indexing your past messages for recall — N messages, roughly $0.02 on your OpenAI key. Recall improves as indexing completes."* (2,875 messages ≈ 860K tokens ≈ $0.017 at text-embedding-3-small pricing — the entire instance costs pennies; the toast is about transparency, not sticker shock.) No-key users get the existing amber inline copy on the Data Bank page; additionally surface worker `failed/no-key` state there rather than leaving it deliberately silent.

**Implementation note:** `/retrieval/messages/ensure` returns a chat count (`queued`), not a message count — walking every message across every queued chat just to size the toast wasn't worth the extra query. The shipped toast copy says "N chats queued" and drops the dollar figure rather than fabricate a per-call cost estimate from a count it doesn't have. `failed` state surfaces on the Data Bank page via a new `failed` field on `GET /retrieval/messages/status` (distinct chats, not job rows — a chat can accumulate multiple failed rows across retries).

### Cleanup — strictly within the cutover release, not before — done

`ensureEmbedded` and `queryTopK` have **live callers today** (`resolveRagContext`, every generation turn), and `embeddingsByChat` backs the Data Bank page counter (`DataBankPage.tsx:436`); only `clearChat` is genuinely caller-less. They become deletable **by the same commit** that rewrites `resolveRagContext` and replaces the counter — not in a preparatory cleanup PR, which would break live RAG. Replace the "N messages embedded" counter with a tiny `GET /retrieval/messages/status` (`{embedded, pending}`) or drop it; keep `enabled` + `fetchPrefs`/`resetUser`; delete `getEmbedding`/`cosineSimilarity` from `utils/embeddings.ts` after re-verifying `chatHistoryRagStore` was the last caller.

---

## Phase 3 — Consolidation completion

Ordered by value-per-effort; each item is independently shippable.

### 3.1 Strip `revisions` from `/retrieval/context` responses — done

**Done — ggbc-backend@6010155 (2026-08-22).**

Every activated entry ships its full uncapped revision history (each with a `prevContent` snapshot) on every generation turn — an entry edited 10 times ships ~11× its content per call. Strip **in `retrieval.py` only**: `response_model_exclude={'entries': {'__all__': {'revisions'}}}` on the route (or set `revisions=[]` per entry). **Do not touch the shared `_entry_to_out`** — it also serves the `/lorebooks` CRUD reads whose responses the editor round-trips on full-replace PUTs; stripping there would silently erase stored revision history on the next edit. Safe client-side: `serverRetrieval.ts:412` guards with `Array.isArray(...) ?? []` and downstream consumers read only `bookId`/`entry.id`.

### 3.2 Pinned-budget guard (pickup item 2, finally) — done

**Done — ggbc-backend@6010155 + goodgirlsbotclub@81202da8 (2026-08-22).** `PinnedBudgetWarning` ships on `create_entry`/`update_entry` responses; the frontend shows a session-guarded warning toast, scoped to exactly the two INTERACTIVE single-entry write paths (`createEntry`/`updateEntry` in `worldInfoStore.ts`) — not the two bulk blob-import loops or the delete-triggered sibling `relatedIds` patch, all of which share the same `applyServerEntryMeta` helper but would make this a noisy/wrong toast (firing repeatedly during import, or on an edit the user didn't consciously make).

Proactive check in `create_entry` and `update_entry` (`lorebooks.py`): when the write would make the book's non-evictable set (`critical` column ∪ `extra.constant`) exceed the token budget, respond with an additive `pinnedBudgetWarning: {pinnedTokens, budgetTokens}` field; the frontend shows a warning dialog/toast. Warn-first, not reject — rejection needs override UX, and additive response fields deploy backend-first safely. Budget source: read `stm_worldinfo.data.tokenBudget` from `user_documents` (default 1024 when absent) — the server has no native home for it and this avoids trusting a client-supplied number. Cost via the existing `estimate_tokens` (chars/3.8) helper. A later strict mode (422 + `force` flag) is optional.

### 3.3 Stop hydrating dead weight on app start — steps (a)/(b) done, (c) deliberately not

- **`stm_data_bank`: exclude from `GET /sync/sections` unconditionally. — done, ggbc-backend@6010155.** No frontend store reads it (dataBankStore uses `stm_data_bank_index`); the only reader is the backend's own `import-from-databank`, which reads the table directly, not via sync. Today it ships full pre-migration document text *plus obsolete client-computed embedding vectors* to every client on every hydration.
- **`stm_worldinfo`: the legacy `books` field is NOT safely strippable yet** (caught in review). `worldInfoStore.fetchPrefs` reads `stored.books` as the input to `buildLegacyIdRemap` — the code calls it the *"cross-device source of truth for a fresh browser whose localStorage cache is empty"* (`worldInfoStore.ts:3378-3380, 3448-3452`) — and when the remap comes up empty with native fetches succeeding, unresolved legacy `wibook_`/`wi_` ids persisted in *other* synced sections (chat-linked books, persona/character links, chat-lore `excludedEntryIds`) are **confidently dropped**, destroying real user state on exactly the migrated cohort. Sequence: **(a) done — ggbc-backend@663c698.** `import_lorebooks_from_blob` now records every legacy id it replaces with a freshly-minted UUID into a new `stm_wi_legacy_id_map` section (`{books: {oldId: newId}, entries: {oldId: newId}}`), merged (not overwritten) across repeated idempotent calls, only for pairs whose savepoint actually succeeded. A compact new section, not `Lorebook.extra` — that column doesn't exist on the book-level model (only `LorebookEntry` has one), so the `extra` route would have needed its own migration. **(b) done — goodgirlsbotclub@23b64977.** `buildLegacyIdRemap` now applies the server map's exact pairs AFTER its own content-signature heuristic (`Map.set` overwrites), so a server-confirmed pair always wins over a guess. Downstream consumers (`chatLoreConfigStore`/`characterStore`/`personaStore`) needed no changes — they read through `remapLegacyBookId`/`remapLegacyEntryId`/`resolveLegacyBookId`/`resolveLegacyEntryId`, whose signatures didn't move. **(c) — strip `books` from hydration, gated on the map existing — still explicitly NOT done, and shouldn't be attempted yet:** the persisted map only covers books/entries imported *after* (a) shipped. The existing user base — everyone who already migrated before this — has no server-recorded trail and still depends entirely on the heuristic fallback, which in turn depends on `stored.books` still being present in hydration. Stripping `books` now would break legacy-id resolution for exactly the users this whole sub-item exists to protect. Revisit only after either a dedicated backfill (re-deriving pairs for already-migrated books via the same scope-key matching `import_lorebooks_from_blob` already does, applied retroactively) or enough runway that the affected cohort is negligible — whichever comes first; this needs its own scoping pass, not a quick follow-up. The section itself always stays regardless — it is the live home of `activeBookIds`/`tokenBudget`/`scanDepth`/etc.
- **Memoize `getSettingsBlob`** for the login burst — **done, goodgirlsbotclub@dee9dd17.** ~20 stores each independently issue a full `GET /sync/sections` today (worse: the function already made two such calls per invocation on its own). A short-lived shared promise turns a burst into one request; not a persistent cache — the next call after one settles fetches fresh.

### 3.4 Auto-memory bounds + semantic-floor scoping — done

**Done — ggbc-backend@6010155 (2026-08-22).**

- **Per-book cap for `auto_extracted` books**, enforced server-side in `create_entry` next to the existing `insertion_order` query (suggest 200; additive error → client routes the overflow fact to the conflict queue instead of writing). Today the book grows without bound and every entry joins the per-turn activation candidate set.
- **Scope the semantic floor**: in `_activation.py:448-453`, allow `sql_hit`-only (no keyword) activation only when `entry.semantic_only or not entry.keys`. Verified consequences: Data Bank chunks are unaffected (both `keys=[]` and `semantic_only=True` are set by both import paths); hand-made keyless entries stay alive via the `or not keys` clause; keyword-keyed entries — including auto-memory's — lose semantic/FTS no-trigger activation and keep their designed keyword path. This restores the "trigger only" promise users are given and stops auto-memory entries (semantically near the chat by construction) from firing every turn. Note in the PR: FTS-only recall for keyword-keyed entries goes away too, including for users with no embeddings key.

### 3.5 Stop paying for character embeddings — done

**Done — ggbc-backend@6010155 (2026-08-22).**

Nothing consumes `Character.embedding` (sole `.embedding` reader in the app is the lorebook leg). Remove the two enqueue call sites (`characters.py:292, 335`), the `_enqueue_embedding_if_changed` helper and its imports, and **gate the character walk in `POST /admin/embeddings/backfill`** (ungated, the next admin run would resurrect the jobs). Keep the columns and the worker branch for cheap re-enable; note that character `content_hash` values freeze, so a future re-enable will re-enqueue everything via the hash-mismatch predicate — desirable.

### 3.6 Explicitly punted (with triggers)

- Retention/pruning, `halfvec(1536)`, ANN indexing — decision 3 trigger above.
- Server-side auto-memory extraction and any cross-mechanism semantic dedup (auto-memory ↔ summarize ↔ RAG restating one fact) — the client-side conflict nets (norm80 / `conflicts_with` / `findNearDuplicates`) have no server counterpart; revisit only if a server-side consolidation pass is ever built.
- FTS leg for message retrieval.
- **Group-chat identity churn** (known hazard, noted not fixed): group chats key on `(user, characterAvatars[0], fileName)` and slot 0 is mutable via member reorder/removal — a reorder makes the next save create a *new* `chats` row, orphaning the old row and its embedding set (cascade never fires; the new row re-embeds on the user's key). Count orphaned rows against the decision-3 triggers; the real fix is a stable group identity (synthetic avatar key), out of scope here.

---

## Rollout & testing

**Status as of 2026-08-22: deployed to production and verified.** ggbc-backend `663c698` + goodgirlsbotclub `1512e6d0` went live on the droplet 2026-08-22. Pre-deploy, a fresh `pg_dump` was taken (`docker compose exec -T postgres pg_dump -U ggbc ggbc | gzip`), copied off-box, and checksum-verified on both ends before migration 0026 ran, per decision 3 and the migration's own docstring. Migration `0025_add_lora_trainings -> 0026_add_message_embeddings` applied cleanly on startup (`alembic upgrade head`, no errors); `message_embeddings` confirmed present with the expected columns/PK/FK. All three containers (`frontend`/`ggbc-backend`/`postgres`) recreated together per the deploy skill's no-partial-restart rule; `/health` returned 200 on the first poll post-deploy. See the verification checklist below for the post-deploy functional check.

**Order:** Phase 0 → migration + worker branch (genuinely dark — the enqueue hook is *not* in this release) → Phase 2 as one release: `save_chat` hook + `/retrieval/messages` + client cutover (the same deploy that starts server-side embedding deletes client-side embedding, so no double-spend window) → Phase 3 items individually, any order. Every API change is additive; backend-first deploys are safe (the frontend has no runtime response validator — new fields pass through; new endpoints are unused until the client ships).

**Backend tests** (pytest, in the Docker container — no local Python 3.12; watch the stale-migration volume trap): worker diff correctness (add/edit/swipe/hide/orphan/branch-restore re-mint), batch-split on a poisoned input, no-key job outcome, boundary exclusion incl. the not-found fallback, hidden filtering in both endpoints, hash-stale skip + opportunistic re-enqueue **with commit** (assert the job row survives the request), enqueue gating on `stm_rag_settings`, 0.1 backfill recovery (embedding-NULL rows re-queue).

**Frontend tests** (vitest): there are **no existing tests** to mirror for the compaction frame ("lockstep" lives only in comments, and `resolveRagContext` is un-exported) — extract `computeRagBoundary` as an exported helper and write its suite fresh: default config (tokenAware, no summary) yields a mid-chat boundary on long chats and full-exclusion on short ones; compaction config; group `slice(-30)` frame; plus the never-throws wrapper fallback and the group-request `characterAvatars[0]` identity assertion.

**Verify on production after deploy** (per the standing rule — a green suite has missed a whole branch before): enable RAG as a test user, watch one chat get indexed (`embedding_jobs` + `message_embeddings` rows), confirm a retrieval hit appears in a prompt for a *long* chat, that a *short* chat correctly returns none, and that a hidden message never surfaces.

**Run 2026-08-22 — results, against real production data (no synthetic test account created; the only RAG-opted-in user at the time was the owner's own account, 13 chats):**

- **Indexing:** confirmed via organic traffic alone, no action needed — the enable-time `/retrieval/messages/ensure` backfill had already fired once for this account. 13 `'chat'` embedding jobs enqueued since deploy: 5 done, 5 pending, 3 processing, **0 failed**. 1839 rows already landed in `message_embeddings`.
- **Long-chat retrieval hit:** exercised the real `POST /retrieval/messages` code path directly (imported and called the actual router functions inside the `ggbc-backend` container, rather than re-deriving the logic in SQL by hand). Picked the largest chat (1476 messages, 1384 embeddable). `_eligible_messages` with no boundary id correctly fell back to TAIL_SKIP and returned 1380 eligible; all 1380 already had fresh (non-stale) embeddings. A real query — 200 characters of an actual older message, embedded live via the account's own OpenAI key — returned **3 ranked chunks** with descending scores (0.83, 0.66, 0.58). Recall works end-to-end.
- **Short-chat empty recall:** a 4-message chat resolved to **0 eligible messages**, matching the endpoint's early-return-empty path (no OpenAI call needed).
- **Hidden messages never surface:** **could not be verified against live data.** Scanned all 22 chats across all 13 production users for any message carrying `extra.hidden === true` — found zero. The hide-message feature (#425, shipped 2026-08-19) hasn't been exercised on any real chat yet, so there was nothing to run the exclusion check against. The gate is confirmed by code reading only (`is_hidden`/`is_embeddable` in `app/routers/_messages.py`, and the same predicate is reused by `_eligible_messages`) — not by a live trial. Revisit if a hidden message ever shows up in real data, or deliberately manufacture one if this needs harder confirmation.
- **Gotcha hit along the way:** running app code inside the `ggbc-backend` container via `docker compose exec` picks up a stale/incomplete `site-packages` copy of `app` that is missing `app.workers` entirely (`ModuleNotFoundError: No module named 'app.workers'`). The real source lives at `/app/app/`, and the container's own CMD runs `uvicorn app.main:app` from cwd `/app` — an ad hoc script needs to be placed under `/app/` itself (not `/tmp/`) so `/app` lands first on `sys.path` and shadows the installed package. All verification scripts were deleted from the container, the droplet, and the local scratchpad after the run.
