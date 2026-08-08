// Character Card utilities for import/export functionality
// Supports Character Card V2 format (PNG with embedded JSON metadata)

import type { CharacterInfo } from '../api/client';

/**
 * Thrown when a JSON file turns out to be a lorebook / world-info export
 * (`{ entries: { ... } }`) instead of a character card.
 */
export class LorebookDetectedError extends Error {
  readonly entryCount: number;
  constructor(entryCount: number) {
    super(
      `This file is a lorebook / world-info export with ${entryCount} entries, not a character card.`
    );
    this.name = 'LorebookDetectedError';
    this.entryCount = entryCount;
  }
}

// Character Book V2 spec format (embedded inside a character card).
// This is the on-disk/wire format used by SillyTavern for
// `data.character_book`. Our internal representation
// (`WorldInfoBook` / `WorldInfoEntry`) is converted to/from this shape
// in `worldInfoStore.ts`.
export interface CharacterBookEntryV2 {
  keys: string[];
  content: string;
  extensions?: Record<string, unknown>;
  enabled?: boolean;
  insertion_order?: number;
  case_sensitive?: boolean;
  name?: string;
  priority?: number;
  id?: number;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  constant?: boolean;
  position?: 'before_char' | 'after_char';
}

export interface CharacterBookV2 {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions?: Record<string, unknown>;
  entries: CharacterBookEntryV2[];
}

// Character Card V2/V3 specification format (V3 is structurally identical)
export interface CharacterCardV2 {
  spec: 'chara_card_v2' | 'chara_card_v3';
  spec_version: '2.0' | '3.0';
  data: {
    name: string;
    description: string;
    personality: string;
    first_mes: string;
    scenario: string;
    mes_example: string;
    creator_notes: string;
    creator: string;
    tags: string[];
    character_version?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    character_book?: CharacterBookV2;
    /** V3-only. Preserved through import/export once present; export only
     *  ever sets it to [] when the card never had one. */
    group_only_greetings?: string[];
    extensions?: {
      depth_prompt?: {
        prompt?: string;
        depth?: number;
        role?: string;
      };
      talkativeness?: string;
      fav?: boolean;
      [key: string]: unknown;
    };
  };
}

// Simple JSON export format (for compatibility)
export interface CharacterExportData {
  name: string;
  description: string;
  personality: string;
  first_mes: string;
  scenario: string;
  mes_example: string;
  creator_notes: string;
  creator: string;
  tags: string[];
  character_version?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  depth_prompt?: {
    prompt?: string;
    depth?: number;
    role?: string;
  };
  talkativeness?: string;
  avatar_base64?: string;
}

/**
 * Book-level fields that don't survive the native-lorebook round trip: the
 * backend's Lorebook table has fixed columns, not a free-form slot for
 * `description`/`scan_depth`/`token_budget`/`recursive_scanning`/book-level
 * `extensions`. When these are known (stashed in import provenance — see
 * Phase 1), pass them here so an export doesn't silently drop metadata the
 * original card had.
 */
export interface CharacterBookMeta {
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions?: Record<string, unknown>;
}

function mergeBookMeta(
  book: CharacterBookV2 | undefined,
  meta: CharacterBookMeta | undefined
): CharacterBookV2 | undefined {
  if (!book || !meta) return book;
  return {
    ...book,
    description: book.description ?? meta.description,
    scan_depth: book.scan_depth ?? meta.scan_depth,
    token_budget: book.token_budget ?? meta.token_budget,
    recursive_scanning: book.recursive_scanning ?? meta.recursive_scanning,
    extensions: { ...(meta.extensions || {}), ...(book.extensions || {}) },
  };
}

/**
 * Convert CharacterInfo to Character Card V2 format.
 *
 * If the caller supplies `characterBook`, it is embedded at
 * `data.character_book` so the V2 card is self-contained. Any card-data key
 * we don't explicitly normalize (V3-only fields, third-party extension
 * namespaces) is carried through untouched via `extraCardData`, so a saved
 * character exports with everything it was imported with.
 */
