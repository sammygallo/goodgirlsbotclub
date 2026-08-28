/**
 * `buildEmptyResponseError`'s three branches (review round 1 fix for
 * F4/F11/F19).
 *
 * The function had NO test at all before this file: it is module-private,
 * and grepping the suite for its name, or for any of its distinctive copy
 * fragments, hit only unrelated lore/tokenizer tests. Its overBudget branch
 * is also the one #453 was filed to fix (attributing an over-budget empty
 * completion to "your message alone" was the original misdiagnosis) — this
 * diff corrects a SECOND-order version of the same mistake: the rewritten
 * string named the message and pinned lore, but dropped the system/character
 * block, which `trimHistoryToBudget` (tokenizer.ts) charges off the top
 * before any pinned message and which is very often the largest of the
 * three. Exported for tests (see the export site's comment) rather than
 * driven end to end through a real generation, because every one of its five
 * call sites needs a real empty completion AND a real overBudget flag to
 * reach it — this pins the STRING directly instead.
 */
import { describe, it, expect, vi } from 'vitest';

// Same prelude as breakdownBuckets.test.ts / chatStore.callSites.test.ts —
// chatStore pulls serverSettings (and the api layer) at module load, and
// chatStore -> authStore -> lovenseStore -> chatStore is a require cycle whose
// leaf subscribes at module scope.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ showToastGlobal: vi.fn() }));
vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}
globalThis.localStorage = new MemoryStorage() as unknown as Storage;

const { buildEmptyResponseError } = await import('./chatStore');

describe('buildEmptyResponseError', () => {
  it('finishReason "length": names the response-token cap, never the overBudget branch', () => {
    const msg = buildEmptyResponseError('generic', 'tap send again', 'length', 256, false);
    expect(msg).toMatch(/response token budget \(currently 256\)/);
    expect(msg).not.toMatch(/context window/i);
  });

  it('finishReason "max_tokens": same branch as "length"', () => {
    const msg = buildEmptyResponseError('generic', 'tap send again', 'max_tokens', 512, false);
    expect(msg).toMatch(/response token budget \(currently 512\)/);
  });

  it('finishReason "content_filter": the provider-filter message, regardless of overBudget', () => {
    const msg = buildEmptyResponseError('generic', 'tap send again', 'content_filter', 2048, true);
    expect(msg).toMatch(/content filter/i);
    expect(msg).not.toMatch(/context window/i);
  });

  it('no finishReason, overBudget false: falls back to the generic message verbatim', () => {
    const msg = buildEmptyResponseError('The model returned nothing.', 'tap send again', null, 2048, false);
    expect(msg).toBe('The model returned nothing.');
  });

  // F4/F11/F19: the overBudget hint must name all THREE pinned contributor
  // classes trimHistoryToBudget actually charges — the newest turn, the
  // system/character block, and pinned constant/critical World Info — not
  // just two of them.
  it('overBudget true: names all three pinned contributors (message, system/character block, pinned lore)', () => {
    // KILLS the pre-fix string, which named only "your message" and "pinned
    // lore" — reverting to it (a later edit, or a bad merge) fails this.
    const msg = buildEmptyResponseError('generic', 'tap send again', null, 2048, true);
    expect(msg).toMatch(/your message/i);
    expect(msg).toMatch(/system\/character block/i);
    expect(msg).toMatch(/pinned lore|constant\/critical world info/i);
  });

  it('overBudget true: still carries the retryAction and the always-valid remedy (raise Max Context Tokens)', () => {
    const msg = buildEmptyResponseError('generic', 'choosing "Save & regenerate" again', null, 2048, true);
    expect(msg).toMatch(/Max Context Tokens/);
    expect(msg.endsWith('then choosing "Save & regenerate" again.')).toBe(true);
  });

  it('overBudget false, no finishReason: does NOT fall through to the overBudget copy', () => {
    const msg = buildEmptyResponseError('The model returned nothing.', 'tap send again', null, 2048, false);
    expect(msg).not.toMatch(/context window/i);
  });
});
