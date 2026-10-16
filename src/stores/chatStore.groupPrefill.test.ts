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
// In the mocked provider below, a payload whose last non-system entry is an
// assistant turn gets the prefill error.

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
const { useGenerationStore } = await import('./generationStore');
const { useWorldInfoStore } = await import('./worldInfoStore');
const { useChatHistoryRagStore } = await import('./chatHistoryRagStore');
const { api } = await import('../api/client');
const { resolveGroupFocusAvatar } = await import(
  '../components/chat/avatarPanel/groupFocus'
);
const { estimateConversationTokens } = await import('../utils/tokenizer');
const { mkBook, mkEntry } = await import('./promptGoldens.fixtures');

import type { CharacterInfo } from '../api/client';
import type { ChatMessage, GroupChatInfo } from './chatStore';
import type { PromptBreakdown } from '../utils/promptBreakdown';

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

const textFrame = (text: string) => ({ choices: [{ delta: { content: text } }] });
const textStream = (text: string) => sse([textFrame(text)]);
// The shape the generation proxy forwards an upstream error in: a 200 SSE
// stream carrying one error frame (ggbc-backend app/routers/generation.py).
const errorFrame = (message: string) => ({ error: { message, code: 400 } });
const errorStream = (message: string) => sse([errorFrame(message)]);

/** An error frame as the stream's last bytes, with no newline after it, so
 *  only the parser's trailing-buffer branch ever sees it. */
function errorStreamNoTrailingNewline(message: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorFrame(message))}`));
      controller.close();
    },
  });
}

/** A stream whose first read rejects with `err`. */
function failingStream(err: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(err);
    },
  });
}

/** A stream that delivers `frames` as SSE, then rejects the next read with
 *  `err`. Pull-driven: erroring a stream discards the chunks still queued in
 *  it, so the error is raised only once the frames have been read. */
function sseThenFail(frames: unknown[], err: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (i < frames.length) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[i++])}\n\n`));
        } else {
          controller.error(err);
        }
      },
    },
    { highWaterMark: 0 }
  );
}

const instruction = (name: string) => `[Write the next reply only as ${name}.]`;

type Payload = { role: string; content: string }[];

function endsOnAssistant(payload: Payload): boolean {
  const last = [...payload].reverse().find((m) => m.role !== 'system');
  return last?.role === 'assistant';
}

/** A provider that refuses assistant prefill. */
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

/** `who`'s messages in the transcript, greetings excluded. */
const repliesFrom = (who: CharacterInfo) =>
  useChatStore
    .getState()
    .messages.filter(
      (m) => !m.isUser && m.characterAvatar === who.avatar && m.id !== 'g1' && m.id !== 'g2'
    );

const GROUP_FILE = 'group-prefill.jsonl';

/** A persisted group record, so sendGroupMessage reads its strategy and
 *  auto-mode settings from it. */
function groupRecord(over: Partial<GroupChatInfo>): GroupChatInfo {
  return {
    fileName: GROUP_FILE,
    characterNames: roster.map((c) => c.name),
    characterAvatars: rosterAvatars,
    lastMessage: '',
    createdAt: 0,
    activationStrategy: 'list',
    mutedAvatars: [],
    pooledExcludeRecent: 0,
    autoModeEnabled: false,
    autoModeDelayMs: 0,
    scenarioOverride: '',
    talkativenessOverrides: {},
    cardMode: 'swap',
    ...over,
  };
}

/** An auto-mode group in natural order with no delay between ticks. A chat
 *  file is set so sendGroupMessage resolves the record; saving and recall are
 *  stubbed/disabled so neither reaches the network. */
function seedAutoModeGroup() {
  vi.spyOn(api, 'saveChat').mockResolvedValue({ server_ts: 1 });
  useChatHistoryRagStore.setState({ enabled: false });
  useChatStore.setState({
    currentChatFile: GROUP_FILE,
    isSending: false,
    isStreaming: false,
    error: null,
    messages: greetings(),
    groupChats: [
      groupRecord({ activationStrategy: 'natural', autoModeEnabled: true, autoModeDelayMs: 0 }),
    ],
  });
}

