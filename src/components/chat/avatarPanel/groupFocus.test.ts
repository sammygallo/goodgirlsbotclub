/**
 * Group focus for the desktop avatar panel (D-C7): streaming message's avatar,
 * then the newest AI message's avatar, then roster slot 0 — by
 * `characterAvatar` only, never by name.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../stores/chatStore';
import { aiMessageIds, lastAiMessageId, latestEmotionFor, resolveGroupFocusAvatar } from './groupFocus';

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    name: 'x',
    isUser: false,
    isSystem: false,
    content: '',
    timestamp: 0,
    swipes: [''],
    swipeId: 0,
    ...over,
  };
}

const roster = ['a.png', 'b.png', 'c.png'];

describe('resolveGroupFocusAvatar', () => {
  it('follows the in-flight streaming message', () => {
    const messages = [msg('1', { characterAvatar: 'a.png' }), msg('2', { characterAvatar: 'c.png', content: 'typ' })];
    expect(resolveGroupFocusAvatar(messages, roster, true)).toBe('c.png');
  });

  it('otherwise follows the newest AI message', () => {
    const messages = [msg('1', { characterAvatar: 'b.png' }), msg('2', { characterAvatar: 'c.png' })];
    expect(resolveGroupFocusAvatar(messages, roster, false)).toBe('c.png');
  });

  it('skips user and system messages', () => {
    const messages = [
      msg('1', { characterAvatar: 'b.png' }),
      msg('2', { isUser: true, characterAvatar: 'a.png' }),
      msg('3', { isSystem: true, characterAvatar: 'c.png' }),
    ];
    expect(resolveGroupFocusAvatar(messages, roster, false)).toBe('b.png');
  });

  it('streaming with a user message last falls through to the newest AI message', () => {
    const messages = [msg('1', { characterAvatar: 'b.png' }), msg('2', { isUser: true })];
    expect(resolveGroupFocusAvatar(messages, roster, true)).toBe('b.png');
  });

  it('ignores a legacy message that carries a member\'s name but no characterAvatar', () => {
    const messages = [msg('1', { name: 'Bea' })];
    expect(resolveGroupFocusAvatar(messages, roster, false)).toBe('a.png');
    expect(resolveGroupFocusAvatar(messages, roster, true)).toBe('a.png');
  });

  it('resolves two same-name members by avatar', () => {
    const messages = [msg('1', { name: 'Sam', characterAvatar: 'c.png' })];
    expect(resolveGroupFocusAvatar(messages, roster, false)).toBe('c.png');
  });

  it('skips an avatar that is no longer in the roster', () => {
    const messages = [msg('1', { characterAvatar: 'b.png' }), msg('2', { characterAvatar: 'gone.png' })];
    expect(resolveGroupFocusAvatar(messages, roster, true)).toBe('b.png');
  });

  it('falls back to roster slot 0, and to null with no roster', () => {
    expect(resolveGroupFocusAvatar([], roster, false)).toBe('a.png');
    expect(resolveGroupFocusAvatar([], [], false)).toBeNull();
  });
});

describe('latestEmotionFor', () => {
  const messages = [
    msg('1', { characterAvatar: 'a.png', emotion: 'joy' }),
    msg('2', { characterAvatar: 'b.png', emotion: 'anger' }),
    msg('3', { isUser: true, emotion: 'sadness' }),
  ];

  it('solo: the newest AI message\'s emotion', () => {
    expect(latestEmotionFor(messages, false, 'a.png')).toBe('anger');
    expect(latestEmotionFor([msg('1', { emotion: null })], false, 'a.png')).toBeNull();
    expect(latestEmotionFor([], false, 'a.png')).toBeNull();
  });

  it('group: the focused member\'s own newest emotion', () => {
    expect(latestEmotionFor(messages, true, 'a.png')).toBe('joy');
    expect(latestEmotionFor(messages, true, 'c.png')).toBeNull();
    expect(latestEmotionFor(messages, true, null)).toBeNull();
  });
});

describe('lastAiMessageId / aiMessageIds', () => {
  it('reads AI messages only', () => {
    const messages = [msg('1'), msg('2', { isUser: true }), msg('3', { isSystem: true })];
    expect(lastAiMessageId(messages)).toBe('1');
    expect(lastAiMessageId([])).toBeNull();
    expect([...aiMessageIds(messages)]).toEqual(['1']);
  });
});