export function characterToCardV2(
  character: CharacterInfo,
  characterBook?: CharacterBookV2,
  bookMeta?: CharacterBookMeta
): CharacterCardV2 {
  const extensions: CharacterCardV2['data']['extensions'] = {
    ...(character.data?.extensions || {}),
  };

  // Preserve depth prompt (character's note)
  const depthPrompt = character.data?.extensions?.depth_prompt;
  if (depthPrompt && (depthPrompt.prompt || depthPrompt.depth !== undefined || depthPrompt.role)) {
    extensions.depth_prompt = depthPrompt;
  }

  // Preserve talkativeness
  const talkativeness = character.data?.extensions?.talkativeness;
  if (talkativeness !== undefined) {
    extensions.talkativeness = talkativeness;
  }

  const mergedBook = mergeBookMeta(characterBook, bookMeta);

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...extraCardData((character.data || {}) as Record<string, unknown>),
      name: character.name || '',
      description: character.description || character.data?.description || '',
      personality: character.personality || character.data?.personality || '',
      first_mes: character.first_mes || character.data?.first_mes || '',
      scenario: character.scenario || character.data?.scenario || '',
      mes_example: character.mes_example || character.data?.mes_example || '',
      creator_notes: character.creator_notes || character.data?.creator_notes || '',
      creator: character.creator || character.data?.creator || '',
      tags: character.tags || character.data?.tags || [],
      character_version: character.character_version || character.data?.character_version || '',
      system_prompt: character.system_prompt || character.data?.system_prompt || '',
      post_history_instructions:
        character.post_history_instructions || character.data?.post_history_instructions || '',
      alternate_greetings: character.alternate_greetings || character.data?.alternate_greetings || [],
      ...(mergedBook ? { character_book: mergedBook } : {}),
      extensions,
    } as CharacterCardV2['data'],
  };
}

/**
 * Convert CharacterInfo to a Character Card V3 object.
 *
 * V3 shares the same core fields as V2 (built via `characterToCardV2`) plus
 * V3-only markers. This exists so the PNG `ccv3` chunk carries a genuinely
 * versioned card instead of a V2 payload mislabeled as V3 — the previous
 * behavior wrote the same v2 JSON into both chunks, which a strict V3
 * reader sees as self-contradicting (`spec: 'chara_card_v3'` claimed by the
 * keyword, `spec_version: '2.0'` claimed by the payload).
 */
export function characterToCardV3(
  character: CharacterInfo,
  characterBook?: CharacterBookV2,
  bookMeta?: CharacterBookMeta
): CharacterCardV2 {
  const v2 = characterToCardV2(character, characterBook, bookMeta);
  const existingGroupGreetings = (v2.data as Record<string, unknown>).group_only_greetings;
  return {
    ...v2,
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      ...v2.data,
      group_only_greetings: Array.isArray(existingGroupGreetings)
        ? (existingGroupGreetings as string[])
        : [],
    } as CharacterCardV2['data'],
  };
}

/**
 * Normalize a raw `entries` payload into a `CharacterBookEntryV2[]`.
 *
 * V2/V3 spec calls for entries to be an array, but a lot of cards in the
 * wild (especially ones exported from SillyTavern) embed entries as a keyed
 * object map (`{"0": {...}, "1": {...}}`) instead. Without this normalizer
 * the whole lorebook is silently dropped on import — the bot speaks in
 * character but knows nothing the lorebook would have provided. See
 * https://github.com/sammygallo/goodgirlsbotclub/issues/206.
 *
 * Returns the normalized array, or `null` if the shape is unrecognizable.
 */