function installHarness() {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage() as unknown as Storage;
    useSettingsStore.setState({ activeProvider: 'anthropic', activeModel: 'claude-sonnet-5-5' });
  });

  afterEach(() => {
    globalThis.localStorage = realLocalStorage;
    vi.restoreAllMocks();
  });
}

describe('group round on a prefill-rejecting provider (#421, #578)', () => {
  installHarness();

  // The conditions the cases below rely on. These held before and after the
  // fix, so a broken harness cannot pass for a reproduced bug.
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
  it("speaker two's payload does not end on an assistant turn", async () => {
    const spy = prefillRejectingProvider();
    await runRound();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(endsOnAssistant(spy.mock.calls[1][0] as Payload)).toBe(false);
  });

  // #421 secondary: an upstream error inside the 200 SSE stream must not
  // read as a blank completion. Unconditional error, so this case tracks the
  // swallow independently of the payload fix.
  it("an upstream error in speaker two's stream is surfaced, not dropped as blank", async () => {
    let call = 0;
    vi.spyOn(api, 'generateMessage').mockImplementation(async () =>
      ++call === 1 ? textStream('[emotion:joy] Hi.') : errorStream('upstream exploded')
    );
    await runRound();
    expect(call).toBe(2);
    expect(useChatStore.getState().error).toBe('upstream exploded');
    // Speaker two's placeholder is gone; speaker one's reply stays.
    expect(repliesFrom(seraphina)).toEqual([]);
    expect(repliesFrom(ivy)).toHaveLength(1);
    expect(repliesFrom(ivy)[0].content).toBe('Hi.');
  });

  // #578: the panel's focus input after the round. Before the fix it read
  // [seraphina, ivy, seraphina, ivy] — the last two values are speaker two's
  // placeholder appearing and being removed. Once speaker two can reply, the
  // round ends with focus on her, on a message with content.
  it('after the round the panel focus rests on speaker two, with no fall-back', async () => {
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

describe('#421 AC1: every group payload ends on a user-role entry', () => {
  installHarness();

  it("speaker two's payload ends on the speaker instruction naming speaker two; speaker one's is untouched", async () => {
    const spy = prefillRejectingProvider();
    await runRound();
    expect(spy).toHaveBeenCalledTimes(2);
    const first = spy.mock.calls[0][0] as Payload;
    const second = spy.mock.calls[1][0] as Payload;
    expect(first[first.length - 1]).toEqual({ role: 'user', content: 'Each of you, say hi.' });
    expect(first.some((m) => m.content === instruction('Ivy'))).toBe(false);
    expect(second[second.length - 1]).toEqual({ role: 'user', content: instruction('Seraphina') });
    // The entry before it is speaker one's reply, sent as history.
    expect(second[second.length - 2]).toEqual({ role: 'assistant', content: '[Ivy]: Hi, I\'m Ivy.' });
  });

  it('a trailing system entry after the last assistant turn still gets the instruction', async () => {
    // A constant after_an world-info entry is emitted as a system message
    // after the whole history, so it is every payload's literal last entry
    // until the instruction is appended.
    const LORE = 'Lore: the back room has no clock.';
    const prev = useWorldInfoStore.getState();
    useWorldInfoStore.setState({
      books: [mkBook('b-prefill', [mkEntry('e-prefill', { content: LORE, position: 'after_an' })])],
      activeBookIds: ['b-prefill'],
    });
    try {
      const spy = prefillRejectingProvider();
      await runRound();
      expect(spy).toHaveBeenCalledTimes(2);
      const first = spy.mock.calls[0][0] as Payload;
      const second = spy.mock.calls[1][0] as Payload;
      // Speaker one: the user's turn, then the system entry — no instruction.
      expect(first.slice(-2)).toEqual([
        { role: 'user', content: 'Each of you, say hi.' },
        { role: 'system', content: LORE },
      ]);
      expect(first.some((m) => m.content === instruction('Ivy'))).toBe(false);
      // Speaker two: speaker one's reply, the system entry, the instruction.
      expect(second.slice(-3)).toEqual([
        { role: 'assistant', content: '[Ivy]: Hi, I\'m Ivy.' },
        { role: 'system', content: LORE },
        { role: 'user', content: instruction('Seraphina') },
      ]);
      expect(useChatStore.getState().error).toBeNull();
    } finally {
      useWorldInfoStore.setState({ books: prev.books, activeBookIds: prev.activeBookIds });
    }
  });

  it('force-talk on a history ending in an assistant turn ends on the instruction', async () => {
    const spy = prefillRejectingProvider();
    seedGroup();
    await useChatStore.getState().forceGroupMemberTalk(ivy, roster);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0][0] as Payload;
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: instruction('Ivy') });
    expect(useChatStore.getState().error).toBeNull();
    expect(repliesFrom(ivy)).toHaveLength(1);
  });

  it("force-talk on a history ending in the user's turn sends no instruction", async () => {
    const spy = prefillRejectingProvider();
    seedGroup();
    useChatStore.setState({
      messages: [
        ...greetings(),
        { id: 'u1', name: 'User', isUser: true, isSystem: false, content: 'Ivy, you first.', timestamp: 3, swipes: ['Ivy, you first.'], swipeId: 0 } as ChatMessage,
      ],
    });
    await useChatStore.getState().forceGroupMemberTalk(ivy, roster);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0][0] as Payload;
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'Ivy, you first.' });
    expect(sent.some((m) => m.content === instruction('Ivy'))).toBe(false);
  });

  it('force-talk after an image-only user turn and a reply: no empty user turn ships, and no images are sent', async () => {
    // gpt-4o can see images, so imagesFromLastUserMessage resolves the
    // attachment on the blank user turn. The newest turn is Ivy's reply, so
    // the turn withholds it (D-E9S11-5) and the blank carrier turn must not
    // ship as an empty content block.
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () => textStream('[emotion:joy] Lovely.'));
    useSettingsStore.setState({ activeProvider: 'openai', activeModel: 'gpt-4o' });
    seedGroup();
    useChatStore.setState({
      messages: [
        { id: 'u1', name: 'User', isUser: true, isSystem: false, content: '', timestamp: 1, swipes: [''], swipeId: 0, images: ['data:image/png;base64,AAAA'] } as ChatMessage,
        { id: 'a1', name: 'Ivy', isUser: false, isSystem: false, content: 'What a photo.', timestamp: 2, characterAvatar: ivy.avatar, swipes: ['What a photo.'], swipeId: 0 } as ChatMessage,
      ],
    });
    await useChatStore.getState().forceGroupMemberTalk(seraphina, roster);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0][0] as Payload;
    expect(sent.every((m) => m.content.trim() !== '')).toBe(true);
    expect(sent.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([instruction('Seraphina')]);
    expect(sent[sent.length - 1].role).toBe('user');
    expect(spy.mock.calls[0][6]).toBeUndefined();
  });

  it('force-talk after a TEXT+image user message and a reply sends no images, so none land on the instruction', async () => {
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () => textStream('[emotion:joy] A spaniel.'));
    useSettingsStore.setState({ activeProvider: 'openai', activeModel: 'gpt-4o' });
    seedGroup();
    useChatStore.setState({
      messages: [
        { id: 'u1', name: 'User', isUser: true, isSystem: false, content: 'What breed is this dog?', timestamp: 1, swipes: ['What breed is this dog?'], swipeId: 0, images: ['data:image/png;base64,AAAA'] } as ChatMessage,
        { id: 'a1', name: 'Ivy', isUser: false, isSystem: false, content: 'Cute dog!', timestamp: 2, characterAvatar: ivy.avatar, swipes: ['Cute dog!'], swipeId: 0 } as ChatMessage,
      ],
    });
    await useChatStore.getState().forceGroupMemberTalk(seraphina, roster);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][6]).toBeUndefined();
    const sent = spy.mock.calls[0][0] as Payload;
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: instruction('Seraphina') });
  });

  it("force-talk right after the user's image message (newest turn is the user's) still sends the images and appends no instruction", async () => {
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () => textStream('[emotion:joy] A spaniel.'));
    useSettingsStore.setState({ activeProvider: 'openai', activeModel: 'gpt-4o' });
    seedGroup();
    useChatStore.setState({
      messages: [
        ...greetings(),
        { id: 'u1', name: 'User', isUser: true, isSystem: false, content: 'What breed is this dog?', timestamp: 3, swipes: ['What breed is this dog?'], swipeId: 0, images: ['data:image/png;base64,AAAA'] } as ChatMessage,
      ],
    });
    await useChatStore.getState().forceGroupMemberTalk(ivy, roster);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][6]).toHaveLength(1);
    const sent = spy.mock.calls[0][0] as Payload;
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'What breed is this dog?' });
    expect(sent.some((m) => m.content === instruction('Ivy'))).toBe(false);
  });

  it("auto-mode (natural): every tick's payload ends on a user-role entry", async () => {
    let call = 0;
    const spy = vi.spyOn(api, 'generateMessage').mockImplementation(async (payload) => {
      // Stop after the third tick has dispatched.
      if (++call === 3) useChatStore.getState().stopGeneration();
      return endsOnAssistant(payload as Payload)
        ? errorStream(PREFILL_ERROR)
        : textStream('[emotion:joy] Hello again.');
    });
    seedAutoModeGroup();
    await sendRound();
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [payload] of spy.mock.calls) {
      const p = payload as Payload;
      expect(p[p.length - 1].role).toBe('user');
      expect(endsOnAssistant(p)).toBe(false);
    }
    // Ticks two and three follow a member's reply, so they end on the
    // instruction for whoever was picked.
    for (const [payload, name] of spy.mock.calls.slice(1)) {
      const p = payload as Payload;
      expect(p[p.length - 1].content).toBe(instruction(name as string));
    }
    expect(useChatStore.getState().error).toBeNull();
  });
});

