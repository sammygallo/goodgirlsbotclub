# Character Selfies — Design Doc

**Status:** Proposal · **Author:** drafted 2026-08-16 · **Repos:** goodgirlsbotclub (frontend) + ggbc-backend

Let characters send **photorealistic, identity-consistent "selfies" of themselves** — generated from their own avatar — inline in chat, driven by the character's own narration.

---

## 1. Summary

Characters already *narrate* sending photos ("*sends photo*", "*sends selfie*") but nothing is rendered. This feature makes that real: when a character offers a selfie, the client generates an image **conditioned on the character's avatar** (so it actually looks like them) and drops it into the conversation as a message from the character.

The hard part — avatar-conditioned, identity-preserving image generation — **already exists in production**. The scene-video pipeline uses **FLUX.1 Kontext** to place a character's avatar into a new scene while pinning their face/identity ([`ggbc-backend/app/routers/scene_video.py`](../../ggbc-backend/app/routers/scene_video.py)). A selfie is that keyframe step returned as a **still image**, minus the Wan-2.2 video animation.

So ~80% of this is wiring an existing primitive into the chat loop. The genuinely new work is (a) the trigger convention and (b) — decisively — an **avatar-provenance safety gate** that does not exist yet.

---

## 2. Why plain image-gen is the wrong tool

The image-gen backends we just shipped (Pollinations / AI Horde / DALL·E / SD WebUI) are **text→image**: they draw *a* person matching a prompt, not *this* character. A "selfie" that doesn't look like the character is worthless.

Identity preservation requires **image→image / reference-conditioned** generation. Options considered:

| Approach | Verdict |
|---|---|
| Text→image (Pollinations/DALL·E) | ✗ No identity — draws a stranger |
| Per-character LoRA training | ✗ Too slow/expensive per character |
| SD + IP-Adapter / InstantID / PuLID | ~ Works, but new infra + tuning |
| **FLUX.1 Kontext (already wired)** | ✓ Instruction-following identity editor, no training, already in prod |

**Decision: reuse FLUX Kontext.** It's the scene-video keyframe engine, it's cheap (~$0.025/image), renders in seconds, and its identity instruction is already tuned ([`_keyframe_prompt`](../../ggbc-backend/app/routers/scene_video.py)):

> "Place this exact person into a new scene while preserving their face, hair, and identity. Keep their real, photorealistic appearance — do not stylize or cartoonify. Scene: {scene} …"

---

## 3. Architecture

```
Character reply (streamed)
   │  contains  [selfie: casual, bedroom, soft smile]
   ▼
Frontend: parse tag (like [lovense:…]/[emotion:…]) ──► strip from rendered text
   │
   ▼
POST /api/selfie/generate  { characterName, prompt, tier }
   │
   ▼  ggbc-backend  (reuses scene_video/live_portrait helpers)
   ├─ _resolve_avatar_blob(character)        ← avatar PNG from user_blobs
   ├─ _upload_avatar(...) → Replicate input
   ├─ FLUX Kontext (REPLICATE_KONTEXT_URL)   ← avatar + selfie instruction
   ├─ poll until done  (KEYFRAME_TIMEOUT_SEC)
   └─ _store_blob("selfie/{avatar}/{id}.png") → /blobs/... URL
   │
   ▼
Frontend: render as an image message from the character + save to gallery
```

**Reuse map (already built):**

| Need | Reuse |
|---|---|
| Avatar bytes → Replicate | `_resolve_avatar_blob`, `_upload_avatar` — [`live_portrait.py`](../../ggbc-backend/app/routers/live_portrait.py) |
| Identity-preserving generation | FLUX Kontext call + poll — [`scene_video.py`](../../ggbc-backend/app/routers/scene_video.py) |
| Identity instruction | `_keyframe_prompt` pattern |
| Store + serve the image | `_store_blob` → `/blobs/...` |
| Per-user Replicate key | `api_key_replicate` secret (from Live Portrait / Scene Video) |
| Inline-tag parse + strip + teach-the-model | `[lovense:…]` machinery — `src/utils/lovense.ts`, `src/stores/lovenseStore.ts` |
| Inline image in chat + gallery | `ImageGenModal` "insert into chat" + `imageGenStore` gallery |

---

## 4. Component 1 — the `[selfie: …]` inline command

Follow the **exact pattern GGBC already uses** for `[lovense:…]` and `[emotion:…]`: teach the model the syntax via a system-prompt block, parse the tag out of the streamed reply, strip it from the rendered text, and fire a side-effect (here: image generation).