export function normalizeCharacterBookEntries(
  entries: unknown
): CharacterBookEntryV2[] | null {
  if (Array.isArray(entries)) {
    return entries as CharacterBookEntryV2[];
  }
  if (entries === null || typeof entries !== 'object') {
    return null;
  }
  // SillyTavern native world-info shape: keyed object {"0": {...}, "1": {...}}.
  // Translate ST field names + numeric extension fields into the V2 spec
  // shape so downstream conversion (`entryFromCharacterBookV2`) works.
  return Object.values(
    entries as Record<string, Record<string, unknown>>
  ).map((e) => ({
    keys: Array.isArray(e.key) ? (e.key as string[]) : [],
    content: typeof e.content === 'string' ? e.content : '',
    comment: typeof e.comment === 'string' ? e.comment : '',
    name: typeof e.comment === 'string' ? e.comment : '',
    enabled: e.disable !== true,
    insertion_order: typeof e.order === 'number' ? e.order : 0,
    case_sensitive: e.caseSensitive === true,
    selective: e.selective === true,
    secondary_keys: Array.isArray(e.keysecondary) ? (e.keysecondary as string[]) : [],
    constant: e.constant === true,
    id: typeof e.uid === 'number' ? e.uid : undefined,
    extensions: {
      position: typeof e.position === 'number' ? e.position : 0,
      selectiveLogic: typeof e.selectiveLogic === 'number' ? e.selectiveLogic : 0,
      depth: typeof e.depth === 'number' ? e.depth : 4,
      scan_depth: e.scanDepth ?? null,
      probability: typeof e.probability === 'number' ? e.probability : 100,
      useProbability: e.useProbability === true,
      group: typeof e.group === 'string' ? e.group : '',
      group_override: e.groupOverride === true,
      group_weight: typeof e.groupWeight === 'number' ? e.groupWeight : 100,
      prevent_recursion: e.preventRecursion === true,
      exclude_recursion: e.excludeRecursion === true,
      sticky: typeof e.sticky === 'number' ? e.sticky : 0,
      cooldown: typeof e.cooldown === 'number' ? e.cooldown : 0,
      delay: typeof e.delay === 'number' ? e.delay : 0,
      // GGBC extensions written by our own ST-format export (entryToStFormat
      // puts them top-level); real SillyTavern exports simply lack them.
      ...(typeof e.ggbcId === 'string' ? { ggbc_id: e.ggbcId } : {}),
      critical: e.critical === true,
      category: typeof e.category === 'string' ? e.category : '',
      related_ids: Array.isArray(e.relatedIds)
        ? (e.relatedIds as unknown[]).filter(
            (id): id is string => typeof id === 'string'
          )
        : [],
    },
  }));
}

/**
 * Pull the embedded character_book off an imported card (if any).
 * Returns null when the data is missing or unrecognizable.
 *
 * Accepts both spec-shaped entries (an array) and SillyTavern's native
 * keyed-object shape — the latter is what trips up otherwise-valid V2
 * cards exported straight out of ST.
 */
export function extractCharacterBook(
  card: CharacterCardV2 | CharacterExportData | null | undefined
): CharacterBookV2 | null {
  if (!card) return null;
  if ('spec' in card && (card.spec === 'chara_card_v2' || card.spec === 'chara_card_v3')) {
    const book = card.data.character_book;
    if (!book || typeof book !== 'object') return null;
    const entries = normalizeCharacterBookEntries(
      (book as { entries?: unknown }).entries
    );
    if (!entries) return null;
    return { ...(book as CharacterBookV2), entries };
  }
  return null;
}

/**
 * Type guard to check if card is V2/V3 format
 */
function isCharacterCardV2(card: CharacterCardV2 | CharacterExportData): card is CharacterCardV2 {
  return 'spec' in card && (card.spec === 'chara_card_v2' || card.spec === 'chara_card_v3');
}

/**
 * Talkativeness as the string our card shape stores. SillyTavern writes it
 * as a NUMBER (0.5); accepting only strings silently dropped it from every
 * real ST card.
 */
function coerceTalkativeness(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Flatten a legacy V1 card object into CharacterExportData. Shared by the
 * PNG and JSON import paths — they previously diverged, with the PNG branch
 * dropping character_version, system_prompt, post_history_instructions,
 * alternate_greetings, depth_prompt, and talkativeness.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function v1ToExportData(data: Record<string, any>): CharacterExportData {
  return {
    name: data.name || data.char_name || '',
    description: data.description || '',
    personality: data.personality || '',
    first_mes: data.first_mes || '',
    scenario: data.scenario || '',
    mes_example: data.mes_example || '',
    creator_notes: data.creator_notes || '',
    creator: data.creator || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    character_version: data.character_version,
    system_prompt: data.system_prompt,
    post_history_instructions: data.post_history_instructions,
    alternate_greetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings
      : undefined,
    depth_prompt: data.depth_prompt,
    talkativeness: coerceTalkativeness(data.talkativeness),
  } as CharacterExportData;
}

/** Card-data keys we normalize explicitly (or must not persist verbatim);
 *  everything else passes through untouched so V3-only and third-party
 *  fields (nickname, source, chub metadata, …) survive a round trip. */
const HANDLED_CARD_KEYS = new Set([
  'name', 'description', 'personality', 'first_mes', 'scenario', 'mes_example',
  'creator_notes', 'creator', 'tags', 'character_version', 'system_prompt',
  'post_history_instructions', 'alternate_greetings', 'extensions',
  // Never persisted into Character.data: books live as native lorebook rows
  // (see worldInfoStore), and V3 embedded assets would bloat the row.
  'character_book', 'assets',
]);

/** The pass-through slice of a card's data: unknown/V3 keys only. */
function extraCardData(data: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!HANDLED_CARD_KEYS.has(key)) extra[key] = value;
  }
  return extra;
}

