/**
 * The desktop avatar panel's source resolution (D-C5, D-C6) and its copies of
 * ChatView's sprite lookups.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../stores/chatStore';
import {
  findPreviousValidSpritePath,
  resolvePanelMotionMode,
  resolvePortraitImageUrl,
} from './portraitSource';

function ai(id: string, emotion: string | null, characterAvatar?: string): ChatMessage {
  return {
    id,
    name: 'x',
    isUser: false,
    isSystem: false,
    content: '',
    timestamp: 0,
    emotion,
    characterAvatar,
    swipes: [''],
    swipeId: 0,
  };
}
function user(id: string): ChatMessage {
  return { ...ai(id, null), isUser: true };
}

const sprites: Record<string, string> = { joy: '/sprites/a/joy.png', sadness: '/sprites/a/sadness.png' };
const getSpritePath = (e: string | null) => (e ? sprites[e] ?? null : null);
const lookup = (failed: string[] = []) => ({
  failedExpressions: new Set(failed),
  availableEmotions: Object.keys(sprites),
  getSpritePath,
});

describe('resolvePanelMotionMode — D-C5 matrix', () => {
  it.each([
    ['auto', true, true, 'liveportrait'],
    ['auto', true, false, 'liveportrait'],
    ['auto', false, true, 'expressions'],
    ['auto', false, false, 'none'],
    ['liveportrait', false, true, 'none'],
    ['liveportrait', true, false, 'liveportrait'],
    ['expressions', true, false, 'none'],
    ['expressions', false, true, 'expressions'],
    ['none', true, true, 'none'],
  ] as const)('%s with clips=%s sprites=%s → %s', (mode, clips, spritesAvail, expected) => {
    expect(resolvePanelMotionMode(mode, clips, spritesAvail, false)).toBe(expected);
  });
});

describe('resolvePanelMotionMode — D-C6 reduced motion', () => {
  it('auto skips Live Portrait to expressions', () => {
    expect(resolvePanelMotionMode('auto', true, true, true)).toBe('expressions');
  });
  it('auto with only clips falls to static', () => {
    expect(resolvePanelMotionMode('auto', true, false, true)).toBe('none');
  });
  it('an explicit liveportrait still plays', () => {
    expect(resolvePanelMotionMode('liveportrait', true, false, true)).toBe('liveportrait');
  });
  it('an explicit expressions is unchanged', () => {
    expect(resolvePanelMotionMode('expressions', true, true, true)).toBe('expressions');
  });
});

describe('resolvePortraitImageUrl', () => {
  const base = { failedExpressions: new Set<string>(), getSpritePath, noFallback: false, previousValidSpritePath: null };

  it('returns the sprite for the emotion', () => {
    expect(resolvePortraitImageUrl('a.png', 'joy', base)).toBe('/sprites/a/joy.png');
  });
  it('falls back to the default avatar when the sprite failed', () => {
    expect(
      resolvePortraitImageUrl('a.png', 'joy', { ...base, failedExpressions: new Set(['a.png-joy']) }),
    ).toBe('/blobs/character/a.png');
  });
  it('falls back to the default avatar for an emotion with no sprite, and for no emotion', () => {
    expect(resolvePortraitImageUrl('a.png', 'anger', base)).toBe('/blobs/character/a.png');
    expect(resolvePortraitImageUrl('a.png', null, base)).toBe('/blobs/character/a.png');
  });
  it('does not alias-map the emotion', () => {
    // "happy" maps to "joy" through mapEmotionToAvailable, but the full-image
    // path looks the raw label up.
    expect(resolvePortraitImageUrl('a.png', 'happy', base)).toBe('/blobs/character/a.png');
  });
  it('uses the walk-back sprite only with no-fallback on', () => {
    expect(
      resolvePortraitImageUrl('a.png', 'anger', { ...base, previousValidSpritePath: '/sprites/a/sadness.png' }),
    ).toBe('/blobs/character/a.png');
    expect(
      resolvePortraitImageUrl('a.png', 'anger', {
        ...base,
        noFallback: true,
        previousValidSpritePath: '/sprites/a/sadness.png',
      }),
    ).toBe('/sprites/a/sadness.png');
  });
  it('encodes the avatar file name in the default URL', () => {
    expect(resolvePortraitImageUrl('a b.png', null, base)).toBe('/blobs/character/a%20b.png');
  });
});

describe('findPreviousValidSpritePath', () => {
  it('solo: the newest emotion whose sprite resolves, skipping user turns and failed keys', () => {
    const messages = [ai('1', 'sadness'), user('2'), ai('3', 'joy'), ai('4', 'anger')];
    expect(findPreviousValidSpritePath(messages, 'a.png', false, 'a.png', lookup())).toEqual({ path: '/sprites/a/joy.png', emotion: 'joy' });
    expect(findPreviousValidSpritePath(messages, 'a.png', false, 'a.png', lookup(['a.png-joy']))).toEqual({
      path: '/sprites/a/sadness.png',
      emotion: 'sadness',
    });
  });

  it('skips user and system turns even when they carry an emotion, as ChatView does', () => {
    const messages = [ai('1', 'sadness'), { ...ai('2', 'joy'), isUser: true }, { ...ai('3', 'joy'), isSystem: true }];
    expect(findPreviousValidSpritePath(messages, 'a.png', false, 'a.png', lookup())).toEqual({
      path: '/sprites/a/sadness.png',
      emotion: 'sadness',
    });
  });

  it('solo: a message\'s characterAvatar is ignored — every AI turn is the character\'s, as ChatView reads it', () => {
    expect(findPreviousValidSpritePath([ai('1', 'joy', 'other.png')], 'a.png', false, 'a.png', lookup())).toEqual({
      path: '/sprites/a/joy.png',
      emotion: 'joy',
    });
  });

  it('alias-maps the walked-back emotion', () => {
    expect(findPreviousValidSpritePath([ai('1', 'happy')], 'a.png', false, 'a.png', lookup())).toEqual({
      path: '/sprites/a/joy.png',
      emotion: 'happy',
    });
  });

  it('group: only that member\'s messages count', () => {
    const messages = [ai('1', 'joy', 'a.png'), ai('2', 'sadness', 'b.png')];
    expect(findPreviousValidSpritePath(messages, 'a.png', true, null, lookup())?.path).toBe('/sprites/a/joy.png');
  });

  it('group: a message with no characterAvatar is attributed to nobody', () => {
    const messages = [ai('1', 'joy')];
    expect(findPreviousValidSpritePath(messages, 'a.png', true, null, lookup())).toBeNull();
  });
});
