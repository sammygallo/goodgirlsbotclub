# Character Selfies — LoRA tier ("Studio" mode: train your character)

**Status:** SHIPPED — C1 2026-08-22 (ggbc-backend #68), C2 2026-08-23 (#75 + goodgirlsbotclub #436), C3 2026-08-24 (management: delete/retrain/steps; Replicate leg DEFERRED, see §8) · **Drafted:** 2026-08-19 · **Repos:** goodgirlsbotclub (frontend) + ggbc-backend · **Builds on:** [`character-selfies-scene-mode.md`](character-selfies-scene-mode.md) (Phase A shipped 2026-08-19; this is its Phase C, committed scope per decision 3)

Scene mode ships, and its decision-4 validation measured the exact cost it warned about: **signature-detail drift**. Across 4 real avatars (1 pass / 3 marginal / 0 fail), identity stayed *recognizable* but the details that make a character *theirs* slipped — Ivy's silver irises turned red, Dominic lost his hair-over-one-eye cut, Mina's pearl hood-trim vanished. A reference-conditioned generator holds a character; it doesn't *memorize* one. The only path that both locks the exact drawn look **and** composes truly novel scenes is a **per-character LoRA** — a small fine-tune that teaches the base model this specific character. This doc specifies that tier.

---

## 1. What a LoRA buys (and costs)

| | Close-up (live) | Scene (live) | **Studio (this doc)** |
|---|---|---|---|
| Engine | Kontext edit-in-place | nano-banana reference-composite | FLUX + **per-character LoRA** |
| Fidelity | pixel-perfect | recognizable, signature details drift | **memorized** — trained into the weights |
| Freedom | none (avatar's frame) | full scene/pose | full scene/pose |
| Setup | none | none | **one-time train (~$3–4, ~minutes–30min)** |
| Per image | ~$0.025 | ~$0.15 | **~$0.04** |

Studio mode is the premium tier for favorite characters: pay once to train, then generate anywhere-selfies that hold the tear-track, the hood-trim, the exact iris color — and at a **quarter of Scene's per-image price**. It fits the platform's monetization direction exactly: BYO key pays the compute, the *feature* is the tier.

---

## 2. The pipeline

```
avatar (cleared provenance — the NCII gate binds HERE, at training)
   │
   ▼  BOOTSTRAP — ~12 synthetic views from the one avatar (~$1.30)
   │    • ~4 × Kontext light edits (expression/lighting — cheap, pixel-faithful)
   │    • ~8 × nano-banana Scene views (angles/poses/settings — the variety
   │      Kontext can't do; Phase A proved this works on real avatars)
   │    → zip in memory (stdlib), stored to user_blobs for audit
   │
   ▼  TRAIN — hosted FLUX LoRA trainer, BYO key (~$2, async)
   │    subject mode, auto-captioned, per-character trigger word
   │    → LoRA weights (safetensors URL) + row in lora_trainings (DB)
   │
   ▼  SERVE — mode: "lora" on the existing selfie contract
        FLUX + the character's LoRA + the scene prompt → the character,
        exactly, anywhere. SFW-only pending Phase B's output-side gate.
```

Why bootstrap at all: a LoRA trained on one image overfits to that framing. Trainers recommend 10–18 varied views ("different settings, facial expressions, and backgrounds"). We synthesize them from the single cleared avatar using the two engines we already run — Kontext for identity-faithful closeup variations, the Phase-A Scene path for pose/angle/setting variety. The bootstrap *is* avatar-conditioned generation, so it inherits the provenance gate by construction.

---

## 3. Trainer landscape (verified against live pages, 2026-08-19)

| Stack | Train | Inference | Verdict |
|---|---|---|---|
| **fal end-to-end** — `flux-lora-fast-training` → `flux-lora` | **$2 flat** (1000 steps), "minutes"; input = zip URL; output = **plain safetensors URL** that plugs straight into inference | **$0.035/MP** (~$0.04/img) via `loras: [{path, scale}]` | ✅ **Recommended v1.** Same BYO `api_key_fal` Scene already uses; the **identical queue envelope** we built in Phase A (submit → echoed status_url → response_url) — the client is a near-copy of `_generate_scene_sfw`. No account lookup, no destination model, no upload-API expiry dance. |
| **Replicate** — `ostris/flux-dev-lora-trainer` (or `fast-flux-trainer`, ~$1.46/2min) | $1.83–2.75 per-second-billed (20–30 min H200); **requires a destination model pre-created on the user's account** (`GET /v1/account` → `POST /v1/models`), zip via Files API (100 MB, ~24 h expiry), separate trainings wire-shape | destination version ~**$0.004/img** (per-second, fast-boot) or `flux-dev-lora` official $0.032/img | ⚠️ **Cheaper at volume, more moving parts.** ~10× cheaper per image — wins for heavy users (breakeven vs fal ≈ 60 images) — but adds a second billing-enabled account requirement and 4 extra orchestration steps, each a new failure mode on end-users' keys. Keep as the swappable second backend. |
| Self-host training | — | — | ❌ Not now — 20+ min of GPU per train on rented infra is Phase-D territory; hosted trainers are cents-comparable. |

**Weights residence (fal path) — REVISED by the C1 live exit test (2026-08-22, ggbc-backend #70/#72), superseding the plan below.** The lifecycle-header lever proved actively wrong: submitting the trainer with `X-Fal-Object-Lifecycle-Preference: {"expiration_duration_seconds": null}` got the output **deleted within minutes** (null read as expire-now, not never — the exact unverified semantics this doc had flagged), while an unheadered plain upload persists under the account default ("forever and publicly readable if not configured"). Shipped design: **no fal lifecycle headers anywhere** (regression-pinned), and on training success the worker **re-hosts** the weights to a plain fal-storage upload we initiate (`_fal_rehost_weights`: streamed download, sha256 in the same pass, single-shot PUT ≤80 MB, else the fal-js multipart flow — the 131 MB weights 413'd the single shot live). `lora_url` + `lora_checksum` pin the durable copy. Caveat stands: fal artifact URLs are public-but-unguessable — an unauthenticated (SFW, illustrated-character) artifact, acceptable exposure class for v1 — and now covers TWO plain uploads per training (the rehosted weights and the bootstrap views zip), which is deletion-relevant: see §8's C3 notes.

---

## 4. Backend design (ggbc-backend)

**The architectural break from Phases A/B: training must survive restarts.** Every selfie/scene/portrait job today lives in an in-memory `_jobs` dict whose docstrings admit restart loss — fine for a 30-second render, unacceptable for a paid multi-minute train (deploys alone happen more often than a training completes, and the provider keeps training/charging through our restart). The repo already has exactly one restart-safe async precedent, chosen deliberately for the 1-vCPU droplet: **`embedding_jobs` + the lifespan polling worker** (`app/models/embedding_job.py`, `app/workers/embeddings.py`). Phase C copies it:

- **Migration 0025 — `lora_trainings` table** (modeled on `embedding_jobs`, real FK to `characters.id`): `status` (pending → bootstrapping → training → succeeded | failed, CheckConstraint), `attempts`, `last_error`, `provider` + `provider_request_id` (**the restart-recovery key** — the worker re-polls it on boot), `lora_url` + `lora_checksum` (set on success), `trigger_word`, `avatar_key` + `provenance_at_train` (binds the artifact to what was cleared), `bootstrap_zip_blob_key`, timestamps. Partial unique index on `character_id WHERE status IN (pending, bootstrapping, training)` — one in-flight train per character, idempotent enqueue (`ON CONFLICT DO NOTHING`).
- **Worker**: a `run_lora_worker()` loop started from main.py's lifespan beside the embedding worker — `FOR UPDATE SKIP LOCKED` claim, per-job commit, the rollback-then-record-failure double-try (load-bearing: skipping it leaves rows stuck at `processing` forever).
- **Router** `app/routers/lora_training.py` under the `/api` prefix (no nginx/vite changes — the bare-prefix gotcha doesn't apply): `POST /api/selfie/lora/train` (enqueue), `GET /api/selfie/lora/status/{characterName}` (**character-keyed, not job-keyed** — reloads can rejoin; reuses the shared `{status, error}` poll shape).
- **Serve**: `mode: "lora"` joins `closeup | scene` on the existing selfie contract; `_run_job` dispatches to a `_generate_lora_sfw(api_key, lora_url, trigger_word, prompt)` that is `_generate_scene_sfw` with `fal-ai/flux-lora` + `loras` instead of nano-banana.
- **Permission**: new `generation:lora_train` in `PERMISSION_CATEGORIES` + `OWNER_ONLY_PERMISSIONS` (the `generation:video` real-spend precedent; Owner auto-gains on boot, Admin auto-excludes, the group editor picks it up from the vocabulary endpoint). *Serving* an already-trained LoRA needs only `generation:image` — training is the gated spend.

### Safety — the gate binds three times, and harder than before

A LoRA is a **persistent identity distillation** — the worst-case NCII artifact if it were ever trained on a real person. So the provenance gate binds at: (1) **enqueue** (route pre-flight, exactly like `selfie_generate`); (2) **worker pickup** (fresh re-read before bootstrap generation — which is itself avatar-conditioned and thus inherently gated); (3) **serve time** — every `mode:"lora"` request verifies the character's *current* avatar equals the training row's `avatar_key` **and** current provenance is still cleared. An avatar swapped after training must not keep serving the old identity, and a LoRA row never outlives its clearance. This is stricter than the selfie double-check because the artifact persists. **LoRA × NSFW is not a decision — it's blocked** pending Phase B's output-side gate: a LoRA is full text-freedom generation, so the Scene-mode containment-premise shift applies at full strength.

---

## 5. Frontend design (goodgirlsbotclub)

- **Train UX** lives in **CharacterEdit** — the Live Portrait bordered-section is the exact template (heading + status chip `not trained / training… / trained` + one-line pitch with the one-time cost + a button opening a `TrainLoraModal` copied from `LivePortraitSetup`). Gated on `avatarProvenanceAllowsSelfies` + `generation:lora_train` + `hasFalKey()`.
- **Reload survival** follows the house pattern (no poll in this codebase survives reload; recovery is server-status rediscovery): a `useLoraStatus(avatar)` hook mirroring `useLivePortraitDiscovery`, polling the character-keyed status endpoint while `training`, hydrating a small persisted store both the CharacterEdit chip and the selfie modal read.
- **Trained state is a top-level server field** on the character row (`lora_status`, `lora_trained_at`) — the `avatar_provenance` precedent, and per the documented rule that trust-sensitive per-character stamps must never ride `data.extensions` (they'd be re-trusted on edit round-trips). It flows through `toCharacterInfo` → `characterStore` with zero new plumbing.
- **Serve UX**: a third mode in TakeSelfieModal — **Close-up / Scene / Studio** — following the modal's teach-and-disable philosophy: visible always; disabled with teaching copy when the character isn't trained ("Train {name} for max fidelity — Character → Edit"). Untrained-character upsell for free. Studio forces SFW (like Scene); the auto-trigger stays Close-up-only (locked decision 2 — untouched). Cost copy in the info box: ~$0.04/image.

---

## 6. Costs (verified where noted)

- **One-time per character:** bootstrap ~$1.30 (4 × Kontext ≈ $0.10 + 8 × nano-banana ≈ $1.20) + train **$2.00 flat** (fal, verified) ≈ **$3.30**. All on the user's own keys (bootstrap: replicate+fal; train: fal).
- **Per image after:** **$0.035/MP** (fal `flux-lora`, verified) ≈ $0.04 at 1 MP — vs $0.15 Scene, $0.025 Close-up.
- Replicate alternative: train $1.83–2.75 (verified per-second), inference ~$0.004/img — total-cost winner past ~60 images/character, at the price of destination-model orchestration and a second billed account.

---

## 7. Decisions (locked 2026-08-19)

1. **Trainer/inference stack — fal end-to-end, behind a swappable interface.** One key (`api_key_fal`, already collected for Scene), the drop-in Phase-A queue client, flat $2 training, `fal-ai/flux-lora` inference. Replicate (10× cheaper inference past ~60 images/character, at the cost of destination-model orchestration + a second billed account) joins later as the swappable second backend — the same shape as Scene's decision 1.
2. **Weights residence — fal CDN with the no-expiry lifecycle header, checksum pinned in DB.** `X-Fal-Object-Lifecycle-Preference: {"expiration_duration_seconds": null}` on the training submit; `lora_url` + `lora_checksum` persisted in `lora_trainings`. Download-and-rehost (~90 MB/character in user_blobs) stays the documented fallback if C1's live train shows the header isn't honored on training endpoints.
3. **Bootstrap recipe — mixed: ~4 Kontext light edits + ~8 nano-banana Scene views (~$1.30).** Kontext supplies pixel-faithful expression/lighting variation; the Phase-A Scene path supplies the pose/angle/setting variety Kontext structurally can't. Kontext-only rejected (overfit risk on near-identical framings); nano-banana-only rejected (pays ~$0.50 more for variety the mix already achieves).
4. **Training gate — `generation:lora_train`, owner-only first.** The `generation:video` precedent: real per-action spend starts contained; widen deliberately later. Serving an already-trained LoRA needs only `generation:image`.
5. **Mode name — "Studio".** Close-up / Scene / Studio in the selfie modal and everywhere user-facing.

**Fixed constraints (not decisions):** LoRA × NSFW blocked pending Phase B's output-side gate; auto-trigger stays Close-up-only; provenance gate binds at enqueue + pickup + serve; training state is DB-backed, never in-memory.

---

## 8. Phasing

- **Phase C1 — training pipeline. SHIPPED 2026-08-22 (ggbc-backend #68, + #70/#72 rehost follow-ups).** Migration 0025 + `lora_trainings` + worker + bootstrap + fal trainer client + `POST .../train` + `GET .../status/{characterName}` + the CharacterEdit section/modal. Gated `generation:lora_train`, owner-only. The exit test (Ivy, live keys) resolved all three §8 uncertainties: training wall-clock ~5m, the lifecycle header DELETES output (→ rehost, see §3), weights file `pytorch_lora_weights.safetensors` @ 131 MB.
- **Phase C2 — Studio serve mode. SHIPPED 2026-08-23 (ggbc-backend #75 + goodgirlsbotclub #436).** `mode:"lora"` + `_generate_lora_sfw` + serve-time gate re-checks + the modal's third mode + `lora_status` on the character row. #75 also landed Phase 3 content-bound provenance (`avatar_cleared_sha256`, migration 0027) after its review confirmed the pre-training byte-swap gap.
- **Phase C3 — management + tuning. SHIPPED 2026-08-24.** As-built scope:
  - **Delete** — `DELETE /api/selfie/lora/{characterName}` (same `generation:lora_train` permission; 409 while in-flight; idempotent): removes every training row + the local `lora-bootstrap/**` cache, then best-effort fal-side cleanup **after** the commit. Character deletion runs the same purge (pre-C3 it leaked the bootstrap blobs and fal payloads forever). Generated `selfie/**` images are kept — chat history references them.
  - **The fal deletion surface, measured (2026-08-23):** the only API is `DELETE api.fal.ai/v1/models/requests/{id}/payloads` — completed requests only, **admin-scoped keys only** (most BYO keys aren't; the UI says so), outputs only. The two durable artifacts are **plain storage uploads fal has no delete API for at all** — the rehosted weights and the bootstrap views zip remain (public-but-unguessable, the accepted §3 exposure class; visible in the user's own fal dashboard). Outcomes are reported per request id (`deleted/unauthorized/failed`) and audit-logged — the log line is the recovery artifact once rows are gone.
  - **Retrain** — was already possible (a finished row leaves the in-flight index scope); C3 adds the confirm dialog + **supersede purge**: when a retrain succeeds, older succeeded rows for the SAME avatar content are deleted (rows + best-effort fal payloads) — they were unreachable (`_servable_lora` picks the newest content match). Rows for OTHER art are kept: reverting art re-serves that art's weights, and the bootstrap cache survives so a same-art retrain still costs trainer-only.
  - **Steps** — `lora_trainings.steps` (migration 0028, default 1000), route-bounded 250–2000, presets in the modal at 500/1000/1500. fal prices the run linearly (~$2 at 1000). The steps-vs-quality question is an EXPERIMENT, not code: see the protocol below.
  - **The Replicate leg is DEFERRED** (decision 2026-08-23) — see the deferral note under Phase D.
- **Steps-vs-quality protocol (manual, ~$6, run when curious):** pick one illustrated character with a trained 1000-step baseline; retrain at 500 and at 1500 (same art, so each retrain is trainer-only); generate the same 3 prompts at each (one close portrait, one full-body scene, one odd angle); compare signature details (the §1 drift list: irises, hair cut, trim). Expect 500 to drift on fine details and 1500 to overfit toward the training views' framing; adjust the modal's default only if the baseline loses. **Result (run 2026-08-24, Ivy, ~$4.40 + $2 restore):** exactly as predicted — 500 gave a mildly underfit face (softer, younger, waxier skin) with identity intact; 1500 gave the strongest style lock but the weakest prompt adherence (the close-up came back as a training-view-framed mid-shot in a different outfit); 1000 balanced both. **Verdict (Sammy): 1000 stays the default.** Ivy restored to a 1000-step model afterward; full-res comparison set in ~/Downloads/ivy-steps-comparison-2026-08-24/. Incidental live findings from the same session: the supersede purge behaved exactly as designed across two retrains, one Replicate cold-boot timeout exercised the cache-resume path with no re-spend, and fal payload deletion returns `unauthorized` on the standard (non-admin) BYO key — the taxonomy's expected modal outcome.

**Known uncertainties to burn down in C1:** ~~fal trainer wall-clock; lifecycle header behavior; weights file naming~~ — all three resolved by the C1 exit test (see the C1 entry and §3).

**Replicate backend — DEFERRED (2026-08-23).** Decision 1 already framed Replicate as "joins later"; the C3 scoping killed the near-term case: the ~10× inference saving (~$0.004/img) exists only on the **destination-model** path (train on Replicate, serve your own version per-second — second billed account, model-creation orchestration, weights resident on Replicate), while the lightweight path (`black-forest-labs/flux-dev-lora` serving our fal-hosted weights by URL) runs ~$0.032/img — no real saving over fal's ~$0.04, pure provider redundancy. Zero characters are near the ~60 Studio images/month break-even. **Revisit triggers:** any character crossing ~60 Studio images/month, or fal reliability becoming a real problem. The seam is already in the schema (`provider`, `provider_request_id/status_url/response_url` are provider-generic and single-sourced).

---

## 9. TL;DR

Scene mode's validation measured the fidelity ceiling of reference-conditioned generation: recognizable, but signature details drift. A per-character LoRA is the only path that memorizes the character *and* keeps full scene freedom. Train once (~$3.30 all-in on the user's own keys: ~12 synthetic bootstrap views from the cleared avatar, then fal's $2 flat trainer over the exact queue client Phase A already built), store the weights URL durably, and serve a third **Studio** selfie mode at ~$0.04/image — cheaper per image than Scene and drift-free. Training state is DB-backed (the repo's embedding-worker pattern) because a paid 20-minute job must survive deploys. The provenance gate binds three times — enqueue, pickup, serve — because a LoRA is a persistent identity distillation, and NSFW stays blocked until Phase B's output-side gate exists.
