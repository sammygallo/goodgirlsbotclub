# GGBC — Platform & Monetization Design Brief for Fable

*Prep doc for designing the monetized, expanded Good Girls Bot Club. Grounded in the
actual `goodgirlsbotclub` codebase as of 2026-07-13. Paste this into the Fable conversation.*

---

## 0. The ask (revised direction)

Design the architecture for GGBC's next phase. Two intertwined goals:

1. **Monetization:** keep the current **bring-your-own-key (BYO)** model, but (a) make it
   *significantly easier* for users to obtain and wire up the keys a given feature needs,
   and (b) charge a **low, flat subscription** that pays for **platform hosting + access +
   tooling** — *not* a markup on compute.
2. **Product expansion:** grow GGBC from a chat app into a **dynamic-partnership platform**
   spanning a spectrum — from casual "texting a friend" chat, through collaborative
   story-building, up to **producing a finished artifact of the user's choosing**: a
   manga / graphic novel / comic, a publishable novel, or a video series.

**Framing note for Fable:** GGBC is the *testing ground* for a broader ambition. Design the
core (partnership engine, project container, production pipelines) as **reusable/portable**,
with GGBC as skin #1 — so the engine can outlive the brand.

---

## 1. The central consequence of keeping BYO-key

Because users keep paying providers (OpenAI/Anthropic/Replicate) **directly**, the
subscription can no longer be justified by "cheap compute." The user makes *two* payments —
their provider bill, plus your sub. So the subscription must earn its keep entirely through
**platform value**: polish, tooling, and the story-building/production features.

**Therefore the expansion features are not extras — they *are* the product**, and they are
what a subscriber pays for. This aligns cleanly with the vision below.

**Corollary — tier on features, not compute.** Production/export capabilities (comic
assembler, publishable-novel export, video sequencing) are *your software* and cost you
nothing per use, so they are the ideal axis to tier a subscription: no metering, no compute
exposure. E.g. free/base = chat + BYO-key; higher tiers unlock production pipelines.

---

## 2. "Make keys easier" — the design fork (Fable to weigh)

Keeping *true* BYO but removing multi-provider signup friction is a real tension. Three
options; **the user wants Fable to recommend** based on cost, effort, and UX:

- **A — Onboarding polish only.** Keep multi-provider BYO; build a great key-setup wizard:
  per-provider deep links, live key validation, and per-feature "here's exactly what you
  need for *this*" guidance. Cheapest to build; keeps all compute cost off the platform.
  Downside: the "sign up + add a card at N providers" friction remains.
- **B — Aggregator-first (one key).** Steer users to a single **OpenRouter-style aggregator
  key** that reaches hundreds of models across providers with one signup and one payment
  relationship. Still BYO (user pays the aggregator; platform never touches compute cost),
  but collapses N keys → 1. GGBC's provider catalog already supports OpenRouter-style
  proxies. Best UX-per-effort for LLM.
- **C — Aggregator + managed media.** Option B for LLM, plus a **small platform-run credit
  path just for image/video** — because media gen (Replicate etc.) has **no
  consumer-friendly BYO aggregator**, so that's the real friction hot-spot. Reintroduces
  light metering/billing, but only for media, where BYO is genuinely painful.

**Key technical note:** LLM has a clean aggregator story; **media generation does not.**
Whatever path is chosen, media keys/costs are the hard part.

---

## 3. The product vision → what it demands architecturally

"Texting-a-friend → publishable manga/novel/video series" is no longer a chat app. It
implies three things GGBC does **not** have today:

- **A Project / Work container above chats.** A persistent creative workspace spanning many
  sessions, characters, and scenes, accumulating toward a deliverable. Today GGBC has chats
  and characters but no "work that produces an artifact."
- **Output/production pipelines per artifact type** — each its own assembler:
  - *Novel* → structured chapters → formatted EPUB/PDF.
  - *Comic / manga* → paneling + composed image-gen + lettering/layout.
  - *Video series* → the existing scene-video pipeline, sequenced into episodes.
