# Lorebook remote-data migration — session pickup

Hand-off notes for continuing this work in a fresh session. This covers the
whole arc from "own the lorebook data layer" through the native-CRUD editor
cutover, and scopes (but does not yet start) the next piece: retiring Data
Bank's separate retrieval pipeline in favor of the native lorebook system.

Last updated: 2026-08-07. Everything under "Where things stand" is merged,
deployed, and verified live. Everything under "Next: Data Bank → Lorebook
migration" is scoped and agreed but **not started** — no code written yet.

---

## Where things stand

| Phase | What landed | Commit(s) | Status |
|---|---|---|---|
| 1 | Native `lorebooks`/`lorebook_entries` tables, full CRUD API, import-from-blob migration, `/worldinfo/shared` native-or-blob dual read | ggbc-backend `22f078b`, `e66a02d` (migration `0018`) | merged, deployed |
| 2 | Embedding pipeline (background worker, `embedding_jobs` queue), hybrid retrieval (`/lorebooks/search`, `/retrieval/context` — ported activation engine: keyword/selective matching, group competition, timed effects) | ggbc-backend `e66a02d` (migration `0019`) | merged, deployed |
| Frontend wiring | `sendMessage`/`impersonate`/`editMessageAndRegenerate` call `/retrieval/context` with a conservative eligibility gate + verified client-side fallback. `swipeRight`/`continueMessage` stay client-only **permanently** (message-window mismatch with the server's stateless full-chat-reread contract — not a gap to close later) | goodgirlsbotclub `9ced3e4` | merged, deployed |
| Proxy fix | `nginx.conf` + `vite.config.ts` were missing `/lorebooks` and `/retrieval` location blocks — everything above was silently unreachable in production until this | goodgirlsbotclub `c79a23b` | merged, deployed |
| 3a | Lorebook editor cutover: `worldInfoStore` now reads/writes native CRUD instead of the `stm_worldinfo` blob. Fixed the live bug where `/retrieval/context` served frozen import-day content. Client-minted UUIDs (`crypto.randomUUID()`), idempotent create-on-collision, one-time id-remap for already-migrated books/entries (best-effort content-signature matching for entries — see gotcha below), `auto_extracted` one-way ratchet fix (Auto Memory sharing-guard regression) | ggbc-backend `56bd2e6`, goodgirlsbotclub `77e689d` | merged, deployed |

**Backend migration head, `main` and production: `0019_add_embedding_pipeline`.**
Don't trust this doc for it if time has passed — check the running DB:

```bash
ssh root@159.89.180.146 "cd /opt/goodgirlsbotclub && \
  docker compose exec -T postgres psql -U ggbc -d ggbc -tAc \
  'select version_num from alembic_version;'"
```

Verified live end-to-end against two real production characters (different
lorebook shapes — one auto-extracted memory book, one manually-authored
embedded book) on 2026-08-07: id-remap produced zero warnings, no
duplicate books, entry counts and content matched exactly, Auto Memory kept
working (including organic growth from real chat during testing).

### Gotchas a fresh session should know

- **The id-remap is best-effort, not exact, for entries.** Books match
  reliably by `(owner_character_avatar, name)` (the DB itself enforces
  uniqueness there for world-scoped books). Entries have no natural stable
  key across the migration boundary — `import-from-blob` never recorded an
  old-id→new-id trail — so entries are matched by a `(comment, content,
  sorted keys)` content signature. Ambiguous cases (e.g. two pre-cutover
  books sharing a name) are left unmapped rather than guessed at
  (`worldInfoStore.ts`'s `buildLegacyIdRemap`). This is fine for the two
  characters spot-checked live, but hasn't been exhaustively verified
  across every user's library.
- **Original 4-phase roadmap** (Fable-designed) had Phase 3 as one block
  ("sync hardening + offline cache"). It got reconciled into 3a (this,
  done) / 3b (offline foundation — IndexedDB mirror, mutation queue,
  session bootstrap for offline, focus/reconnect re-sync — genuinely new,
  unproven infrastructure, deliberately not started) / 3c
  (`stm_chat_lore_configs` gets the same focus/reconnect re-sync trigger,
  small). Phase 4 (collaborative lore + scene memory) comes after 3b/3c
  and hasn't been scoped in detail yet. Group chat
  (`buildGroupConversationContext`) was never wired to server-side
  retrieval at all — deliberately out of scope every time it's come up.
- **Do not start 3b/3c/Phase 4/group-chat wiring unless explicitly asked.**
  The Data Bank migration below was the agreed next step, chosen
  specifically because 3a needed time to "bake" in production before more
  complexity landed on top of it.

---

## Next: Data Bank → Lorebook migration (scoped, not started)

**Goal:** retire Data Bank's separate client-side retrieval pipeline while
keeping its actual value — low-friction bulk ingestion of unstructured text.

### Why

Investigated 2026-08-07 (see conversation history if the reasoning needs
re-deriving — not duplicated here). Summary: Data Bank
(`goodgirlsbotclub/src/stores/dataBankStore.ts`) does naive client-side-only
cosine similarity (hardcoded top-3, threshold 0.3) against vectors dumped
raw into a JSONB blob (`stm_data_bank`, via the generic `/sync/section`
endpoint — no pgvector, no server-side search), and re-runs that search in
JS on **every single generation call**. The native Lorebook system's hybrid
retrieval (keyword + semantic + FTS, server-side, budget-aware,
critical-never-evict) is strictly better along every axis that matters. But
Data Bank's actual UX value — paste text or upload a `.txt`/`.md` file,
auto-chunk it, no manual per-entry authoring — isn't covered by the
Lorebook system today (entries are still hand-authored one at a time).

**`chatHistoryRagStore.ts` (recalls past conversation turns, not uploaded
documents) is a genuinely separate feature, confirmed unaffected — do not
touch it as part of this.**

### The mapping

- One uploaded document → one new `Lorebook` (name = document name)
- Each ~500-char chunk (reuse `chunker.ts` as-is, it's proven) → one
  `LorebookEntry`, `comment` set to something like "chunk 3 of Setting Bible"
- Global vs. Character scope toggle → `owner_character_avatar` (already exists)
- Embedding → the existing background worker picks it up automatically once
  entries are created — no new embedding pipeline needed

### The one real open design question — needs a decision, not just implementation

Hand-authored entries get selected by `/retrieval/context` via keyword
matching (or `constant: true`). Auto-chunked document text has no natural
keys. The plan: a new per-entry flag (working name `semantic_only`) that
skips the keyword gate and qualifies purely on semantic similarity crossing
the floor — the SQL recall stage already computes this score for every
candidate, so this is a gating-logic change in `app/routers/_activation.py`,
not new infrastructure.

### Three validation additions, inspired by (not copied from) a Parachute
Health internal skill the user shared (`make-lorebook-entry` —
institutional-knowledge lorebook for AI tool-calls, a different domain, but
these three ideas transfer):

1. **`semantic_only` entries can never be `critical: true`.** A "never
   evict, must always be present when needed" guarantee is incoherent
   paired with a fuzzy similarity match that might not cross the threshold.
   Reject at validation time, both schema-level and DB CHECK constraint if
   feasible (mirrors the existing
   `lorebooks_auto_extracted_private_check` pattern in
   `app/models/lorebook.py`).
2. **Authoring-time non-evictable budget guard.** GGBC already detects this
   failure mode reactively — `wiScanReport.pinnedOverBudget` fires a
   warning toast *after* constant+critical entries already exceed budget
   (`chatStore.ts`, around the `buildConversationContext` scan). Upgrade to
   a proactive check: reject (or warn clearly) a create/update that would
   push some active scope's non-evictable (constant ∪ critical) total over
   the configured token budget, rather than only detecting it after the
   fact at scan time.
3. **Reject empty/whitespace-only keys at entry save time.** Currently
   silent — a key that can never match just never fires, with no feedback
   to the author.

**Separate, smaller frontend follow-up (not blocking the above):** a
semantic dedup-check nudge at entry-creation time — "here's a similar
existing entry, still want to create this one?" — using the already-live
`/lorebooks/search` endpoint. Low effort since the search endpoint already
exists; do this after the migration above, not as part of it.

### Also in scope for the migration itself

- One-shot migration for existing Data Bank documents: read the
  `stm_data_bank` blob, create books+entries via native CRUD. Mirror the
  idempotent, skip-already-migrated pattern from the original
  `import-from-blob` endpoint (`app/routers/lorebooks.py`) rather than
  inventing a new migration shape.
- `DataBankPage.tsx`'s paste/upload UI stays — it becomes "one more way to
  create a lorebook" rather than a parallel system. Its own
  query/embedding/cosine-search code (`dataBankStore.ts`'s
  `queryRelevantChunks`, `src/utils/embeddings.ts`'s client-side search)
  gets deleted once the native path replaces it.
- `resolveRagContext()` in `chatStore.ts` currently handles both Data Bank
  AND chat-history RAG in one call — losing Data Bank's half of this
  function is a real edit, not a deletion of the whole function (chat-history
  RAG's half stays).

### Recommended approach when this starts

Given the pattern that's worked all session: ground in the actual current
code first (don't trust this doc's file/line references without
re-checking — things may have moved), then implement with adversarial
review before deploy, same rigor as the 3a cutover above. This one is
smaller in scope than 3a was, but it does touch the activation engine's
core matching semantics (`_activation.py`), which is exactly the kind of
change that warrants real review before it ships.