/**
 * Convert Character Card V2 or import data to CharacterInfo format
 */
export function cardToCharacterInfo(
  card: CharacterCardV2 | CharacterExportData
): Partial<CharacterInfo> {
  if (isCharacterCardV2(card)) {
    // V2/V3 card format. Known fields are normalized explicitly; every other
    // data key passes through so nothing a creator shipped gets dropped.
    const depthPrompt = card.data.extensions?.depth_prompt;
    const talkativeness = coerceTalkativeness(card.data.extensions?.talkativeness);
    return {
      name: card.data.name,
      description: card.data.description,
      personality: card.data.personality,
      first_mes: card.data.first_mes,
      scenario: card.data.scenario,
      mes_example: card.data.mes_example,
      tags: card.data.tags,
      creator: card.data.creator,
      creator_notes: card.data.creator_notes,
      character_version: card.data.character_version,
      system_prompt: card.data.system_prompt,
      post_history_instructions: card.data.post_history_instructions,
      alternate_greetings: card.data.alternate_greetings,
      data: {
        ...extraCardData(card.data as unknown as Record<string, unknown>),
        name: card.data.name,
        description: card.data.description,
        personality: card.data.personality,
        first_mes: card.data.first_mes,
        scenario: card.data.scenario,
        mes_example: card.data.mes_example,
        creator_notes: card.data.creator_notes,
        creator: card.data.creator,
        tags: card.data.tags,
        character_version: card.data.character_version,
        system_prompt: card.data.system_prompt,
        post_history_instructions: card.data.post_history_instructions,
        alternate_greetings: card.data.alternate_greetings,
        extensions: {
          ...(card.data.extensions || {}),
          ...(depthPrompt ? { depth_prompt: depthPrompt } : {}),
          ...(talkativeness !== undefined ? { talkativeness } : {}),
        },
      },
    };
  }

  // Simple export format (CharacterExportData)
  const talkativeness = coerceTalkativeness(card.talkativeness);
  return {
    name: card.name,
    description: card.description,
    personality: card.personality,
    first_mes: card.first_mes,
    scenario: card.scenario,
    mes_example: card.mes_example,
    tags: card.tags,
    creator: card.creator,
    creator_notes: card.creator_notes,
    character_version: card.character_version,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
    alternate_greetings: card.alternate_greetings,
    data: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      first_mes: card.first_mes,
      scenario: card.scenario,
      mes_example: card.mes_example,
      creator_notes: card.creator_notes,
      creator: card.creator,
      tags: card.tags,
      character_version: card.character_version,
      system_prompt: card.system_prompt,
      post_history_instructions: card.post_history_instructions,
      alternate_greetings: card.alternate_greetings,
      extensions: {
        ...(card.depth_prompt ? { depth_prompt: card.depth_prompt } : {}),
        ...(talkativeness !== undefined ? { talkativeness } : {}),
      },
    },
  };
}

/**
 * PNG chunk reading utilities
 */
function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  );
}

function writeUint32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

// CRC32 table for PNG chunk verification
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Offset of the null byte separating a tEXt chunk's keyword from its text. */
function textChunkNullIndex(chunkData: Uint8Array): number {
  let i = 0;
  while (i < chunkData.length && chunkData[i] !== 0) i++;
  return i;
}

/** tEXt/zTXt/iTXt keywords that carry a character card. Both are rewritten
 *  on embed; on read, `ccv3` wins when both are present. */
