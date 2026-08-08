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

// JSON-recovery helpers now live in the shared LLM toolkit; re-exported here
// so existing ingestion imports keep working.
export { extractJsonObjects, firstJsonObject, asString, asStringList } from '../llm/json';