- **Cross-generation consistency — the hard technical spine.** A manga needs the *same*
  character face across hundreds of panels; a video series needs consistent scenes/style.
  This is what separates a publishable product from a cute demo. The existing scene-video
  **keyframe + LoRA** work (FLUX Kontext keyframe → wan-2.2 motion) is exactly the relevant
  groundwork — ask Fable to design consistency as a first-class subsystem (character bible,
  style locks, reference-image conditioning), not an afterthought.

Also implied: a **partnership "intent spectrum"** — the same underlying engine at different
fidelities (quick-text friend ↔ story collaborator ↔ production director), likely UI modes
over shared primitives, plus a **structured story-state layer** (beats, chapters, scene
lists, character bibles) above today's characters + prompt templates.

---

## 4. Current architecture (what exists to build into)

**Three repos:**
- `sammygallo/goodgirlsbotclub` — React/Vite/TS **frontend** (this repo).
- `sammygallo/ggbc-backend` — **FastAPI + Postgres backend** (separate repo, not checked
  out locally). Most new server work (billing, ledger, project container) lives here.
  Clone as `../ggbc-backend`.
- `sammygallo/ggbc-intake-bot` — Discord feature-intake bot (pm2 on droplet).

**Auth:** same-origin **httpOnly session cookies** (not JWT). First registrant = `owner`;
self-registration off in prod; onboarding via invite tokens.

**Access control:** `owner | admin | contributor | end_user` roles as a shim over a
finer-grained **permission-group RBAC** system. → Natural home for subscription-tier
entitlement checks (gate production features by tier).

**Secrets:** per-user encrypted secret storage (Fernet, `SECRET_ENCRYPTION_KEY`). → Already
the mechanism that holds users' BYO provider keys; the pattern for a processor customer ID.

**Deploy:** single DigitalOcean droplet (**1 vCPU / 1 GB RAM + 2 GB swap**), pull-only
Docker Compose (frontend nginx + backend uvicorn + Postgres 16), images built in GH Actions
→ GHCR. No Redis, no queue. *Production pipelines (rendering novels/comics/video) will need
real background-job infra + more headroom — factor into cost.*

**Content primitives that exist:** characters, chats, messages, prompt templates, cross-
device settings sync, per-user blob (media) storage. **Paid-compute chokepoints** already
isolated behind backend routes: `/api/backends/*` (LLM), `/api/scene-video/*`,
`/api/live-portrait/*`, `/api/sd/*` + `/api/openai/generate-image` (image).

**⚠️ All media generation currently runs on Replicate** (FLUX Kontext + wan-2.2), *not*
RunPod — see the discrepancy in §7.

---

## 5. What's absent (must be built)

- **No Project/Work container** and no structured story-state layer (beats/chapters/scene
  lists/character bible) — the backbone of the production vision.
- **No production/export pipelines** — nothing assembles a novel/comic/video-series
  deliverable; no consistency/continuity subsystem for characters or style.
- **No billing of any kind** — no subscription schema, no payment processor, no webhook
  handler. Even a *flat* sub needs: a plan/subscription table, processor integration,
  webhook-driven state, and tier→entitlement wiring into RBAC.
- **No server-authoritative usage anything** — current metering is client-side, *estimated*,
  *soft*, and user-resettable. Fine for a flat sub (no metering needed); required only if
  Option C's managed-media credits are chosen.
- **Better key-onboarding** — today users hand-enter provider keys; the "make keys easy"
  wizard/aggregator flow (§2) doesn't exist yet.

---

## 6. Reusable primitives (don't reinvent)

- **RBAC** (`src/utils/permissions.ts`, `RequireRole`/`RequirePermission`) — ready to gate
  premium/production features by subscription tier.
- **Encrypted per-user secrets** (Fernet) — already stores BYO keys; extend for aggregator
  keys and processor IDs.
- **`usageStore` budget model** (`src/stores/usageStore.ts`) — a full cap→deplete→reset
  mechanism; reusable *only if* Option C credits are adopted. `TokenUsage.source:
  'estimated' | 'measured'` (`src/stores/chatStore.ts:68`) already anticipates a measured
  path. Otherwise a flat sub needs none of this.
