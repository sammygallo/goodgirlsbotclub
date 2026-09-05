# Character Building Guide

A friendly guide to making characters. It explains what each setting does, how it changes the way your character talks and acts, and how to keep things from getting too long (which costs **tokens** — basically the "fuel" the AI burns each message).

## What's a Token

Every word, space, and punctuation mark you write costs **tokens**. The AI reads all your character info every single message you send. So if your character has 2,000 tokens of stuff written in it, you pay that 2,000 every time you say "hi." Short and clear beats long and rambling.

## The Character Card

These are the boxes in the character editor.

### The Big Boxes (Always Sent to the AI)

**Name** — What your character is called. The AI uses this name when it talks. Keep it short.

**Description** — What your character looks like, where they're from, their backstory.
- *How it changes behavior:* This is the AI's main "who am I?" reference. If you write "always angry," the AI will play them angry. If you write three pages of every cousin's name, the AI gets confused and forgets the important stuff.
- *Tip:* Use bullet points instead of paragraphs. Stick to the facts that matter.

**Personality** — How your character talks and acts. Quirks, mood, speech style.
- *How it changes behavior:* This shapes the *voice*. "Speaks in short sentences. Uses sarcasm. Never says sorry." → The AI will write that way.
- *Tip:* Don't repeat stuff from Description here. Keep them different jobs.

**Scenario** — Where the story starts. What's happening right now.
- *How it changes behavior:* Sets up the situation the AI plays out. "You both work at a coffee shop on a slow Tuesday."
- *Tip:* If your First Message already shows the scene, you can leave Scenario empty.

**First Message** — The first thing your character says when a chat starts.
- *How it changes behavior:* This is huge. Whatever style and length you use here, the AI will copy it for the whole chat. Write a 6-paragraph epic? Expect 6-paragraph replies. Write 2 short lines? You'll get short replies back.
- *Tip:* Match the message length to what you want the rest of the chat to feel like.

**Example Messages** — Sample back-and-forth chats showing how your character talks.
- *How it changes behavior:* The AI studies these like a script. It will copy the rhythm, vocabulary, and length of your examples.
- *Tip:* Two great examples beat six okay ones. Show the character at their most "them."

### The Hidden Boxes (Only Sent if You Use Them)

**System Prompt Override** — Replaces the main rules the AI follows.
- *How it changes behavior:* Powerful but risky. It throws out your normal settings and uses this instead. Only use it if your character truly needs different rules (like a video game NPC who must speak in code).

**Post-History Instructions** — A reminder that gets shoved in right before the AI replies.
- *How it changes behavior:* Because it's the *last* thing the AI reads, it pays extra attention to it. Great for rules like "Keep replies under 3 paragraphs" or "Stay in character."
- *Tip:* Short and direct works best. One or two sentences.
- *Provider note:* On Claude and Gemini this arrives wrapped as a bracketed system note inside a regular turn rather than as a separate system message — see "Where these reminders land on each provider" below. It still lands in that exact spot, so the "last thing it reads" effect holds everywhere.

**Character's Note (Depth Prompt)** — A reminder you slip into the recent chat history.
- *How it changes behavior:* You tell it how deep to put the reminder (depth 0 is right next to the latest message; depth 4 is four messages back). The AI sees it as if it were just said. Super effective at fixing "the AI forgot they're sad" problems.
- *Tip:* This is the secret weapon. Use it for "Stay in voice" or "Remember they don't trust strangers."
- *Role setting:* Leave Role at its default (**System**) and the note still lands at your chosen depth on every provider — see below for exactly how it's delivered. Switch Role to **User** or **Assistant** and it's sent as that role everywhere, unchanged.

**Where these reminders land on each provider** — Post-History Instructions, the Character's Note (at Role = System), and any World Info card set to `at_depth` are all built the same way: text inserted at a specific position among the messages sent to the AI. Most providers (the OpenAI-compatible ones, including OpenRouter) receive that position exactly as built — a real system-role message sitting right where it was placed; OpenRouter doesn't publicly document what it then does with a system message that sits mid-conversation before handing it off to whichever model is behind it. Claude and Gemini only accept a system prompt as one block at the very top of the request, so anything positioned *after* that block goes out instead as a bracketed system note (something like "[System note: ...]") inside a regular user turn — same position, same content, just a different wrapper.

**Alternate Greetings** — Other possible openings the user can pick.
- *How it changes behavior:* Only the one chosen gets sent to the AI. So you can have 10 of these without making chats more expensive.

**Talkativeness** — How often this character talks in group chats. Doesn't cost tokens.

**Creator, Notes, Tags, Version** — Just labels for organizing. The AI never sees these. Free.

## Lorebooks

A lorebook is like a folder of index cards. Each card has facts ("Sarah's dog is named Biscuit"). The AI only pulls a card out when something in the chat triggers it.

**Why this saves tokens:** Instead of cramming every single fact into the Description (paid every message), you put facts in lorebook entries that *only* show up when needed.

### Embedded Lorebook (Built Into the Character)

Made through the Character Lorebook section. It's automatically used when this character is selected.
- **Use it for:** stuff that belongs to this character — their family, their hometown, their pet, items they own.

