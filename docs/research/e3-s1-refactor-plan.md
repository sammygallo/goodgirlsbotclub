# E3-S1 task 2 — `resolveEffectiveSettings()` file-level implementation plan and §6 disagreement list

**Provenance:** produced by the built-in Plan agent on 2026-09-25 against the E3-S1 draft spec (`docs/settings-cascade-semantics.md` at `ae641dbd`) and saved verbatim by the PM (the agent runs read-only and cannot write files). The design-level statement of the seam lives in the spec's §6; this file is the file-level plan E3-S3 task 1 starts from. Where the two disagree, the spec wins once the disagreements below are folded into it; this file records what the fold was based on. **Updated 2026-09-25 after red-team round 1 (C1–C13, `scratchpad/research/review-round1-triage.md`):** the chat slot (a `stm_chat_settings` section, not the chat header), the two section shapes (top-level identity keys + reserved `__meta` / `__pending`), the every-apply snapshot heals, the PR4 placement of the `linkedStyleActive` / `pureChatMode` builder-read swap, the pre-marker legacy read path, `local` hydration and the three `authStore` fan-outs below follow the spec's §6 as amended; each is stated once, canonically, in the spec, and this file points at it.

**Ground truth:** frontend worktree `scratchpad/wt/e3-s1` @ `ae641dbd` (docs-only commit on `origin/main` `1e6a555f`; `git diff --stat 1e6a555f HEAD -- src` is empty). Backend `/Users/sammy/Documents/GitHub/ggbc-backend` @ `fb26a80`. Every `file:line` below was read with `grep -n`/`sed -n` on 2026-09-25; symbol names are the stable reference.

## Summary (10 lines)

