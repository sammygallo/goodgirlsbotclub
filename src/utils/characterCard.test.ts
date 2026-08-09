import { describe, it, expect } from 'vitest';
import {
  embedCharacterInPNG,
  extractCharacterFromPNG,
  cardToCharacterInfo,
  characterToCardV2,
  parseCharacterFromJSON,
  LorebookDetectedError,
  type CharacterBookV2,
  type CharacterCardV2,
  type CharacterExportData,
} from './characterCard';
import type { CharacterInfo } from '../api/client';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Build a PNG chunk. CRC is left zeroed — nothing in the reader checks it. */
function chunk(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

function textChunk(keyword: string, text: string): Uint8Array {
  const kw = new TextEncoder().encode(keyword);
  const body = new TextEncoder().encode(text);
  const payload = new Uint8Array(kw.length + 1 + body.length);
  payload.set(kw, 0);
  payload.set(body, kw.length + 1);
  return chunk('tEXt', payload);
}

/** A minimal structurally-valid PNG: signature, IHDR, any extras, IEND. */
function makePng(extras: Uint8Array[] = []): Blob {
  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunk('IHDR', new Uint8Array(13)),
    ...extras,
    chunk('IEND'),
  ];
  return new Blob(parts as BlobPart[], { type: 'image/png' });
}

/** Every tEXt keyword in the file, in order. */
async function textKeywords(blob: Blob): Promise<string[]> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(data.buffer);
  const keywords: string[] = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(...data.slice(offset + 4, offset + 8));
    if (type === 'tEXt') {
      const payload = data.slice(offset + 8, offset + 8 + length);
      const nul = payload.indexOf(0);
      keywords.push(String.fromCharCode(...payload.slice(0, nul)));
    }
    offset += 12 + length;
  }
  return keywords;
}

async function readCard(blob: Blob): Promise<CharacterCardV2> {
  const file = new File([blob], 'card.png', { type: 'image/png' });
  const card = await extractCharacterFromPNG(file);
  return card as CharacterCardV2;
}

const character: CharacterInfo = {
  name: 'Mira',
  avatar: 'Mira.png',
  description: 'A courier — she remembers every road.',
  data: { description: 'A courier — she remembers every road.' },
};

function book(entryContent: string): CharacterBookV2 {
  return {
    name: 'Mira Lorebook',
    entries: [
      {
        keys: ['road'],
        content: entryContent,
        enabled: true,
        extensions: { ggbc_critical: true },
      },
    ],
  };
}

describe('embedCharacterInPNG', () => {
  it('writes the card to both a ccv3 and a chara chunk', async () => {
    const out = await embedCharacterInPNG(makePng(), character, book('The old road'));

    expect(await textKeywords(out)).toEqual(['ccv3', 'chara']);
    const card = await readCard(out);
    // ccv3 now wins on read (see extractCharacterFromPNG precedence), and
    // it carries a genuine v3 payload rather than a v2 payload mislabeled
    // as v3 — so the chunk read back here is chara_card_v3, not v2.
    expect(card.spec).toBe('chara_card_v3');
    expect(card.data.name).toBe('Mira');
    expect(card.data.character_book?.entries[0].content).toBe('The old road');
  });

  it('replaces card chunks already in the image instead of appending', async () => {
    // Stand-in for a server export: the PNG already carries a card whose
    // lorebook is a version behind.
    const stale = await embedCharacterInPNG(makePng(), character, book('stale entry'));
    const fresh = await embedCharacterInPNG(stale, character, book('fresh entry'));

    expect(await textKeywords(fresh)).toEqual(['ccv3', 'chara']);
    const card = await readCard(fresh);
    expect(card.data.character_book?.entries[0].content).toBe('fresh entry');
  });

  it('leaves unrelated tEXt chunks alone', async () => {
    const png = makePng([textChunk('Software', 'GGBC')]);
    const out = await embedCharacterInPNG(png, character, undefined);

    expect(await textKeywords(out)).toEqual(['Software', 'ccv3', 'chara']);
  });

  it('omits character_book when the character has no lorebook', async () => {
    const out = await embedCharacterInPNG(makePng(), character, undefined);

    const card = await readCard(out);
    expect(card.data.character_book).toBeUndefined();
  });

  it('round-trips non-ASCII card text', async () => {
    const out = await embedCharacterInPNG(
      makePng(),
      { ...character, name: 'ミラ', description: '“smart quotes” — and an emoji 🜁' },
      undefined,
    );

    const card = await readCard(out);
    expect(card.data.name).toBe('ミラ');
    expect(card.data.description).toBe('“smart quotes” — and an emoji 🜁');
  });

  it('rejects a file that is not a PNG', async () => {
    const notPng = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8])]);
    await expect(embedCharacterInPNG(notPng, character, undefined)).rejects.toThrow(
      'Invalid PNG file',
    );
  });

  it('rejects a PNG with no IEND chunk', async () => {
    const headless = new Blob([
      new Uint8Array(PNG_SIGNATURE),
      chunk('IHDR', new Uint8Array(13)),
    ] as BlobPart[]);
    await expect(embedCharacterInPNG(headless, character, undefined)).rejects.toThrow(
      'IEND chunk not found',
    );
  });
});

