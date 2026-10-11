# E6 UI Redesign — Design Specification (E6-S1)

**Status:** Frames approved 2026-10-11; QA re-run pending · **Date:** 2026-10-06 · **Amended:** 2026-10-10 (A1, §0.3: sidebar is a hidden drawer at every width; hero is followed by category rows) · **Story:** E6-S1 (design-first gate for E6-S2, E6-S3, E6-S4)
**Grounded against:** `goodgirlsbotclub` `main` @ `766d0ca8`, `ggbc-backend` `origin/main` @ `fb26a80`

This document is the source of truth for the three E6 surfaces. Implementation stories copy their checklist from §8 and inherit every decision here. Where this spec and the Fable mockups disagree, **this spec wins** unless Sammy's mockup approval explicitly overrides a numbered decision (cite the decision ID, e.g. "overrides D-H7").

Every decision has an ID (`D-<surface><n>`) so reviews, PRs and QA reports can cite it. Surfaces: **G** global, **H** hero, **S** sidebar, **C** chat layout, **T** tokens/theme.

---

## 0. Read this first

### 0.1 Corrections to the brief (verified against code)

The brief for this spec contained premises that the codebase contradicts. Each one is fixed below and the fix is a decision you can check.

| # | Brief said | Code says | Evidence | Resolution |
|---|---|---|---|---|
| K1 | Sort recent characters by `date_last_chat` ("most recently used") | `date_last_chat` is the character row's `last_modified`, and that column has `onupdate=func.now()`. It changes on **any** write to the character row (edits, embedding-cache writes, LoRA status, avatar provenance), not when someone chats. The sidebar's existing "Recent chat" sort has the same flaw. | `src/api/client.ts:252-263` (`date_last_chat: modified`); `ggbc-backend app/models/character.py:106-108` | **D-H3**: recency comes from chat rows' `updated_at` through a new aggregate endpoint (S2 backend task). The *intent* of the locked decision ("most recently used") is kept; the field is not used. |
| K2 | "No VN mode in GGBC (doesn't exist)" | VN mode exists (Phase 6.4): `displayPreferencesStore.vnMode`, a full-screen sprite layer, a background image, and a group layout for the last 3 speakers | `src/components/chat/ChatView.tsx:208-211, 1256-1335` | **D-C9**: when VN mode is on, the avatar panel does not render and VN behaves exactly as today. Listed as confirmation **Q1**. |
| K3 | Avatar source priority "Auto → Live Portrait → Expressions → static" | "Auto" is not a source. It is one of four per-character **motion modes** (`auto`, `liveportrait`, `expressions`, `none`). `auto` *resolves* to Live Portrait if clips exist, otherwise Expressions if sprites exist, otherwise static. An explicit mode whose assets are missing resolves to static. | `src/stores/motionModeStore.ts:88-103` | **D-C5** restates it as a resolution rule. |
| K4 | Themes: "light, dark, and cyberpunk" | Theme = **mode** (`light`/`dark`/`auto`) × **preset** (`purple`, `blue`, `green`, `red`, `amber`, `cyberpunk`, or `custom:<id>`). Cyberpunk is a preset, and it is the **default** preset. Users can also define custom themes with arbitrary colors. | `src/hooks/themePreferences.ts:15-19, 168-176` | **D-T1** defines the QA matrix as mode × preset. |
| K5 | Tokens `--color-secondary`, `--color-border-light` | Neither exists. The real set is listed in §6.1. | `src/index.css:7-40`, `ThemeColors` | **D-T2**: E6 introduces no new themed tokens. |
| K6 | 1/3 avatar ≈ 230–245px and chat ≈ 490–510px "at 1280px" | Before A1, at 1280px with the 288px sidebar the main column was 992px, so the avatar was 330px and the chat 662px. The brief's numbers matched **1024px with the sidebar expanded**. | arithmetic, §5.2 table | §5.2 table is authoritative (A1: no sidebar column). |
| K7 | Hero is "full viewport width" | Before A1, at ≥1024px the sidebar occupied the left edge, so the hero spanned the `<main>` column. Under A1 the drawer overlays, and the hero spans the viewport. | `MainLayout.tsx` | **D-H1**. |
| K8 | "Personal: Profile, Logout, Settings, user's Character" (decision 4) and "Profile, Settings, Character, Logout (in this order)" (brief §3) | Two different orders | — | **D-S9** fixes one order. The meaning of "user's Character" is assumed to be the **persona** (confirmation **Q3**). |
| K9 | The header currently holds only account clutter | The header also holds the PWA **Install app** button, the **PersonaSelector**, a permission-split **Settings** / **My API Keys** button, and a **kebab overflow menu** below `sm`. All of these need a destination. | `src/components/layout/Header.tsx:110-283` | **D-S10**. |
| K10 | "Feature-slide CTA opens character modal"; "link to character library/browse" | `CharacterPreviewModal` exists and fits. There is **no** library, catalog or browse route; the character list lives in the sidebar. The roadmap's S2 acceptance criterion "catalog grid below unaffected" is vacuous because no catalog exists. | `src/components/character/CharacterPreviewModal.tsx`; `src/App.tsx:41-60` | **D-H11** ("Browse" opens or focuses the sidebar list); the S2 checklist drops the catalog item. |
| K11 | Implied: a user can get back to the hero | Nothing calls `characterStore.clearSelection()`. After a user selects a character there is no UI path back to the no-selection state, so the hero would only appear on a cold load. | `grep clearSelection() src` → tests only | **D-S6** adds a Home control. |
| K12 | Drawer "focus trapped using focus-trap library" | No focus-trap dependency exists, and this repo **commits `node_modules`**, so adding a dependency has outsized churn. The shared `Modal` also lacks `role="dialog"`, `aria-modal` and focus containment. | `package.json`; `src/components/ui/Modal.tsx` | **D-G5**: an in-repo `inert`-based trap, built in S2 (first consumer) and reused by S3. |
| K13 | Drawer at `z-50`, right panels at `z-40` | Today the drawer, the Settings/Guides/Works panels and BottomSheet **all** sit at `z-50` with `z-40` scrims. | `Sidebar.tsx:299-307`, `SettingsPanel.tsx:103-111`, etc. | **D-S14** moves the drawer to z 1000 (A1), above the z 50 panels, and adds a mutual-exclusion rule. |
| K14 | Speaker tracking can use the current speaker | `chatStore.currentSpeakerName` is **name**-keyed, and names are not unique within a roster. Group-chat identity is positional and fragile (#458 parked, ggbc-backend#84). | `src/stores/chatStore.ts:527` | **D-C7** keys only by `characterAvatar`. |
| K15 | Carousel `aria-label="Auto-advance: on/off"`; "pauses on hover OR focus" | The WAI-ARIA APG carousel pattern says keyboard focus *stops* rotation until the user restarts it (hover only *pauses*), and the rotation button's label names the action. | APG Carousel pattern | **D-H14, D-H15** follow APG. |
| K16 | `<nav aria-label="Main navigation">` | Screen readers read that as "Main navigation navigation". | — | **D-S15** uses `aria-label="Main"`. |

### 0.2 Open confirmations for Sammy (each has a default; silence = default)

| ID | Question | Default this spec uses |
|---|---|---|
| **Q1** | VN mode exists (K2). Should VN mode suppress the 1/3 avatar panel? | **Yes.** VN wins and the panel is not rendered (D-C9). |
| **Q2** | Avatar panel side. The 2026-09 epic notes said the avatar takes "1/3 of left side"; the E6-S1 brief says right. | **LEFT.** Layout is `avatar 1/3 │ chat 2/3`, with no sidebar column (A1; D-C1). |
| **Q3** | "user's Character" in the Personal section: the **persona** (the character the user plays as), or something else? | **Persona.** The PersonaSelector moves into Personal (D-S9). |
| **Q4** | Light mode `--color-text-secondary` on `--color-bg-secondary` measures **4.40:1** (below AA 4.5:1) for the five non-cyberpunk presets, and 3.81:1 on `bg-tertiary`. The sidebar uses that pair for small text, so "axe clean" (epic criterion) cannot pass without a fix. | **APPLY.** S3 changes light `textSecondary` from `#71717a` to `#52525b` for purple/blue/green/red/amber (also `textQuote`), raising the pair to 7.03:1 on `bg-secondary` (D-T4). This is an app-wide visual change in light mode. |
| **Q5** | The hero carousel purpose: sort by recent chats or curate featured characters + announcements? | **Featured characters + announcements.** The hero is a storefront, not a recently-used list. Slides are: curated featured characters (from admin config or a backend-determined list) and product announcements. The featured list is populated by S2 backend endpoint; new users see the same featured carousel as everyone (D-H4, D-H9). |
| **Q6** | S2 now needs a small backend endpoint (K1). Accept the scope addition, which takes S2 from M to roughly M+? | **Accept.** It is the only way to honor "most recently used". |

---

### 0.3 Amendment A1 (2026-10-10): drawer sidebar and category rows

Sammy's direction, from reference screenshots of a streaming home page (a hero followed by Netflix-style horizontal category rows) and a hidden menu drawer that slides over a dimmed page at the highest z-index.

- **The sidebar is a hidden drawer at every width.** It has no expanded or rail state. Superseded: the D-G2 sidebar column, D-G7 `stm:sidebar-expanded`, D-S1 widths, D-S2, D-S3 and D-S4 (rewritten), the D-S5 sequencing rule, D-S10's breakpoint, D-S11 (removed), D-S12's reset rule, the D-S14 rail rule, D-S15, D-S17, and §3.4.
- **The hero is followed by category rows** (D-H21). Superseded: D-H4's slide mix, D-H11's Start row, D-H2's order, and D-H7's ≥640px portrait card (now full-bleed art with left-aligned text).
- **The chat has no sidebar column.** The avatar panel takes the left third of the full viewport and the chat takes the right two thirds. Superseded: D-C1's order, D-C10, and the §5.2 widths.
- **Confirmed by Sammy (2026-10-11):** the drawer z-index is 1000, the top app layer (Modal stays at 100, panels at 50). Toast and Onboarding are raised to 1100 and 1200 so they stay above the drawer.
- **Reference imagery:** only the layout pattern is in scope. Third-party branding, copy and imagery are not.
- **Data source confirmed (2026-10-11):** "New this week" (D-H21) uses `create_date`, a non-null server-default timestamp on the character row. It is set once at creation and does not change on edits (the backend's `last_modified` does change, so it is not used). The frontend already reads it (`src/api/client.ts:251`).
- **Approved:** the 22 v2 frames in §7 were approved by Sammy on 2026-10-11.

---

## 1. Overview

### 1.1 Surfaces and story mapping

| Surface | Story | Blast radius | Summary |
|---|---|---|---|
| Hero carousel | E6-S2 | Low: the ChatView no-selection branch only | Replaces the "Select a Character" empty state with a featured hero carousel, followed by category rows (D-H21) |
| Sidebar | E6-S3 | **High**: the app shell, every route | Converts the existing `Sidebar.tsx` into a hidden drawer at every width (My Characters / Works / Personal), and moves account items out of the header |
| Desktop chat layout | E6-S4 | Medium: ChatView at ≥1024px | Adds a 1/3 full-bleed avatar panel left of a 2/3 chat, with no sidebar column; mobile is unchanged |

Order is fixed: **S2 → S3 → S4** (roadmap). Each story must leave `main` releasable on its own; see the sequencing note in D-C10.

### 1.2 Global decisions

- **D-G1 Breakpoints.** These are the Tailwind v4 defaults (no custom `@theme` breakpoints exist): `sm` 640, `md` 768, **`lg` 1024**, **`xl` 1280**, `2xl` 1536. The two layout-critical ones are `lg` and `xl`. `useIsMobile()` already means `< 1024` (`src/hooks/useIsMobile.ts`).
- **D-G2 Responsive matrix.**

  | Viewport width | Sidebar | Chat | Hero layout |
  |---|---|---|---|
  | < 640 | Drawer (overlay) | Single column + existing mobile portrait panel | Stacked: full-bleed image, text overlaid at the bottom |
  | 640–1023 | Drawer (overlay) | Single column + existing mobile portrait panel | Full-bleed image, text left-aligned |
  | 1024–1279 | Drawer (overlay), closed by default | 1/3 avatar + 2/3 chat | Full-bleed image, text left-aligned |
  | ≥ 1280 | Drawer (overlay), closed by default | 1/3 avatar + 2/3 chat | Full-bleed image, text left-aligned |

- **D-G3 No horizontal scroll** at any width ≥ 320 CSS px (WCAG 1.4.10 Reflow). This is verified at 320, 375, 768, 1024, 1279, 1280 and 1920.
- **D-G4 WCAG 2.2 AA** is the bar for all new and restructured UI. The criteria with specific obligations here: 1.4.3 / 1.4.11 contrast, 1.4.10 reflow, 1.4.13 content on hover (tooltips), 2.1.1 keyboard, 2.2.2 pause/stop/hide (carousel **and** looping Live Portrait video), 2.4.3 focus order, 2.4.7 focus visible, **2.4.11 focus not obscured** (sticky header and overlays), **2.5.7 dragging movements** (portrait framing), **2.5.8 target size ≥ 24×24**, 3.2.6 consistent help (Help stays in the header), 4.1.2 name/role/value.
- **D-G5 Focus containment without a dependency.** S2 adds `src/hooks/useModalFocus.ts`. While a modal surface is open it (a) sets the `inert` attribute on every sibling of the surface's portal root (React 19 supports `inert`); (b) moves focus to the surface's first focusable element, or to an element marked `data-autofocus`; (c) on close, restores focus to the element that opened the surface; (d) closes on Escape. S2 applies it to the shared `Modal` and also adds `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at the title `h2`. This affects every existing modal, which is intended: they all gain correct semantics. S3 reuses the hook for the drawer. **No new npm dependency.**
- **D-G6 Reduced motion** is read through a shared `usePrefersReducedMotion()` hook (added in S2; `matchMedia('(prefers-reduced-motion: reduce)')` with a change listener) and through Tailwind `motion-reduce:` variants for CSS. JS-driven behavior (auto-rotation, Live Portrait selection) must use the hook, not CSS alone.
- **D-G7 Storage keys** use the existing `stm:` namespace (as in `stm:theme-mode`). They are device-level layout preferences: `localStorage` only, **not** server-synced and **not** user-scoped. Every read and write is wrapped in try/catch with the default used on failure (the pattern in `themePreferences.ts`).

  | Key | Type | Default | Owner |
  |---|---|---|---|
  | `stm:sidebar-sections` | JSON `{characters, groups, works, personal}` booleans | `{true, false, true, true}` | S3 |
  | `stm:chat-avatar-panel-expanded` | `"true"` \| `"false"` | `"true"` | S4 |

  Hero rotation state is deliberately **not** stored; it resets on every page load.

- **D-G8 No new theme tokens** (see D-T2). Fixed, non-themed scrim values are defined once in `:root` next to the status colors.

---

## 2. Hero carousel (E6-S2)

### 2.1 Placement

- **D-H1** The hero renders **in place of** ChatView's no-selection branch: `if (!selectedCharacter && !isGroupChatMode)` at `ChatView.tsx:1211`. That branch is reachable at `/` (index) and at `/chat/:characterId` (ChatView ignores params; the route is only navigated to by STscript). The hero therefore appears wherever that branch renders, and nowhere else. It spans the full viewport width (A1: there is no sidebar column at any width).
- **D-H2** Layout of the no-selection page, top to bottom: **hero** → **category rows** (D-H21). The page scrolls vertically inside `<main>` (`overflow-y-auto` on the hero page wrapper; `<main>` is `overflow-hidden` today).
- Height: `height: clamp(300px, 45dvh, 440px)` at ≥ 640px; `clamp(320px, 58dvh, 460px)` below 640px.

### 2.2 Content and data

- **D-H3 Recency endpoint (feeds the D-H21 row and the D-S7 sort).** S2 adds a backend route on the **existing** chats router, next to `/chats/list`: `POST /chats/recency`, body `{ "limit": int (1–500, default 5) }`, response `[{ "character_avatar": str, "last_chat_at": datetime }]`. It returns the caller's own chats, one row per character, `max(updated_at)` per character, ordered descending (to honor "most recently used" per Q6). Because it lives on an existing router prefix, no nginx/vite registration is needed (the registration rule applies to new bare-prefix routers only). Requirements:
  - **Solo chats only.** Group chat rows are keyed by roster slot 0's avatar (positional identity; #458 / ggbc-backend#84) and must **not** count toward slot 0's recency. If the backend cannot tell a group row from a solo row, S2 **stops and raises it** instead of guessing.
  - The client joins the rows against `characterStore.characters` by avatar and **drops** any avatar the user can no longer see (deleted or unshared).
  - Backend tests cover: ordering, de-duplication per character, owner scoping (another user's chats never appear), group exclusion, and the limit bounds.
  - **Note (A1):** The endpoint feeds the "Pick up where you left off" row (D-H21) and the sidebar's "Recent chat" sort (D-S7). It does not feed the hero, which uses the featured list (Q5).
- **D-H4 Hero slides (A1).** The hero carries at most 5 slides, drawn from enabled featured-character entries and enabled feature or announcement entries (D-H6), in configured order. Rotation and controls per D-H12–D-H17 are unchanged. The hero no longer mixes in recent characters: recency feeds the "Pick up where you left off" row (D-H21).
- **D-H5 Character slide content (featured carousel).**
  - Image: `/blobs/character/<avatar>` (the existing blob URL).
  - Name: `h3`, text-xl or 2xl, 1 line, truncated.
  - Creator: "by {creator}" when `creator` or `data.creator` is non-empty.
  - Blurb: the **first sentence of `creator_notes`** as plain text (reuse `firstSentence` / `htmlToPlainText`), clamped to 2 lines. **Never** `description`. That field is model-facing prompt text; this follows `CharacterPreviewModal`'s documented rule.
  - Primary CTA **"Chat"** calls `selectCharacter(avatar)`. Secondary CTA **"About"** opens `CharacterPreviewModal`, whose own "Start chat" also selects.
- **D-H6 Feature slide config** lives in a static file, `public/hero/feature-slides.json`, fetched at runtime. Editing it needs **no TSX change**, only a deploy of the static asset. Schema (v1):

  ```json
  {
    "version": 1,
    "slides": [
      {
        "id": "selfie-mode",
        "enabled": true,
        "title": "Take a selfie with your character",
        "body": "One or two sentences, plain text, ≤ 160 chars.",
        "image": "/hero/selfie-mode.webp",
        "imageAlt": "",
        "requires": "character:create",
        "cta": {
          "label": "Learn more",
          "modal": { "kind": "feature", "heading": "Selfie mode", "image": "/hero/selfie-mode.webp", "bodyMarkdown": "…" }
        }
      }
    ]
  }
  ```

  - `cta.modal.kind` is `"feature"` (opens the new `FeatureInfoModal`) or `"character"` with `"avatar": "<file>.png"` (opens `CharacterPreviewModal` for that character). A `character` slide whose avatar is not in the user's `characterStore.characters` is **dropped**.
  - `requires` is an optional permission string checked with `can(role, …)` / `hasPermission(user, …)`; the slide is dropped when the check fails.
  - `imageAlt`: `""` when the image is decorative (usual); otherwise a description.
  - Validation: any entry missing `id`, `title`, `body`, `image` or `cta` is skipped with one `console.warn`. A failed fetch, invalid JSON, or an unknown `version` yields **zero feature slides** and never blocks or errors the hero.
  - `FeatureInfoModal` is built on `Modal` (size `lg`): heading, optional image, body rendered with the existing `MarkdownDoc`. The config is first-party static content, so it is not sanitized beyond what `MarkdownDoc` does. **Never** load slide config from user-writable storage.
- **D-H7 Character slide visual layout.**
  - **≥ 640px (A1):** full-bleed art (the same avatar with `object-fit: cover`, unblurred, decorative: `alt=""`, `aria-hidden`) under `--scrim-hero-side`. The text block is left-aligned, vertically centered, max-width 620px. The 2:3 portrait card is removed.
  - **< 640px:** no foreground card. The background avatar is **unblurred**, `object-fit: cover`, `object-position: 50% 0%` (faces are usually at the top). A bottom scrim carries the text, which is overlaid at the bottom with 16px padding.
  - Feature slides use the same frames with `image` in place of the avatar.
- **D-H8 Image loading.** The first two slides load eagerly; the rest use `loading="lazy"`. On image error the slide stays and shows a placeholder: a `--color-bg-tertiary` fill with the character's initial in `--color-text-primary`, 64px.
- **D-H9 New user / empty featured carousel.** When the featured-character list is empty or the user has no permission to see any, no carousel and no controls. The region renders one static welcome panel: heading "Start a new conversation", body "Pick a character to chat with, or create your own.", and a **Browse characters** button (D-H11). No feature slides.
- **D-H10 One slide total** (e.g. one featured character and no announcements): render it statically, with no rotation, no prev/next and no indicator.
- **D-H11 Browse (A1).** The **Browse characters** button (the D-H9 welcome panel and the hero's secondary action) opens the drawer and focuses `#character-search` at every width. The Start row is removed; the category rows (D-H21) replace it. S2 ships it against today's sidebar; S3 makes the drawer the only sidebar.

- **D-H21 Category rows (A1).** Below the hero, rows of cards. Each row has an `<h3>` heading and a "See all ›" button that opens the drawer with My Characters focused. Rows render in this fixed order. A row with no visible items is **omitted**, never shown empty:
  1. **Pick up where you left off:** solo chats by D-H3 recency, up to 20, 2:3 cards.
  2. **Featured characters:** the featured list (Q5), 2:3 cards.
  3. **New this week:** visible characters whose `create_date` is within the last 7 days, 2:3 cards. Uses `create_date`, not `last_modified` (confirmed 2026-10-11).
  4. **Works** (only with `project:view` and at least one work): 16:9 cards.
  - **Card:** image (`/blobs/character/<avatar>`), title on one line, and a small caps tag (CHARACTER / WORK / NEW). Activating a card opens `CharacterPreviewModal` (or the Works panel for a work); its "Start chat" selects.
  - **Scrolling:** native horizontal scroll with `scroll-snap-type: x mandatory`. Scroll buttons, "Scroll {row} left" and "Scroll {row} right", are real buttons, visible from 640px on hover or focus. Below 640px the row is swipe-only. Keyboard users Tab through the cards, and focusing an offscreen card scrolls it into view.
  - Rows do not rotate and do not pause. Images beyond the first 6 per row are `loading="lazy"`. Under reduced motion, scrolling is instant.
  - Each row is a `<section aria-labelledby>`. Cards are `<button>`s, never `div`s with handlers.
### 2.3 Behavior

- **D-H12 Rotation timing.** 6000 ms per slide. The timer resets on any manual navigation. Rotation wraps from the last slide to the first.
- **D-H13 Transition.** Cross-fade on opacity, 300 ms `ease-out`. **No zoom or Ken Burns** (vestibular risk). With reduced motion the transition is 0 ms.
- **D-H14 Rotation stops and pauses** (APG semantics; K15):
  - **Hover** over the hero region *pauses*. Rotation resumes on mouse leave unless it is stopped.
  - **Keyboard focus** entering any element in the hero *stops* rotation. It stays stopped until the user activates the rotation button.
  - The **rotation button** toggles stopped and rotating.
  - Rotation also *pauses* while `document.hidden` is true, while any modal opened from the hero is open, and while the Settings, Guides or Works panel is open (`useSettingsPanelStore`, `useGuidesPanelStore`, `useProjectStore` open flags).
  - **Reduced motion:** rotation starts *stopped*. The user may press play to opt in; transitions stay at 0 ms.
- **D-H15 Controls**, in DOM and focus order: **rotation button** (first, per APG) → **Previous** → **Next** → **slide indicator buttons**. Then come the slide's own CTAs.
  - The controls sit bottom-right on ≥ 640px and top-right below 640px, so they never overlap the text block. Hit targets are 40×40 (≥ 24×24 per 2.5.8).
  - Indicator: one button per slide. The visual is an 8px dot inside a 24×24 target. The active dot is 24px wide. A visually hidden "n of m" is also exposed through the slide label (D-H17).
- **D-H16 Keyboard.**
  - **Tab / Shift+Tab** move through the controls, then the visible slide's CTAs. Hidden slides are `inert` and contribute no tab stops.
  - **Enter / Space** activate the focused button.
  - **ArrowLeft / ArrowRight** go to the previous/next slide while focus is on Previous, Next or any indicator button. When focus is on an indicator, focus moves to the new active indicator. Arrows are **not** captured inside slide content.
  - **Home / End** go to the first/last slide while focus is on an indicator.
- **D-H16a Touch swipe** is in S2 scope. A horizontal swipe on the slide area with |Δx| > 50px and |Δx| > |Δy| (the same thresholds as `useSwipeSidebar`) goes to the previous or next slide and resets the timer. **Touches that start within 30px of the viewport's left edge are ignored**, so the drawer's edge-swipe (`EDGE_ZONE = 30`) always wins.

### 2.4 A11y contract (WAI-ARIA APG Carousel, "basic" variant)

- **D-H17** Markup:

  ```html
  <section aria-roledescription="carousel" aria-label="Featured characters and updates">
    <div class="controls">
      <button aria-label="Stop slide rotation | Start slide rotation">…</button>
      <button aria-label="Previous slide" aria-controls="hero-slides">…</button>
      <button aria-label="Next slide" aria-controls="hero-slides">…</button>
      <button aria-label="Go to slide 2: Ivy" aria-current="true|undefined">…</button> …
    </div>
    <div id="hero-slides" aria-live="off | polite">
      <div role="group" aria-roledescription="slide" aria-label="2 of 7: Ivy">…</div>
      <div role="group" aria-roledescription="slide" aria-label="3 of 7: Selfie mode" inert>…</div>
    </div>
  </section>
  ```

  - `aria-live="off"` while rotating; `"polite"` while stopped or paused, so manual navigation is announced.
  - The rotation button's label names the **action** ("Stop slide rotation" or "Start slide rotation"). Its icon swaps between pause and play.
  - Every non-active slide carries `inert` (not only `aria-hidden`), so its CTAs are neither focusable nor announced.
  - The static welcome panel (D-H9) and the single-slide case (D-H10) are a plain `<section aria-label="Welcome">` with no roledescription, controls or live region.
- **D-H18 WCAG 2.2.2** is met because rotation exceeds 5 s, starts automatically, and can be stopped through a mechanism that is the first focusable element.
- **D-H19 Focus visibility.** All hero controls use a 2px `#ffffff` outline with a 2px offset, plus a 2px `#000` outer ring, so the indicator is visible on any image (≥ 3:1 against both light and dark backgrounds).

### 2.5 Hero colors (fixed, not themed)

- **D-H20** Text over imagery uses **fixed** colors, never theme tokens. Custom themes and several presets make themed text over photos unreadable (§6.3 measurements). Defined in `:root` next to the status colors:

  ```css
  --scrim-hero: linear-gradient(to top, rgb(0 0 0 / .80) 0%, rgb(0 0 0 / .55) 45%, rgb(0 0 0 / 0) 75%);
  --scrim-hero-side: linear-gradient(to right, rgb(0 0 0 / .80) 0%, rgb(0 0 0 / .55) 55%, rgb(0 0 0 / .25) 100%); /* ≥640 full-bleed layout (A1) */
  --on-scrim-text: #ffffff;
  --on-scrim-text-muted: rgb(255 255 255 / .85);
  ```

  - **Guarantee:** all hero text sits where scrim alpha is ≥ 0.55. Worst case is white text over a pure-white image under 55% black, which composites to `#737373` and gives **4.74:1** (AA for all text sizes).
  - The primary CTA "Chat" / "Learn more" is a solid `#ffffff` background with `#111111` text (18.9:1); hover is `#e5e5e5`.
  - The secondary CTA "About" is transparent with a 1px `rgb(255 255 255 / .8)` border and `#ffffff` text; hover is `rgb(255 255 255 / .12)` fill.
  - Control buttons are `rgb(0 0 0 / .5)` fill with a `#ffffff` icon; hover is `rgb(0 0 0 / .7)`.
  - Indicator dots: active `#ffffff`, inactive `rgb(255 255 255 / .6)`.
  - The hero looks the same in light and dark mode. Theme tokens apply only to the category rows and the welcome panel: `--color-bg-secondary` card, `--color-text-primary` heading, `--color-text-secondary` body (≥ 14px), and a primary button.

---

## 3. Sidebar (E6-S3)

### 3.1 Structure

- **D-S1 Anatomy** (top to bottom, all widths):
  1. **Top bar** (h-14): Home button (logo; D-S6) · close button.
  2. **Current-chat card** (only when a chat is open; D-S5).
  3. **Sections scroller** (`flex-1 overflow-y-auto`): **My Characters** (search, filters, sort, drafts, list, and a nested **Group chats** subsection) → **Works** (only with `project:view`).
  4. **Personal** section: pinned at the bottom of the drawer.

  Width: **320px** drawer (A1; replaces the 288px expanded column and the 72px rail).
- **D-S2 Drawer at every width (A1).** The sidebar is a hidden drawer at every width and is closed on load. There is no expanded or rail state, and no sidebar open state persists. `stm:sidebar-expanded` is removed.
- **D-S3 No layout shift on load.** The drawer is closed in the first render at every width, so the content column spans the full viewport from first paint. A unit test asserts that the first committed render has no open drawer and a full-width content column at 1100px and 1400px.
- **D-S4 Drawer transition** is the existing 200 ms `ease-in-out` `translate-x` slide, with the scrim fading over the same duration. Both are disabled under reduced motion.

### 3.2 Current-chat card (header modes)

- **D-S5 Modes.** These replace today's whole-sidebar view swap (portrait view ↔ list view). The **sections are always visible**, so "Switch character" and "Back to character" are removed.

  | Mode | When | Content |
  |---|---|---|
  | `none` | No chat open (the hero is showing) | No card |
  | `single` | `selectedCharacter && !isGroupChatMode` | Always compact (A1) |
  | `group` | `isGroupChatMode` | "Group chat" label + group title (or member names) · member thumbnails (28px, **stable roster order**, last speaker ringed with `--color-primary` and given `aria-current="true"`) · the text "Last to speak: {name}" |

  **`single` card (A1):** always **compact** at every width: a 40px avatar, the name, the `MotionModePicker` in a 32px popover button, and an "About" button that opens `CharacterPreviewModal`. The portrait lives in the chat panel (D-C), so the drawer never shows a second one. The expanded-portrait path is removed.

  Stable member order in `group` mode is a deliberate deviation from the brief's "most recent speakers at top". Reordering on every turn breaks muscle memory and focus position; recency is shown by the ring and the "Last to speak" text instead.
  The brief's "list mode with a character select dropdown" is **not built**: the always-visible My Characters list replaces it with more capability (search, filters).
- **D-S6 Home control.** The logo in the top bar is a button labelled "Home". Activating it calls `exitGroupChat()` if `isGroupChatMode`, then `clearSelection()`, then `navigate('/')`. ChatView then renders the hero.
  - It is **disabled** (`aria-disabled="true"`, tooltip "Wait for the reply to finish") while a generation is streaming, so a reply cannot land in a chat the user has navigated away from.
  - **Required test:** Home → re-select the previous solo character → send a message, and confirm it saves to the original chat file. Do the same for a group chat. This guards the group-identity hazard in #458.

### 3.3 Section inventory

- **D-S7 My Characters** (`<h2>` toggle, persisted `sections.characters`, default expanded). It contains **everything the current list view has**, moved without behavior change unless noted:
  - search (`#character-search`), favorites filter, tag filter chips, sort select, clear filters;
  - pull-to-refresh;
  - the list (avatar, name, first-sentence teaser, up to 3 tags + "+N");
  - per-row About (preview) and Favorite buttons;
  - group-select mode (the "Start group chat" toggle, checkboxes, and the "Start Group Chat (n/2+)" footer);
  - the drafts strip ("Resume interview", "Resume draft", Discard);
  - **Import** and **New** buttons, now icon+label buttons in the section header row (only with `character:create`).

  The section label is "My Characters" (decision 4). **Its content does not change**: it lists every character the user can see today. An owned-only filter is out of scope.

  Sorting:
  - Options stay "Name", "Recently added" and "Recent chat". **"Recent chat" switches to the D-H3 endpoint's data** (call it with `limit: 500`, cache for the session, refresh on chat save). Characters with no chats sort after those that have chats, by name. This fixes K1 for the sidebar too.
  - Favorites still bubble to the top.
  - Sort and filter state stays **session-only** (the default `sortMode` remains `'name'`).

  **Group chats** subsection: nested under My Characters, `<h3>` toggle, persisted `sections.groups`, default collapsed (today's behavior). It renders only when `groupChats.length > 0`.
- **D-S8 Works** (`<h2>` toggle, persisted `sections.works`, **default expanded**; today it is collapsed and not persisted). It renders only with `project:view`. The content is unchanged: work rows open the Works panel, and "New work" / "Start your first work" appears with `project:manage`.
- **D-S9 Personal** (`<h2>` toggle, persisted `sections.personal`, default expanded). Items in this exact order:
  1. **Profile**: `navigate('/profile')`.
  2. **Persona**: the existing `PersonaSelector`, rendered in a sidebar variant: a full-width row showing the active persona's name, which opens the existing selector or manager UI (Q3).
  3. **Settings**: `useSettingsPanelStore.getState().open()` when the user has `settings:view`. Otherwise **My API Keys** → `openToPage('my-keys')` when the user has `settings:personal`. The permission split is copied exactly from `Header.tsx:148-170`.
  4. **Install app**: only when `usePwaInstall().canInstall`.
  5. **Logout**: `authStore.logout()`, separated from the items above by a top border.

  Items 1–4 that open a right-side panel or navigate also **close the drawer first** (D-S14).
- **D-S10 Header after S3:**
  - Left: the menu button (all widths), then the character identity (avatar + name + edit pencil with `character:edit`), unchanged, or the logo when nothing is selected.
  - Right: **Guides** (unchanged gate: `character:edit`) and **Help**. Nothing else.
  - The `sm` kebab overflow menu is **removed**, because two icons fit at 320px.
  - Install, Persona, Settings / My API Keys, Profile and Logout **move to Personal** (D-S9).
  - Help stays in the same place on every screen (WCAG 3.2.6).

### 3.4 States

| Element | Drawer (all widths, A1) |
|---|---|
| Top bar | Home logo + "Close menu" button |
| Current-chat card | Compact (D-S5) |
| My Characters | Full section, scrolls |
| Group chats | Nested subsection |
| Works | Full section |
| Personal | Pinned bottom: persona row, Settings/Keys, Install?, Logout |
| Scrim | `fixed inset-0 bg-black/50 z-[999]`; a click closes |

- **D-S11 Removed (A1).** The rail and its tooltips are gone. Drawer rows show their labels as text, so no tooltip (WCAG 1.4.13) applies.

### 3.5 Behavior

- **D-S12 Drawer (all widths, A1).**
  - Opened by the header menu button (`aria-expanded`, `aria-controls="app-drawer"`) or the existing edge-swipe (`useSwipeSidebar`: 30px edge zone, 50px threshold; unchanged).
  - Closed by the close button, a scrim click, a left swipe, **Escape**, or selecting any item that navigates, selects a character or opens a panel.
  - When open, focus is contained with `useModalFocus` (D-G5); the `<main>` column and header are `inert`.
  - On close, focus returns to the menu button.
- **D-S13 Keyboard in My Characters.**
  - Every row's primary button, About and Favorite remain in Tab order (as today).
  - **ArrowUp / ArrowDown** additionally move focus between rows' primary buttons; **Home / End** go to the first and last rows. This is an accelerator only; Tab order is unchanged.
  - Section toggles respond to Enter and Space.

  S3 must also fix these pre-existing defects in markup it rewrites:
  - The About and Favorite buttons are `opacity-0` until hover on hover-capable devices, so they are invisible when keyboard-focused. Add `focus-visible:opacity-100` and `group-focus-within:opacity-100` (WCAG 2.4.7).
  - Favorite has only `title`. Add `aria-label="Favorite {name}"` and `aria-pressed`.
  - The favorites filter button and the sort `<select>` rely on `title` / hidden text below `sm`. Add `aria-label` (and `aria-pressed` on the toggle).
  - Group chat **Delete is a `<button>` nested inside a `<button>`** (`Sidebar.tsx:885-905`), which is invalid HTML and unreachable by keyboard in some browsers. Make the two siblings in a row container.
- **D-S14 Layering and mutual exclusion.**

  | Layer | z-index | Source |
  |---|---|---|
  | Header (sticky) | 20 | `Header.tsx` |
  | Right-panel scrims | 40 | unchanged |
  | Settings, Guides, Works panels / BottomSheet | 50 | unchanged |
  | Modal | 100 | `Modal.tsx` |
  | Drawer scrim | 999 | new (A1) |
  | Drawer | 1000 | new (A1): the top app layer |
  | Toast | 1100 | `Toast.tsx`, raised from 200 so toasts stay above the drawer (A1) |
  | Onboarding | 1200 | `OnboardingWalkthrough.tsx`, raised from 110 (A1) |

  **Rule:** the drawer and a right panel are never open together. Any drawer item that opens a right panel calls the drawer's close function first. `useSwipeSidebar`'s `onOpen` is a no-op while any right panel is open (it checks the three panel stores). With that rule, the drawer (z 1000) never has to compete with a right panel (z 50). The drawer is always an overlay (A1); there is no normal-flow sidebar.

### 3.6 A11y contract

- **D-S15** Markup:
  - `<div id="app-drawer" role="dialog" aria-modal="true" aria-label="Menu">` wrapping `<nav aria-label="Main">`, present at every width and `hidden` while closed (A1).
- **D-S16** Section toggles: `<h2><button aria-expanded="true|false" aria-controls="sidebar-sec-<id>">My Characters</button></h2>`. The controlled region has `id="sidebar-sec-<id>"` and is **removed from the accessibility tree** when collapsed (`hidden`), not just height-0. The Group chats subsection uses the same pattern with `<h3>`.
- **D-S17** Close button: `aria-label="Close menu"`, `aria-expanded="true"`, `aria-controls="app-drawer"` (A1).
- **D-S18** Active character row: `aria-current="true"` plus `font-semibold` **plus** the existing tinted background and left bar. Color is never the only cue (see the §6.3 measurements for `--color-primary` against backgrounds).
- **D-S19** Targets: every interactive element ≥ 24×24 CSS px (list rows ≥ 44px tall).
- **D-S20** Focus not obscured (2.4.11): when an item scrolls into view through focus, the pinned Personal block and the sticky top bar must not cover it. Use `scroll-padding-bottom` on the scroller equal to the Personal block's height (`scroll-margin` on items as a fallback).

---

## 4. Avatar sources (shared by S3's card and S4's panel)

- **D-C5 Source resolution** reuses `resolveMotionMode(mode, hasLivePortraitClips, hasExpressionSprites)` exactly:
  - The per-character mode comes from `useMotionModeStore.modesByAvatar[avatar] ?? 'auto'`.
  - `auto` → `liveportrait` if clips exist (`useLivePortraitDiscovery`), else `expressions` if sprites exist (`useCharacterSprites`), else `none`.
  - Explicit `liveportrait` or `expressions` without assets → `none`.
  - `none` means the **static avatar** (`/blobs/character/<avatar>`).

  Rendering:
  - `liveportrait`: `<LivePortraitVideo clips emotion={latestEmotion} fill shape="square">`.
  - `expressions`: the sprite for `latestEmotion` through `getSpritePath`, falling back to the default avatar on a 404, with the failed key remembered (the existing `failedExpressions` logic).
  - Static: the default avatar.
  - No image at all: a placeholder, `--color-bg-tertiary` with the initial.
- **D-C6 Reduced motion and Live Portrait** (WCAG 2.2.2: a looping autoplay video is moving content > 5 s):
  - Under reduced motion, `auto` **skips Live Portrait** and resolves to `expressions`, then `none`.
  - An explicit `liveportrait` mode still plays, because the user opted in.
  - **At every motion setting**, whenever Live Portrait is playing, the panel shows a **Pause animation / Play animation** button. S4 adds a `paused` prop to `LivePortraitVideo` that pauses the active `<video>` elements and leaves the current frame visible.

---

## 5. Desktop chat layout (E6-S4)

### 5.1 Anatomy

- **D-C1 Order (A1):** `avatar panel (1fr) │ chat (2fr)`, with no sidebar column (Q2). The avatar panel is **full-bleed**: no padding, no border radius, and a 1px `--color-border` right border separating it from the chat. Its height is the full `<main>` height (100dvh minus the 56px header).
- **D-C2 When the panel renders.** All of the following must be true: viewport ≥ 1024, a chat is open (solo or group), `vnMode === false` (D-C9), the panel is expanded (`stm:chat-avatar-panel-expanded`), and the container rule holds (D-C3). Otherwise the chat takes the full main width.
- **D-C3 Container rule.** `<main>` is a size container (`@container/main`). The split applies only when the main column is ≥ **600px** (equivalently, chat ≥ 400px). With the widths in §5.2 this always holds at ≥ 1024. It is a **guard** against page zoom and future sidebar widths, not an expected path. Implement it with Tailwind v4 container variants (`@min-[600px]/main:`).
- Below 1024, the chat is **unchanged**: the existing mobile portrait panel (`lg:hidden`, resize handle, collapse, drag framing) stays, and mobile landscape still hides it (`isMobileLandscape`). Tablets in landscape at ≥ 1024 (e.g. 1180×820) get the split.

### 5.2 Width table (authoritative)

`main = viewport` (A1: there is no sidebar column; the drawer overlays); `avatar = floor(main / 3)`; `chat = main − avatar`.

| Viewport | Sidebar | Main | Avatar | Chat |
|---|---|---|---|---|
| 1024 | drawer (overlay) | 1024 | 341 | 683 |
| 1279 | drawer (overlay) | 1279 | 426 | 853 |
| 1440 | drawer (overlay) | 1440 | 480 | 960 |
| 1920 | drawer (overlay) | 1920 | 640 | 1280 |

The user's chat-width preference (`getChatMaxWidth()`, 60–100%) keeps applying **within** the chat column.

### 5.3 Panel content

- **D-C4 Image fit.** The image uses `object-fit: cover` with `object-position` taken from the **desktop** framing values (D-C8). It never stretches; aspect is preserved by `cover`. Live Portrait uses `fill`, so it gets the same cover behavior. On a speaker change, the image cross-fades over 200 ms (0 ms under reduced motion).
- **Panel toolbar** (top-right, always visible rather than hover-revealed, so touch and keyboard users can find it): `rgb(0 0 0 / .5)` fill, `#fff` icons, 32×32 buttons. In order:
  1. **Motion mode** (the `MotionModePicker` in a popover; it moves here from the sidebar card).
  2. **Adjust framing**.
  3. **Pause/Play animation** (only while Live Portrait plays; D-C6).
  4. **Hide portrait**.
- **Bottom overlay** on `--scrim-hero` (fixed colors, D-H20): the emotion chip when the resolved mode is `expressions` and an emotion exists. In group mode it shows the thumbnail strip (D-C7) instead.
- **Collapse:** "Hide portrait" sets `stm:chat-avatar-panel-expanded=false`. A **"Show portrait"** button then appears in the existing desktop chat header bar (`ChatView.tsx:1656`) with `aria-expanded="false"` and `aria-controls="chat-avatar-panel"`.
- **D-C7 Group chats.**
  - **Focus target**, resolved in this order: the avatar of the in-flight streaming message, **if that message carries `characterAvatar`**. S4 verifies this; if it does not, the step is skipped. **Never** resolve by `currentSpeakerName` (K14). Then the last non-user, non-system message's `characterAvatar`. Then roster slot 0. This generalizes `Sidebar.tsx:282-291` and `recentSpeakers` at `ChatView.tsx:874`.
  - The focused character's own motion mode is used (D-C5 with that avatar).
  - **Thumbnails:** a bottom strip of 48px circular buttons for **all** members in **stable roster order**. The focused member has a 2px `#fff` ring and `aria-pressed="true"`. The strip scrolls horizontally if it overflows, and the panel itself never scrolls.
  - **Manual focus:** activating a thumbnail pins that member. The pin holds until the next AI message is appended, after which auto-follow resumes.
  - Reads only. The panel must never write to or derive chat identity (#458).
- **D-C8 Framing.**
  - Desktop framing is stored **separately** from mobile. A tall, narrow desktop panel crops the sides, while the wide, short mobile panel crops top and bottom, so the same `object-position` would frame different regions.
  - Add `desktopPositionsByAvatar` to `portraitPositionStore`. Bump the persist `version` from 1 to 2 with a `migrate` that keeps `positionsByAvatar` intact. The default is `{x: 50, y: 0}`.
  - **No width resize** on desktop: the 1/3 ratio is fixed. The mobile height resize (`mobilePortraitHeight`) is untouched.
  - **"Adjust framing"** toggles a framing mode:
    - pointer drag repositions;
    - **arrow keys** move by 5% (Shift+arrow by 1%);
    - a **Reset framing** button restores the default;
    - **Enter or Escape** exits the mode.

    The buttons and keys satisfy WCAG 2.5.7, which requires an alternative to dragging. While the mode is active the panel shows "Drag or use arrow keys to reposition" in `--on-scrim-text`.
- **D-C9 VN mode precedence (Q1).** When `vnMode` is true, the panel does not render, the chat is full width, and VN's background and sprite layers behave exactly as today.
- **D-C10 Sequencing with S3 (A1).** The drawer card is compact at every width (D-S5), so S3 and S4 can merge in either order without a double portrait.

### 5.4 A11y contract

- **D-C11** The panel is **meaningful**, not decorative: `<aside id="chat-avatar-panel" aria-label="{name} portrait">`.
  - Image: `alt="{name}"`. In expressions mode, the visible emotion chip is plain text and is **not** in a live region (emotion changes are not announced, because chat messages already are).
  - The `LivePortraitVideo` element is `aria-hidden="true"`; the aside label carries the meaning.
  - In group mode: `aria-label="Group portrait: {focused name}"`.
- **D-C12** Thumbnails: `<ul aria-label="Group members">` of `<button aria-label="Show {name}" aria-pressed>`, with roving tabindex. One Tab stop enters the strip; ArrowLeft/ArrowRight move; Home/End; Enter/Space pins.
- **D-C13** Toolbar buttons have explicit `aria-label`s. "Adjust framing" uses `aria-pressed`. Every target is ≥ 24×24.
- **D-C14** Reduced motion: no cross-fade, Live Portrait per D-C6, no animated framing.

---

## 6. Theme tokens and styling

### 6.1 Tokens that exist (use only these)

- **D-T2** These come from `ThemeColors` → CSS variables set by `applyTheme()`. **E6 adds no new themed token.** A new token would have to be added to `ThemeColors`, all 12 preset entries, and the custom-theme editor, which is out of scope.

| Token | Use on E6 surfaces |
|---|---|
| `--color-bg-primary` | `<main>` / chat background, hero page background |
| `--color-bg-secondary` | Drawer, header, welcome panel card, category-row card background |
| `--color-bg-tertiary` | Row hover, tooltip background, image placeholders, chips |
| `--color-text-primary` | Names, headings, Personal labels, tooltip text |
| `--color-text-secondary` | Teasers, counts, icons, section toggles at rest (see D-T4) |
| `--color-primary` | Active-row bar and tint, focused-member ring in the sidebar card, primary buttons, focus rings on themed surfaces. **Never small text** (D-T3) |
| `--color-primary-hover` | Hover state of primary buttons |
| `--color-border` | Dividers, drawer edge, avatar panel right edge. **Decorative only** (1.27–1.67:1; nothing may rely on it for identification) |
| `--color-accent` | Alias of primary; not used by E6 |
| `--color-warning` / `-error` / `-success` | Fixed status colors; not used by E6 except the Logout hover may use `--color-error` |

The brief's "secondary", "border-light" and "cyberpunk variants" map onto these: **cyberpunk is just a preset that supplies different values for the same tokens. No cyberpunk-specific CSS rules are allowed.**

Fixed (non-themed) values: `--scrim-hero`, `--scrim-hero-side`, `--on-scrim-text`, `--on-scrim-text-muted` (D-H20).

### 6.2 QA theme matrix

- **D-T1** Every surface is checked in **light and dark** × **cyberpunk** (the default preset) **and** at least one non-cyberpunk preset (**amber** in light mode, which is the lowest-contrast combination, plus **purple** in dark). `auto` mode is covered by light and dark. Custom themes are **not** guaranteed: users own their contrast.

### 6.3 Measured contrast (WCAG ratios, from `themePreferences.ts` values)

| Pair | Dark (all non-cyberpunk) | Dark cyberpunk | Light (non-cyberpunk) | Light cyberpunk |
|---|---|---|---|---|
| text-primary / bg-secondary | 17.40 | 15.50 | 16.12 | 15.79 |
| text-secondary / bg-secondary | 6.79 | 6.13 | **4.40** | 7.39 |
| text-secondary / bg-tertiary | 5.90 | 5.65 | **3.81** | 6.41 |
| primary / bg-secondary | 4.11 (purple) – 8.10 (amber) | 5.59 | **2.90** (amber) – 5.18 (purple) | 3.99 |
| white / primary (white text on primary buttons) | **2.15** (amber) – 4.23 (purple) | **3.34** | 3.19 (amber) – 5.70 | 4.71 |
| border / bg-secondary | 1.67 | 1.27 | 1.34 | 1.50 |

Bold = fails AA for normal text (or fails 3:1 for non-text).

- **D-T3** On E6 surfaces, `--color-primary` is **never** used for text below 18.66px bold / 24px regular. Interactive states that use primary must also carry a non-color cue (weight, `aria-current`, an icon). White text on `--color-primary` cannot be guaranteed AA (it measures 2.15–5.70 across presets), so **E6 surfaces introduce no new primary-filled text buttons.** Where a primary action is needed on a themed surface (the category rows, the welcome panel), E6 reuses `<Button variant="primary">` unchanged. Its contrast failures in some presets are pre-existing: E6 does not make them worse and does not fix them, and they are excluded from the "axe 0 violations" checks only for that existing component, with each exclusion noted in the QA report.
- **D-T4 (Q4)** S3 changes light-mode `textSecondary` (and `textQuote`) from `#71717a` to `#52525b` for purple, blue, green, red and amber. That lifts text-secondary/bg-secondary to ≥ 6.5 and text-secondary/bg-tertiary to ≥ 5.5. Cyberpunk light already passes and is unchanged. Without this change the "axe clean" epic criterion cannot be met on the sidebar.

### 6.4 Motion tokens

| Token (code constant) | Value | Reduced motion |
|---|---|---|
| Hero slide duration | 6000 ms | Rotation starts stopped |
| Hero cross-fade | 300 ms ease-out | 0 ms |
| Drawer slide and scrim fade | 200 ms ease-in-out | 0 ms |
| Avatar speaker cross-fade | 200 ms | 0 ms |
| Tooltip hover delay | 300 ms (focus: 0 ms) | unchanged |

### 6.5 Typography

The type scale is unchanged: system font stack and Tailwind sizes.
- Hero: slide title `text-2xl font-bold` (≥ 640) / `text-xl` (< 640); creator `text-sm`; blurb `text-base`; CTAs `text-sm font-semibold`.
- Sidebar: section toggles `text-xs font-semibold uppercase tracking-wide`; rows `text-sm` / `text-xs`, as today.
- No hero text is smaller than 14px.

---

## 7. Mockup frame inventory (v2 approved 2026-10-11; v1 superseded by A1)

Sammy approves each frame. A frame is approved when it matches the decisions cited, or when the approval note explicitly overrides one by ID.

**A1 v2 approval set (2026-10-11): 22 frames, on the Fable canvas** https://claude.ai/artifact/Jwd5kYiVQCanN9Gpn2FEY3. The v1 table below is superseded (expanded/rail sidebar).

| # | Frame (canvas file) | Width | Theme | Decisions shown |
|---|---|---|---|---|
| H1 | V2-Home | 1440 | dark · cyberpunk | D-H1, D-H4, D-H21 |
| H2 | V2-Hero-feature | 1440 | dark · cyberpunk | D-H4, D-H6, D-H7 |
| H3 | V2-Home-light | 1280 | light · amber | D-H20, D-H21, token tints |
| H4 | V2-Home-1024 | 1024 | dark · purple | D-H1, D-S3 (drawer closed) |
| H5 | V2-Home-mobile | 375 | dark · cyberpunk | D-H7 (< 640), control placement |
| H6 | V2-Home-mobile-light | 375 | light · cyberpunk | D-H7, D-H20 |
| H7 | V2-Welcome | 1280 | dark · cyberpunk | D-H9, D-H11 |
| H8 | V2-Keyboard | 1280 | dark · cyberpunk | D-H14, D-H17, D-H19, D-G5 |
| S1 | V2-Drawer | 1440 | dark · cyberpunk | D-S1, D-S2, D-S12, D-S14 |
| S2 | V2-Drawer-single | 1440 | dark · cyberpunk | D-S5 (compact card) |
| S3 | V2-Drawer-group | 1440 | dark · purple | D-S5 group |
| S4 | V2-Drawer-focus-1024 | 1024 | dark · cyberpunk | D-S12, D-S13 |
| S5 | V2-Drawer-mobile | 375 | dark · cyberpunk | D-S12 scrim, compact card |
| S6 | V2-Header | 320 / 1280 | dark · cyberpunk | D-S10 |
| S7 | V2-Drawer-light | 1280 | light · amber | D-S13, D-S18, D-T4 |
| C1 | V2-Chat | 1440 | dark · cyberpunk | D-C1, D-C4, D-C6 |
| C2 | V2-Chat-1024 | 1024 | dark · purple | §5.2 row 1024 |
| C3 | V2-Chat-group | 1440 | dark · cyberpunk | D-C7, D-C12 |
| C4 | V2-Chat-hidden | 1280 | dark · cyberpunk | D-C2 collapse |
| C5 | V2-Chat-framing | 1280 | dark · cyberpunk | D-C8 |
| C6 | V2-Chat-1920-light | 1920 | light · cyberpunk | §5.2 row 1920 |
| C7 | V2-Mobile-reference | 375 / 812×375 | dark · cyberpunk | D-G2, §5.1 |

Frames use placeholder art and copy, and placeholder token values approximate the presets.

**Approved by Sammy, 2026-10-11:** all 22 frames above, as the approval set for this spec. No decision overrides.

| # | Frame | Width | Theme | Decisions shown |
|---|---|---|---|---|
| H1 | Hero, character slide, rotating | 1440 | dark · cyberpunk | D-H4, H5, H7, H15, H20 |
| H2 | Hero, feature slide | 1440 | dark · cyberpunk | D-H6, H7 |
| H3 | Hero, character slide | 1280 | light · amber | D-H20 (theme-independent), Start row tokens |
| H4 | Hero, rail sidebar | 1024 | dark · purple | D-H1 width, D-H15 |
| H5 | Hero, character slide, stacked | 375 | dark · cyberpunk | D-H7 (< 640), control placement |
| H6 | Hero, feature slide, stacked | 375 | light · cyberpunk | D-H7, D-H20 |
| H7 | New-user welcome panel | 375 and 1280 | dark · cyberpunk | D-H9, D-H11 |
| H8 | Keyboard: rotation stopped, focus ring on Next, FeatureInfoModal open | 1280 | dark · cyberpunk | D-H14, H17, H19, D-G5 |
| S1 | Sidebar expanded, no chat open | 1440 | dark · cyberpunk | D-S1, S7, S8, S9 |
| S2 | Sidebar expanded, `single` card (pre-S4 portrait) | 1440 | dark · cyberpunk | D-S5 |
| S3 | Sidebar expanded, `group` card | 1440 | dark · purple | D-S5 group |
| S4 | Rail with tooltip visible on keyboard focus | 1024 | dark · cyberpunk | D-S2, §3.4 rail column, D-S11 |
| S5 | Drawer open with scrim | 375 | dark · cyberpunk | D-S12, compact card |
| S6 | Header after S3 at 320 and 1280 | 320 / 1280 | dark · cyberpunk | D-S10 |
| S7 | Sidebar expanded, focus states and active row | 1280 | light · amber | D-S13, S18, D-T4 |
| C1 | Solo chat split, Live Portrait, pause button | 1280 | dark · cyberpunk | D-C1, C4, C6 |
| C2 | Solo chat split with rail | 1024 | dark · purple | §5.2 rows 1–2 |
| C3 | Group chat, focused speaker + thumbnail strip | 1440 | dark · cyberpunk | D-C7, C12 |
| C4 | Panel hidden, "Show portrait" in the chat header | 1280 | dark · cyberpunk | D-C2 collapse |
| C5 | Framing mode active | 1280 | dark · cyberpunk | D-C8 |
| C6 | Wide desktop | 1920 | light · cyberpunk | §5.2 last row |
| C7 | Mobile reference (unchanged): portrait + landscape | 375 / 812×375 | dark · cyberpunk | D-G2, §5.1 |

Counts (v1): hero 8, sidebar 7, chat 7 → **22**. Counts (v2, approved): hero 8, sidebar 7, chat 7 → **22**.

---

## 8. Implementation acceptance checklists

Each story copies its block into its brief and PR body and ticks items with evidence (a test name, a screenshot frame ID, or a QA note). "Verified" means checked on the final branch state, not inferred from the diff.

### E6-S2 — Hero

- [ ] Backend: `POST /chats/recency` per D-H3. Tests cover ordering, per-character dedup, owner scoping, group-row exclusion and limit bounds. If group rows are indistinguishable, the story stopped and raised it.
- [ ] Hero replaces the no-selection branch only (D-H1); a selected solo or group chat never shows it.
- [ ] Hero slides per D-H4 (at most 5, featured and feature/announcement entries). Category rows per D-H21: "Pick up where you left off" from D-H3 joined and filtered against `characterStore`; rows with no visible items are omitted; cards open `CharacterPreviewModal`. "New this week" stops and raises if no creation timestamp exists.
- [ ] Character slide shows the `creator_notes` first sentence, never `description` (D-H5). "Chat" selects; "About" opens `CharacterPreviewModal`.
- [ ] `public/hero/feature-slides.json` is loaded per the D-H6 schema. Invalid entries are skipped with a warning; a failed fetch gives zero feature slides without an error; the `requires` permission is honored; a `character` slide for an invisible avatar is dropped.
- [ ] `FeatureInfoModal` is built on `Modal` + `MarkdownDoc`.
- [ ] Layout per D-H7 at 375, 640, 1024 and 1440; heights per D-H2; images per D-H8 (lazy loading, error placeholder).
- [ ] Empty featured list and no recency → static welcome panel, no carousel, no controls (D-H9). Exactly one slide → static (D-H10).
- [ ] Browse per D-H11 against the current sidebar, as S2 specified before A1. Category rows scroll and omit empty rows per D-H21.
- [ ] Rotation 6000 ms, cross-fade 300 ms, wraps, timer resets on manual navigation (D-H12, H13).
- [ ] Hover pauses and resumes; keyboard focus stops until play is pressed; pauses while hidden or while a modal or right panel is open; reduced motion starts stopped (D-H14). Each has a unit test with fake timers.
- [ ] Control order and labels per D-H15 and D-H17; inactive slides are `inert`; `aria-live` is off while rotating and polite otherwise.
- [ ] Keyboard per D-H16 (arrows only on controls; Home/End on indicators).
- [ ] Swipe per D-H16a, ignoring the 30px left edge; the drawer edge-swipe still works on top of the hero.
- [ ] Fixed scrim and on-scrim colors per D-H20; contrast spot-checked over a pure-white test image (≥ 4.5:1).
- [ ] `useModalFocus` (D-G5) added. `Modal` gains `role="dialog"`, `aria-modal`, `aria-labelledby`, focus containment and focus restore. The existing modal tests still pass, and one new test asserts focus returns to the opener.
- [ ] `usePrefersReducedMotion` added (D-G6).
- [ ] No new npm dependency.
- [ ] Theme matrix per D-T1. axe reports 0 violations on the hero region in each matrix cell.
- [ ] Reflow: no horizontal scroll at 320 / 375 / 1024 / 1280 (D-G3).
- [ ] Frames match the approved v2 set (A1, §7).

### E6-S3 — Sidebar

- [ ] Anatomy per D-S1. Every capability in the D-S7 inventory still works (walk the list: search, favorites, tags, sort, clear, pull-to-refresh, About, Favorite, group-select + start, group chats load/delete, drafts resume/discard, Import, New → interview → simple-form escape, Works open/new, motion picker, creator-notes "Show more").
- [ ] "Recent chat" sort uses D-H3 data; characters without chats sort after, by name.
- [ ] Drawer at every width per D-S2 and the §3.4 table (A1). `stm:sidebar-expanded` is removed; a unit test asserts the drawer is closed on load regardless of stored state.
- [ ] No layout shift: first-render test per D-S3 at 1100 and 1400 (drawer closed, full-width content).
- [ ] Section toggles per D-S16, persisted in `stm:sidebar-sections` with the D-G7 defaults; collapsed regions are `hidden`.
- [ ] Current-chat card modes per D-S5: compact at every width (A1).
- [ ] Home per D-S6: disabled while streaming, plus the round-trip tests for solo **and** group chats (message saves to the original chat file).
- [ ] Personal items and order per D-S9, with the Settings / My API Keys permission split copied exactly; Install is conditional.
- [ ] Header reduced per D-S10; kebab removed; fits at 320 with no overflow.
- [ ] Drawer per D-S12: `role="dialog"`, Escape, scrim click, swipe, focus contained via `useModalFocus`, focus returns to the menu button.
- [ ] Keyboard per D-S13, including all four pre-existing defect fixes (focus-visible opacity, Favorite label/pressed, filter/sort labels, nested-button fix).
- [ ] Layering and mutual exclusion per D-S14: opening Settings from the drawer closes the drawer; edge-swipe is ignored while a right panel is open.
- [ ] Landmarks and labels per D-S15, D-S17, D-S18; targets per D-S19; focus not obscured per D-S20.
- [ ] Rail and tooltips removed (D-S11, A1); no tooltip test.
- [ ] D-T4 palette change applied (or Q4 answered otherwise and recorded here).
- [ ] D-H11 Browse opens the drawer at every width (A1).
- [ ] Theme matrix per D-T1. axe reports 0 violations on the sidebar and header in each cell.
- [ ] **Route sweep:** `/`, `/chat/:characterId` (via STscript `/go`), `/guides`, `/guides/:slug` (contributor+), `/profile`, `/login`, `/register`, `/forgot-password`, `/invite/:token`, an unknown path (redirects to `/`). Check each with the drawer open and closed where `MainLayout` applies. Also open each right panel (Settings, Guides, Works) and Help with the drawer closed.
- [ ] Frames S1–S7 match.

### E6-S4 — Desktop chat layout

- [ ] Order and sizing per D-C1; widths match the §5.2 table at 1024, 1279, 1440 and 1920, within ±1px (A1: no sidebar column).
- [ ] Render conditions per D-C2; container guard per D-C3 (test by forcing a main width of 590px).
- [ ] Source resolution per D-C5, including explicit-mode-without-assets → static.
- [ ] Reduced motion + Live Portrait per D-C6. The `paused` prop on `LivePortraitVideo` is added. A Pause/Play button exists whenever Live Portrait plays.
- [ ] Image fit per D-C4: no distortion at any table width, with portrait, square and landscape test avatars.
- [ ] Toolbar order and labels per §5.3; the MotionModePicker has moved into the panel.
- [ ] Collapse/expand persisted (`stm:chat-avatar-panel-expanded`); "Show portrait" in the chat header with `aria-expanded`.
- [ ] Group focus per D-C7: streaming message avatar (if carried) → last speaker → slot 0; never by name; manual pin until the next AI message; stable roster order.
- [ ] Framing per D-C8: separate desktop positions, store migration v1→v2 keeps mobile values (unit test), keyboard arrows (5% / 1%), Reset, Enter/Escape exit.
- [ ] VN precedence per D-C9.
- [ ] Expanded-portrait path removed in S3 (D-S5); the drawer shows no portrait, so S4 adds none to it (D-C10).
- [ ] Below 1024 unchanged: mobile portrait panel, resize, collapse and drag; landscape hides it.
- [ ] A11y per D-C11–C14; axe reports 0 violations on the panel in each D-T1 cell.
- [ ] No regression in chat interactions: message edit, swipe left/right (alternate replies), branch UI, regenerate, continue, group-chat turn order, prompt breakdown sheet, Live Portrait discovery, expressions fallback on a 404 sprite.
- [ ] Frames match the approved v2 set (A1, §7).

---

## 9. Resolved decisions (record)

Locked by Sammy on 2026-10-06, as interpreted by this spec:

| Decision | Locked text | Implemented as |
|---|---|---|
| 1 | Hero replaces the ChatView empty state on `/` | D-H1 (the no-selection branch, wherever it renders) |
| 2 | **Featured characters + announcements**, curated list (admin or backend-determined); recency endpoint for sidebar "Recent chat" sort | D-H3/H4; D-H9 (empty featured list); sidebar recency at D-S7 |
| 3 | Feature-slide CTA opens a modal with subject info (character info modal with avatar, tags, creator's notes) | D-H6: `character` kind → `CharacterPreviewModal`; `feature` kind → `FeatureInfoModal` |
| 4 | Personal sidebar: Profile, Logout, Settings, user's Character. Header keeps Guides, Help | D-S9 order (Profile, Persona, Settings, Install?, Logout); D-S10 |
| 5 | Avatar panel: Auto → LP → Expressions → static; group chat focuses the current or most recent speaker with small thumbnails; no VN mode | D-C5 (restated, K3); D-C7; VN exists → D-C9 (Q1) |
| — | Mockup frame count ≈ 22 (hero ≈ 8, sidebar ≈ 7, chat ≈ 7) | §7, exactly 22 (v1; superseded by A1) |
| A1 (2026-10-10) | Sidebar is a hidden drawer at every width (z-index 1000, the top app layer). Hero is followed by category rows | §0.3; D-G2, D-G7, D-S1–S5, D-S10–S12, D-S14, D-S15, D-S17, D-S11 (removed), §3.4, D-C1, D-C10, §5.2, D-H2, D-H4, D-H7 (≥640), D-H11, D-H21 (new), §7, §8. Toast and Onboarding raised to 1100 and 1200 (confirmed 2026-10-11) |

Deviations from the brief's non-locked details, each with its reason in place: D-G5 (no focus-trap dependency), D-G7 (`stm:` key names, one JSON key for sections), D-H13 (no zoom), D-H14/H17 (APG stop-on-focus and action labels), D-S5 (stable member order; no dropdown mode), D-S1 (A1: the rail is removed; the drawer is 320px), D-S8 (Works default expanded, now persisted), D-S15 (`aria-label="Main"`), D-C7 (thumbnails include all members in stable order).
