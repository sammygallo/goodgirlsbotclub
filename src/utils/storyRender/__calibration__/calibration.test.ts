/**
 * The renderer's calibration harness (step 3, phase 6, Decision 4).
 *
 * WHAT THIS IS: a golden-file pin on everything deterministic about a
 * render — the assembled brief and the prompt built from it. Same input,
 * byte-identical output, checked on every run.
 *
 * WHAT THIS IS NOT: a test of prose quality. You cannot assert LLM output.
 * Same input, same model, different text; and a hash of generated prose
 * would fail on every provider-side model update while catching nothing.
 * The rated prose corpus lives in RATINGS.md and is a HUMAN review
 * checklist, deliberately not asserted here — see README.md.
 *
 * Why the brief is the right thing to pin: every renderer regression that
 * is mechanically detectable is a regression in what went INTO the call.
 * Which facts reached the model, which world rules fired, what the cap
 * dropped and in what order, how the hints resolved — all of it is decided
 * before a token is sent, by pure functions. If the prose gets worse and
 * the brief is byte-identical, the change is in the model or the prompt
 * text, and the goldens say which.
 *
 * REGENERATE after an intended change:
 *
 *   npx vitest run src/utils/storyRender/__calibration__ -u
 *
 * Then READ THE DIFF. A golden diff is the whole signal: it is the list of
 * everything your change altered about what the model is told. An update
 * committed without reading it throws away the only thing this harness
 * does.
 */

import { describe, it, expect } from 'vitest';
import { assembleRenderBrief } from '../contextAssembler';
import { prosePrompt } from '../prompts';
import { isRefusal } from '../types';
import { CALIBRATION_FIXTURES } from './fixtures';

describe('calibration — the brief is stable', () => {
  for (const fixture of CALIBRATION_FIXTURES) {
    describe(fixture.name, () => {
      const brief = assembleRenderBrief(fixture.input);

      it('assembles to a stable brief', async () => {
        // Serialized rather than snapshotted as an object so the golden is
        // readable in a diff: a reviewer should be able to see "this fact
        // stopped reaching the model" without decoding a structure dump.
        await expect(describeBrief(brief)).toMatchFileSnapshot(
          `./goldens/${fixture.name}.brief.txt`
        );
      });

      it('builds a stable prompt', async () => {
        if (isRefusal(brief)) {
          // A refusal has no prompt, and recording that IS the pin: a
          // fixture that starts assembling when it used to refuse (or the
          // reverse) is a change worth seeing in a diff.
          await expect('REFUSED: ' + brief.reason).toMatchFileSnapshot(
            `./goldens/${fixture.name}.prompt.txt`
          );
          return;
        }
        await expect(prosePrompt(brief)).toMatchFileSnapshot(
          `./goldens/${fixture.name}.prompt.txt`
        );
      });
    });
  }
});

describe('calibration — the corpus is honest about itself', () => {
  it('every fixture records where its material came from', () => {
    for (const f of CALIBRATION_FIXTURES) {
      expect(f.provenance.length, `${f.name} has no provenance`).toBeGreaterThan(0);
    }
  });

  it('a rating records what produced it', () => {
    // The guard against the failure mode §6 names: a corpus that looks
    // rated but is not. A rating that cannot say which model wrote the
    // prose, or when, is not a rating — it is a checkbox.
    //
    // This deliberately does NOT require the fixture's input to be real.
    // An earlier version did, which conflated where the INPUT came from
    // with whether prose was actually generated and read, and would have
    // blocked rating the hand-built fixtures after their prose was
    // genuinely rendered and criticised.
    for (const f of CALIBRATION_FIXTURES) {
      if (!f.ratedProse) continue;
      expect(f.ratedProse.model, `${f.name} rating has no model`).toMatch(/\S/);
      expect(f.ratedProse.date, `${f.name} rating has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('at least one fixture is built from a real transcript', () => {
    // Hand-built fixtures can walk every branch and still describe a story
    // nobody played. The corpus needs at least one input that came off a
    // real render, or it is measuring the renderer against its own author's
    // imagination.
    expect(
      CALIBRATION_FIXTURES.some((f) => f.provenance.toLowerCase().startsWith('real'))
    ).toBe(true);
  });
});

/** A stable, diff-readable rendering of the brief: what reached the model,
 *  what did not, and why. Deliberately not JSON.stringify — the point is
 *  that a reviewer can read the change. */
function describeBrief(brief: ReturnType<typeof assembleRenderBrief>): string {
  if (isRefusal(brief)) {
    return [
      'REFUSED',
      `reason: ${brief.reason}`,
      `coreTokens: ${brief.coreTokens}`,
      `capTokens: ${brief.capTokens}`,
      '',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(`scene: ${brief.scene.id} — ${brief.scene.title}`);
  lines.push(`position: ${brief.position} of ${brief.totalScenes}`);
  lines.push(`precedingSummary: ${brief.precedingSummary ? 'present' : 'none'}`);
  lines.push('');

  lines.push(`participants (${brief.participants.length}):`);
  for (const c of brief.participants) lines.push(`  - ${c.id} ${c.canonical_name}`);
  lines.push('');

  lines.push(`facts.own (${brief.facts.own.length}):`);
  for (const f of brief.facts.own) lines.push(`  - ${f.id}: ${f.text}`);
  lines.push(`facts.sceneAttributed (${brief.facts.sceneAttributed.length}):`);
  for (const f of brief.facts.sceneAttributed) lines.push(`  - ${f.id}: ${f.text}`);
  lines.push(`facts.unattributed (${brief.facts.unattributed.length}):`);
  for (const f of brief.facts.unattributed) lines.push(`  - ${f.id}: ${f.text}`);
  lines.push('');

  lines.push(`rules (${brief.rules.length}):`);
  for (const r of brief.rules) lines.push(`  - ${r.id ?? '(no id)'}: ${r.text}`);
  lines.push('');

  // The review found this missing: `user_voice` reached the prompt but
  // appeared in no golden, so the brief could stop carrying the author's
  // voice with nothing to show for it.
  lines.push(`userVoice: ${brief.userVoice ? 'present' : 'none'}`);
  if (brief.userVoice) {
    lines.push(`  style_summary: ${brief.userVoice.style_summary}`);
    lines.push(`  devices: ${(brief.userVoice.rhetorical_devices ?? []).join(', ')}`);
  }
  lines.push('');

  lines.push('hints:');
  for (const [k, v] of Object.entries(brief.hints).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${k}: ${JSON.stringify(v)}`);
  }
  lines.push('');

  // The never-silent record. If a change alters what the cap eats, THIS is
  // the part of the golden that must be read before the update is accepted.
  lines.push(`drops (${brief.drops.length}):`);
  for (const d of brief.drops) lines.push(`  - ${JSON.stringify(d)}`);
  lines.push('');
  lines.push(`caveats: ${JSON.stringify(brief.caveats)}`);
  lines.push('');

  return lines.join('\n');
}