const CARD_KEYWORDS = ['ccv3', 'chara'];

/** Inflate a zlib-format (RFC 1950) compressed byte buffer via the
 *  browser's native DecompressionStream. Returns null on any failure
 *  (unsupported environment, malformed data) — callers treat that as
 *  "skip this chunk" rather than failing the whole parse. */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Decode a card chunk's raw payload bytes (the base64 ASCII text every
 *  card-carrying chunk type stores) into the parsed card object. */
function decodeCardPayload(base64String: string): CharacterCardV2 | CharacterExportData {
  // atob() returns a binary string; decode as UTF-8 so non-ASCII
  // characters (em-dashes, smart quotes, emoji) survive import.
  const binary = atob(base64String);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const jsonString = new TextDecoder('utf-8').decode(bytes);
  const charData = JSON.parse(jsonString);

  if (charData.spec === 'chara_card_v2' || charData.spec === 'chara_card_v3') {
    return charData as CharacterCardV2;
  }
  // Legacy V1 format — convert to our simple format via the shared mapper
  // so PNG and JSON imports carry the same fields.
  return v1ToExportData(charData);
}

/**
 * Extract character data from a PNG file's embedded card chunk.
 *
 * Character Card data lives in a `ccv3` (V3) and/or `chara` (V2) chunk as
 * base64-encoded JSON. `chara` is read by every legacy tool; `ccv3` is what
 * V3-native exporters (RisuAI and similar) prefer, and some emit ONLY that
 * keyword — a PNG carrying `ccv3` alone previously returned "no character
 * data found" because only `chara` was read. Collected across tEXt/zTXt/
 * iTXt (each decoded independently and try/caught, so one malformed
 * optional chunk can never hide a good chunk elsewhere in the file); `ccv3`
 * wins when both are present, mirroring the backend's precedence
 * (app/util/png_card.py `extract_card`) so the two parsers agree on which
 * card a dual-chunk PNG actually is.
 */
export async function extractCharacterFromPNG(
  file: File
): Promise<CharacterCardV2 | CharacterExportData | null> {
  const buffer = await file.arrayBuffer();
  const data = new Uint8Array(buffer);

  // Verify PNG signature
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (data[i] !== pngSignature[i]) {
      throw new Error('Invalid PNG file');
    }
  }

  const payloads: Record<string, string> = {};

  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = readUint32BE(data, offset);
    const type = String.fromCharCode(...data.slice(offset + 4, offset + 8));
    const chunkData = data.slice(offset + 8, offset + 8 + length);

    if (type === 'tEXt') {
      try {
        // tEXt chunk: keyword\0text (text stored as-is, Latin-1)
        const nullIndex = textChunkNullIndex(chunkData);
        const keyword = String.fromCharCode(...chunkData.slice(0, nullIndex));
        if (CARD_KEYWORDS.includes(keyword) && !(keyword in payloads)) {
          const textBytes = chunkData.slice(nullIndex + 1);
          payloads[keyword] = String.fromCharCode(...textBytes);
        }
      } catch {
        // malformed tEXt chunk — skip, don't kill the whole parse
      }
    } else if (type === 'zTXt') {
      try {
        // zTXt chunk: keyword\0 + compression method (1 byte, always 0/zlib) + zlib data
        const nullIndex = textChunkNullIndex(chunkData);
        const keyword = String.fromCharCode(...chunkData.slice(0, nullIndex));
        if (CARD_KEYWORDS.includes(keyword) && !(keyword in payloads)) {
          const inflated = await inflateZlib(chunkData.slice(nullIndex + 2));
          if (inflated) payloads[keyword] = new TextDecoder('utf-8').decode(inflated);
        }
      } catch {
        // malformed/unsupported zTXt chunk — skip
      }
    } else if (type === 'iTXt') {
      try {
        // iTXt chunk: keyword\0 + compression flag (1) + compression method (1)
        // + language tag\0 + translated keyword\0 + text (UTF-8, optionally zlib)
        let i = textChunkNullIndex(chunkData);
        const keyword = String.fromCharCode(...chunkData.slice(0, i));
        i += 1;
        const compressionFlag = chunkData[i];
        i += 2; // skip compression flag + compression method bytes
        let langEnd = i;
        while (langEnd < chunkData.length && chunkData[langEnd] !== 0) langEnd++;
        let kwEnd = langEnd + 1;
        while (kwEnd < chunkData.length && chunkData[kwEnd] !== 0) kwEnd++;
        const textBytes = chunkData.slice(kwEnd + 1);
        if (CARD_KEYWORDS.includes(keyword) && !(keyword in payloads)) {
          if (compressionFlag === 1) {
            const inflated = await inflateZlib(textBytes);
            if (inflated) payloads[keyword] = new TextDecoder('utf-8').decode(inflated);
          } else {
            payloads[keyword] = new TextDecoder('utf-8').decode(textBytes);
          }
        }
      } catch {
        // malformed/unsupported iTXt chunk — skip
      }
    }

    // Move to next chunk (length + type + data + crc)
    offset += 12 + length;
  }

  const base64String = payloads.ccv3 ?? payloads.chara;
  if (!base64String) return null;

  try {
    return decodeCardPayload(base64String);
  } catch {
    throw new Error('Failed to parse character data from PNG');
  }
}

