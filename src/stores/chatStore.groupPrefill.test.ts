import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Reproduction for #421 (group chat: every speaker after the first in a round
// 400s against prefill-rejecting Anthropic models, and the error is dropped
// silently) and #578, its symptom on the E6-S4 desktop avatar panel.
//
// Observed in production 2026-10-16 (claude-sonnet-5-5, group Ivy + Seraphina,
// one user message): two generate calls; the second returned only
//   data: {"error": {"message": "This model does not support assistant message
//   prefill. The conversation must end with a user message.", "code": 400}}
// The panel's focus went Seraphina → Ivy → Seraphina → Ivy: speaker two's
// placeholder appeared, its stream yielded no text, and the blank-turn guard in
// generateGroupTurn removed it, so focus fell back to speaker one.
//
// The mocked provider below applies the same rule the real one did: a payload
// whose last non-system entry is an assistant turn gets the prefill error.
//
// The `it.fails` cases assert the behaviour #421 asks for. They pass while the
// bug is present; when a fix lands, the matching case turns red and should be
// converted to a plain `it`.

// chatStore pulls serverSettings (and through it the api layer) at module
// load — neutralize before importing, per chatStore.groupMacros.test.ts.
vi.mock('../utils/serverSettings', () => ({
  getSettingsBlob: vi.fn(async () => ({})),
  makeLocalTsKey: vi.fn((k: string) => `ts_${k}`),
  patchServerKey: vi.fn(async () => {}),
  markSectionDirty: vi.fn(),
  recordServerTs: vi.fn(),
  shouldReuploadSection: vi.fn(() => false),
  clearLocalTs: vi.fn(),
}));

// chatStore -> authStore -> lovenseStore -> chatStore is a require cycle; stub
// the leaf, per chatStore.groupMacros.test.ts.
vi.mock('./lovenseStore', () => ({
  useLovenseStore: { getState: () => ({}), subscribe: () => () => {} },
}));

const { useChatStore } = await import('./chatStore');
const { useSettingsStore } = await import('./settingsStore');
const { api } = await import('../api/client');
const { resolveGroupFocusAvatar } = await import(
  '../components/chat/avatarPanel/groupFocus'
);

import type { CharacterInfo } from '../api/client';
import type { ChatMessage } from './chatStore';

function mkChar(name: string, avatar: string): CharacterInfo {
  return { name, avatar, description: `${name} description` } as CharacterInfo;
}

const ivy = mkChar('Ivy', 'ivy.png');
const seraphina = mkChar('Seraphina', 'seraphina.png');
const roster = [ivy, seraphina];
const rosterAvatars = roster.map((c) => c.avatar);

const PREFILL_ERROR =
  'This model does not support assistant message prefill. The conversation must end with a user message.';

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

const textStream = (text: string) => sse([{ choices: [{ delta: { content: text } }] }]);
// The shape the generation proxy forwards an upstream error in: a 200 SSE
// stream carrying one error frame (ggbc-backend app/routers/generation.py).
const errorStream = (message: string) => sse([{ error: { message, code: 400 } }]);

type Payload = { role: string; content: string }[];

function endsOnAssistant(payload: Payload): boolean {
  const last = [...payload].reverse().find((m) => m.role !== 'system');
  return last?.role === 'assistant';
}

/** A provider that refuses assistant prefill, like claude-sonnet-5-5 did. */
function prefillRejectingProvider() {
  return vi.spyOn(api, 'generateMessage').mockImplementation(async (payload, name) =>
    endsOnAssistant(payload as Payload)
      ? errorStream(PREFILL_ERROR)
      : textStream(`[emotion:joy] Hi, I'm ${name}.`)
  );
}

// The greeting state the production group opened in: Ivy then Seraphina, so the
// panel starts focused on Seraphina (the newest AI message).
function greetings(): ChatMessage[] {
  return [
    { id: 'g1', name: 'Ivy', isUser: false, isSystem: false, content: 'Ivy greeting', timestamp: 1, characterAvatar: ivy.avatar, swipes: ['Ivy greeting'], swipeId: 0 },
    { id: 'g2', name: 'Seraphina', isUser: false, isSystem: false, content: 'Seraphina greeting', timestamp: 2, characterAvatar: seraphina.avatar, swipes: ['Seraphina greeting'], swipeId: 0 },
  ] as ChatMessage[];
}

/** Every distinct value of the panel's focus input across one round. */
function recordFocus(): { seq: (string | null)[]; stop: () => void } {
  const seq: (string | null)[] = [];
  const push = () => {
    const s = useChatStore.getState();
    const f = resolveGroupFocusAvatar(s.messages, rosterAvatars, s.isStreaming);
    if (seq[seq.length - 1] !== f) seq.push(f);
  };
  push();
  const stop = useChatStore.subscribe(push);
  return { seq, stop };
}

