import { describe, it, expect } from 'vitest';
import { trimHistoryToBudget, estimateMessageTokens } from './tokenizer';

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };

const msg = (role: Msg['role'], content: string): Msg => ({ role, content });
const long = (n: number) => 'x'.repeat(n);

describe('trimHistoryToBudget', () => {
  it('keeps the newest messages and drops the oldest when over budget', () => {
    const history = [
      msg('user', long(400)),
      msg('assistant', long(400)),
      msg('user', long(400)),
    ];
    const perMsg = estimateMessageTokens(history[0], 'generic');
    const { kept, dropped } = trimHistoryToBudget(
      [],
      history,
      0,
      // Room for two messages plus overheads, not three.
      Math.max(256, perMsg * 2 + 32),
      'generic'
    );
    expect(dropped).toBe(1);
    expect(kept).toEqual([history[1], history[2]]);
  });

  it('always keeps the newest real turn even when over budget', () => {
    const history = [msg('user', long(4000))];
    const { kept, overBudget } = trimHistoryToBudget(
      [msg('system', long(2000))],
      history,
      0,
      300,
      'generic'
    );
    expect(kept).toEqual(history);
    expect(overBudget).toBe(true);
  });

  it('keeps a pinned real turn behind trailing insertions when over budget', () => {
    // A depth-0 insertion sits after the newest user turn. The caller pins
    // the turn; the droppable insertion goes, the turn survives.
    const userTurn = msg('user', long(400));
    const history = [msg('assistant', long(400)), userTurn, msg('system', long(400))];
    const { kept, overBudget } = trimHistoryToBudget(
      [msg('system', long(2000))],
      history,
      0,
      300,
      'generic',
      new Set([userTurn])
    );
    expect(kept).toEqual([userTurn]);
    expect(overBudget).toBe(true);
  });

  it('is not fooled by a user-role trailing insertion masquerading as the turn', () => {
    // Regression: an author's note with role 'user' injected at depth 0 must
    // not displace the user's actual newest message under budget pressure.
    const realTurn = msg('user', long(400));
    const userRoleNote = msg('user', long(400));
    const history = [realTurn, userRoleNote];
    const { kept } = trimHistoryToBudget(
      [msg('system', long(2000))],
      history,
      0,
      300,
      'generic',
      new Set([realTurn])
    );
    expect(kept).toContain(realTurn);
  });

  it('pinned messages survive the trim even when older than the kept window', () => {
    const pinnedInsertion = msg('system', long(200));
    const history = [
      pinnedInsertion,
      msg('user', long(400)),
      msg('assistant', long(400)),
      msg('user', long(400)),
    ];
    const perMsg = estimateMessageTokens(history[1], 'generic');
    const pinnedCost = estimateMessageTokens(pinnedInsertion, 'generic');
    const budget = Math.max(256, pinnedCost + perMsg * 2 + 32);
    const { kept, dropped } = trimHistoryToBudget(
      [],
      history,
      0,
      budget,
      'generic',
      new Set([pinnedInsertion])
    );
    // The unpinned oldest turn is dropped; the pinned insertion survives in
    // original order.
    expect(dropped).toBe(1);
    expect(kept).toEqual([pinnedInsertion, history[2], history[3]]);
  });

  it('pinned cost is charged against the budget for everything else', () => {
    const pinnedInsertion = msg('system', long(400));
    const history = [
      pinnedInsertion,
      msg('assistant', long(400)),
      msg('user', long(400)),
    ];
    const perMsg = estimateMessageTokens(history[1], 'generic');
    // Budget fits pinned + one message only.
    const budget = Math.max(
      256,
      estimateMessageTokens(pinnedInsertion, 'generic') + perMsg + 32
    );
    const { kept } = trimHistoryToBudget(
      [],
      history,
      0,
      budget,
      'generic',
      new Set([pinnedInsertion])
    );
    expect(kept).toEqual([pinnedInsertion, history[2]]);
  });

  it('matches the unpinned baseline when the pinned set is empty', () => {
    const history = [
      msg('user', long(400)),
      msg('assistant', long(400)),
      msg('user', long(400)),
    ];
    const budget = 100000;
    const withSet = trimHistoryToBudget(
      [],
      history,
      0,
      budget,
      'generic',
      new Set<Msg>()
    );
    const without = trimHistoryToBudget([], history, 0, budget, 'generic');
    expect(withSet).toEqual(without);
  });
});