1. The doc's seam is implementable, but two of its §6 statements cannot be followed as written: `Source = 'card'` inside `plain.prompt` (D1) breaks the builder's precedence chain and the goldens' macro counters, and "provider/model from `getProviderAndModel()`" (D2) forces a side-effect reorder on four of six seams.
2. The migration table is incomplete in a way that ships a regression for wizard users: it replays only one of `restoreDefault`'s two branches (D4).
3. Between E3-S3 task 1 and E3-S4, `ChatStyleModal` and `CharacterEdit`'s Unlink chips would write and read dead legacy keys (D3); task 1 must re-point them.
4. Landing order that keeps every existing gate green: pure resolver → dormant stores → seam wiring with the ChatView effects still running and the `linkedStyleActive` / `pureChatMode` builder reads left on the legacy fields (byte-neutral) → migration + heals + effect deletion + those two swaps.
5. Neutrality gate is real but has an unstated mechanical cost: seven `PINS_ANCHORS` fingerprints in `promptGoldens.fixtures.ts` name `linkedStyleActive`, `genState.prompt.*`, `genState.context` and `wiState.*` verbatim and must be re-fingerprinted (not the fixtures' `pins` strings, which the golden headers render).
6. The goldens harness calls the exported wrapper `buildConversationContext` and `buildGroupConversationContext` directly; both must resolve internally when no snapshot is passed.
7. The chat-level map is a synced section `stm_chat_settings` in its own store (not `chatStore`, not the chat header — spec §6.4); key solo chats by avatar+file and group chats by file only (D10, D11, C1).
8. §6.1 triggers that apply: spread/layering refactor, async store orchestration, user-writable storage. Not: backend contract (task 1), safety gate.
9. Concrete failure modes: first-turn-before-hydration, `loadChat` failure (#530) keyed off `currentChatFile`, clear-then-409 resurrection, old-bundle resurrection of deleted legacy keys after a clear, `getProviderAndModel` ordering.
10. Effort: four task-PRs — S (resolver) · M (stores) · L (seam wiring, prompt-assembly class) · M (migration + effects) — build ≈ L total.

---

## 1 · File-level plan

### 1.1 New modules and exports

| File | Exports | Notes |
|---|---|---|
| `src/utils/settingsCascade.ts` (new) | `resolveEffectiveSettings(ctx: ResolveContext): EffectiveSettings` · `resolveFromInputs(inputs: CascadeInputs): EffectiveSettings` (pure) · types `ResolveContext`, `EffectiveSettings`, `Resolved<T>`, `Applicability`, `Level`, `CustomizationFields`, `GLOBAL_MARKER` · `PROVIDER_DROPPED_TABLE` (dated client mirror of `anthropic.py`/`google.py`) | `resolveEffectiveSettings` reads store snapshots and delegates to the pure `resolveFromInputs`; the precedence table tests run against the pure core with no store. Until `__meta.migration` exists in a scope it reads that scope's legacy link maps as the customization source (spec §6.1, last rule). Must not call `getProviderAndModel` (`src/utils/llm/resolve.ts:17-51` has `setState` at `:36` and a `setContext` bump at `:43-46`). Imports `isChatEligibleForServerRetrieval` (`src/utils/serverRetrieval.ts:102-161`), `modelRejectsSamplers` (`src/api/client.ts:775-786`), `useGenerationStore`, `useWorldInfoStore`, `useSettingsStore`, `useCharacterSettingsStore`, `chatSettingsStore` helpers. Never imported by `src/utils/insights/types.ts` or `wiInsights.ts` (guard: `tools/insightsBoundary.test.ts:304-313`). |
| `src/stores/characterSettingsStore.ts` (new) | `useCharacterSettingsStore`: section value `{ [avatar]: Partial<CustomizationFields> \| null, __meta: { migration: { version, at } } }` (spec §6.4 — avatars are top-level keys, `__meta` reserved, `null` = tombstone); `hydration: 'cold' \| 'local' \| 'server'`; actions `set(avatar, patch)`, `clear(avatar, field)`, `clearAll(avatar)`, `stage(patch)`, `commitStaged(avatar)`, `discardStaged()`, `initForUser(handle)`, `resetUser()`, `fetchPrefs()` | Section `stm_character_settings`; localStorage key `stm:character-settings_<handle>` (prefix `stm:` so `clearAllAppStorage`, `src/utils/serverSettings.ts:209-219`, wipes it on logout; handle-scoped like `chatLoreConfigStore`'s `scopedKey`). Persist pattern = `chatLoreConfigStore`'s three-branch `fetchPrefs` + debounced subscribe PUT (`src/stores/chatLoreConfigStore.ts` `fetchPrefs` at `:607`, module-tail `useChatLoreConfigStore.subscribe`, which PUTs its per-chat-file `configs` map as the section value). The 409 shallow merge is per top-level key (`serverSettings.ts:300`) — the spec's §6.4 says why that dictates the shape. `local` counts as hydrated (spec §6.1). |
| `src/stores/chatSettingsStore.ts` (new; see D11, C1) | `useChatSettingsStore`: section value `{ [key]: Partial<CustomizationFields>, __pending: { [file]: Partial<CustomizationFields> }, __meta }` (spec §6.4); `chatSettingsKey(avatar, file)` → `${avatar}\u0000${file}` solo / `${file}` group (D10); `hydration`; `get(key)`, `set(key, patch)`, `clear(key, field)`, `clearAll(key)`, `rekey(from, to)`, `drop(key)`, `materializePending(key, file)`, `initForUser(handle)`, `resetUser()`, `fetchPrefs()`, `subscribe` | Section `stm_chat_settings`, same persistence pattern and localStorage scoping as `characterSettingsStore`. No import of `chatStore`. **No header hydrate/emit** — the chat header is untouched (spec §6.4). |
| `src/utils/settingsMigration.ts` (new) | `migrateLegacyLinks(): Promise<void>` (one-shot: character rows, the `__pending` snapshot of the three chat maps, both `__meta.migration` markers) · `healSnapshots(): void` (idempotent; run inside `generationStore.fetchPrefs` / `promptTemplateStore.fetchPrefs` on every server-state apply — spec §6.4 "Snapshot heals") | `migrateLegacyLinks` is called from all three `authStore` fan-outs after the four prefs promises (§1.5); lazy materialization is `chatSettingsStore.materializePending`, called from `loadChat` / `loadGroupChat`. |

### 1.2 The `EffectiveSettings` type (as §6.1, with the two corrections that make it implementable)

```ts
type Level = 'global' | 'character' | 'chat';
type Source = Level | 'card';                       // 'card' appears ONLY in the annotated view (D1)
const GLOBAL_MARKER = '__global__' as const;        // chat-level "skip character" (§2.1)
type Customizable<T> = { [K in keyof T]?: T[K] | typeof GLOBAL_MARKER };
interface CustomizationFields {                     // what a level may store
  sampler?: Customizable<SamplerParams>;            // generationStore.ts:14-25
  prompt?: Customizable<Pick<PromptConfig, 'mainPrompt' | 'jailbreakPrompt' | 'postHistoryInstructions'>>;
  context?: Customizable<ContextConfig>;            // generationStore.ts:86-95
  pureChat?: boolean;                               // chat level only
}
type Applicability = { kind: 'applies' } | { kind: 'inert'; reason: ... } | { kind: 'server-fixed'; serverValue: number | 'none'; when: 'predicted' };
interface Resolved<T> { value: T; source: Source; applicability: Applicability }
interface EffectiveSettings {
  sampler, prompt, context, pureChat, wi, engine   // as §6.1
  plain: { sampler: SamplerParams; prompt: PromptConfig; context: ContextConfig; instruct: InstructConfig };
  meta: { characterLevel: 'hydrated' | 'pending'; chatLevel: 'hydrated' | 'pending' | 'none' };   // 'pending' only while the store is cold; 'local' counts as hydrated (spec §6.1, C8)
}
// prompt additionally carries `cardPhiSuppressed: boolean` (spec §6.1, C7)
interface ResolveContext {
  characterAvatar?: string; chatFile?: string | null; chatKind: 'solo' | 'group';
  seam: PromptCaptureSeam | 'preview';               // src/utils/promptCapture.ts:19-25
  provider: string; model: string;                   // from useSettingsStore.getState() — NOT getProviderAndModel() (D2)
  character?: CharacterInfo;                         // for the 'card' annotation only; the builder still subs the card text itself (D1)
}
```

Rules the implementation must keep:
- `plain.prompt.mainPrompt` is the level-resolved customization value (global/character/chat). It never carries card text. `linkedStyleActive` in the builder becomes `eff.prompt.mainPrompt.source === 'character' || === 'chat'`; the card chain at `chatStore.ts:1558-1562` stays as is with `userMainPrompt = sub(eff.plain.prompt.mainPrompt)`.
- Identity: when no customization touches any field of a group, `plain.sampler` **is** `useGenerationStore.getState().sampler` (same for `prompt`, `context`; `instruct` always).
- `plain.prompt.respectCharacterOverride/respectCharacterPHI` are always the global values (§3: G only).
- The `'card'` annotation is for `mainPrompt` only; PHI's `source` is the level of the user value and `cardPhiSuppressed` mirrors the builder's `char_phi` gate (`chatStore.ts:1510-1517`, `:1618-1623`) — spec §2.1 / §6.1 (C7).

### 1.3 Store changes (file · symbol · change)

**`src/stores/generationStore.ts`**
- Keep: `sampler`, `presets`, `activePresetId` (`:222`), `defaultPresetId` (`:229`), `setSampler` with mirroring (`:514-533`), `resetSampler` (`:535-550`), `loadPreset` (`:579-597`), `ensurePreset` (`:733-766`), `PersistedShape` keys unchanged (`:396-409`; the key set is pinned by `src/stores/generationStore.promptCapture.test.ts:186-210`).
- Make read-only legacy (no new writers after PR4): `linkedPresetByAvatar` (`:231`), `linkedPresetByChatFile` (`:234`), `setLinkedPreset` (`:705-717`), `setChatLinkedPreset` (`:719-731`), `savePresetAndLink` (`:677-703`, loses its only caller after the wizard rewrite).
- Remove in PR4: `loadPresetTransient` (`:605-619`), `restoreDefault` (`:621-641`); `samplerSnapshot` (`:242`) stays in state/shape as a legacy field until the follow-up removal story (its persisted key is pinned by the test above). `fetchPrefs` (`:919-978`) runs `healSnapshots` on every server-state apply (spec §6.4, C4).
- `deletePreset` (`:643-675`) keeps pruning legacy link maps (harmless).

**`src/stores/promptTemplateStore.ts`**
- Remove in PR4: `loadTemplateMainPromptTransient` (`:308-329`; the `gen.setPrompt` at `:321` is the server-persisting overwrite), `restoreDefaultMainPrompt` (`:331-343`), and the `mainPromptSnapshot !== null` branch of `ensureTemplate` (`:417-419`) — a third reader the doc does not list (D9). `mainPromptSnapshot` (`:54`, `PersistedShape:124`) stays as a legacy field, healed by `healSnapshots` on every apply in `fetchPrefs` (spec §6.4, C4).
- Legacy read-only: `linkedTemplateByAvatar` (`:41`), `linkedTemplateByChatFile` (`:44`), `chatCompanionModeByChatFile` (`:48`), `setLinkedTemplate` (`:345-360`), `setChatLinkedTemplate` (`:362-378`), `setChatCompanionMode` (`:380-396`), `saveTemplateWithPromptAndLink` (`:244`).

**`src/stores/chatStore.ts`**
- `PreparedConversation` (`:1161-1208`): add `eff: EffectiveSettings` beside `genState` (`:1194`) — `genState` stays for the `setLastTokenEstimate` action (`:2124`, `:2191`). D7.
- `prepareConversationContext` (`:1273`): new trailing optional param `eff?: EffectiveSettings`; when absent, resolve with `seam: 'preview'` (keeps the goldens' wrapper `buildConversationContext` `:1245-1265` and E8-S4's byte-equivalence seam intact). Replace reads **in PR3**: `wiState.scanDepth/maxRecursionSteps/tokenBudget` (`:1382-1384`) → `eff.wi.*.value`; `genState.prompt.*` (`:1507`, `:1511`, `:1516-1518`) → `eff.plain.prompt.*`; `ctxConfig` (`:1641`) → `eff.plain.context`; `promptOrder` (`:1628`) stays `genState.promptOrder`. Replace **in PR4 only** (spec §6.3 / §6.7, C6): `linkedStyleActive` (`:1497-1498`) → `eff.prompt.mainPrompt.source === 'character' || === 'chat'`; `pureChatMode` (`:1503-1505`) → `eff.pureChat.value`.
- `finishConversationContext` (`:2007`): `ctxConfig` (`:2037`) → `prepared.eff.plain.context`. Signature untouched.
- `buildGroupConversationContext` (`:2382-2407`): trailing optional `eff?: EffectiveSettings` after `breakdownOut`; `wiState.*` at `:2518-2520` → `eff.wi.*.value`. Nothing else in the group builder reads a cascade field (R3 §5).
- `loadChat` (`:4877-4899`): after `api.getChatWithHeader` resolves, set a new `loadedChatIdentity: { avatar, file, kind } | null` **on success only** (#530: `currentChatFile` is set before the fetch at `:4878`), then `useChatSettingsStore.getState().materializePending(chatSettingsKey(avatarUrl, fileName), fileName)`. **No header hydrate** (spec §6.4, C1). Same in `loadGroupChat` (`:4901-4922`, kind `'group'`, key = file). `startNewChat`/`startNewGroupChat` set `loadedChatIdentity` when they set `currentChatFile`.
- `buildChatPayload` (`:3659-3734`): **unchanged** — nothing is emitted into the header (spec §6.4).
- `renameChat` (`:5615`): `chatSettingsStore.rekey` beside the `wiFiredByFile` re-key (`:5621-5624`), using the `avatarUrl` param. `deleteChat` (`:5598-5612`): `chatSettingsStore.drop` beside `:5606`.
- New actions: `setChatCustomization(patch)`, `clearChatCustomization(field)`, `clearAllChatCustomization()` — operate on `loadedChatIdentity` and write `stm_chat_settings` only. **No chat-row save**: `saveCurrentChat()` is dropped (spec §6.4 / §9 D7, C2).
- The six seams: see §1.4.

**`src/utils/llm/resolve.ts`**: `getGenerationOptions(plain: Pick<EffectiveSettings['plain'], 'sampler' | 'instruct'>)` (`:54-81`); only callers are the six seams (verified: `chatStore.ts:3397, 5192, 5383, 5543, 5798, 6242`). `getProviderAndModel` untouched.

**`src/utils/serverRetrieval.ts`**: `tryServerRetrieval(characterAvatar, chatFile, tokenBudget: number)` (`:525`); replace the store read at `:558`; `budgetRequested: tokenBudget` (`:620`) keeps its meaning. No test mocks this module's arity (grep: none).

**`src/stores/worldInfoStore.ts`**: no change. The resolver reads `scanDepth/maxRecursionSteps/tokenBudget` (`:1730-1732`; defaults `:263-265`; clamps in setters `:3537-3553`).

**`src/stores/authStore.ts`** (D6, C11): **three** identical prefs fan-outs — `checkAuth` (`:130`; `initForUser` `:136-147`, `fetchPrefs` from `:161`), `register` (`:214`) and `login` (`:288`); every sync store is wired in all three (e.g. `useChatLoreConfigStore.getState().initForUser` at `:146` / `:234` / `:306`, `.fetchPrefs()` at `:186` / `:276` / `:348`). Add `initForUser(handle)` and `fetchPrefs()` for `useCharacterSettingsStore` and `useChatSettingsStore` to each; in each, collect the `[gen, tpl, charSettings, chatSettings].fetchPrefs()` promises and `.then(migrateLegacyLinks)` (spec §6.5).

**Out of task 1 (E3-S2, C9):** `ContextMeter.tsx:30` reads the resolver's `context.maxTokens` (spec §6.5 / §7.7).

**`src/stores/personaStore.ts`, `settingsStore.ts`**: untouched (as doc).

### 1.4 Call-site changes at the six seams, in landing order

Each seam: `const eff = resolveEffectiveSettings({ characterAvatar, chatFile, chatKind, seam, provider: activeProvider, model: activeModel, character })` at the top (before `tryServerRetrieval` where present), then thread it. `activeProvider/activeModel` from `useSettingsStore.getState()` — the same read `prepare` makes at `:1306` and group at `:2424` (D2).

| Seam (`PromptCaptureSeam`) | Function | Today | Change |
|---|---|---|---|
| `send` | `sendMessage` `:5708` | `getProviderAndModel` `:5732` (before build); `tryServerRetrieval` `:5771`; `prepare` `:5779`; probe `:5780`; finish `:5783`; `getGenerationOptions` `:5798`; `generateWithFallback` `:5812` | resolve after `:5762` (`currentChatFile` read); `tryServerRetrieval(avatar, file, eff.wi.tokenBudget.value)`; `prepare(..., serverRetrieval?.matchedEntries, eff)`; `getGenerationOptions(eff.plain)` |
| `impersonate` | `impersonate` `:5479` | `tryServerRetrieval` `:5506`; prepare `:5509`; `getProviderAndModel` `:5542` (after build); options `:5543` | same; `getProviderAndModel` stays at `:5542` (do not hoist) |
| `regenerate` | `editMessageAndRegenerate` `:6174` | `tryServerRetrieval` `:6219`; prepare `:6222`; `getProviderAndModel` `:6238`; options `:6242` | same |
| `swipe` | `swipeRight` `:5096` (also `regenerateMessage`) | prepare `:5170`; `getProviderAndModel` `:5175`; options `:5192` | resolve before `:5170`; no retrieval call |
| `continue` | `continueMessage` `:5315` | prepare `:5354`; `getProviderAndModel` `:5371`; options `:5383` | same |
| `group` | `generateGroupTurn` `:3310` | `getProviderAndModel` `:3325`; builder `:3361`; options `:3397` | resolve with `chatKind: 'group'`, `characterAvatar: character.avatar` (ignored for customizations in v1); pass `eff` as the builder's trailing arg; `getGenerationOptions(eff.plain)` |

`dispatchWithCapture` (`:3617-3653`), `maybeApplyInstructMode` (`:3531-3542`), `isTextCompletionMode` (`:3545-3547`) untouched. The `chatStore.callSites.test.ts` fingerprints (`:403`, `:413`, `:421`, `:429`, `:439`, `:707`) do not include the `prepare(...)` lines, so the added argument does not break them.

**Landing order (four PRs, §5):** (1) resolver module alone; (2) the two new synced stores + chatStore `loadedChatIdentity` / rekey / drop + authStore wiring in all three fan-outs, no readers; (3) seam wiring for `plain.*` and `wi.*` + the `PINS_ANCHORS` entries those touch (1082, 1084, 1205, 1346), ChatView effects still running, `linkedStyleActive` / `pureChatMode` **left on the legacy fields** — with no customization stored anywhere, `plain.*` is identity and the effects' global overwrite still produces today's bytes (spec §6.7's invariant, C6); (4) migration + `healSnapshots` + effect deletion + the two builder-read swaps (`PINS_ANCHORS` 1195, 1209, 1257 and the two legacy-state fixture rewrites move here) + UI re-point + removal of transient actions.

### 1.5 Migration of existing links — one-shot for character level, read-time-then-materialize for chat level

**Decision (as amended by C4/C5/C10/C12 — canonical text in spec §6.4):** one-shot for the avatar maps plus a `__pending[file]` snapshot of the three chat maps (values resolved), gated on both new stores reporting `hydration === 'server'` and gen/tpl having applied server state; lazy materialization from `__pending` on the first `loadChat`/`loadGroupChat` of `(a, f)` (first loader wins; a chat with no pending entry is never written; nothing in the lazy step reads the legacy maps). Idempotent via the `__meta.migration` markers, not via "slot already has content" (D5). The snapshot heals are **not** part of the one-shot: `healSnapshots` runs on every server-state apply (C4). Legacy keys — avatar maps, chat maps, snapshots — are **kept** (C12; rollback, spec §6.7).

| Legacy | Becomes | Notes |
|---|---|---|
| `linkedPresetByAvatar[a] = id` | `stm_character_settings[a].sampler = { ...presets[id].sampler }` | dangling id → nothing written |
| `linkedTemplateByAvatar[a] = id` | `stm_character_settings[a].prompt.mainPrompt = templates[id].prompt.mainPrompt` | same dangling rule |
| `samplerSnapshot !== null` **and** no `defaultPresetId` | `sampler = snapshot; samplerSnapshot = null; activePresetId = null` (`restoreDefault` `:626-632`) | **heal — every apply**, idempotent (C4) |
| `defaultPresetId` set **and** `activePresetId !== defaultPresetId` | `sampler = presets[defaultPresetId].sampler; activePresetId = defaultPresetId` (`restoreDefault` `:637-640`) | **heal — every apply** (D4, C4) |
| `mainPromptSnapshot !== null` | `prompt.mainPrompt = snapshot; mainPromptSnapshot = null` | **heal — every apply** (C4) |
| `linkedPresetByChatFile[f]` / `linkedTemplateByChatFile[f]` / `chatCompanionModeByChatFile[f]` | one-shot: `__pending[f]` = sampler fields (preset values, or all `GLOBAL_MARKER` for `CHAT_STYLE_NONE`, `src/utils/chatStyles.ts:17`), `mainPrompt` (template text or marker), `pureChat: true`; on the first load of `(a, f)`: `materializePending` moves it to the keyed slot and deletes the pending entry; the legacy key is **kept** | `loadGroupChat` included (chat styles are offered in group, `ChatView.tsx:2222`); no chat-row save (C5) |
| marker | `__meta.migration = { version: 1, at }` in both `stm_character_settings` and `stm_chat_settings` | after the marker exists the resolver never reads a legacy map for that scope; before it, the resolver reads them (spec §6.1) |
| Wizard `handleSaveAndLink` (`CharacterSetupWizard.tsx:938-948`: `applyRecommendedSampler` `:941` then `savePresetAndLink` `:945`) | `characterSettingsStore.set(avatar, { sampler: {...rec fields} })`; the global write is removed; "Linked to X" UI keys off `stm_character_settings[avatar].sampler` | `handleApplyGlobal` keeps `setSampler`; `handleSaveAndLinkTemplate` (`:349-357`) → `set(avatar, { prompt: { mainPrompt } })`; "Set on card" unchanged |
| `CharacterEdit` Unlink chips (`:570`, `:599`; selectors `:103-112`) | read `stm_character_settings[avatar]`; Unlink → `clear(avatar, 'sampler')` / `clear(avatar, 'prompt')` | D3 |
| `ChatStyleModal` (`:27-41` reads; `:149`, `:173`, `:199` writers; quick styles `:53-65`; NONE options `:180`, `:206`) | read the chat slot; write `setChatCustomization` (preset/template values copied; NONE → markers) | D3; retired by E3-S4 |
| `ChatView.tsx` selectors `:316-322`, `:667-669`, `chatStyleActive` `:2223` | read the chat slot (`subscribe` from `chatSettingsStore`) | — |
| Card `system_prompt`/PHI | none; builder-side sources | D1 |

### 1.6 Persistence writes/reads

- **Character slot:** `stm_character_settings` = `{ [avatar]: … | null, __meta }` (spec §6.4 — one shape, C3); write = debounced whole-section `patchServerKey` (300 ms, the `chatLoreConfigStore` pattern); read = `fetchPrefs` three-branch (`shouldReuploadSection`, `serverSettings.ts:249-253`). `clearAll(avatar)` writes `[avatar] = null` (tombstone) rather than deleting the key, so the 409 retry's per-key `{...current, ...local}` (`:300`) cannot resurrect it; the resolver treats `null` as "no customization".
- **Chat slot:** `stm_chat_settings` = `{ [key]: …, __pending, __meta }` (spec §6.4, C1/C2/C5); same write/read pattern; `rekey` / `drop` from `renameChat` / `deleteChat`. The chat header and `saveChatToBackend` are not involved; backend unchanged.

### 1.7 Sync-section change and the #536 exposure

- New sections `stm_character_settings` and `stm_chat_settings`: older bundles never PUT them, so a whole-section replace (`app/routers/sync.py:236`) by an older bundle cannot drop their keys. Exposure limited to the tombstone/409 case above.
- `stm_generation` and `stm_prompt_templates` keep every legacy key in `PersistedShape` (`generationStore.ts:396-409`; `promptTemplateStore.ts:115-125`), including the three chat maps (C12). The exposure that remains: an older bundle re-PUTs a legacy link; the markers (§1.5) make that harmless for the link maps — the new bundle ignores them once the marker exists (D5) — and `healSnapshots` on every apply covers the **global** fields an older bundle's template effect keeps dirtying (C4).
- `stm_chat_state` untouched in v1.

### 1.8 The two `ChatView` effects

`ChatView.tsx:833-849` (preset: `loadPresetTransient`/`restoreDefault`) and `:855-871` (template: `loadTemplateMainPromptTransient`/`restoreDefaultMainPrompt`) are deleted in PR4, together with the reactive selectors at `:316-322` that exist only to re-trigger them, and in the same PR the builder's `linkedStyleActive` / `pureChatMode` reads move to the resolver (C6). The template effect's `gen.setPrompt` (`promptTemplateStore.ts:321` → `generationStore.ts:768-774` → `persist` `:429-447`) is the server-persisting overwrite; its deletion is what stops `stm_generation.prompt.mainPrompt` from carrying template text.

---

## 2 · Test plan

| Test | Mechanism | Mutation it must kill |
|---|---|---|
| Golden byte-neutrality (133 files, `promptGoldens.test.ts`) | Harness unchanged: it calls `buildConversationContext` (`:125-126` import; wrapper at `chatStore.ts:1245`) and `buildGroupConversationContext`, which now resolve internally. **Through PR3 no fixture is rewritten**: `pure-chat` (`:1192-1194`, sets `chatCompanionModeByChatFile[GOLDEN_CHAT_FILE] = true`) and `linked-style-active` (`:1232` sets `mainPromptSnapshot`, `:1233-1235` sets global `mainPrompt`) run as they are and must stay byte-identical (C6). **In PR4**: `resetStores` (`promptGoldens.fixtures.ts:257-260`) also clears both new stores; `pure-chat` → `setChatCustomization({ pureChat: true })` for `(IVY.avatar, GOLDEN_CHAT_FILE)`; `linked-style-active` → chat-level `mainPrompt` customization with the same text. `PINS_ANCHORS` re-fingerprinted per PR (PR3: 1082, 1084, 1205, 1346; PR4: 1195, 1209, 1257); the `pins` strings and the golden files do not change; headers render `fx.pins` at `:384`/`:442`. README counts (`:544-545`) unchanged. | Any resolver that changes a byte for a user with no customization; a hoisted `sub()` (macro counters `:673-724`); the PR3 swap of `linkedStyleActive` (C6) |
| Identity | `resolveEffectiveSettings(ctx).plain.sampler` `toBe` store `sampler` (also `prompt`, `context`, `instruct`) with empty stores; the goldens' `resetStores` never sets `sampler`/`instruct` (`:251-256`), so this needs its own unit test | "always spread a fresh object" |
| Precedence table (pure core) | For each field in `CustomizationFields` × {G, C, Ch, Ch=marker}: chat > character > global; marker skips character; card annotation (`mainPrompt` only): `source: 'card'` only when `respectCharacterOverride && card.system_prompt && no customization`; `plain.prompt.mainPrompt` never equals the card text. PHI (C7): with a card PHI and `respectCharacterPHI` on, a character PHI customization → `source: 'character'`, `cardPhiSuppressed: false`, builder emits both `char_phi` and `user_phi`; a character `mainPrompt` customization only → `cardPhiSuppressed: true`, builder's `char_phi` is the style note; the annotated view must agree with `buildConversationContext` for the same inputs | "always return global"; "marker treated as absent"; "card folded into plain"; "PHI reported as a chain" |
| Group = Global + Chat | `chatKind: 'group'` with a character customization present → `source: 'global'`; chat customization → `source: 'chat'` | "group reads character level" |
| Single snapshot per turn | Drive `swipeRight` with a store write injected between `prepare` and the committing `finish` (via a spy on `finishConversationContext`), assert the dispatched prompt equals a run without the write; `prepared.eff` identity across both passes | "finish re-reads the store" |
| Round-trip, character | `set` → `patchServerKey` payload → fresh store `fetchPrefs` from that payload → resolve → same value; `clearAll` → tombstone `null` → resolves global; 409 retry with server copy containing the cleared avatar → still cleared; **two-device 409** (C3): mocked 409 whose `current_data` holds avatar Ivy while local holds only Bob → the retried payload keeps both | "delete key instead of tombstone"; "nest avatars under one key" |
| Round-trip, chat | `setChatCustomization` → `patchServerKey('stm_chat_settings')` payload → fresh `fetchPrefs` → resolve → same value; `renameChat` re-keys it; `deleteChat` drops it; failed `loadChat` leaves `loadedChatIdentity` on the previous chat and the previous chat's settings apply; a group reorder still finds the file-keyed entry; **neither `setChatCustomization` nor `loadChat` calls `api.saveChat`** (C2, C5) | "key off `currentChatFile`"; "save the chat row on write"; "key group by avatar" |
| Migration | Each row of §1.5 → expected slot; second run is a no-op (marker); `CHAT_STYLE_NONE` → all-marker; dangling id → nothing written; after the one-shot, `loadChat` on a chat with no `__pending` entry calls neither `api.saveChat` nor `patchServerKey('stm_generation')` and still resolves global (C5); a chat opened while the stores are cold writes nothing and resolves its legacy link once they hydrate (C10); after materialization the legacy chat key still exists and is ignored while the marker is present (C12) | "re-migrate when slot is empty"; "write `{}` on every load"; "delete the legacy chat key" |
| Heals (C4) | With `__meta.migration` already set, write the old-bundle transient state (`stm_generation.prompt.mainPrompt = 'TEMPLATE'`, `stm_prompt_templates.mainPromptSnapshot = 'MINE'`, a linked `activePresetId` with a `defaultPresetId` present), apply server state → global `mainPrompt` resolves to `'MINE'`, `sampler` / `activePresetId` to the default preset's | "heal once behind the marker"; "skip the defaultPresetId branch" (D4) |
| Hydration (C8) | Seed the localStorage mirror with `[Ivy].sampler.temperature = 0.3`, make `getSettingsBlob` reject → the send seam's `getGenerationOptions` receives 0.3 (`local` is hydrated); a cold store → `meta.characterLevel: 'pending'`, values global, **no** `patchServerKey` call; with `linkedPresetByAvatar` present and no marker → the linked values apply | "treat `local` as pending"; "resolver writes a default customization"; "ignore legacy maps pre-marker" |
| Applicability | `provider-dropped` per family pinned against a dated table; `model-omitted` agrees with `modelRejectsSamplers` for `claude-sonnet-4-7*` and `claude-opus-5-*`; `engine.predicted` agrees with `isChatEligibleForServerRetrieval` for each disqualifier (`serverRetrieval.ts:106-158`) and is `'client'` for seams `swipe`/`continue`, `'n/a'` for group; `wi.scanDepth.applicability.kind === 'server-fixed'` with `serverValue: 4` only when predicted server; `maxRecursionSteps` → `'none'` | "server-fixed reported on swipe"; "predicted server while `sharedBooksStatus !== 'loaded'`" |
| Server-path turn reports server-fixed values | Drive `sendMessage` on an eligible chat with `api.getRetrievalContext` stubbed; `tryServerRetrieval` receives `eff.wi.tokenBudget.value`; `breakdown.wi.server.budgetRequested` equals it (existing `chatStore.wiServerFacts.test.ts` style) | "tryServerRetrieval still reads the store" |
| Seam wiring | Extend `chatStore.callSites.test.ts` rows: `getGenerationOptions` spy receives `eff.plain` (same object as `prepared.eff.plain`) at all six sites | "one seam resolves twice" / "one seam still calls the no-arg form" |
| Persisted key sets | `generationStore.promptCapture.test.ts:186-210` unchanged in this story (keys kept); new equivalents for `stm_character_settings` (avatar keys + `__meta` only) and `stm_chat_settings` (identity keys + `__pending` + `__meta` only) | "resolver output leaks into the persisted shape" |

---

## 3 · Risk list against the §6.1 trigger list (`docs/product-roadmap-10.2-12.md:645`)

| Trigger | Applies? | Why |
|---|---|---|
| Spread/layering refactor | **Yes** | A new resolution layer between stores and builders; identity-vs-spread is the neutrality mechanism; `{ ...state.sampler, ...patch }`-style merges in the new stores. |
| Async store orchestration | **Yes** | Three `fetchPrefs` + a one-shot migration + lazy per-chat migration inside `loadChat` + a header save from a store action. |
| Backend contract | No (task 1) | Header is opaque JSONB; the new section uses the generic `/sync/section` API. E3-S3b (scan depth in `RetrievalContextIn`, `app/schemas/retrieval.py:124`) is the contract story. |
| User-writable storage | **Yes** | New sync section, chat-header field written by the client, handle-scoped localStorage mirror. |
| Safety gate | No | No media/NCII/provenance surface. (A chat-level `jailbreakPrompt` customization changes what is sent but is not a §6.8 gate.) |

Concrete failure modes to design and test against:
1. **First turn while cold.** `authStore` fans out `fetchPrefs` without awaiting; a turn fired before the new stores' mirrors load resolves global. Must be visible (`meta.*: 'pending'`) and must never persist. Once the handle-scoped mirror has loaded (`local`) the level is hydrated and applies whatever the network does (C8); a turn fired before the migration has run applies the legacy links through the transitional read path (spec §6.1).
2. **`loadChat` failure (#530).** `currentChatFile` is set before the fetch (`:4878`); keying the chat slot off it would apply the *new* file's (absent) customizations to the *old* messages. Key off `loadedChatIdentity` set on success only.
3. **Stale resolved object across turns.** Reuse across the two `finish` passes is required; reuse across turns (a module cache, or `regenerateMessage → swipeRight` sharing one) is the bug. Resolve exactly once per seam invocation; a group round resolves once per `generateGroupTurn`, so a mid-round chat edit applies to later speakers — state it.
4. **Sync race with #536.** Older bundles keep re-PUTting legacy links; the migration markers make that inert. `clearAll` on a 409 retry: the per-key `{...current, ...local}` (`serverSettings.ts:300`) resurrects a deleted avatar key — tombstones. The same hole exists today for `stm_chat_lore_configs`; do not copy it. Older bundles also keep re-dirtying the **global** `sampler` / `activePresetId` / `prompt.mainPrompt` through the template effect's `setPrompt → persist` — only the every-apply `healSnapshots` repairs that (C4).
4b. **Rollback** to a pre-PR4 bundle: every legacy key is kept, so the old bundle's effects restore every migrated link; it cannot see customizations made through the new UI (they sit in the new sections until roll-forward), and the heals stop until roll-forward (spec §6.7).
5. **`getProviderAndModel` ordering.** Four seams call it after the build (`:5175`, `:5371`, `:5542`, `:6238`); the resolver must not need it (D2).
6. **Wizard "Save and link".** `CharacterSetupWizard` is only mounted from `CharacterEdit.tsx:869` (an existing avatar), so `stage/commitStaged` serves E7-S2, not this story; the rewrite must also stop `savePresetAndLink` setting `activePresetId` (`generationStore.ts:692`, `:698`), or `setSampler` mirroring keeps rewriting a "linked" preset.
7. **Persisted `activePresetId` = a legacy linked id.** Reachable today via `loadPresetTransient` (`:618`, no persist) followed by any `persist()`; without D4's reset, `ensurePreset` (`:746`) and `setSampler` (`:522-528`) keep mirroring into that preset after the effects are gone.
8. **Group key (#458).** A group's row avatar is roster slot 0 (`loadGroupChat` `:4904`, `buildChatPayload` `:3729-3731`), so an avatar-keyed group entry would miss after a reorder. Key group by file (D10); the row still forks, the customization does not.
9. **Module cycle in tests.** Every chatStore test mocks `./lovenseStore` because of a module-scope subscribe in a cycle (`promptGoldens.test.ts:88-90`); a resolver that imports `chatStore` while `chatStore` imports the resolver adds another (D11).
10. **`ChatStyleModal` in group.** Offered whenever a file is open (`ChatView.tsx:2222`); after re-pointing, a group chat customization must key by file and its template/pure-chat halves stay inert (badge in E3-S2).

---

## 4 · Disagreements with the doc's §6 (and §2/§3 where they bear on implementation)

**D1 — blocking — `Source = 'card'` cannot live in the value the builder consumes.** §6.1 `Resolved.source: Level | 'card'` with `plain.prompt: PromptConfig` "for the builders", §3 "Read by the resolver as character-level *sources*", §6.4 "read as character-level sources". If `plain.prompt.mainPrompt` carries the card text, the builder's chain `(linkedStyleActive && userMainPrompt) || charSystemPromptOverride || userMainPrompt` (`chatStore.ts:1558-1562`) double-applies, and the goldens' macro counters break: `charSysPrompt` must run exactly once even when the card loses (`promptGoldens.fixtures.ts:1043-1044`), and `charPhiSub` must be absent when suppressed (`:1184-1190`); both `sub()` calls (`:1508`, `:1516`) execute in the builder today. **Correction:** `plain.prompt.*` = level-resolved customization only; card fields stay builder-side; `source: 'card'` appears only in the annotated view for display; `linkedStyleActive := prompt.mainPrompt.source ∈ {character, chat}`.

**D2 — blocking — `provider/model` "from `getProviderAndModel()`, passed in" forces a side-effect reorder on four seams.** The resolver must run before `tryServerRetrieval`/`prepare`, but `getProviderAndModel()` runs *after* the build in `swipeRight` (`:5175`), `continueMessage` (`:5371`), `impersonate` (`:5542`), `editMessageAndRegenerate` (`:6238`). Hoisting it moves its `setState` (`resolve.ts:36`) and `setContext({ maxTokens: 32768 })` (`:43-46`) ahead of `prepare`'s reads of `activeProvider` (`:1361`) and `context.maxTokens` (`:1641`, `:2119`) — a byte-visible change on the first turn after an auto-switch. **Correction:** `ResolveContext.provider/model` come from `useSettingsStore.getState()` (what `prepare` reads at `:1306`); keep every `getProviderAndModel()` where it is.

**D3 — blocking — the doc leaves live writers pointed at dead keys between task 1 and E3-S4.** §6.5 makes `linkedPresetByChatFile`/`linkedTemplateByChatFile`/`chatCompanionModeByChatFile` "read-only legacy" and §6.4 deletes a chat's legacy keys after materialization, but `ChatStyleModal` still writes them (`:149`, `:173`, `:199`, quick styles `:53-65`) and reads them for its selects (`:28-29`, `:37`), `ChatView` reads them (`:316-322`, `:667-669`, `:2223`), and `CharacterEdit`'s Unlink chips read/write the avatar maps (`:103-112`, `:570`, `:599`). After task 1 a chat-style pick would be inert and the modal would show "Default" for a customized chat. **Correction:** task 1 re-points these readers/writers to the new slots (small, mechanical), or the resolver keeps reading legacy chat keys at resolve time and nothing is deleted until E3-S4. Recommend re-point.

**D4 — blocking — the migration replays only one of `restoreDefault`'s two branches.** §6.4 row "`samplerSnapshot !== null` and no `defaultPresetId` → `sampler = snapshot`". But `loadPresetTransient` sets `sampler` + `activePresetId` without persisting (`generationStore.ts:618`), and any later `persist()` — the template effect's `setPrompt` (`promptTemplateStore.ts:321` → `generationStore.ts:768-774` → `:429-447`) fires right after it on every styled-chat open — writes the transient sampler and the linked `activePresetId` to `stm_generation`. `restoreDefault` heals that only in memory, via the `defaultPresetId` branch (`:637-640`). Once the effects are deleted, a wizard user with a default preset keeps the linked preset's values as their global sampler and `setSampler` keeps mirroring into the linked preset (`:522-528`). **Correction:** add the row "`defaultPresetId` set and `activePresetId !== defaultPresetId` → `sampler = presets[defaultPresetId].sampler`, `activePresetId = defaultPresetId`", and state that the persisted global `sampler` may already be a linked preset's values.

*(Round-1 resolutions, where the fold changed a D's answer: D5 → the marker is `__meta.migration` in each new section, not a header key (C1); D6 → `local` hydration counts, `pending` only while cold, and all three `authStore` fan-outs are wired (C8, C11); D10 → group keyed by file, now as a section key (C1); D11 → `chatSettingsStore` is a synced section store, not an in-memory map (C1); D12 → withdrawn — no chat-row save exists (C2).)*

**D5 — advisory — "legacy maps stay in `PersistedShape` so an older bundle's whole-section PUT cannot resurrect a migrated link as new" names a mechanism that does not do that.** Keeping the keys only stops the *new* bundle's PUT from dropping them; an older bundle re-PUTs its own local copy regardless (`persist()` `:429-447`; `saveToStorage` merge `promptTemplateStore.ts:168-179`). The "slot already has settings → skip" guard covers it until the user *clears* a migrated customization; then the doc's "legacy keys read as a fallback until removed" re-applies the resurrected link. **Correction:** a `migration` marker in `stm_character_settings` and an always-present header `settings` key (possibly `{}`); once present, never read legacy maps for that scope. Delete the quoted sentence.

**D6 — advisory — "runs once per client after all three stores' `fetchPrefs` resolve" is not a gate as written.** Every `fetchPrefs` swallows errors and resolves (`generationStore.ts:978`; `promptTemplateStore.ts:607-609`; the new store will too), and `authStore` discards the promises (`:160-187`). `getSettingsBlob` is one shared GET (`serverSettings.ts:121-154`), so the real order is "apply order within one tick" plus network failure. **Correction:** gate on the new store's `hydration === 'server'` and on gen/tpl having applied server state; collect the promises in `authStore` (a file §6.5 omits, along with its `initForUser` fan-out `:139-147`); defer on any failure; expose `meta.characterLevel: 'pending'` so E3-S2 can badge honestly.

**D7 — advisory — thread the snapshot through `PreparedConversation`, not through `finish`'s signature.** `PreparedConversation` already carries `genState`, `chatStoreState`, `ctxChatFile` (`:1194-1196`); adding `eff` makes "both finish passes see one snapshot" structural, keeps `finishConversationContext(prepared, ragContext, opts)` (`:2007`) unchanged, and keeps `genState` for `setLastTokenEstimate` (`:2124`, `:2191`).

**D8 — advisory — §6.6 understates what the goldens pin.** (a) The harness calls the exported wrapper `buildConversationContext` (`:1245`) and `buildGroupConversationContext` directly (`promptGoldens.test.ts:125-126`), so both must accept the snapshot optionally and resolve it themselves (seam `'preview'`); E8-S4's byte-equivalence seam is the wrapper. (b) `PINS_ANCHORS` fingerprints `'const linkedStyleActive ='` (1195), `'genState.prompt.respectCharacterPHI && !linkedStyleActive && !pureChatMode'` (1209), `'(linkedStyleActive && userMainPrompt) ||'` (1257), `'const charSystemPromptOverride = genState.prompt.respectCharacterOverride'` (1205), `'const ctxConfig = genState.context;\n  const allNonSystemMessages…'` (1346), `['scanDepth: wiState.scanDepth,', 2]` (1082), `['tokenBudget: wiState.tokenBudget,', 2]` (1084) are asserted by the "every :NNNN anchor" test (`promptGoldens.test.ts:558-640`, occurrence counts included). The refactor must re-fingerprint them; "the expected files are not touched" holds only if the fixtures' `pins` strings (rendered at `:384`/`:442`) are left alone. (c) `src/stores/__goldens__/README.md`'s mutation drill (`:77-116`) should gain the "always return global" and "resolve per read" rows §6.6 names.

**D9 — advisory — "no callers outside those effects and their own stores" misses an in-store reader.** `ensureTemplate` pushes a re-ensured quick-style template's `mainPrompt` into the global store when `mainPromptSnapshot !== null` (`promptTemplateStore.ts:417-419`); the removal list must delete that branch. Also `generationStore.promptCapture.test.ts:186-210` pins the `stm_generation` key set (incl. `samplerSnapshot`, `linkedPreset*`) — consistent with keeping the keys now, but the follow-up removal story must change that test.

**D10 — advisory — the `${avatar}\u0000${file}` key is wrong for group chats.** `loadGroupChat` hydrates under `characterAvatars[0]` (`:4904`); `buildChatPayload` emits under `groupCharacters[0].avatar` (`:3729-3731`). After a reorder (#458) the emit lookup misses and the customization is dropped, not forked. **Correction:** key group chats by file name only (group names are `Group_<names> - <date>@<ms>`, `startNewGroupChat`); solo by avatar+file. Also add `loadGroupChat` to the lazy-migration entry points (chat styles are offered in group, `ChatView.tsx:2222`).

**D11 — advisory — a resolver in `src/utils/settingsCascade.ts` that reads `chatStore.chatSettingsByKey` creates a resolver↔chatStore import cycle** in a graph that already needs `vi.mock('./lovenseStore')` in every chatStore test (`promptGoldens.test.ts:88-90`, `chatStore.callSites.test.ts:92`). **Correction:** hold the chat-level map in `src/stores/chatSettingsStore.ts` (no chatStore import); `chatStore` calls its hydrate/emit/rekey/drop helpers; the resolver imports it. Split the resolver into a pure `resolveFromInputs` plus a store-reading wrapper — §6.1 calls it "pure over store snapshots", which it is not if it reads stores.

**D12 — advisory — "a customization on a chat with no saved row needs a save (`saveChat` exists; E3-S4 triggers it on write)" pushes a store concern into the UI.** `saveChatToBackend` is module-private (`:3965`) and needs `character`/`isGroupChat`/`groupCharacters`; `api.createChat` returns only a name (`client.ts:1730-1734`); `setAuthorNote` (`:4583-4596`) never saves. **Correction:** task 1's `setChatCustomization` performs the save through a store-internal `saveCurrentChat()` that reuses `lastSaveContext`, so E3-S4 and E7-S2 write through one action.

**D13 — advisory — §6.2's group row implies a shape change.** `buildGroupConversationContext` has positional params only (`:2382-2407`) and many direct callers in tests plus the goldens; the only cascade reads are `wiState.*` (`:2518-2520`), none customizable in v1. **Correction:** a trailing optional `eff` after `breakdownOut`; three-line change.

**D14 — advisory — §6.1's prose and type disagree on G-only fields.** The paragraph after the type says `instruct`, `promptOrder`, `showExactPrompt`, provider/model "and every G-only field are returned as `source: 'global'` for display", but `EffectiveSettings` has no slot for them (only `plain.instruct`). **Correction:** either add a `display` bag for them or state that E3-S2 reads G-only fields from the stores directly.

**D15 — advisory — the wizard staging API is speculative in task 1.** `CharacterSetupWizard` is mounted only from `CharacterEdit.tsx:869` with an existing avatar; `stage/commitStaged` serves E7-S2's creation wizard (precedent `InterviewReview.tsx` committing staged lore after `createCharacter` resolves). Fine to include as a thin holder, but §8.1 should say task 1 ships it untested by any caller.

§2 and §3 as they bear on implementation: no further disagreement found. §2.1's "customization > card (respected) > global" is exactly today's order once D1 keeps the card in the builder; §3's G-only classification of `instruct`/`showExactPrompt` is what keeps `dispatchWithCapture` closed; §2.3-A's backend change is correctly excluded from task 1.

---

## 5 · Effort — E3-S3 task 1 as four task-PRs

| PR | Contents | Build size | Review class (roadmap §5 table) |
|---|---|---|---|
| 1 | `settingsCascade.ts` pure core + types + precedence/applicability/identity unit tests; no wiring | **S** | standard (new pure module) — but declare N=4 loops at PLAN |
| 2 | `characterSettingsStore.ts`, `chatSettingsStore.ts` (both synced sections), chatStore `loadedChatIdentity` + rekey/drop, `authStore` wiring in all three fan-outs, round-trip tests incl. the two-device 409; no readers, no chat-row save | **M** | trigger-tier, contained seam (async orchestration, user-writable storage) |
| 3 | Seam wiring (six seams, prepare/finish/group, `getGenerationOptions(plain)`, `tryServerRetrieval` budget arg) for `plain.*` and `wi.*` only — `linkedStyleActive` / `pureChatMode` stay on the legacy fields; `PINS_ANCHORS` 1082/1084/1205/1346; goldens neutrality with the two legacy-state fixtures un-rewritten; single-snapshot and seam-wiring tests; ChatView effects still present | **L** | prompt assembly / frozen layer (4–6 rounds) — this PR touches both builders' reads |
| 4 | One-shot migration with markers + `__pending` snapshot, lazy `materializePending`, `healSnapshots` on every apply, delete the two ChatView effects and the transient actions/snapshot readers, swap `linkedStyleActive` / `pureChatMode` to the resolver (`PINS_ANCHORS` 1195/1209/1257, two fixture rewrites), re-point `ChatStyleModal`/`CharacterEdit`/`CharacterSetupWizard`, migration + heals tests | **M** | trigger-tier, contained seam (2 full rounds realistic: the migration writes four sections; the builder-read swap is byte-pinned by the goldens) |

Total initial build ≈ **L** (0.5–1.5M, §5 size bands), matching the card's L. Verification is priced per loop by class, not by letter.

---

### Critical files for implementation
- `src/stores/chatStore.ts` (prepare/finish/group builders, six seams, header hydrate/emit, rename/delete)
- `src/stores/generationStore.ts` (legacy link maps, transient actions, persist shape, migration source)
- `src/stores/promptTemplateStore.ts` (template transient, `mainPromptSnapshot`, `ensureTemplate` branch, pure-chat map)
- `src/stores/promptGoldens.fixtures.ts` (`resetStores`, the two legacy-state fixtures, `PINS_ANCHORS`)
- `src/components/chat/ChatView.tsx` (the two overwrite effects and their selectors)