/** Avatars of every AI message that existed at any point during the round. */
function recordAppearedAvatars(): { seen: Set<string>; stop: () => void } {
  const seen = new Set<string>();
  const stop = useChatStore.subscribe((s) => {
    for (const m of s.messages) {
      if (!m.isUser && !m.isSystem && m.characterAvatar) seen.add(m.id + '|' + m.characterAvatar);
    }
  });
  return { seen, stop };
}

// A round that streams to completion reaches recordTurnUsage -> the usage
// store's persist middleware, which writes localStorage unguarded; this
// runtime's global localStorage is inert. Same in-memory Storage as
// chatStore.groupMacros.test.ts.
class MemoryStorage {
  private store = new Map<string, string>();
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
const realLocalStorage = globalThis.localStorage;

function seedGroup() {
  // currentChatFile null keeps saveChatToBackend out of the test; no
  // groupChats record, so the activation strategy falls back to 'list' —
  // every member speaks once, in roster order.
  useChatStore.setState({
    currentChatFile: null,
    isSending: false,
    isStreaming: false,
    error: null,
    messages: greetings(),
    groupChats: [],
  });
}

async function sendRound() {
  await useChatStore.getState().sendGroupMessage('Each of you, say hi.', roster);
}

async function runRound() {
  seedGroup();
  await sendRound();
}

describe('group round on a prefill-rejecting provider (#421, #578)', () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage() as unknown as Storage;
    useSettingsStore.setState({ activeProvider: 'anthropic', activeModel: 'claude-sonnet-5-5' });
  });

  afterEach(() => {
    globalThis.localStorage = realLocalStorage;
    vi.restoreAllMocks();
  });

  // Plain test: the conditions the it.fails cases below rely on. These hold
  // before and after a fix, so a broken harness cannot pass for a reproduced
  // bug.
  it('runs both speakers in roster order, and speaker two gets a placeholder', async () => {
    const spy = prefillRejectingProvider();
    const appeared = recordAppearedAvatars();
    await runRound();
    appeared.stop();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[1])).toEqual(['Ivy', 'Seraphina']);
    // Speaker one's payload ends on the user's message, so it is accepted.
    expect(endsOnAssistant(spy.mock.calls[0][0] as Payload)).toBe(false);
    // Speaker two's placeholder existed at some point in the round.
    expect([...appeared.seen].some((k) => k.endsWith('|' + seraphina.avatar) && !k.startsWith('g2|'))).toBe(true);
    const ivyReplies = useChatStore
      .getState()
      .messages.filter((m) => !m.isUser && m.characterAvatar === ivy.avatar && m.id !== 'g1');
    expect(ivyReplies).toHaveLength(1);
  });

  // #421 primary: speaker two's payload must end on a user-role entry.
  it.fails("speaker two's payload does not end on an assistant turn", async () => {
    const spy = prefillRejectingProvider();
    await runRound();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(endsOnAssistant(spy.mock.calls[1][0] as Payload)).toBe(false);
  });

  // #421 secondary: an upstream error inside the 200 SSE stream must not
  // read as a blank completion. Unconditional error, so this case tracks the
  // swallow independently of the payload fix.
  it.fails("an upstream error in speaker two's stream is surfaced, not dropped as blank", async () => {
    let call = 0;
    vi.spyOn(api, 'generateMessage').mockImplementation(async () =>
      ++call === 1 ? textStream('[emotion:joy] Hi.') : errorStream('upstream exploded')
    );
    await runRound();
    expect(call).toBe(2);
    expect(useChatStore.getState().error).not.toBeNull();
  });

  // #578: the panel's focus input after the round. Today it reads
  // [seraphina, ivy, seraphina, ivy] — the last two values are speaker two's
  // placeholder appearing and being removed. Once speaker two can reply, the
  // round ends with focus on her, on a message with content.
  it.fails('after the round the panel focus rests on speaker two, with no fall-back', async () => {
    prefillRejectingProvider();
    seedGroup();
    const focus = recordFocus();
    await sendRound();
    focus.stop();
    expect(focus.seq).toEqual([seraphina.avatar, ivy.avatar, seraphina.avatar]);
    // ...and on a real reply: an error path that leaves speaker two's empty
    // placeholder in the transcript would satisfy the sequence alone.
    const reply = useChatStore
      .getState()
      .messages.find((m) => !m.isUser && m.characterAvatar === seraphina.avatar && m.id !== 'g2');
    expect(reply?.content.trim()).toBeTruthy();
  });
});
