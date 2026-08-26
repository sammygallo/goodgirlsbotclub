// Desync guard for the E4-S0 cross-engine lockstep fixture.
//
// src/stores/__fixtures__/e4s0_lockstep_vectors.json and ggbc-backend's
// tests/e4s0_lockstep_vectors.json are the SAME FILE, committed twice. The
// activation rules are implemented twice (scanMessagesForEntries here,
// run_activation_engine there) and this table is the only thing that makes a
// one-sided rule change fail rather than ship — but only for as long as the
// two copies stay identical. Nothing structural stops someone from "fixing" a
// vector in the repo whose suite is red and walking away with two tables that
// each agree with their own engine.
//
// So both repos assert the same sha256 constant. Edit one copy alone and that
// repo goes red on the checksum, pointing at the other copy rather than at a
// vector. Edit both to the same new bytes and both stay green — which is the
// intended workflow, and requires the change to be made deliberately in two
// places.
//
// Lives in `tools/` for the same reason as sourceHygiene.test.ts and
// provenanceWiring.test.ts: it needs node's fs, and `tsconfig.app.json` (the
// project covering `src/`) ships `types: ["vite/client"]` only, so a
// `node:fs` import under `src/` fails `tsc -b`. Reading with fs is also the
// point rather than an accident — this must hash the file's actual bytes, not
// a value that has been through a bundler transform or a JSON round trip.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FIXTURE = new URL(
  '../src/stores/__fixtures__/e4s0_lockstep_vectors.json',
  import.meta.url
).pathname;

/**
 * Must equal the constant ggbc-backend's tests/test_retrieval_context.py
 * asserts over its own copy. If you are here because this failed: do not
 * update this number to whatever the file now hashes to. Find out which copy
 * changed, apply the same change to the other, and update BOTH constants.
 */
const EXPECTED_SHA256 =
  'c7d20ac0998a249e689376c382674c69502d862c8e3e7cce3bc1446dfc466df4';

interface FixtureEntry {
  id: string;
  order: number;
  relatedIds: string[];
  comment: string;
  keys: string[];
  content: string;
  [k: string]: unknown;
}

interface FixtureVector {
  id: string;
  name: string;
  entries: FixtureEntry[];
  timers: Record<string, number>;
  expect: { injected: string[]; activated: string[]; evicted: string[] };
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  vectors: FixtureVector[];
};