/** Base64-encode an arbitrary object the way the source encodes a card:
 *  JSON.stringify → UTF-8 bytes → base64 (mirrors characterCard.ts's
 *  internal encodeCardBase64, which isn't exported). */
function toBase64Card(obj: unknown): string {
  const jsonString = JSON.stringify(obj);
  const utf8Bytes = new TextEncoder().encode(jsonString);
  let binary = '';
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binary);
}

/** Reverse of toBase64Card: base64 → UTF-8 bytes → JSON.parse. Mirrors the
 *  source's internal decodeCardPayload decoding step. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeBase64Json(base64String: string): any {
  const binary = atob(base64String);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const jsonString = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(jsonString);
}

/** Raw base64 text stored under a specific tEXt keyword (undefined if the
 *  keyword isn't present as a tEXt chunk in the file). Unlike textKeywords,
 *  this returns the payload text itself, not just the keyword list. */
async function readChunkPayload(blob: Blob, keyword: string): Promise<string | undefined> {
  const data = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(data.buffer);
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(...data.slice(offset + 4, offset + 8));
    if (type === 'tEXt') {
      const payload = data.slice(offset + 8, offset + 8 + length);
      const nul = payload.indexOf(0);
      const kw = String.fromCharCode(...payload.slice(0, nul));
      if (kw === keyword) {
        return String.fromCharCode(...payload.slice(nul + 1));
      }
    }
    offset += 12 + length;
  }
  return undefined;
}

/** Like readCard, but doesn't assume the result is a V2/V3 card — used for
 *  the V1/legacy-format assertions where extractCharacterFromPNG resolves
 *  to CharacterExportData instead of CharacterCardV2. */
async function extractRaw(blob: Blob): Promise<CharacterCardV2 | CharacterExportData | null> {
  const file = new File([blob], 'card.png', { type: 'image/png' });
  return extractCharacterFromPNG(file);
}

/** A minimal, valid V2/V3 card, varying only name and spec. */
function buildCard(name: string, spec: 'chara_card_v2' | 'chara_card_v3'): CharacterCardV2 {
  return {
    spec,
    spec_version: (spec === 'chara_card_v3' ? '3.0' : '2.0') as '2.0' | '3.0',
    data: {
      name,
      description: 'desc',
      personality: '',
      first_mes: '',
      scenario: '',
      mes_example: '',
      creator_notes: '',
      creator: '',
      tags: [],
    },
  };
}

/** A zTXt chunk carrying `keyword` whose "compressed" bytes are garbage
 *  (not valid zlib), used to prove one malformed optional chunk doesn't
 *  take down the whole parse. */
function malformedZtxtChunk(keyword: string, garbage: number[]): Uint8Array {
  const kw = new TextEncoder().encode(keyword);
  const payload = new Uint8Array(kw.length + 1 + 1 + garbage.length);
  payload.set(kw, 0);
  payload[kw.length] = 0; // keyword/text null separator
  payload[kw.length + 1] = 0; // compression method byte (0 = zlib)
  payload.set(new Uint8Array(garbage), kw.length + 2);
  return chunk('zTXt', payload);
}

/** A V1-shaped (no `spec`) legacy card exercising every field the
 *  PNG/JSON V1 parity fix covers, including a NUMERIC talkativeness. */
function v1LegacyData() {
  return {
    name: 'Legacy',
    description: 'A legacy card',
    personality: 'kind',
    first_mes: 'hi there',
    scenario: 'a scenario',
    mes_example: 'an example',
    creator_notes: 'some notes',
    creator: 'someone',
    tags: ['a', 'b'],
    character_version: '1.2',
    system_prompt: 'sys prompt',
    post_history_instructions: 'phi',
    alternate_greetings: ['alt1', 'alt2'],
    depth_prompt: { prompt: 'depth note', depth: 3, role: 'system' },
    talkativeness: 0.7,
  };
}

function expectV1FieldParity(result: CharacterExportData) {
  expect(result.name).toBe('Legacy');
  expect(result.character_version).toBe('1.2');
  expect(result.system_prompt).toBe('sys prompt');
  expect(result.post_history_instructions).toBe('phi');
  expect(result.alternate_greetings).toEqual(['alt1', 'alt2']);
  expect(result.depth_prompt).toEqual({ prompt: 'depth note', depth: 3, role: 'system' });
  expect(result.talkativeness).toBe('0.7');
}

