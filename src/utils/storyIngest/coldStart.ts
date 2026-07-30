// Cold-start pass (story-state phase 6, pass 1).
//
// Builds a starter bible from the ST primitives that already exist —
// character card, lorebooks, persona — before a single transcript
// message is read. The schema doc's ingestion table is a mechanical
// mapping, so this pass is mostly a pure function: card name becomes
// canonical_name, scenario becomes the setting summary, lorebook entries
// become world rules, and so on.
//
// The model is called exactly twice, for the two things a regex cannot
// do: extracting structured physical attributes, and reading a voice
// register. Both are optional — if the call fails, the pass still
// produces a usable bible rather than aborting, because a starter bible
// without eye colour is far better than no bible at all.
//
// Provenance: every object this pass writes carries a SourceRef. Facts
// lifted verbatim from a card field get a `card_field` ref; anything the
// model inferred gets `agent_inference`, so the review checkpoint can
// tell the user which is which.

import type {
  BibleCharacter,
  EntitiesSection,
  RenderingHintsSection,
  SourceRef,
  WorldSection,
} from '../../types/storyBible';
import { capturedAt, createIdMinter } from '../storyBible/sourceRefs';
import {
  ATTRIBUTES_SYSTEM,
  VOICE_SYSTEM,
  asString,
  asStringList,
  attributesPrompt,
  firstJsonObject,
  voicePrompt,
} from './prompts';
import type { ColdStartSources, LlmCall } from './types';

function cardFieldRef(avatar: string, field: string, excerpt?: string): SourceRef {
  return {
    kind: 'card_field',
    ref: { character_avatar: avatar, field },
    snapshot: excerpt ? { excerpt: excerpt.slice(0, 500) } : {},
    captured_at: capturedAt(),
  };
}

function inferenceRef(note: string): SourceRef {
  return {
    kind: 'agent_inference',
    snapshot: { excerpt: note.slice(0, 500) },
    captured_at: capturedAt(),
  };
}

function lorebookRef(bookId: string, entryId: string, excerpt: string): SourceRef {
  return {
    kind: 'lorebook_entry',
    ref: { book_id: bookId, entry_id: entryId },
    snapshot: { excerpt: excerpt.slice(0, 500) },
    captured_at: capturedAt(),
  };
}

/** Split example dialogue into representative lines. ST's mes_example
 *  uses `<START>` blocks and `{{char}}:` prefixes; we keep the character's
 *  own lines only, since the user's half is voice-profiled separately. */
export function dialogueExamplesFrom(
  mesExample: string,
  characterName: string
): string[] {
  if (!mesExample.trim()) return [];
  const lines = mesExample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^<start>$/i.test(l));

  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:\{\{char\}\}|char|assistant|([^:]{1,40})):\s*(.+)$/i);
    if (!m) continue;
    const speaker = (m[1] ?? '').trim().toLowerCase();
    const text = m[2].trim();
    // Skip the user's half — `{{user}}:` or the persona's name.
    if (speaker === '{{user}}' || speaker === 'user' || speaker === 'you') continue;
    if (speaker && characterName && speaker !== characterName.toLowerCase()) {
      // A named speaker who isn't the character (group example) — skip.
      if (speaker !== 'char' && speaker !== 'assistant') continue;
    }
    if (text.length < 2) continue;
    out.push(text.slice(0, 500));
    if (out.length >= 10) break;
  }
  return out;
}

/** Per-rule text cap. */
const RULE_TEXT_MAX = 2000;
/** Byte budget for lorebook-derived rules. Well under the server's
 *  256KB section cap so the rest of the world section (summary,
 *  attributes, geography) always fits alongside them. */
export const WORLD_RULE_BYTE_BUDGET = 180 * 1024;

export interface ColdStartResult {
  entities: EntitiesSection;
  world: WorldSection;
  renderingHints: RenderingHintsSection;
  /** Model calls actually made — 0 when the caller passed no LLM. */
  llmCalls: number;
  /** Lorebook entries left out because the section budget ran out.
   *  Surfaced to the user — a silently truncated bible reads as a
   *  complete one (plan: "no silent caps"). */
  rulesDropped: number;
}

/**
 * Run the cold-start mapping.
 *
 * `llm` is optional so the mechanical half stays unit-testable without a
 * network, and so a user who aborts before the model responds still gets
 * the deterministic bible.
 */