### Extra Lorebooks (Outside the Character)

Set up in the World Info page. Two ways to use them:
1. **Always on** — used in every chat with every character (a checkbox).
2. **Linked to a character** — only used when that character is in the chat.

**Important:** All active lorebooks share one budget (default **1,024 tokens**). If your books have more lore than that, the extra gets cut — except cards marked **Constant** or **Critical**, which are never cut. If your constant + critical cards alone are bigger than the budget, the app warns you: a toast in chat (once per chat) plus a **Lorebook health** panel on the World Info page showing the totals. More books = more competition.

## Lorebook Entry Settings

Each card in your lorebook has these settings.

### Triggering the Card (When does it show up?)

**Keys** — The trigger words. If anyone in the chat says one of these words, the card activates.
- Example: keys = "Biscuit, dog, puppy" → the dog card shows up when those words appear.
- *How it changes behavior:* The AI suddenly "remembers" facts when relevant — and forgets them when not. Realistic.

**Secondary Keys + Selective Logic** — A second list of words to filter the card.
- `AND_ANY` — needs a primary key AND at least one secondary key.
- `AND_ALL` — needs a primary key AND ALL secondary keys.
- `NOT_ANY` — primary key, but NONE of the secondary words.
- `NOT_ALL` — primary key, but not all secondary words at once.
- *Use case:* "Mom" card only fires when "mom" appears with "fight" or "argument" — not casual mentions.

**Constant** — The card *always* fires, no triggers needed.
- *How it changes behavior:* The fact is always in the AI's mind. Use only for stuff that truly always matters.

**Critical** — The card can never be cut, no matter how tight the token budget gets, and keyword scanning can only trigger it from real chat text (other cards' text can't set it off through chain reactions; a Related Entries link you author yourself can still bring it in).
- *How it changes behavior:* This is the "never lose this fact" switch. Use it for hard continuity facts — "she lost her left hand in chapter 12" — where the story breaks if the AI silently forgets. Mark only a handful of cards Critical; if everything is critical, nothing is.

**Case Sensitive** — Whether "biscuit" and "Biscuit" count as the same. Usually leave off.

**Probability + Use Probability** — A dice roll for whether the card fires.
- *How it changes behavior:* Set to 30% to add unpredictability. The AI won't always remember, which can feel more human.

**Enabled** — On/off switch.

**Category** — A label for what kind of fact this is: `character_fact`, `world_rule`, `relationship`, `location`, `continuity_note`, or `standing_directive`, picked from a dropdown (custom tags from imported books are kept and stay selectable). Shows as a little chip in the entry list. The AI never sees it (free), but it makes finding and auditing cards way faster. The AI lorebook generator fills it in automatically.

**Delay / Cooldown / Sticky** — Time-based controls.
- **Delay**: wait this many turns before the card can ever fire.
- **Cooldown**: after firing, wait this many turns before it can fire again.
- **Sticky**: after firing, stay active for this many turns (even without trigger words).
- *How it changes behavior:* Sticky is great for emotions ("she's been crying for the last 3 messages"). Cooldown stops repetitive lore dumps.

**Related Entries** — Other cards in the same book that come along when this card fires.
- *How it changes behavior:* The linked card skips its own triggers entirely — no keys needed, no dice roll, no group competition (delay and cooldown still apply). Great for pairs that belong together: a rule and its one exception, a name and the fact that always travels with it. Links chain (A brings B, B brings C), and the app tidies them up when you delete or duplicate cards. One caveat: a pulled-in card still counts against the token budget and can be trimmed like any other — if a pair truly must never split, mark both cards Critical.

### Where the Card Goes in the AI's "Memory"

**Position** — Where the card text gets inserted:
- `before_char` — before the character description (default).
- `after_char` — after the character description.
- `before_an` — before the author's note.
- `after_an` — after the author's note.
- `at_depth` — slipped in N messages back in the chat (use the depth field).

*How position changes behavior:* The AI pays more attention to stuff near the *end* of what it reads. So `at_depth` with a low depth number (close to the latest message) makes the lore feel "fresh" and recent. Depth 0 works too: it puts the card right after the newest message — the closest possible spot to where the AI starts writing. Save that trailing slot for the one rule the AI absolutely must follow right now. (`at_depth` cards go out as system-role text, so on Claude and Gemini they're delivered as the same bracketed system note described under Character's Note above — still at that depth, just wrapped differently.)

**Order** — A number for sorting cards in the same position. Lower = earlier.
- *How it changes behavior:* If the budget runs out, higher-order cards get cut first. Put your most important cards at order 0–50. Cards marked Constant or Critical are never cut, whatever their order.

### Scanning (How Far Back the AI Looks)

**Scan Depth** — How many recent chat messages get searched for trigger words. Default **4**.
- *How it changes behavior:* Higher = more cards activate (because more messages are checked) = more tokens used and more chance of off-topic cards firing.

**Max Recursion** — How many times one card can trigger another card. Default **3**.
- Example: Card A says "Biscuit lives at the cabin." That triggers Card B about the cabin. That triggers Card C about the woods.
- Set to 0 if you don't want chain reactions.

