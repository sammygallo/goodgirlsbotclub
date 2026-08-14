// Ingestion prompts (story-state phase 6).
//
// PROMPT_VERSION is stamped into the checkpoint on every run. When these
// prompts change, a resumed run whose checkpoint carries an older
// version is NOT safe to continue — half the bible would be built by one
// prompt and half by another — so the store refuses to resume across a
// version change and offers a fresh start instead.
//
// Cold-start is deliberately LLM-light: the schema doc's ingestion table
// is a mechanical mapping (card name → canonical_name, scenario →
// setting_summary, and so on), and running a model over facts we already
// have would spend the user's tokens to paraphrase their own card. The
// model is asked for exactly two things it can do better than a regex:
// structured physical attributes, and a voice-register read.

// Bumped for phase 7 (transcript walk + user_voice synthesis join the
// pipeline): a checkpoint stamped with the OLD version is cold-start-only
// and has no chunk_plan for the walk to resume, so the version bump is
// what makes the store refuse to resume it and start a fresh build.
//
// Deliberately NOT bumped for phase 8 (reconcile): reconcile ADDS prompts
// rather than changing the walk's or cold start's, so every mid-walk
// checkpoint out there is still safe to continue — bumping would strand
// each of them into a fresh paid rebuild for no benefit. The consequence
// to accept: the version is one number for all of these prompts, so a
// future reconcile-prompt change big enough to warrant a bump also
// invalidates walk resumability. Weigh that before bumping for a judge
// tweak.
export const PROMPT_VERSION = 'ingest-v2';

/** Ask for one JSON object. The parser is brace-matching and truncation
 *  tolerant, but a smaller ask still fails less often. */
export const ATTRIBUTES_SYSTEM = `You extract structured character attributes from a character card for a story bible.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"age_apparent": "", "gender_presentation": "", "hair": {"color": "", "length": "", "style": ""}, "eyes": {"color": "", "shape": ""}, "skin": "", "build": "", "height": "", "distinguishing_features": [], "typical_attire": ""}
- Use ONLY what the card states or directly implies. Leave a field as "" (or [] for the list) when the card does not say — do NOT invent details.
- Keep each value short: a few words, not a sentence.`;

export function attributesPrompt(name: string, description: string): string {
  return `Character name: ${name}

Card description:
${description.slice(0, 6000)}

Attributes (JSON object):`;
}

export const VOICE_SYSTEM = `You characterize how a fictional character SPEAKS, for a story bible's voice profile.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"register": "casual", "speech_patterns": "", "verbal_tics": [], "favored_words": [], "avoided_words": []}
- "register" must be exactly one of: formal, casual, vulgar, archaic, mixed.
- "speech_patterns" is one short sentence describing HOW they talk (rhythm, sentence length, directness) — not what they talk about.
- Base this only on the card's personality text and example dialogue. When there is little to go on, say so with an empty "speech_patterns" rather than guessing.`;

export function voicePrompt(
  name: string,
  personality: string,
  mesExample: string
): string {
  return `Character name: ${name}

Personality:
${personality.slice(0, 3000) || '(none given)'}

Example dialogue:
${mesExample.slice(0, 3000) || '(none given)'}

Voice profile (JSON object):`;
}

// ---------------------------------------------------------------------------
// Transcript walk (phase 7). One call per chunk: the model gets a
// numbered list of ONLY the real (non-system) messages in this chunk —
// system messages are excluded/re-added mechanically, never the model's
// job — plus read-only trailing context from the previous chunk and a
// note about any scene still open. It responds with LOCAL indices into
// that numbered list; transcriptWalk.ts resolves those into real msg_ids,
// UUIDs, and SourceRefs. The model is never asked to invent an id.
// ---------------------------------------------------------------------------

