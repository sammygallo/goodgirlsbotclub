// Render prompts (step 3, phase 3).
//
// TWO calls per scene, not the schema doc's five (plan §3.4). The doc's
// chain is POV/tense transformer → dramatic compressor → dialogue polisher
// → narration voice-matcher → continuity validator, and the first four each
// rewrite the whole scene. On a 60-scene bible that is 300 calls carrying
// the full scene text in and out, and each handoff is a lossy generation:
// stage 4 never sees what stage 1 saw, only stage 3's paraphrase of it. The
// failure mode of long rewrite chains is drift toward generic prose, which
// is the opposite of what `user_voice` is for.
//
// So: ONE prose call receiving POV/tense, the compression target, the
// participants' voice profiles and the user's voice as a single structured
// brief, and ONE continuity call reading the produced prose against the
// scene's fact set. Two calls, one rewrite, no lossy handoffs.

import type { RenderBrief } from './types';
import type { BibleCharacter, BibleFact } from '../../types/storyBible';

const POV_LABELS: Record<string, string> = {
  first: 'first person',
  third_limited: 'third person limited',
  third_omniscient: 'third person omniscient',
};

const COMPRESSION_GUIDANCE: Record<string, string> = {
  tight: 'Compress hard. Summarise transitions, keep only the lines that carry the scene.',
  balanced: 'Keep the scene’s shape, trimming repetition and small talk.',
  loose: 'Stay close to the source. Expand where the chat was terse.',
};

export const PROSE_SYSTEM = `You turn one scene of a roleplay chat into finished novel prose.

You are given a story bible's record of the scene — not the raw chat — plus how the people in it speak and how the author writes. Write the scene as it would appear in a novel.

Rules:
- Output ONLY the prose. No headings, no scene numbers, no commentary, no markdown fences.
- Write the WHOLE scene through to its end. Do not stop early, and do not summarise the ending in a sentence.
- Never contradict the established facts given below. If the record is silent on a detail, you may invent ordinary connective detail (weather, gesture, small objects) but never a new event, revelation, or change in a character's situation.
- Match each character's voice: their register, speech patterns and verbal tics are given, and any example lines are real lines they have spoken. Do not give two characters the same voice.
- Match the author's own prose habits where they are given. Their voice is the point of this — it is what makes the result theirs rather than generic.
- Dialogue is prose dialogue, not a script. No name-colon lines.
- Do not open with a restatement of the scene title or a summary of what is about to happen.`;

function characterBrief(c: BibleCharacter): string {
  const voice = c.personality?.voice_profile;
  const lines: string[] = [`- ${c.canonical_name}`];
  if (c.aliases?.length) lines.push(`  also called: ${c.aliases.join(', ')}`);
  if (c.physical_description?.summary) {
    lines.push(`  appearance: ${c.physical_description.summary}`);
  }
  const traits = (c.personality?.traits ?? []).map((t) => t.trait).filter(Boolean);
  if (traits.length) lines.push(`  traits: ${traits.join(', ')}`);
  if (voice?.register) lines.push(`  register: ${voice.register}`);
  if (voice?.speech_patterns) lines.push(`  speech: ${voice.speech_patterns}`);
  if (voice?.verbal_tics?.length) {
    lines.push(`  verbal tics: ${voice.verbal_tics.join(', ')}`);
  }
  if (c.arc?.current_state) lines.push(`  where they are now: ${c.arc.current_state}`);
  for (const ex of voice?.dialogue_examples ?? []) {
    if (ex.text?.trim()) lines.push(`  says things like: "${ex.text.trim()}"`);
  }
  return lines.join('\n');
}

function factLines(facts: BibleFact[]): string {
  return facts.map((f) => `- ${f.text}`).join('\n');
}