**Prevent Recursion** — This card's words can't trigger others.

**Exclude Recursion** — This card can't be triggered *by* other cards (only by chat).
- *How it changes behavior:* Stops cards from snowballing into a giant lore dump. Cards marked **Critical** get this protection automatically — keyword scanning only ever triggers them from real chat text (an explicit Related Entries link is the one thing that can still bring one in, because you authored that link yourself).

### Group Competition

**Group** — Give multiple cards the same group name and only ONE will fire per message.

**Group Weight** — Decides *how* the winner is picked. If every competing card has the **same** weight, the winner is predictable: lowest Order wins, ties go to the card that matched more trigger words, then alphabetical. Same chat, same winner — no dice. Give the cards **different** weights and it becomes a weighted dice roll instead (higher weight = better odds).

**Group Override** — This card always wins, no matter the weight.

*How it changes behavior:* Perfect for moods. Make 5 cards: happy, sad, angry, tired, excited. Put them all in group "mood." Now exactly ONE mood is active at a time, instead of all 5 piling on. Keep weights equal when it matters *which* card wins (a story fact that must stay consistent); use different weights only for flavor cards where any of them would do.

## Smart Tricks That Save Tokens

These are the moves that actually make a difference.

### Trick 1: Use the Depth Prompt Instead of Cramming the Description

If you keep needing to remind the AI "stay grumpy," don't add it to Description (paid every message forever). Put it in **Character's Note** at depth 2 instead. Same effect, way fewer tokens, and the AI listens to it more because it's near recent messages.

### Trick 2: Move Big Lore Into a Lorebook

Got a 200-word "world history" in Description? That's paid every message even when nobody's talking about history. Move it to a lorebook entry. Either:
- Mark it `constant` if it really should always be there (still costs tokens, but you can swap or disable it).
- Or add **keys** so it only shows up when history is mentioned.

### Trick 3: Don't Crank Scan Depth Globally

If you set the global scan depth to 20, *every* card now searches 20 messages. Instead, leave the global at 4 and only raise it on the few cards that need long memory.

### Trick 4: Use Order, Not Position, to Pick Favorites

When the token budget runs out, the AI cuts cards starting from the highest order numbers. So your most important cards should be at order 0, 10, 20… and your nice-to-haves at order 200+. (Constant and Critical cards skip this line entirely — they never get cut. For the two or three facts you truly can't lose, flip the Critical toggle instead of trusting a low order.)

### Trick 5: Use at_depth for "Right Now" Lore

Stuff like "She just got bad news" works better at `at_depth` (depth 2) than at `before_char`. The AI pays more attention to recent stuff and will reflect the mood immediately.

### Trick 6: Group Your Mood Cards

Five mood cards in a group = only one fires per message. Total tokens stay the same no matter how many moods you add. With equal weights **and the same Order** on every mood card, when two moods trigger at once the card that matched more of the chat's words wins — so the mood that fires is the one the scene is actually about, not a coin flip. (Order is checked first, so if you stagger Orders per Trick 4 the lowest-Order mood always wins instead.)

### Trick 7: Two Example Messages Is Enough

Examples are sent every single message. Two great ones teach the AI the voice better than six average ones — and cost half as much.

### Trick 8: Watch the Token Count on Linked Templates

If you link a prompt template, the editor shows you how many tokens it costs. If it's 500+ tokens, ask yourself: is it doing 500 tokens of work? If not, drop it.

## Other Character Controls

None of these cost prompt tokens.

- **Linked Sampler Preset** — Auto-loads the right "creativity dial" settings when this character is picked.
- **Linked Prompt Template** — Auto-loads a writing style template (this DOES cost tokens — shown inline). For narrative characters, see the [HYPERCODE Prompt Framework guide](/guides/hypercode-guide).
- **Visibility** — Share with everyone or keep private.
- **Expression Sprites** — Picture changes with emotion. Only shown to you, never sent to the AI.
- **Live Portrait** — Animated video clips for emotions. Made once, replay free.
- **Regex Scripts** — Auto-fix patterns in the AI's replies (like always replacing "okay" with "okie").
- **Setup Wizard** — Suggests good settings based on your character.
- **Duplicate** — Make a copy to mess with safely.

## A Cheap, Sharp Character Recipe

Want a character that's fast, stays in voice, and doesn't drain tokens? Build it like this:

1. **Description**: 300 tokens or less. Bullet points. Looks + one-line backstory. Done.
2. **Personality**: 150 tokens or less. 3–5 traits. No overlap with Description.
3. **Scenario**: 80 tokens or empty.
4. **First Message**: medium length — sets the rhythm for the whole chat.
5. **Example Messages**: exactly 2. Show the character at their most "them."
6. **Character's Note**: 1–2 sentences at depth 2. Something like *"Stay in voice. Keep replies under 3 paragraphs."*
7. **Embedded lorebook**: keyword-triggered cards for friends, places, items. Avoid `constant` unless it's truly always needed.
8. **Linked template**: skip it unless you really need one.

Every token you save here is a token saved on every message, forever. That's the whole game.