**Grammar (v1):**

```
[selfie: <comma-separated descriptors>]
e.g.  [selfie: mirror selfie, black dress, playful smirk]
      [selfie: close-up, morning light, sleepy smile]
```

- Free-text descriptors (framing, outfit, setting, expression). The backend composes the final Kontext instruction from these + the identity anchor.
- **One selfie per message** (throttle, like lovense directive throttling).
- The client owns the trigger; the model only *requests* it. This keeps generation gated on our rules, not the model's whim.

**System-prompt teaching block** (mirrors `lovenseStore.ts` "teach the model the directive syntax"): injected only for characters where selfies are enabled (see §7 gate). If not enabled, the block is absent and the model is never told the tag exists.

**Trigger model (decided):** **model-emitted `[selfie:…]` tag only for v1** — fully in-narrative, the character decides. A manual "📸 ask for a selfie" affordance is deferred to polish (§9 Phase 4).

---

## 5. Component 2 — `POST /api/selfie/generate` (ggbc-backend)

A new router, structurally a **trimmed scene_video** (keyframe only, no Wan-2.2, no ffmpeg concat).

**Request**
```jsonc
{
  "characterName": "Ivy",
  "prompt": "mirror selfie, black dress, playful smirk",  // from the tag or manual UI
  "tier": "sfw"   // "sfw" | "nsfw"  — see §7
}
```

**Behavior**
1. **Gate check** (§7): reject 403 unless this character's avatar is provenance-cleared for selfies.
2. `api_key = resolve_credential(db, user.id, "api_key_replicate")` — 400 if missing (BYO key, same as Live Portrait).
3. `_resolve_avatar_blob(characterName)` → PNG bytes → `_upload_avatar` → Replicate input URL.
4. Build the Kontext instruction: identity anchor (`_keyframe_prompt` style) + `"a selfie photo, {prompt}"`. For `tier=nsfw`, route through the scene-worker undress-LoRA keyframe path already used by scene-video (same tiering, same safeguards).
5. FLUX Kontext predict → poll (`KEYFRAME_TIMEOUT_SEC`, ~3 min ceiling; renders in seconds normally).
6. Download result → `_store_blob("selfie/{avatar}/{jobId}.png")` → return the `/blobs/...` URL.

**Response**
```jsonc
{ "imageUrl": "/blobs/selfie/Ivy.png/ab12.png" }
```

**Sync vs. job:** Kontext keyframes render in seconds, and nginx allows 300s on `/api`, so a **single blocking call** is fine (simpler than the Live Portrait/Scene Video job+poll pattern). If p95 latency creeps up, promote to the `{jobId}` poll pattern later — the client contract can be designed to allow both.

**Cost:** ~$0.025/selfie on the user's own Replicate key.

---

## 6. Component 3 — inline display

- On the returned `imageUrl`, insert an **image message attributed to the character** at the point where the `[selfie:…]` tag appeared (the tag itself is stripped from the visible text, exactly as `[lovense:…]` is stripped in `lovenseStore.ts`).
- Persist it with the message so it survives reload (blob URL is already served + durable).
- Auto-save to the **Image Gallery** (reuse `imageGenStore` gallery), tagged with the character + prompt.
- Loading state: a lightweight "📸 …" placeholder bubble while the ~few-second generation runs.

---

## 7. The safety gate — avatar provenance (decisive constraint)

⚠️ **This is the constraint that decides whether the feature can ship for a given character — not a nice-to-have.**

Avatar-conditioned generation faithfully reproduces the avatar's identity, **including NSFW variants**. If the avatar is a **real person's uploaded photo**, generating selfies (especially undress-tier) of them is **non-consensual intimate imagery (NCII)** — GGBC's stated red line: *fictional characters only; real-person depiction is gated at avatar upload and never built (no face-swap-of-a-found-photo).*

So selfie generation must be **allowed only when the avatar is known-fictional.**

**Gap:** there is **no avatar-provenance field today.** Character avatars carry no "AI-generated vs uploaded" marker (confirmed: no such flag in `characterStore`/`characterCard`; only unrelated story-bible `provenance` exists). This must be added.

**Proposed provenance model:**

| Provenance | How it's set | Selfies? |
|---|---|---|
| `generated` | Avatar made **in-app** (character-creator portrait step, image-gen) | ✅ allowed |
| `fictional-declared` | User affirmatively marks the avatar as original/fictional art (attestation at upload) | ✅ allowed (with the attestation on record) |
| `uploaded` / `unknown` | Arbitrary uploaded image, no attestation | ❌ blocked — never offered, tag never taught |