/**
 * Create a tEXt chunk for PNG embedding
 */
function createTextChunk(keyword: string, text: string): Uint8Array {
  const keywordBytes = new TextEncoder().encode(keyword);
  const textBytes = new TextEncoder().encode(text);

  // Chunk data: keyword + null + text
  const chunkData = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  chunkData.set(keywordBytes, 0);
  chunkData[keywordBytes.length] = 0;
  chunkData.set(textBytes, keywordBytes.length + 1);

  // Create chunk: length + type + data + crc
  const typeBytes = new TextEncoder().encode('tEXt');
  const typeAndData = new Uint8Array(4 + chunkData.length);
  typeAndData.set(typeBytes, 0);
  typeAndData.set(chunkData, 4);

  const crc = crc32(typeAndData);

  const chunk = new Uint8Array(4 + 4 + chunkData.length + 4);
  chunk.set(writeUint32BE(chunkData.length), 0);
  chunk.set(typeBytes, 4);
  chunk.set(chunkData, 8);
  chunk.set(writeUint32BE(crc), 8 + chunkData.length);

  return chunk;
}

/** Base64-encode a card object the way an embedded chunk stores it: JSON →
 *  UTF-8 bytes → base64. Raw btoa() throws on any character above U+00FF
 *  (em-dashes, smart quotes, emoji, CJK) — exactly what real character
 *  cards contain — so the UTF-8 bytes are re-mapped through
 *  String.fromCharCode first, mirroring the decode path in reverse. */
function encodeCardBase64(card: CharacterCardV2): string {
  const jsonString = JSON.stringify(card);
  const utf8Bytes = new TextEncoder().encode(jsonString);
  let binary = '';
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binary);
}

/**
 * Embed character data into a PNG file.
 *
 * Returns a new PNG blob carrying a genuine V3 card in its `ccv3` tEXt
 * chunk and a genuine V2 card in `chara` — v3 readers and v2/legacy readers
 * each see a correctly self-described payload, rather than both chunks
 * holding the same v2 JSON with `ccv3` mislabeling it as V3. Any card
 * chunks already in the image (tEXt, zTXt, or iTXt — matching everything
 * `extractCharacterFromPNG` can read) are stripped first, so the result
 * holds exactly one card even when the input was itself an export. This
 * mirrors ggbc-backend's `embed_card` (app/util/png_card.py); the two must
 * stay in step or the same character exports differently depending on
 * which path produced the file.
 */
