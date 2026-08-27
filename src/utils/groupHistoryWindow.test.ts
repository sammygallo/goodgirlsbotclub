/**
 * `groupHistoryWindow` — the group builder's raw-history window, and the one
 * definition of it.
 *
 * The four cases below are ported from `ragBoundary.test.ts`, which E2-S2
 * task 1b deleted along with the module it covered. Its SOLO cases died with
 * that file — they asserted the behaviour of a re-simulation of the solo trim
 * that no longer exists, and re-simulating is exactly the thing that was
 * wrong. Its GROUP cases survive here because group's window was never a
 * simulation of anything: it is a fixed slice, computable from the message
 * list alone, and now computed in ONE place both the builder and the recall
 * path call.
 */

import { describe, it, expect } from 'vitest';
import { GROUP_HISTORY_WINDOW, groupHistoryWindow } from './groupHistoryWindow';
import type { ChatMessage } from '../stores/chatStore';

let msgId = 0;
function mkMsg(content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  msgId += 1;
  return {
    id: `m${msgId}`,
    name: 'User',
    isUser: true,
    isSystem: false,
    hidden: false,
    content,
    timestamp: 0,
    swipes: [content],
    swipeId: 0,
    ...over,
  } as ChatMessage;
}

describe('groupHistoryWindow', () => {
  it('keeps the newest GROUP_HISTORY_WINDOW visible messages, oldest first', () => {
    const messages = Array.from({ length: 40 }, (_, i) => mkMsg(`turn ${i}`));
    const window = groupHistoryWindow(messages);
    expect(window.length).toBe(GROUP_HISTORY_WINDOW);
    // slice(-30) over 40 keeps indices 10..39.
    expect(window[0].id).toBe(messages[10].id);
    expect(window[window.length - 1].id).toBe(messages[39].id);
  });

  it('filters hidden BEFORE slicing, so a hidden message never eats a slot', () => {
    // KILLS: `.slice(-30).filter(!hidden)`, i.e. filtering after the slice.
    // That ordering would spend one of the thirty slots on the hidden message
    // and emit twenty-nine turns, shifting the boundary one turn newer — and
    // with it every `depthFromEnd` the builder's loop computes.
    const messages = [
      mkMsg('hidden, and oldest', { hidden: true }),
      ...Array.from({ length: 30 }, (_, i) => mkMsg(`turn ${i}`)),
    ];
    const window = groupHistoryWindow(messages);
    expect(window.length).toBe(30);
    expect(window[0].id).toBe(messages[1].id);
    expect(window.some((m) => m.hidden)).toBe(false);
  });

  it('filters isSystem AFTER slicing, so a window holding system turns emits fewer', () => {
    // KILLS: `.filter(!hidden).filter(!isSystem).slice(-30)`, i.e. filtering
    // system turns before the slice. That would top the window back up to a
    // full thirty from further back in the chat — emitting turns the real
    // builder never sends, which as a recall boundary means excluding
    // messages that ARE eligible for recall.
    const messages = Array.from({ length: 40 }, (_, i) =>
      mkMsg(`turn ${i}`, { isSystem: i >= 12 && i % 6 === 0 })
    ); // system at 12, 18, 24, 30, 36 — five, all inside the last thirty
    const window = groupHistoryWindow(messages);
    expect(window.length).toBe(25);
    expect(window[0].id).toBe(messages[10].id);
    expect(window.some((m) => m.isSystem)).toBe(false);
  });

  it('returns an empty array rather than throwing on an empty chat', () => {
    // The caller turns this into a null boundary; it must not have to guard
    // against an exception to do so.
    expect(groupHistoryWindow([])).toEqual([]);
    expect(groupHistoryWindow([mkMsg('only a system turn', { isSystem: true })])).toEqual([]);
  });
});
