import { describe, it, expect } from 'vitest';
import {
  hasSelfieTag,
  parseSelfieDirective,
  stripSelfieTags,
  selfieTargetUnchanged,
} from './selfie';

describe('hasSelfieTag', () => {
  it('detects an open [selfie: tag (even before it closes)', () => {
    expect(hasSelfieTag('she smiles [selfie: mirror')).toBe(true);
    expect(hasSelfieTag('[SELFIE :winks]')).toBe(true); // case/space tolerant
  });
  it('is false when absent', () => {
    expect(hasSelfieTag('just a normal reply')).toBe(false);
    expect(hasSelfieTag('a selfie of her')).toBe(false); // the word, not the tag
  });
});

describe('parseSelfieDirective', () => {
  it('returns the trimmed descriptors of the FIRST fully-closed tag', () => {
    expect(parseSelfieDirective('hi [selfie:  mirror selfie, black dress ] bye')).toBe(
      'mirror selfie, black dress',
    );
  });
  it('returns only the first tag when several are present (one per message)', () => {
    expect(parseSelfieDirective('[selfie: a] then [selfie: b]')).toBe('a');
  });
  it('returns "" for an empty-but-present tag (a valid request)', () => {
    expect(parseSelfieDirective('[selfie:]')).toBe('');
    expect(parseSelfieDirective('[selfie:   ]')).toBe('');
  });
  it('returns null when there is no closed tag', () => {
    expect(parseSelfieDirective('no tag here')).toBeNull();
    expect(parseSelfieDirective('half a [selfie: mirror')).toBeNull(); // unterminated
  });
  it('is stateless across calls (global regex lastIndex is reset)', () => {
    const t = '[selfie: one]';
    expect(parseSelfieDirective(t)).toBe('one');
    expect(parseSelfieDirective(t)).toBe('one'); // would return null on 2nd call if lastIndex leaked
  });
});

describe('stripSelfieTags', () => {
  it('removes the tag and tidies whitespace', () => {
    expect(stripSelfieTags('she poses [selfie: mirror, dress] and grins')).toBe(
      'she poses and grins',
    );
  });
  it('removes every tag in the text (leading/trailing trim is left to call sites)', () => {
    // Matches stripLovenseTags: collapses inner whitespace but does not trim —
    // ChatMessage applies .trim() at the render call site.
    expect(stripSelfieTags('[selfie: a] mid [selfie: b] end').trim()).toBe('mid end');
  });
  it('leaves tag-free text untouched', () => {
    expect(stripSelfieTags('nothing to strip')).toBe('nothing to strip');
  });
});

describe('selfieTargetUnchanged (mid-flight misattribution guard)', () => {
  it('true only when the same character AND chat file are still open', () => {
    expect(selfieTargetUnchanged('Ivy.png', 'Ivy.png', 'chat-1', 'chat-1')).toBe(true);
  });
  it('false when the character switched (different avatar)', () => {
    expect(selfieTargetUnchanged('Bella.png', 'Ivy.png', 'chat-1', 'chat-1')).toBe(false);
  });
  it('false when a DIFFERENT chat file of the same character is open', () => {
    expect(selfieTargetUnchanged('Ivy.png', 'Ivy.png', 'chat-2', 'chat-1')).toBe(false);
  });
  it('false when no character is selected (null/undefined avatar)', () => {
    expect(selfieTargetUnchanged(null, 'Ivy.png', 'chat-1', 'chat-1')).toBe(false);
    expect(selfieTargetUnchanged(undefined, 'Ivy.png', 'chat-1', 'chat-1')).toBe(false);
  });
});
