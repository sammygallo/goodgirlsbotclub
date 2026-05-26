# Good Girls Bot Club — FAQ

This is the corpus the in-app support assistant grounds on. Each entry is a
question (`##` heading) followed by the answer. Keep entries focused, concrete,
and pointing at where to find the setting in the UI.

---

## Where do the prompts come from? Do I write the main prompt and jailbreak myself?

The app ships with sensible defaults for the **Main Prompt** and
**Jailbreak / Auxiliary Prompt** — a third-person roleplay style guide and a
permissive system note for adult fiction — so bots behave reasonably out of
the box. **Post-History Instructions** ships blank.

You can edit, replace, or clear any of them. Hit **Reset to Defaults** in
Generation Settings to restore the shipped versions.

**Where:** Settings → Generation Settings.

You can save a full prompt setup as a named template under **Settings → Prompt
Templates** and switch between them per character or scene.

**Note:** character cards can carry their own `system_prompt` and post-history
instructions. By default the app honors those over the user's prompts. Toggle
**Respect character override** / **Respect character PHI** in Generation
Settings to change this.

---

## How does memory work? What's the difference between Auto-Memory, RAG, and Summarize?

The app has three memory mechanisms — they can run together:

1. **Auto-Memory** — every N messages (default 30), the active model extracts
   canonical facts from the chat and appends them to a per-character lorebook
   called "{Character} — Auto Memory". Same retrieval as regular World Info
   (keyword-triggered). Toggle under Settings → Extensions → Auto-Memory.

2. **Chat-History RAG** — embeds your past chat messages and pulls the most
   semantically relevant past turns into context at generation time. Better
   recall than keyword-based World Info. Opt-in. One embedding call per new
   message. Settings → Data Bank.

3. **Summarize** — periodic rolling summary of older chat, injected as a
   system message. More about compression than recall. Settings → Extensions
   → Summarize.

For long-term character memory, Auto-Memory is the simplest. For "the model
forgot something we talked about 200 messages ago", Chat-History RAG is the
right tool.

---

## How do I change AI models? Why don't I see all the models my provider offers?

**Where:** Settings → AI Settings → pick a provider → use the **Model** dropdown.

The dropdown auto-loads the live catalog for these providers (when an API key
is configured): OpenAI, Mistral, Groq, DeepSeek, Cohere, xAI, Moonshot, Google
AI Studio, NanoGPT, Pollinations, AIMLAPI, Electron Hub. **OpenRouter** loads
its full catalog (370+) without needing a key.

These providers still show a curated default list because their backends don't
expose a model catalog yet: Claude, Vertex AI, Perplexity, AI21, 01.AI, Zhipu,
Block Entropy. You can still type a model id elsewhere if you know one.

A small "X models from …" line under the dropdown confirms when you're seeing
the live list.

---

## How do I add an API key?

Settings → AI Settings → pick the provider → enter the key in the
**API Keys** section that appears below the provider grid.

Keys are stored server-side, encrypted at rest. Each user has their own keys
unless an admin enables global sharing for that provider, in which case
everyone uses the shared key.

**For non-admin users:** Settings → My API Keys is the same flow with the
admin-only sections hidden.

---

## How do I import a character card?

Sidebar → **Import** button at the bottom. Accepts PNG character cards
(v2/v3 spec — the open community format used across the character-chat
ecosystem), JSON exports, and Tavern AI cards.

Once imported, the character shows up in the sidebar list. Tap it to start a
chat. To edit the card after import, tap the pencil icon in the header while
the character is selected.

---

## What's the difference between OpenAI, Claude, OpenRouter, and the other providers?

- **OpenAI / Claude / Google Gemini / Mistral / xAI / DeepSeek / etc.** —
  direct connections to that provider's API. You bring your own key.
- **OpenRouter** — one key gets you access to 370+ models from every major
  provider (OpenAI, Anthropic, Google, Meta, etc.). Slight cost markup, but
  much less account juggling.
- **Aggregators (NanoGPT, AIMLAPI, Electron Hub, Pollinations)** — similar to
  OpenRouter, different model selections and pricing.
- **Custom / Local** — point at any OpenAI-compatible endpoint (Ollama, LM
  Studio, vLLM, KoboldCpp, llama.cpp). Useful for self-hosted models.

If you're starting out and want one key for everything, OpenRouter is the
easiest path. If you want the cheapest route for a specific model, go direct.

---

## How do extensions work?

Settings → Extensions. Built-in extensions: Text-to-Speech, Image Generation,
Translation, Summarize, Auto-Memory.

Each extension has its own toggle and settings. Some extensions add slots in
the chat UI (e.g., the message-action menu, the chat-input toolbar) when
enabled.

Server-side extensions (third-party extensions compatible with the
community Extension SDK, like Live2d) are listed at the bottom of the
Extensions page.

---

## What are connection profiles?

A snapshot of "provider + model + sampler settings + custom URL" you can save
under a name and switch between in one click.

**Where:** Settings → AI Settings → **Connection Profiles** section.

Useful for: a "creative writing" profile (high temperature, Claude Opus) vs.
a "tight roleplay" profile (low temp, Mistral Large) vs. a "local cheap"
profile (Ollama running llama3).

---

## How do lorebooks / World Info work?

Lorebooks are keyword-triggered context. When the user's last message (or the
recent chat) contains a key from a lorebook entry, that entry's content is
injected into the prompt before generation.

**Where:** Settings → World Info.

Lorebooks can be:
- **Character-attached** — only active when that character is selected.
- **Chat-attached** — only active in that specific chat.
- **Globally enabled** — active everywhere.

The injection budget is shared with the rest of the prompt context, so very
large lorebooks can push older chat messages out.

---

## Why isn't my character responding?

Most common causes, in order:

1. **No API key configured.** Settings → AI Settings → check that the active
   provider shows a green checkmark. If not, enter a key.

2. **Model name wrong.** Some providers return errors like "model not found"
   — check the active model is one your account has access to.

3. **Character card has a broken `system_prompt`.** Try toggling **Respect
   character override** off in Generation Settings.

4. **Context too large.** The prompt may have exceeded the model's window.
   Check the token budget in Generation Settings.

5. **Provider outage.** Try a different provider via Connection Profiles to
   isolate.

If none of those: the browser console (DevTools → Console) usually has the
exact error from the server.

---

## How do I share characters with other users on the same server?

When viewing or editing a character, look for the **Visibility** toggle:
- **Personal** — only you see it.
- **Global** — every user on the server sees it.

Admins can edit any character's visibility from Settings → Character Management.
