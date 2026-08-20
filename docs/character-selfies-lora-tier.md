# Character Selfies — LoRA tier ("Studio" mode: train your character)

**Status:** Proposal · **Drafted:** 2026-08-19 · **Repos:** goodgirlsbotclub (frontend) + ggbc-backend · **Builds on:** [`character-selfies-scene-mode.md`](character-selfies-scene-mode.md) (Phase A shipped 2026-08-19; this is its Phase C, committed scope per decision 3)

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

**Weights residence (fal path):** fal's CDN retains artifacts "at least 7 days" *by default* — a trained LoRA must not silently vanish. Two verified levers: send `X-Fal-Object-Lifecycle-Preference: {"expiration_duration_seconds": null}` on the training submit (no expiration), and/or download `diffusers_lora_file.url` (~90 MB class) and re-host. Recommendation: the lifecycle header, plus persisting the URL + its checksum in the DB; re-hosting 90 MB per character in droplet Postgres is the fallback, not the plan. Caveat noted: fal artifact URLs are public-but-unguessable — an unauthenticated (SFW, illustrated-character) artifact, same exposure class as a private Replicate model, acceptable for v1.

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

## 7. Open decisions

1. **Trainer/inference stack:** fal end-to-end (recommended — one key, drop-in Phase-A queue client, flat pricing) vs Replicate (10× cheaper inference, more orchestration + second account) vs both-swappable now. Recommend **fal v1, swappable interface** so Replicate can join later — the same shape as Scene's decision 1.
2. **Weights residence:** fal CDN + no-expiry lifecycle header + checksum pinned in DB (recommended) vs download-and-rehost ~90 MB/character in user_blobs (droplet-heavy; keep as fallback if the lifecycle header proves unreliable — see uncertainty below).
3. **Bootstrap recipe:** mixed 4-Kontext + 8-nano-banana (recommended, ~$1.30, balances fidelity + variety) vs nano-banana-only (~$1.80, max variety) vs Kontext-only ($0.30, overfit risk on near-identical framings).
4. **Training gate tier:** `generation:lora_train` owner-only first (recommended — `generation:video` precedent, real per-action spend) vs contributor-and-up at launch.
5. **Mode name:** "Studio" (recommended) / "Trained" / "Max fidelity" — pure copy, but it's user-facing everywhere.

**Fixed constraints (not decisions):** LoRA × NSFW blocked pending Phase B's output-side gate; auto-trigger stays Close-up-only; provenance gate binds at enqueue + pickup + serve; training state is DB-backed, never in-memory.

---

## 8. Phasing

- **Phase C1 — training pipeline.** Migration 0025 + `lora_trainings` + worker + bootstrap + fal trainer client + `POST .../train` + `GET .../status/{characterName}` + the CharacterEdit section/modal. Gated `generation:lora_train`, owner-only. **Exit test: one real character trained end-to-end on live keys** (the fal lifecycle header behavior — an open uncertainty — gets verified here).
- **Phase C2 — Studio serve mode.** `mode:"lora"` + `_generate_lora_sfw` + serve-time gate re-checks + the modal's third mode + `lora_status` on the character row. Ships the user-visible tier.
- **Phase C3 — management + alternatives.** Retrain/delete (incl. deleting the fal artifact), the Replicate backend behind the swappable interface, cost/step tuning (steps vs quality on illustrated characters).

**Known uncertainties to burn down in C1:** fal trainer wall-clock (page says only "minutes"); whether the lifecycle header is honored on training endpoints specifically; the exact weights file naming/format. All three resolve with the first live train.

---

## 9. TL;DR

Scene mode's validation measured the fidelity ceiling of reference-conditioned generation: recognizable, but signature details drift. A per-character LoRA is the only path that memorizes the character *and* keeps full scene freedom. Train once (~$3.30 all-in on the user's own keys: ~12 synthetic bootstrap views from the cleared avatar, then fal's $2 flat trainer over the exact queue client Phase A already built), store the weights URL durably, and serve a third **Studio** selfie mode at ~$0.04/image — cheaper per image than Scene and drift-free. Training state is DB-backed (the repo's embedding-worker pattern) because a paid 20-minute job must survive deploys. The provenance gate binds three times — enqueue, pickup, serve — because a LoRA is a persistent identity distillation, and NSFW stays blocked until Phase B's output-side gate exists.