describe('#421 AC2: an upstream error frame is surfaced, never a silent blank turn', () => {
  installHarness();

  it('force-talk: an upstream error frame sets error and removes the placeholder', async () => {
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () => errorStream('upstream exploded'));
    seedGroup();
    await useChatStore.getState().forceGroupMemberTalk(ivy, roster);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().error).toBe('upstream exploded');
    expect(repliesFrom(ivy)).toEqual([]);
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['g1', 'g2']);
  });

  it('an error frame with no trailing newline is still surfaced', async () => {
    vi.spyOn(api, 'generateMessage').mockImplementation(async () =>
      errorStreamNoTrailingNewline('upstream exploded at the end')
    );
    seedGroup();
    await useChatStore.getState().forceGroupMemberTalk(ivy, roster);
    expect(useChatStore.getState().error).toBe('upstream exploded at the end');
    expect(repliesFrom(ivy)).toEqual([]);
  });

  it('an upstream error after partial text keeps the partial reply, surfaces the error and ends the round', async () => {
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () =>
        sse([textFrame('[emotion:joy] Hi, I was say'), errorFrame('upstream cut off')])
      );
    await runRound();
    // The round stopped at speaker one: speaker two was never asked.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().error).toBe('upstream cut off');
    expect(repliesFrom(ivy).map((m) => m.content)).toEqual(['Hi, I was say']);
    expect(repliesFrom(seraphina)).toEqual([]);
  });

  it('an upstream error ends an auto-mode loop instead of retrying every tick', async () => {
    let call = 0;
    const spy = vi.spyOn(api, 'generateMessage').mockImplementation(async () => {
      // Safety valve: a loop that keeps going is stopped on its next tick.
      if (++call === 2) useChatStore.getState().stopGeneration();
      return errorStream('quota exceeded');
    });
    seedAutoModeGroup();
    await sendRound();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().error).toBe('quota exceeded');
  });

  it('a stream that errors before any token removes the placeholder and surfaces the error', async () => {
    let call = 0;
    const spy = vi.spyOn(api, 'generateMessage').mockImplementation(async () =>
      ++call === 1 ? textStream('[emotion:joy] Hi.') : failingStream(new TypeError('network error'))
    );
    await runRound();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().error).toBe('network error');
    expect(repliesFrom(seraphina)).toEqual([]);
    expect(repliesFrom(ivy).map((m) => m.content)).toEqual(['Hi.']);
  });

  it('a stream that errors after partial text keeps the finalized partial reply and surfaces the error', async () => {
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () =>
        sseThenFail([textFrame('[emotion:joy] Hi, I was say')], new TypeError('network error'))
      );
    await runRound();
    // The round stopped at speaker one: speaker two was never asked.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().error).toBe('network error');
    const kept = repliesFrom(ivy);
    expect(kept.map((m) => m.content)).toEqual(['Hi, I was say']);
    expect(kept[0].emotion).toBe('joy');
    expect(repliesFrom(seraphina)).toEqual([]);
  });

  it('an aborted stream (AbortError) removes a blank placeholder and sets no error', async () => {
    const spy = vi
      .spyOn(api, 'generateMessage')
      .mockImplementation(async () => failingStream(new DOMException('aborted', 'AbortError')));
    await runRound();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().error).toBeNull();
    expect(repliesFrom(ivy)).toEqual([]);
    expect(repliesFrom(seraphina)).toEqual([]);
  });

  it('a genuinely blank completion (no error frame) is still dropped silently and the round continues', async () => {
    let call = 0;
    const spy = vi.spyOn(api, 'generateMessage').mockImplementation(async () =>
      // Speaker one's stream carries only an emotion tag, which strips to
      // nothing; speaker two's is a normal reply.
      ++call === 1 ? textStream('[emotion:joy]') : textStream('[emotion:joy] Hello.')
    );
    await runRound();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().error).toBeNull();
    expect(repliesFrom(ivy)).toEqual([]);
    expect(repliesFrom(seraphina).map((m) => m.content)).toEqual(['Hello.']);
  });
});