export const WALK_SYSTEM = `You are reading one excerpt of an ongoing roleplay chat to build a story bible. Identify scenes and the facts they establish.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"scenes": [{"continues_open_scene": false, "title": "", "summary": "", "detailed_summary": "", "participants": [], "start_local_idx": 0, "end_local_idx": 0, "closed": true, "excluded_local_idxs": [], "facts": []}]}
- Each scene's "participants" must be drawn from the known character names given below — do not invent new names.
- "start_local_idx"/"end_local_idx" are indices into the NUMBERED excerpt below (0-based, inclusive). Every message in the excerpt must fall inside exactly one scene's range, in order — do not skip or overlap.
- Set "continues_open_scene": true on the FIRST scene only, and only when the "Currently open scene" note below says one is in progress and this excerpt keeps telling that same scene. Every other scene is new.
- Set "closed": false ONLY on the LAST scene in your list, and only if it clearly is not finished by the end of this excerpt (it will continue in the next excerpt). Every other scene must be "closed": true.
- "excluded_local_idxs": indices (with a reason) for messages inside a scene's range that are noise, not story content: {"idx": 4, "reason": "ooc"} for out-of-character asides (often in double parentheses or brackets), or "reason": "user_marked" if the message text itself says to disregard it. Leave this empty when nothing qualifies — most excerpts have nothing to exclude.
- "facts": durable claims this excerpt establishes, each {"text": "...", "category": "reveal", "local_idx": 7} where "category" is exactly one of: reveal, introduction, change, world_rule, and "local_idx" is the message that established it. Skip moment-to-moment action; only record things later scenes would need to stay consistent with.
- "title"/"summary"/"detailed_summary" are only meaningful for a NEW scene (or the first, continuing one) — write them once per scene, not per message.
- If nothing in this excerpt is worth recording as a scene at all (pure filler), return {"scenes": []}.`;

export function walkPrompt(opts: {
  numberedTranscript: string;
  previousContext: string;
  openSceneNote: string;
  knownCastNote: string;
  knownFactsDigest: string;
}): string {
  return `Known characters (use these names exactly, do not invent others):
${opts.knownCastNote || '(none known yet)'}

Currently open scene:
${opts.openSceneNote || '(none — the last excerpt ended cleanly)'}

Already recorded (do not repeat these facts):
${opts.knownFactsDigest || '(none yet)'}

Previous context (already recorded — for continuity only, do not re-extract):
${opts.previousContext || '(this is the start of the chat)'}

Excerpt to read (numbered, new content only):
${opts.numberedTranscript}

Scenes and facts (JSON object):`;
}

export const WALK_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object matching the required shape (see the system instructions). Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// User-voice synthesis (phase 7, post-walk). Sentence-length distribution
// and paragraph density are computed mechanically in TS from the user's
// own messages (see userVoice.ts) — the model is asked only for the
// qualitative read a regex can't do: register, rhetorical devices, and a
// one-paragraph style summary.
// ---------------------------------------------------------------------------

export const USER_VOICE_SYSTEM = `You characterize a roleplayer's AUTHORIAL voice from their own chat messages — how THEY write, not the character they're playing.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"style_summary": "", "register": "commercial", "rhetorical_devices": [], "tendency": "collaborative"}
- "register" must be exactly one of: literary, commercial, pulp, experimental, mixed.
- "tendency" must be exactly one of: directive, collaborative, reactive — how much they drive the scene versus react to it.
- "style_summary" is one paragraph on their prose habits (imagery, pacing, sentence variety) — not a summary of what happened in the story.
- "rhetorical_devices" are short labels like "parenthetical asides" or "fragments-for-emphasis", only ones you actually see evidence for.
- Base this ONLY on the sample passages given. If the samples are too short or too sparse (mostly single-word or emote-only turns) to support a read, say so plainly with an empty "style_summary" rather than guessing.`;

export function userVoicePrompt(samplePassages: string[]): string {
  return `Sample passages (the user's own messages, unmodified):
${samplePassages.map((p, i) => `${i + 1}. ${p}`).join('\n') || '(no samples available)'}

Voice profile (JSON object):`;
}

