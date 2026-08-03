# Lorebook Authoring

How to write lorebook entries that fire when they should, stay quiet when they shouldn't, and never lose the facts your story depends on. This is the craft side — the field-by-field reference lives in the Character Building guide (link at the bottom).

## One entry, one fact

Each entry is one self-contained fact. If you need the word "and" to describe what an entry covers, it's two entries — split it.

Put the whole rule in the first line. The AI (and future you) may only skim the opening before deciding whether the card matters, so don't bury the point in sentence two.

Write it so it makes sense alone. The AI reads the entry mid-story with no surrounding context, so "as mentioned above" and "see the other entry" mean nothing. Every entry has to stand on its own feet.

Aim for about 60–110 words. If you're consistently going over, you almost certainly have two facts glued together.

## Choosing keys

Pick 3–6 keys that literally appear in your prose or your own messages: a name, a place, a specific term you actually type. Skip paraphrases of the concept — if you write "the Hollow" in chat, "mysterious forest" is a key that will never fire.

**Keys match as substrings, not as words.** GGBC scans the recent chat text and asks "does this key appear anywhere inside it?", ignoring case and ignoring word boundaries. That has three consequences worth internalising:

- **Short fragments fire inside unrelated words.** `ana` matches "banana", `art` matches "started", `Ed` matches "wanted". Anything under three characters is almost always a mistake; distinctive proper nouns and multi-word phrases are the safe end of the scale.
- **Everyday words fire constantly.** `the`, `she`, `they`, `said`, `about` — these appear in nearly every message, so the entry is effectively always on, eating budget and crowding out the cards that actually matter. If you want a card on every message, use **Constant** and say so, rather than faking it with a common word.
- **A longer key is pointless when a shorter one already covers it.** If you list `Hollow`, then `the Hollow Road` can never be the reason the card fires — any text containing the longer phrase already contains the shorter key. It's a free line in the list that does nothing.

Resist the urge to add every word that might come up. 3–6 well-chosen keys beat 15 speculative ones, because every extra key is another way for the card to fire on a coincidental mention and eat budget for nothing.

A key wrapped in `/slashes/` is treated as a regular expression instead — powerful, but if the pattern doesn't compile the app falls back to matching the literal text *including* the slashes, which means it never fires.

## Categories

Every entry can carry a **Category**, picked from six presets (custom tags from imported books are preserved too):

- `character_fact` — who someone is, what they look like, what they own
- `world_rule` — how magic, tech, or society works
- `relationship` — how two people stand with each other
- `location` — a place and what's true there
- `continuity_note` — a thing that happened and must stay happened
- `standing_directive` — a tone or style rule that always applies

The category shows as a chip in the entry list, and the AI lorebook generator tags new entries automatically. The AI never reads it — it's free. The payoff is audits: once a book grows past twenty entries, being able to scan "all my standing directives" or "every continuity note" at a glance turns a chore into a minute.

## Constant, Critical, and the budget

Ask three questions about every important entry:

1. **Should it fire every message?** That's the **Constant** toggle. The fact is always in the AI's mind — and always on the bill.
2. **If the token budget gets tight, can it be dropped?** If losing it would break the story, that's the **Critical** toggle. A critical entry is never cut by the World Info budget and survives chat-history trimming.
3. **What's allowed to trigger it?** Keyword scanning only ever fires a Critical entry off real chat text — a stray keyword sitting inside some other entry's content can never set one off through a chain reaction. (A Related-entries link you author yourself is the one deliberate exception.)

Use Critical for hard continuity facts where silent absence would break things: "she lost her left hand in chapter 12," "the empire fell three years before the story starts." Not "I'd prefer this be there" — "the story contradicts itself without this."

Discipline: keep constants under roughly 20% of a book, and mark only a handful of entries Critical. If everything is critical, nothing is.

The app fails loud instead of quiet. If your constant + critical entries alone blow past the World Info budget, you get a warning toast in chat, and the **Lorebook health** panel on the World Info page shows your pinned-token total against the budget, your constant share, critical counts, and any broken related-entry links. When that panel shows red, the fix is editorial — split, trim, or demote something — not "trust it'll work out."

## Related entries

When two cards belong together, don't rely on one happening to trigger the other — link them. A card's **Related Entries** inject alongside it whenever it fires, skipping the linked card's own keys, dice roll, and group competition (delay and cooldown are still honored). The pulled-in card still counts against the token budget, though — if the pair truly must never split, mark both Critical.

Link when the pairing is the point: a rule and its one exception, a name and the fact that always travels with it. A keyword chain can silently break the moment you reword an entry; a link can't. Links chain onward (A brings B, B brings C), and the app cleans them up when you delete a card and remaps them when you duplicate or import a book.

## Groups without dice

Put competing, mutually-exclusive cards in the same group and only one fires per message. How the winner is picked is up to you:

- **Equal weights** → a predictable winner: lowest Order wins; ties go to the card that matched more of the chat's words, then alphabetical. Same chat state, same injected fact, every time.
- **Different weights** → the classic weighted dice roll.

For anything where continuity matters — the current state of the world, a character's status — keep weights equal and use Order to name the winner. Save the dice for flavor groups where any of the cards would do.

## Placement

Think of the prompt in three bands, and place entries deliberately:

- **Lead** (Before Character): background and world texture — the stage dressing.
- **Body** (the default positions): everyday facts.
- **Trailing** (@ Depth 0–1): the one non-negotiable rule of the scene. Depth 0 lands the card right after the newest message — the closest possible spot to where the AI starts writing, and the spot it obeys most.

Placement decides *where* an entry goes, never *whether* it loads. Loading is still governed by keys, Constant, and Critical — a trailing slot is no substitute for a trigger that works.

## The entry check

The editor now checks each entry while you write it, and the AI lorebook generator checks its drafts before you save them. Nothing here blocks you — it's a second pair of eyes, not a gate.

**Red means the entry can never reach the AI.** These are the silent failures, the ones that look fine in the list and simply never show up in a story:

- No keywords and not Constant — nothing can trigger it.
- Empty content — the scanner skips it entirely.
- A Critical entry with no trigger. Critical protects an entry from being cut; it doesn't fire one. Give it a keyword or make it Constant.
- A `/regex/` key that doesn't compile, which gets matched as literal text (slashes and all) and never hits.

**Amber means it'll work, but probably not the way you want:**

- A key under three characters, or an everyday word — both fire far more often than you intended (see *Choosing keys* above).
- More than six keys on one entry.
- A body over roughly 150 tokens — usually two facts wearing one coat.
- Two entries in the book that say nearly the same thing — either mostly the same words, or one entry whose content sits entirely inside a longer one. Both fire, both cost budget, and editing one leaves the other quietly stale. The check is lexical, so a restatement in genuinely different words ("keeps a knife in her boot" vs "hides a blade in her boot") will slip past it.
- Related-entry links pointing at something deleted, disabled, or empty — the chain stops there.

If you only ever act on one colour, make it red. An amber entry is merely expensive; a red one isn't in the story at all, and nothing else in the app will tell you.

---

For the full field-by-field reference — secondary keys, sticky/cooldown, scan depth, and the rest — see the [Lorebooks section of the Character Building guide](/guides/character-guide#lorebooks).