export function prosePrompt(brief: RenderBrief): string {
  const { scene, hints } = brief;
  const povCharacter = hints.povCharacterId
    ? (brief.participants.find((c) => c.id === hints.povCharacterId)?.canonical_name ??
      null)
    : null;

  const direction: string[] = [];
  if (hints.pov) {
    direction.push(
      `Point of view: ${POV_LABELS[hints.pov] ?? hints.pov}${
        povCharacter ? `, through ${povCharacter}` : ''
      }.`
    );
  }
  if (hints.tense) direction.push(`Tense: ${hints.tense}.`);
  direction.push(
    COMPRESSION_GUIDANCE[hints.compressionLevel] ?? COMPRESSION_GUIDANCE.balanced
  );
  if (scene.transformations) {
    const t = scene.transformations;
    direction.push(
      `This scene was read as "${t.compression_recommendation}" at roughly ${Math.round(
        t.compression_ratio_target * 100
      )}% of its length.${t.pacing_notes ? ` ${t.pacing_notes}` : ''}`
    );
  }
  if (scene.function) {
    direction.push(
      `Its beat is "${scene.function.beat}", tension ${scene.function.tension}/10.${
        scene.function.mood ? ` Mood: ${scene.function.mood}.` : ''
      }${scene.function.stakes ? ` At stake: ${scene.function.stakes}.` : ''}`
    );
  }
  if (hints.targetWordCount) {
    direction.push(`Aim for roughly ${hints.targetWordCount} words across the whole work.`);
  }
  if (hints.styleAnchors.length) {
    direction.push(`Style anchors: ${hints.styleAnchors.join('; ')}.`);
  }

  const voice = brief.userVoice;
  const authorVoice: string[] = [];
  if (voice?.style_summary) authorVoice.push(voice.style_summary);
  if (voice?.rhetorical_devices?.length) {
    authorVoice.push(`Devices they favour: ${voice.rhetorical_devices.join(', ')}.`);
  }
  if (voice?.diction?.sentence_length?.distribution) {
    authorVoice.push(
      `Sentence lengths: ${voice.diction.sentence_length.distribution}; paragraphs ${voice.diction.paragraph_density}.`
    );
  }
  if (voice?.diction?.preferred_vocabulary?.length) {
    authorVoice.push(`Words they reach for: ${voice.diction.preferred_vocabulary.join(', ')}.`);
  }
  if (voice?.diction?.avoided_vocabulary?.length) {
    authorVoice.push(`Words they avoid: ${voice.diction.avoided_vocabulary.join(', ')}.`);
  }

  const allFacts = [
    ...brief.facts.own,
    ...brief.facts.sceneAttributed,
    ...brief.facts.unattributed,
  ];

  return `Scene ${brief.position} of ${brief.totalScenes}: ${scene.title || '(untitled)'}

What happens (the bible's record of this scene):
${scene.detailed_summary || scene.summary || '(no summary recorded)'}
${scene.setting?.atmosphere ? `\nAtmosphere: ${scene.setting.atmosphere}` : ''}

${brief.precedingSummary ? `Immediately before this scene:\n${brief.precedingSummary}\n` : ''}
Who is in it:
${brief.participants.map(characterBrief).join('\n') || '(nobody recorded)'}

Established facts — these are canon and must not be contradicted:
${factLines(allFacts) || '(none recorded)'}
${
  brief.rules.length
    ? `\nHow this world works:\n${brief.rules.map((r) => `- ${r.text}`).join('\n')}\n`
    : ''
}
${authorVoice.length ? `How the author writes:\n${authorVoice.join(' ')}\n` : ''}
Direction:
${direction.map((d) => `- ${d}`).join('\n')}

Write the scene:`;
}

export const CONTINUITY_SYSTEM = `You check a passage of novel prose against a story's established facts and report only where they cannot both be true.

Rules:
- Return ONLY a JSON object. No prose, no markdown fences.
- Shape: {"findings": [{"fact": "f1", "claim": "what the prose says", "canon": "what the facts say", "severity": "major"}]}
- "fact" must be one of the labels given below, or "" when the prose contradicts the story generally rather than one listed fact.
- "severity" is exactly one of: minor, major. Major means a reader would notice a real inconsistency; minor is a small detail out of place.
- Report ONLY direct contradictions. Detail the facts simply do not mention is NOT a contradiction — prose is expected to add ordinary connective detail.
- A fact stated in different words is not a contradiction. Neither is a character changing over time, unless the prose asserts something that cannot coexist with a listed fact.
- If nothing contradicts, return {"findings": []}. That is the expected answer most of the time.`;

/** Facts are labelled `f1`, `f2`, … rather than given their UUIDs, and the
 *  label→id map stays client-side. Same reasoning as reconcile's judge:
 *  models mangle UUIDs, and a mangled id that happens to resolve is far
 *  worse than one that obviously does not. */
export function continuityPrompt(opts: { labelledFacts: string; prose: string }): string {
  return `Established facts:
${opts.labelledFacts || '(none recorded)'}

The prose to check:
${opts.prose}

Contradictions (JSON object):`;
}

export const CONTINUITY_REPAIR_INSTRUCTION = `That response could not be parsed as a JSON object with a "findings" array (see the system instructions). Return ONLY the corrected JSON object — no prose, no markdown fences, no explanation.`;