- **Scene-video keyframe+LoRA pipeline** (`src/api/sceneVideoGen.ts`,
  `GenerateSceneModal.tsx`) — the seed of the video-series producer and the
  consistency subsystem.
- **Characters + prompt templates + blob storage** — raw material for the story-state
  layer and asset continuity.

---

## 7. Discrepancies to resolve *before* Fable prices/architects

1. **RunPod vs. Replicate for media.** Project notes say the scene-video pipeline is moving
   to **self-hosted RunPod** (NSFW reasons); **shipped code uses Replicate**. Different cost
   curves and different consistency/LoRA control. Decide the go-forward platform — it drives
   both media cost and how much control you have over character consistency (a self-hosted
   pipeline gives far more control over the exact levers the production vision needs).
2. **A prior monetization design exists.** `docs/v2/ROADMAP.md` sketches a `BillingProvider`
   interface, a subscriptions table + `users.subscription_tier`, credit-pack pricing for
   "Film Creation," Redis + a job queue, and the NSFW → CCBill/Segpay processor concern.
   **Bring it** — Fable should extend it, not restart. (Note: it assumes a credit/markup
   model; reconcile it with the new flat-sub direction.)

---

## 8. Hard constraints (non-negotiable inputs)

- **Payment processor: the NSFW problem does NOT go away with a flat "hosting" sub.**
  Stripe/PayPal classify the *platform* by its content, not by what the line-item says. A
  low hosting sub on an NSFW platform still trips their ToS. Plan on **CCBill / Segpay /
  Verotel / crypto** regardless of how the charge is framed.
- **Age verification** is mandatory for a paid adult product.
- **Content-safety scope is fixed:** fictional-characters-only; real-person depiction (NCII)
  is a hard red line gated at avatar upload. A production platform that outputs *publishable*
  artifacts *raises* this stakes — export/consistency features must not become a face-swap
  or real-likeness vector.
- **Publishing/IP surface (new).** If users export *publishable* novels/comics/videos, Fable
  should address: who owns the output, model-provider ToS on commercial use, and platform
  liability for user-generated published content.
- **Infra headroom.** The droplet is tiny (1 vCPU / 1 GB). Production rendering + billing
  webhooks + job queue will need more; fold into unit economics.

---

## 9. Numbers you must bring

A flat sub needs far less cost data than the markup model, but Fable still needs:
- **Your fixed monthly costs** — droplet, storage, bandwidth, plus what the production
  pipelines will add (render compute, queue infra). This sets the subscription floor.
- **If self-hosting media (RunPod):** GPU baseline + per-render cost — this becomes a real
  cost line even under BYO, because *rendering a final product* may run on your infra, not
  the user's key.
- **If Option C (managed media credits):** per-image / per-video-clip cost to price credits.
- **Rough user count + how many would want production features** — sizes the tier split.

---

## 10. Open decisions for Fable

1. **Key-onboarding path** — A (polish) vs. B (aggregator) vs. C (aggregator + managed
   media). *User has asked Fable to recommend* (see §2).
2. **Subscription shape** — single low flat tier, or free-base + paid tiers where tiers
   unlock production pipelines? What's free vs. gated?
3. **Where does rendering run** — on the user's BYO key, or on platform infra (esp. for
   final-product assembly)? This decides whether *any* compute cost lands on you.
4. **Project/Work data model** — how a work relates to chats, characters, scenes, and
   accumulates toward a typed deliverable.
5. **Consistency subsystem** — character bible + style locks + reference conditioning;
   how it plugs into the chosen media platform.
6. **Portability** — how to factor the core engine so GGBC is one skin over a reusable
   platform.
7. **Processor + age-gate + publishing-IP** — the compliance spine (§8).

---

*Companion pointers: backend in `ggbc-backend` (separate repo); prior design notes in
`docs/v2/ROADMAP.md`; BYO-key handling via Fernet-encrypted secrets; usage/gauge in
`src/stores/usageStore.ts` + `src/components/settings/UsagePage.tsx`; media pipeline seed in
`src/api/sceneVideoGen.ts` + `src/components/chat/GenerateSceneModal.tsx`.*