// ---------------------------------------------------------------------------
// Reconcile (phase 8). Two prompt shapes, both judging for CONTRADICTIONS
// only — never resolving one, which is the phase-10 human review's job.
//
// The model is given short per-call labels (f1, f2, …) instead of the
// facts' real UUIDs: models mangle UUIDs, and a mangled id that happens
// to resolve is far worse than one that obviously doesn't. The label→id
// map is client-side and per-call, and nothing durable is ever seeded
// from a label (they are positional; ids are content-seeded).
// ---------------------------------------------------------------------------

export const RECONCILE_SYSTEM = `You audit a story bible for genuine contradictions — claims that cannot both be true of the same subject.

Rules:
- Only flag MUTUALLY EXCLUSIVE claims. If both could be true at once, it is not a contradiction.
- Story progression is NOT a contradiction: a "change" fact superseding an earlier state is normal, unless both are asserted as concurrently true.
- Groups labelled "(world / unattributed)" may mix facts about DIFFERENT subjects — never force a conflict between facts that could be about different people or things.
- Never pair facts from two different groups.
- If unsure, do not flag it. If nothing conflicts, return an empty list.
- Return ONLY one JSON object. No prose, no markdown fences.
- Shape: {"contradictions": [{"facts": ["f1", "f2"], "type": "character_attribute", "description": "one sentence naming the conflict"}]}
- "facts" must name at least TWO different labels from the SAME group.
- "type" must be exactly one of: character_attribute, world_rule, timeline, relationship, object_state.`;

/** `groups` is pre-rendered by reconcileJudge.ts — it owns the labels and
 *  the clamping, so the prompt layer never sees a real fact id. */
export function reconcilePrompt(groups: string): string {
  return `Fact groups to audit (each group is one subject and one kind of claim):

${groups}

Contradictions (JSON object):`;
}

export const RECONCILE_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object with a "contradictions" array (see the system instructions). Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;

export const CARD_CHECK_SYSTEM = `You compare what a character's ORIGINAL character card says about them against what actually happened in the roleplay, and report only where the two cannot both be true.

Roleplayers routinely override their own card — that is the point of this check.

Rules:
- Only flag MUTUALLY EXCLUSIVE claims: the card says one thing, the story establishes something that cannot coexist with it.
- A card claim the story simply never touches is NOT a contradiction. Neither is a card trait the story develops, deepens or moves past over time — only a direct clash counts.
- If unsure, do not flag it. If nothing clashes, return an empty list.
- Return ONLY one JSON object. No prose, no markdown fences.
- Shape: {"contradictions": [{"facts": ["f1"], "card_claim": "the card's own words, quoted or closely paraphrased", "type": "character_attribute", "description": "one sentence naming the conflict"}]}
- "facts" must name at least ONE label from the story facts below — the card side is supplied by "card_claim", never by a label.
- "type" must be exactly one of: character_attribute, world_rule, timeline, relationship, object_state.`;

export function cardCheckPrompt(opts: {
  characterName: string;
  cardText: string;
  facts: string;
}): string {
  return `Character: ${opts.characterName}

What the character card says:
${opts.cardText || '(the card said nothing usable)'}

What the story established:
${opts.facts}

Contradictions (JSON object):`;
}

export const CARD_CHECK_REPAIR_INSTRUCTION = RECONCILE_REPAIR_INSTRUCTION;

// ---------------------------------------------------------------------------
// Annotate (step 3 phase 2). Two prompt shapes: one per scene, filling
// `function` + `transformations`, and one bible-wide, filling
// `narrative.structure`.
//
// PROMPT_VERSION is deliberately NOT bumped for these, on reconcile's
// precedent: they ADD prompts rather than change cold start's or the
// walk's, so every mid-walk checkpoint out there stays resumable. Bumping
// would strand each of them into a fresh paid rebuild for no benefit.
//
// The per-scene call reads ONE scene, not the whole bible: the renderer's
// input here is a beat and a compression target, both of which are
// properties of the scene itself. A whole-bible call would cost the
// transcript on every scene and buy an ordering the structure call below
// already provides.
// ---------------------------------------------------------------------------