export async function runColdStart(
  sources: ColdStartSources,
  llm?: LlmCall,
  signal?: AbortSignal
): Promise<ColdStartResult> {
  const avatar = sources.characterAvatar;
  let llmCalls = 0;

  // Every id this pass mints is derived from something mechanically
  // stable about the thing it names — the card avatar, the persona name,
  // the lorebook entry — never from randomness.
  //
  // Cold start reruns: on a "Rebuild the groundwork", and (before the
  // resume gate was fixed) on any interrupted walk. Random ids made each
  // rerun mint a NEW id for the same character and then full-replace the
  // entities section, so every scene already on the server was left
  // pointing at a character that no longer existed anywhere in the bible
  // — a dangling reference the pipeline had no way to notice. Derived
  // ids make a rerun idempotent instead: the same card re-derives the
  // same character, and the scenes stay attached.
  //
  // Not scoped to the project: ids only have to be unique WITHIN a
  // bible, and "the same card always maps to the same character id" is
  // the property being bought. It also keeps runColdStart free of any
  // project/bible argument it has no other use for.
  const mintId = createIdMinter();

  // --- the character the chat is with -------------------------------
  const character: BibleCharacter = {
    // Avatar is the card's filename — stable across rebuilds in a way the
    // display name is not (the user can rename a card). Falls back to the
    // name, then to the same 'Unnamed' literal canonical_name uses, so a
    // card with neither still mints something rather than seeding on ''.
    id: mintId(`character:${avatar || sources.characterName || 'Unnamed'}`),
    canonical_name: sources.characterName || avatar || 'Unnamed',
    aliases: [],
    role: 'protagonist',
    is_user_persona: false,
    source: {
      kind: 'character',
      ref: avatar,
      snapshot: { name: sources.characterName },
      captured_at: capturedAt(),
    },
    physical_description: {
      summary: sources.description.slice(0, 4000),
      attributes: {
        age_apparent: '',
        gender_presentation: '',
        hair: { color: '', length: '', style: '' },
        eyes: { color: '', shape: '' },
        skin: '',
        build: '',
        height: '',
        distinguishing_features: [],
        typical_attire: '',
      },
    },
    personality: {
      traits: [],
      voice_profile: {
        register: 'mixed',
        speech_patterns: '',
        verbal_tics: [],
        dialogue_examples: dialogueExamplesFrom(
          sources.mesExample,
          sources.characterName
        ).map((text) => ({
          text,
          source: cardFieldRef(avatar, 'mes_example', text),
        })),
        vocabulary_signals: { favored: [], avoided: [] },
      },
      motivations: [],
      fears: [],
      values: [],
    },
    background: '',
    relationships: [],
    arc: { starting_state: '', current_state: '', target_state: null, beats: [] },
    provenance: [
      cardFieldRef(avatar, 'description', sources.description),
      ...(sources.personality
        ? [cardFieldRef(avatar, 'personality', sources.personality)]
        : []),
    ],
  };

  // Personality text is a paragraph, not a trait list; keeping it whole
  // as one evidence-bearing trait beats splitting on commas and inventing
  // structure the card never had.
  if (sources.personality.trim()) {
    character.personality!.traits = [
      {
        trait: sources.personality.trim().slice(0, 300),
        evidence: cardFieldRef(avatar, 'personality', sources.personality),
      },
    ];
  }

  // --- the user's persona, as a character ---------------------------
  const characters: BibleCharacter[] = [character];
  if (sources.persona?.name) {
    characters.push({
      // The persona name is already this entity's `source.ref` below —
      // the same identity the SourceRef envelope resolves against.
      id: mintId(`persona:${sources.persona.name}`),
      canonical_name: sources.persona.name,
      aliases: [],
      role: 'user_persona',
      is_user_persona: true,
      source: {
        kind: 'persona',
        ref: sources.persona.name,
        snapshot: {
          name: sources.persona.name,
          excerpt: sources.persona.description.slice(0, 500),
        },
        captured_at: capturedAt(),
      },
      physical_description: {
        summary: sources.persona.description.slice(0, 4000),
        attributes: {
          age_apparent: '',
          gender_presentation: '',
          hair: { color: '', length: '', style: '' },
          eyes: { color: '', shape: '' },
          skin: '',
          build: '',
          height: '',
          distinguishing_features: [],
          typical_attire: '',
        },
      },
      personality: {
        traits: [],
        voice_profile: {
          register: 'mixed',
          speech_patterns: '',
          verbal_tics: [],
          dialogue_examples: [],
          vocabulary_signals: { favored: [], avoided: [] },
        },
        motivations: [],
        fears: [],
        values: [],
      },
      background: '',
      relationships: [],
      arc: { starting_state: '', current_state: '', target_state: null, beats: [] },
      provenance: [],
    });
  }

  // --- world: scenario + lorebook entries ---------------------------
  const world: WorldSection = {
    name: '',
    setting_summary: sources.scenario.slice(0, 4000),
    setting_attributes: {
      time_period: '',
      technology_level: '',
      magic_or_supernatural: '',
      society: { political: '', cultural: '', economic: '' },
    },
    geography: [],
    rules: [],
    timeline: { anchors: [] },
  };

  // Lorebook entries → world rules, under a byte budget.
  //
  // The section has a hard 256KB server cap and a rejected write is a
  // 413 that kills the whole run AFTER the model calls are paid for, so
  // the budget is enforced here rather than discovered there. Constant
  // entries go first: they were in every prompt, so they are the ones
  // the story was demonstrably played under.
  const candidates = sources.lorebooks.flatMap((book) =>
    book.entries
      // A switched-off entry never reached a prompt — ingesting it as
      // canon (worse, as `explicit` canon when it is also constant)
      // would put lore the user deliberately disabled into the bible.
      .filter((entry) => entry.enabled !== false && entry.content.trim())
      .map((entry) => ({ book, entry }))
  );
  candidates.sort((a, b) => Number(b.entry.constant) - Number(a.entry.constant));

  let ruleBytes = 0;
  let rulesDropped = 0;
  for (const { book, entry } of candidates) {
    const text = entry.content.trim().slice(0, RULE_TEXT_MAX);
    // text + the snapshot excerpt + envelope, roughly.
    const cost = text.length + Math.min(text.length, 500) + 260;
    if (ruleBytes + cost > WORLD_RULE_BYTE_BUDGET) {
      rulesDropped++;
      continue;
    }
    ruleBytes += cost;
    world.rules!.push({
      // Book + entry id, matching `lorebookRef` below. Seeding on the
      // rule TEXT instead would remint the id whenever the user edited
      // the entry, orphaning any fact that cited the rule.
      id: mintId(`rule:${book.bookId}:${entry.id}`),
      text,
      category: 'other',
      source: lorebookRef(book.bookId, entry.id, entry.content),
      // Constant entries are always in the prompt, so the chat has
      // demonstrably been played under them. Selective entries may
      // never have fired — the WI replay pass (1.5) upgrades those it
      // can show did.
      confidence: entry.constant ? 'explicit' : 'inferred',
      established_in: null,
    });
  }

  const renderingHints: RenderingHintsSection = {
    novel: {
      pov: null,
      pov_character: null,
      tense: null,
      chapter_breaks: [],
      chapter_titles: [],
      compression_level: 'balanced',
      target_word_count: null,
      style_anchors: [],
    },
    screenplay: { format: 'fountain', sluglines_inferred: true, page_target: null },
    graphic_novel: {
      pages_per_scene: 1,
      panel_density: 'standard',
      art_style_brief: '',
      character_consistency_refs: [],
    },
    storyboard: { aspect_ratio: '16:9', panels_per_scene: 4 },
  };

  // --- the two model calls ------------------------------------------
  if (llm && sources.description.trim()) {
    try {
      const raw = await llm(
        [
          { role: 'system', content: ATTRIBUTES_SYSTEM },
          {
            role: 'user',
            content: attributesPrompt(sources.characterName, sources.description),
          },
        ],
        { maxTokens: 700, signal }
      );
      llmCalls++;
      const obj = firstJsonObject(raw);
      if (obj) {
        const hair = (obj.hair ?? {}) as Record<string, unknown>;
        const eyes = (obj.eyes ?? {}) as Record<string, unknown>;
        character.physical_description!.attributes = {
          age_apparent: asString(obj.age_apparent, 40),
          gender_presentation: asString(obj.gender_presentation, 40),
          hair: {
            color: asString(hair.color, 40),
            length: asString(hair.length, 40),
            style: asString(hair.style, 60),
          },
          eyes: { color: asString(eyes.color, 40), shape: asString(eyes.shape, 40) },
          skin: asString(obj.skin, 60),
          build: asString(obj.build, 60),
          height: asString(obj.height, 40),
          distinguishing_features: asStringList(obj.distinguishing_features, 8),
          typical_attire: asString(obj.typical_attire, 200),
        };
        character.provenance!.push(
          inferenceRef('physical attributes extracted from the card description')
        );
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      // A failed extraction leaves the (empty) mechanical defaults —
      // strictly less information, never wrong information.
    }
  }

  if (llm && (sources.personality.trim() || sources.mesExample.trim())) {
    try {
      const raw = await llm(
        [
          { role: 'system', content: VOICE_SYSTEM },
          {
            role: 'user',
            content: voicePrompt(
              sources.characterName,
              sources.personality,
              sources.mesExample
            ),
          },
        ],
        { maxTokens: 500, signal }
      );
      llmCalls++;
      const obj = firstJsonObject(raw);
      if (obj) {
        const register = asString(obj.register, 20).toLowerCase();
        const allowed = ['formal', 'casual', 'vulgar', 'archaic', 'mixed'];
        character.personality!.voice_profile = {
          ...character.personality!.voice_profile!,
          register: (allowed.includes(register)
            ? register
            : 'mixed') as 'formal' | 'casual' | 'vulgar' | 'archaic' | 'mixed',
          speech_patterns: asString(obj.speech_patterns, 300),
          verbal_tics: asStringList(obj.verbal_tics, 8),
          vocabulary_signals: {
            favored: asStringList(obj.favored_words, 12),
            avoided: asStringList(obj.avoided_words, 12),
          },
        };
        character.provenance!.push(
          inferenceRef('voice register inferred from personality and examples')
        );
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
    }
  }

  return {
    entities: { characters, objects: [], factions: [] },
    world,
    renderingHints,
    llmCalls,
    rulesDropped,
  };
}