describe('extractCharacterFromPNG — ccv3/chara chunk precedence', () => {
  it('parses a PNG whose only card chunk is ccv3 (no chara chunk at all)', async () => {
    const png = makePng([textChunk('ccv3', toBase64Card(buildCard('Ccv3Only', 'chara_card_v3')))]);
    const card = (await extractRaw(png)) as CharacterCardV2;

    expect(card).not.toBeNull();
    expect(card.data.name).toBe('Ccv3Only');
  });

  it('returns the ccv3 chunk content when both chara and ccv3 are present with different names', async () => {
    const png = makePng([
      textChunk('chara', toBase64Card(buildCard('CharaName', 'chara_card_v2'))),
      textChunk('ccv3', toBase64Card(buildCard('Ccv3Name', 'chara_card_v3'))),
    ]);
    const card = (await extractRaw(png)) as CharacterCardV2;

    expect(card.data.name).toBe('Ccv3Name');
  });
});

describe('embedCharacterInPNG — ccv3 vs chara payload content', () => {
  it('writes a real, differently-shaped v3 card into ccv3 and v2 card into chara', async () => {
    const out = await embedCharacterInPNG(makePng(), character, undefined);

    const ccv3Text = await readChunkPayload(out, 'ccv3');
    const charaText = await readChunkPayload(out, 'chara');
    expect(ccv3Text).toBeDefined();
    expect(charaText).toBeDefined();
    expect(ccv3Text).not.toBe(charaText);

    const ccv3Json = decodeBase64Json(ccv3Text!);
    const charaJson = decodeBase64Json(charaText!);

    expect(ccv3Json.spec).toBe('chara_card_v3');
    expect(ccv3Json.spec_version).toBe('3.0');
    expect(Array.isArray(ccv3Json.data.group_only_greetings)).toBe(true);

    expect(charaJson.spec).toBe('chara_card_v2');
    expect(charaJson.spec_version).toBe('2.0');
    expect(charaJson.data.group_only_greetings).toBeUndefined();
  });
});

describe('parseCharacterFromJSON — V1 legacy field parity', () => {
  it('maps every V1 field, coercing a numeric talkativeness to a string', async () => {
    const file = new File([JSON.stringify(v1LegacyData())], 'legacy.json', {
      type: 'application/json',
    });

    const result = (await parseCharacterFromJSON(file)) as CharacterExportData;
    expectV1FieldParity(result);
  });
});

describe('extractCharacterFromPNG — V1 legacy field parity (PNG side)', () => {
  it('maps every V1 field the same way as the JSON path for a PNG-embedded V1 card', async () => {
    const png = makePng([textChunk('chara', toBase64Card(v1LegacyData()))]);

    const result = (await extractRaw(png)) as CharacterExportData;
    expectV1FieldParity(result);
  });
});

describe('cardToCharacterInfo — unknown-key passthrough and book/asset exclusion', () => {
  it('carries an unknown data key through but strips character_book and assets', () => {
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Test',
        description: '',
        personality: '',
        first_mes: '',
        scenario: '',
        mes_example: '',
        creator_notes: '',
        creator: '',
        tags: [],
        character_book: { name: 'Book', entries: [] },
        assets: [{ type: 'icon', uri: 'ccdefault' }],
        nickname: 'Mimi',
      },
    } as unknown as CharacterCardV2;

    const info = cardToCharacterInfo(card);
    const data = info.data as unknown as Record<string, unknown> | undefined;

    expect(data?.nickname).toBe('Mimi');
    expect(data?.character_book).toBeUndefined();
    expect(data?.assets).toBeUndefined();
    expect(!!data && 'character_book' in data).toBe(false);
    expect(!!data && 'assets' in data).toBe(false);
  });
});

describe('characterToCardV2 — third-party extension namespace passthrough', () => {
  it('preserves an unrecognized extensions namespace on round trip', () => {
    const withChub: CharacterInfo = {
      ...character,
      data: {
        ...character.data,
        extensions: { chub: { foo: 'bar' } },
      },
    };

    const card = characterToCardV2(withChub);
    expect(card.data.extensions?.chub).toEqual({ foo: 'bar' });
  });
});

describe('parseCharacterFromJSON — lorebook detection', () => {
  it('throws LorebookDetectedError, not a generic error, for an entries-shaped file with a non-card spec', async () => {
    const lorebookLike = {
      spec: 'something-else',
      entries: { '0': { key: ['x'], content: 'y' } },
    };
    const file = new File([JSON.stringify(lorebookLike)], 'lore.json', {
      type: 'application/json',
    });

    let caught: unknown;
    try {
      await parseCharacterFromJSON(file);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LorebookDetectedError);
    expect((caught as LorebookDetectedError).entryCount).toBe(1);
  });
});

describe('extractCharacterFromPNG — malformed optional chunk resilience', () => {
  it('skips a malformed zTXt chunk and still reads a valid chara chunk elsewhere in the file', async () => {
    const badZtxt = malformedZtxtChunk('ccv3', [0xff, 0x00, 0x13, 0x37, 0x99, 0x00]);
    const validChara = textChunk('chara', toBase64Card(buildCard('SurvivingChara', 'chara_card_v2')));
    const png = makePng([badZtxt, validChara]);

    const card = (await extractRaw(png)) as CharacterCardV2;
    expect(card).not.toBeNull();
    expect(card.data.name).toBe('SurvivingChara');
  });
});
