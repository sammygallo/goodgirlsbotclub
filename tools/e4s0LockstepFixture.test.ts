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