describe('#421 AC3: the published breakdown describes the dispatched payload', () => {
  installHarness();

  it("speaker two's published breakdown records the instruction as a call-site turn, and assembledTotal + callSite equals the dispatched estimate", async () => {
    const spy = prefillRejectingProvider();
    await runRound();
    expect(spy).toHaveBeenCalledTimes(2);
    const sent = spy.mock.calls[1][0] as Payload;
    const breakdown = useGenerationStore.getState().lastPromptBreakdown!;
    const callSite = breakdown.slices.filter((s) => s.kind.stage === 'callSite');
    expect(callSite.map((s) => s.kind)).toEqual([{ stage: 'callSite', turn: 'group_nudge' }]);
    expect(callSite[0].chars).toBe(instruction('Seraphina').length);
    const dispatched = estimateConversationTokens(sent, breakdown.profile);
    expect(breakdown.totals.assembledTotal + breakdown.totals.callSite).toBe(dispatched);
    const reply = repliesFrom(seraphina);
    expect(reply).toHaveLength(1);
    expect(reply[0].usage!.inputTokens).toBe(dispatched);
  });

  it("speaker one's breakdown has no call-site turn", async () => {
    let firstBreakdown: PromptBreakdown | null = null;
    let call = 0;
    vi.spyOn(api, 'generateMessage').mockImplementation(async (payload, name) => {
      // Published before dispatch, so on call 1 it is speaker one's.
      if (++call === 1) firstBreakdown = useGenerationStore.getState().lastPromptBreakdown;
      return endsOnAssistant(payload as Payload)
        ? errorStream(PREFILL_ERROR)
        : textStream(`[emotion:joy] Hi, I'm ${name}.`);
    });
    await runRound();
    expect(firstBreakdown).not.toBeNull();
    expect(firstBreakdown!.slices.some((s) => s.kind.stage === 'callSite')).toBe(false);
    expect(firstBreakdown!.totals.callSite).toBe(0);
  });
});