**Enforcement points (defense in depth):**
1. **Upload time** — capture provenance when an avatar is set. In-app generation stamps `generated` automatically; uploads require an explicit "this is a fictional/original character, not a real person" attestation to reach `fictional-declared`, else `uploaded`.
2. **Feature availability** — the `[selfie:…]` teaching block is injected, and the "📸" affordance shown, **only** for cleared provenance. If not cleared, the model is never told selfies exist.
3. **Backend** — `/api/selfie/generate` re-checks provenance server-side and 403s otherwise. Never trust the client.

**Decisions (locked 2026-08-16 — scale: 18 characters, 9 users):**
- **v1 scope:** `generated` **and** `fictional-declared` (attested uploads) both qualify. The attestation must be an explicit, **logged** affirmation ("fictional/original character, not a real person"), never a silent default.
- **Backfill:** the current avatar set is **auto-cleared as fictional**. Rationale: at this scale the owner personally knows all ~18 avatars, so the "unknown real-person photo in the set" risk — the thing the gate defends against — is nil; owner knowledge *is* the verification. **This is bounded to the current set.** New avatars still pass the go-forward gate above, so the design doesn't silently become "no gate" as GGBC grows.
- **⚠ Revisit trigger:** the auto-clear rationale holds only while the owner can vouch for every avatar. **If the platform opens up** (many more users / at-scale user-uploaded avatars), the backfill assumption breaks — re-gate then. The go-forward attested gate already covers new uploads regardless.
- **NSFW:** shipped in v1, reusing scene-video's existing undress-LoRA safeguards **on top of** the provenance gate. A still is higher-exposure than a fleeting video frame, so the provenance gate — not the tier — is what keeps this inside the fictional-only scope.

---

## 8. Notes

- **Consistency:** Kontext is strongest at **close, face-forward framing** — i.e. exactly selfie framing — so identity holds up better here than in full-body scene shots (where it drifts more). Prompt guidance should nudge toward selfie/portrait framing.
- **Illustrated avatars:** the current `_keyframe_prompt` pins *photorealism*, which fights an anime/illustrated avatar. Selfies should preserve the avatar's **own style** — add a style-neutral variant of the instruction (or detect avatar style) so a drawn character sends a drawn selfie, not a photoreal one.
- **Rate/cost control:** one selfie per message; a per-user/day soft cap; BYO Replicate key means the user pays — aligns with the BYO-key + low-flat-sub direction.
- **Failure UX:** on generation failure, degrade to the narrated "*sends a photo*" text (no dead bubble) — never block the reply.

---

## 9. Phasing

- **Phase 0 — Provenance foundation.** Add the avatar-provenance field + upload-time capture (in-app generation → `generated`). One-time backfill: auto-clear the current ~18 avatars as fictional. *(Gate must exist before generation ships.)*
- **Phase 1 — Backend endpoint.** `/api/selfie/generate` reusing scene_video/live_portrait helpers, **SFW + NSFW (undress-LoRA)** tiers behind the provenance gate. Prove the still-image Kontext path end-to-end.
- **Phase 2 — Inline trigger + display.** Model-emitted `[selfie:…]` grammar + teaching block + parse/strip + inline image message + gallery.
- **Phase 3 — Attested-upload UX.** The `fictional-declared` attestation flow + audit trail for new uploads (the go-forward gate).
- **Phase 4 — Polish.** Style-preserving instruction variant (drawn avatar → drawn selfie, not forced photoreal); rate/cost caps; optional manual "📸" affordance.

---

## 10. Decisions (resolved 2026-08-16)

1. **v1 provenance scope:** `generated` + `fictional-declared` (attested uploads). Attestation = explicit, logged affirmation.
2. **Backfill:** auto-clear the current avatar set as fictional — at 18 characters / 9 users the owner knows every avatar, so the unknown-real-person risk is nil. Bounded to the current set; go-forward uploads use the attested gate. **Revisit if the platform opens to scale.**
3. **Trigger:** model-emitted `[selfie:…]` tag only for v1. Manual "📸" affordance deferred to Phase 4.
4. **NSFW:** shipped in v1, reusing scene-video's existing undress-LoRA safeguards on top of the provenance gate.
5. **Endpoint shape:** blocking `/api/selfie/generate` now (Kontext renders in seconds; nginx allows 300s); contract shaped so a future `{jobId}`-poll mode is a non-breaking addition.