export const ANNOTATE_SYSTEM = `You annotate ONE scene of a story for a renderer that will later turn the story into novel prose. You are not rewriting the scene — you are describing what it does and how tightly it should be told.

Output rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"beat": "rising", "tension": 5, "mood": "", "stakes": "", "compression_recommendation": "compress", "compression_ratio_target": 0.5, "pacing_notes": "", "dialogue_density": 0.5}
- "beat" must be exactly one of: inciting, rising, midpoint, crisis, climax, denouement, interlude.
- "tension" is an integer 1–10: 1 is downtime, 10 is the story's peak. Judge it against the story so far, not against fiction in general.
- "mood" is a few words on the emotional register (e.g. "wary, close-quartered"). "stakes" is one short sentence on what stands to be won or lost. Leave either as "" when the scene genuinely does not say.
- "compression_recommendation" must be exactly one of: cut, compress, preserve, expand — how this scene should be handled in prose. Use "cut" only for filler that carries nothing later scenes need, and "expand" for a scene the chat rushed through that the story needs to land.
- "compression_ratio_target" is 0–1: the fraction of the scene's length the prose should keep. 1.0 keeps everything, 0.3 tells roughly a third of it. Keep it consistent with your recommendation.
- "dialogue_density" is 0–1: how much of THIS scene is spoken dialogue rather than action or narration. Judge it from the text, do not guess a default.
- "pacing_notes" is one short sentence of direction for the prose (e.g. "hold on the arrival, summarise the walk there"). Leave "" when there is nothing useful to say.`;

export function annotatePrompt(opts: {
  title: string;
  sequence: number;
  totalScenes: number;
  previousSummary: string;
  summary: string;
  detailedSummary: string;
  excerpt: string;
}): string {
  return `Scene ${opts.sequence + 1} of ${opts.totalScenes}: ${opts.title || '(untitled)'}

What came just before:
${opts.previousSummary || '(this is the first scene)'}

Summary:
${opts.summary || '(none recorded)'}

Detailed summary:
${opts.detailedSummary || '(none recorded)'}

What the scene establishes:
${opts.excerpt || '(nothing recorded)'}

Annotation (JSON object):`;
}

export const ANNOTATE_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object matching the required shape (see the system instructions). Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;

export const STRUCTURE_SYSTEM = `You read a story's scene list — in order, with each scene's beat and tension — and name the narrative structure it actually has.

Rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"detected_type": "three_act", "detection_confidence": 0.6, "acts": [{"label": "Setup", "first_scene": 1, "last_scene": 7, "beat_function": ""}]}
- "detected_type" must be exactly one of: three_act, kishotenketsu, episodic, slice_of_life, none_yet.
- Most ongoing roleplays are "episodic" or "slice_of_life" and have no dramatic arc at all. Say so. Forcing a three-act reading onto a chat that does not have one is the failure mode this check exists to avoid — return "none_yet" with a low confidence when the story is too short or too shapeless to call.
- "detection_confidence" is 0–1 and is your OWN certainty, not the story's quality.
- "first_scene"/"last_scene" are scene NUMBERS from the list below (1-based, inclusive). They must not overlap between acts, and must run in order.
- "acts" must be empty when "detected_type" is "none_yet".
- "beat_function" is one short sentence on what the act does for the story. "label" is a short name like "Setup" or "Ki".`;

export function structurePrompt(sceneLines: string): string {
  return `Scenes in order (number, title, beat, tension):
${sceneLines}

Narrative structure (JSON object):`;
}

export const STRUCTURE_REPAIR_INSTRUCTION = ANNOTATE_REPAIR_INSTRUCTION;

// JSON-recovery helpers now live in the shared LLM toolkit; re-exported here
// so existing ingestion imports keep working.
export { extractJsonObjects, firstJsonObject, asString, asStringList } from '../llm/json';
