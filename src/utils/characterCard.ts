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
 * Convert CharacterInfo to Character Card V2 format.
 *
 * If the caller supplies `characterBook`, it is embedded at
 * `data.character_book` so the V2 card is self-contained.
 */
export function characterToCardV2(
  character: CharacterInfo,
  characterBook?: CharacterBookV2
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

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
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
      ...(characterBook ? { character_book: characterBook } : {}),
      extensions,
    },
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
 * Convert Character Card V2 or import data to CharacterInfo format
 */
export function cardToCharacterInfo(
  card: CharacterCardV2 | CharacterExportData
): Partial<CharacterInfo> {
  if (isCharacterCardV2(card)) {
    // V2 card format
    const depthPrompt = card.data.extensions?.depth_prompt;
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
        },
      },
    };
  }

  // Simple export format (CharacterExportData)
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
      extensions: card.depth_prompt ? { depth_prompt: card.depth_prompt } : {},
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

/**
 * Extract character data from a PNG file's tEXt chunk
 * Character Card format stores base64-encoded JSON in a tEXt chunk with keyword "chara"
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

  // Parse PNG chunks
  let offset = 8;
  while (offset < data.length) {
    const length = readUint32BE(data, offset);
    const typeBytes = data.slice(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);

    if (type === 'tEXt') {
      // tEXt chunk: keyword\0text
      const chunkData = data.slice(offset + 8, offset + 8 + length);

      // Find null separator
      let nullIndex = 0;
      while (nullIndex < chunkData.length && chunkData[nullIndex] !== 0) {
        nullIndex++;
      }

      const keyword = String.fromCharCode(...chunkData.slice(0, nullIndex));

      if (keyword === 'chara') {
        // Found character data - decode from base64
        const textData = chunkData.slice(nullIndex + 1);
        const base64String = String.fromCharCode(...textData);

        try {
          // atob() returns a binary string; decode as UTF-8 so non-ASCII
          // characters (em-dashes, smart quotes, emoji) survive import.
          const binary = atob(base64String);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const jsonString = new TextDecoder('utf-8').decode(bytes);
          const charData = JSON.parse(jsonString);

          // Check if it's V2/V3 format
          if (charData.spec === 'chara_card_v2' || charData.spec === 'chara_card_v3') {
            return charData as CharacterCardV2;
          }

          // Legacy V1 format - convert to our simple format
          return {
            name: charData.name || charData.char_name || '',
            description: charData.description || '',
            personality: charData.personality || '',
            first_mes: charData.first_mes || '',
            scenario: charData.scenario || '',
            mes_example: charData.mes_example || '',
            creator_notes: charData.creator_notes || '',
            creator: charData.creator || '',
            tags: charData.tags || [],
          } as CharacterExportData;
        } catch {
          throw new Error('Failed to parse character data from PNG');
        }
      }
    }

    // Move to next chunk (length + type + data + crc)
    offset += 12 + length;
  }

  return null;
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

/**
 * Embed character data into a PNG file
 * Returns a new PNG blob with the character data in a tEXt chunk
 */
export async function embedCharacterInPNG(
  imageBlob: Blob,
  character: CharacterInfo,
  characterBook?: CharacterBookV2
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

  // Convert character to V2 card and encode as base64. Mirror the decode
  // path: encode the JSON to UTF-8 bytes first, then base64. Raw btoa()
  // throws on any character above U+00FF (em-dashes, smart quotes, emoji,
  // CJK), which is exactly what real character cards contain.
  const cardData = characterToCardV2(character, characterBook);
  const jsonString = JSON.stringify(cardData);
  const utf8Bytes = new TextEncoder().encode(jsonString);
  let binary = '';
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  const base64Data = btoa(binary);

  // Create the tEXt chunk
  const textChunk = createTextChunk('chara', base64Data);

  // Find IEND chunk and insert tEXt before it
  let offset = 8;
  let iendOffset = -1;

  while (offset < data.length) {
    const length = readUint32BE(data, offset);
    const typeBytes = data.slice(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);

    if (type === 'IEND') {
      iendOffset = offset;
      break;
    }

    offset += 12 + length;
  }

  if (iendOffset === -1) {
    throw new Error('Invalid PNG: IEND chunk not found');
  }

  // Build new PNG: signature + chunks before IEND + tEXt + IEND
  const beforeIEND = data.slice(0, iendOffset);
  const iendChunk = data.slice(iendOffset);

  const newPNG = new Uint8Array(
    beforeIEND.length + textChunk.length + iendChunk.length
  );
  newPNG.set(beforeIEND, 0);
  newPNG.set(textChunk, beforeIEND.length);
  newPNG.set(iendChunk, beforeIEND.length + textChunk.length);

  return new Blob([newPNG], { type: 'image/png' });
}

/**
 * Export character as JSON file (as Character Card V2 so advanced fields survive)
 */
export function exportCharacterAsJSON(
  character: CharacterInfo,
  characterBook?: CharacterBookV2
): Blob {
  const cardV2 = characterToCardV2(character, characterBook);
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

  try {
    const data = JSON.parse(text);

    // Check if it's V2/V3 format
    if (data.spec === 'chara_card_v2' || data.spec === 'chara_card_v3') {
      return data as CharacterCardV2;
    }

    // Detect lorebook / world-info exports: they have `entries` but no
    // character card fields.  Throw a typed error so the UI can offer to
    // import it as a lorebook instead of silently creating an empty character.
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

    // Return as simple export format
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
      talkativeness: data.talkativeness,
    } as CharacterExportData;
  } catch {
    throw new Error('Invalid JSON file');
  }
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