export async function embedCharacterInPNG(
  imageBlob: Blob,
  character: CharacterInfo,
  characterBook?: CharacterBookV2,
  bookMeta?: CharacterBookMeta
): Promise<Blob> {
  const buffer = await imageBlob.arrayBuffer();
  const data = new Uint8Array(buffer);

  // Verify PNG signature
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (data[i] !== pngSignature[i]) {
      throw new Error('Invalid PNG file');
    }
  }

  const cardChunks = [
    createTextChunk('ccv3', encodeCardBase64(characterToCardV3(character, characterBook, bookMeta))),
    createTextChunk('chara', encodeCardBase64(characterToCardV2(character, characterBook, bookMeta))),
  ];

  // Copy the chunk stream through, dropping stale card chunks (any
  // tEXt/zTXt/iTXt chunk carrying a CARD_KEYWORDS keyword) and inserting
  // the new ones just before IEND.
  const parts: Uint8Array[] = [data.slice(0, 8)];
  let inserted = false;
  let offset = 8;

  while (offset + 8 <= data.length) {
    const length = readUint32BE(data, offset);
    const type = String.fromCharCode(...data.slice(offset + 4, offset + 8));
    const end = offset + 12 + length;

    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      try {
        const chunkData = data.slice(offset + 8, offset + 8 + length);
        const nullIndex = textChunkNullIndex(chunkData);
        const keyword = String.fromCharCode(...chunkData.slice(0, nullIndex));
        if (CARD_KEYWORDS.includes(keyword)) {
          offset = end;
          continue;
        }
      } catch {
        // malformed chunk we can't identify — leave it in place untouched
      }
    }

    if (type === 'IEND' && !inserted) {
      parts.push(...cardChunks);
      inserted = true;
    }

    parts.push(data.slice(offset, end));
    offset = end;
  }

  if (!inserted) {
    throw new Error('Invalid PNG: IEND chunk not found');
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const newPNG = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    newPNG.set(part, cursor);
    cursor += part.length;
  }

  return new Blob([newPNG], { type: 'image/png' });
}

/**
 * Export character as JSON file (as Character Card V2 so advanced fields survive)
 *
 * V2 stays the JSON default: it's the widest-compatibility interchange
 * format, and unlike the PNG export (which can carry both a `ccv3` and a
 * `chara` chunk in one file) a JSON export has no equivalent way to offer
 * both versions at once.
 */
export function exportCharacterAsJSON(
  character: CharacterInfo,
  characterBook?: CharacterBookV2,
  bookMeta?: CharacterBookMeta
): Blob {
  const cardV2 = characterToCardV2(character, characterBook, bookMeta);
  const jsonString = JSON.stringify(cardV2, null, 2);
  return new Blob([jsonString], { type: 'application/json' });
}

/**
 * Try to parse a JSON file as a standalone lorebook (CharacterBookV2).
 * Handles both CharacterBookV2 format (entries array) and SillyTavern native
 * world-info format (entries keyed object like {"0": {...}, "1": {...}}).
 * Returns null if the file is a character card or can't be parsed as a lorebook.
 */
export async function parseLorebookFromJSON(file: File): Promise<CharacterBookV2 | null> {
  try {
    const data = JSON.parse(await file.text());
    if (data === null || typeof data !== 'object' || 'spec' in data) return null;

    const entries = normalizeCharacterBookEntries(
      (data as { entries?: unknown }).entries
    );
    if (!entries) return null;

    return {
      name: typeof (data as { name?: unknown }).name === 'string'
        ? (data as { name: string }).name
        : undefined,
      entries,
    };
  } catch {
    return null;
  }
}

/**
 * Parse character from JSON file
 */
export async function parseCharacterFromJSON(
  file: File
): Promise<CharacterExportData | CharacterCardV2> {
  const text = await file.text();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }

  // Check if it's V2/V3 format
  if (data.spec === 'chara_card_v2' || data.spec === 'chara_card_v3') {
    return data as CharacterCardV2;
  }

  // Detect lorebook / world-info exports: they have `entries` but no
  // character card fields. This throw is now OUTSIDE the JSON.parse
  // try/catch above — previously it was caught by a wrapping try and
  // rethrown as a generic "Invalid JSON file", so the UI's "import this as
  // a lorebook instead" offer never actually fired.
  if (
    data.entries &&
    typeof data.entries === 'object' &&
    !data.name &&
    !data.first_mes &&
    !data.char_name
  ) {
    const count = Object.keys(data.entries).length;
    throw new LorebookDetectedError(count);
  }

  // Legacy V1 / bare-object format, via the shared mapper so this stays in
  // parity with the PNG import path (character_version, system_prompt,
  // post_history_instructions, alternate_greetings, depth_prompt, and a
  // properly coerced talkativeness).
  return v1ToExportData(data);
}

/**
 * Download a file in the browser
 */
export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Fetch an image as a Blob
 */
export async function fetchImageAsBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  return response.blob();
}