describe('E4-S0 lockstep fixture', () => {
  it('is byte-identical to the copy ggbc-backend commits', () => {
    const actual = createHash('sha256')
      .update(readFileSync(FIXTURE))
      .digest('hex');
    expect(actual).toBe(EXPECTED_SHA256);
  });

  // The checksum pins the bytes; these pin the PREMISES those bytes encode.
  // A future editor changing both copies in lockstep still has to keep the
  // table runnable by both engines, and every rule below is one the harnesses
  // silently depend on. Mirrors the backend's equivalent guard.
  it('holds fourteen vectors with unique ids', () => {
    expect(fixture.vectors).toHaveLength(14);
    const ids = fixture.vectors.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists every vector in canonical candidate order, (order, id) ascending', () => {
    // Load-bearing: the frontend iterates book.entries in array order and the
    // backend does ORDER BY (insertion_order, id). The two engines only
    // observe the same candidate order — the precondition for comparing any
    // equal-`order` case at all — if the array is already in it.
    for (const v of fixture.vectors) {
      for (let i = 1; i < v.entries.length; i++) {
        const prev = v.entries[i - 1];
        const cur = v.entries[i];
        const ordered =
          prev.order < cur.order ||
          (prev.order === cur.order && prev.id < cur.id);
        expect(
          ordered,
          `${v.id}: entries[${i - 1}] and entries[${i}] are out of (order, id) order`
        ).toBe(true);
      }
    }
  });

  it('keeps relatedIds empty and probability unset in every entry', () => {
    // relatedIds pull-in and recursive passes are documented backend scope
    // cuts, so a vector using them would be un-mirrorable; a probability roll
    // would make the table non-deterministic. Both harnesses assume neither
    // appears (the frontend runs with maxRecursionSteps: 0).
    for (const v of fixture.vectors) {
      for (const e of v.entries) {
        expect(e.relatedIds, `${v.id}/${e.id} relatedIds`).toEqual([]);
        expect(e.useProbability, `${v.id}/${e.id} useProbability`).toBeUndefined();
        expect(e.probability, `${v.id}/${e.id} probability`).toBeUndefined();
      }
    }
  });

  it('references only ids the vector actually defines', () => {
    for (const v of fixture.vectors) {
      const ids = v.entries.map((e) => e.id);
      expect(new Set(ids).size, `${v.id}: duplicate entry ids`).toBe(
        ids.length
      );
      const known = new Set(ids);
      const refs = [
        ...Object.keys(v.timers),
        ...v.expect.injected,
        ...v.expect.activated,
        ...v.expect.evicted,
      ];
      for (const ref of refs) {
        expect(known.has(ref), `${v.id}: unknown id ${ref}`).toBe(true);
      }
    }
  });

  // The TEETH. Four vectors exist only to make a specific one-sided rule
  // change fail: V11 (the label key is consulted at all), V12 (content
  // compares by code point), V13 (the label is case-folded first) and V14 (the
  // label compares by code point too). Each of those rules passed every
  // earlier vector by accident before its vector was added, so deleting or
  // defanging one would quietly return the table to that state.
  //
  // Written as EXISTENCE checks over the whole table rather than by vector id,
  // deliberately: a renumbering, a merge that drops a vector, or an edit that
  // softens one into a co-linear case all still have to leave *something*
  // carrying the property, and cannot silently disable it by touching a name.
  // Mirrors the backend guard's equivalent assertions.
  const label = (e: FixtureEntry) =>
    (e.comment || e.keys[0] || e.id).toLowerCase();

  /** Local, deliberately independent of the implementation under guard. */
  const byCodePoint = (a: string, b: string): number => {
    if (a === b) return 0;
    const ca = Array.from(a);
    const cb = Array.from(b);
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
      const pa = ca[i].codePointAt(0) ?? 0;
      const pb = cb[i].codePointAt(0) ?? 0;
      if (pa !== pb) return pa < pb ? -1 : 1;
    }
    return ca.length - cb.length;
  };
  const hasNonBmp = (s: string) =>
    Array.from(s).some((c) => (c.codePointAt(0) ?? 0) > 0xffff);
  /** Every equal-`order` pair in the table, which is where ties get broken. */
  const equalOrderPairs = () => {
    const pairs: Array<[FixtureEntry, FixtureEntry]> = [];
    for (const v of fixture.vectors) {
      for (let i = 0; i < v.entries.length; i++) {
        for (let j = i + 1; j < v.entries.length; j++) {
          if (v.entries[i].order === v.entries[j].order) {
            pairs.push([v.entries[i], v.entries[j]]);
          }
        }
      }
    }
    return pairs;
  };

  it('pits label order against content order in some equal-order pair', () => {
    // Without this, every vector's content is co-linear with its label and the
    // middle key can be deleted outright with the table still green.
    const found = equalOrderPairs().some(([a, b]) => {
      const l = byCodePoint(label(a), label(b));
      const c = byCodePoint(a.content, b.content);
      return l !== 0 && c !== 0 && Math.sign(l) !== Math.sign(c);
    });
    expect(found, 'no vector contradicts label order with content order').toBe(
      true
    );
  });

  it('reorders some equal-order pair of labels under case-folding', () => {
    // Without this, the `.lower()`/`.toLowerCase()` fold can be dropped from
    // both engines with the table still green (the backend proved exactly
    // that against the twelve-vector version).
    const found = equalOrderPairs().some(([a, b]) => {
      const raw = byCodePoint(
        a.comment || a.keys[0] || a.id,
        b.comment || b.keys[0] || b.id
      );
      const folded = byCodePoint(label(a), label(b));
      return (
        raw !== 0 && folded !== 0 && Math.sign(raw) !== Math.sign(folded)
      );
    });
    expect(found, 'no vector reorders its labels under case-folding').toBe(true);
  });

  it('carries a non-BMP character in some content and in some label', () => {
    // The astral characters are what separate a code-point comparison from a
    // UTF-16 code-unit one. Replace them with BMP text and both kill vectors
    // (V12 for content, V14 for label) go green against a bare `<`.
    const entries = fixture.vectors.flatMap((v) => v.entries);
    expect(
      entries.some((e) => hasNonBmp(e.content)),
      'no entry content carries a non-BMP character'
    ).toBe(true);
    expect(
      entries.some((e) => hasNonBmp(label(e))),
      'no entry label carries a non-BMP character'
    ).toBe(true);
  });

  it('keeps the three expectation sets consistent with each other', () => {
    for (const v of fixture.vectors) {
      const injected = new Set(v.expect.injected);
      // An entry registers a timer only if it also survived the trim, and an
      // evicted entry by definition did not reach the prompt.
      for (const id of v.expect.activated) {
        expect(injected.has(id), `${v.id}: ${id} activated but not injected`).toBe(
          true
        );
      }
      for (const id of v.expect.evicted) {
        expect(injected.has(id), `${v.id}: ${id} both injected and evicted`).toBe(
          false
        );
      }
    }
  });
});
