import { describe, it, expect } from 'vitest';
import {
  embedCharacterInPNG,
  extractCharacterFromPNG,
  type CharacterBookV2,
  type CharacterCardV2,
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
    expect(card.spec).toBe('chara_card_v2');
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
