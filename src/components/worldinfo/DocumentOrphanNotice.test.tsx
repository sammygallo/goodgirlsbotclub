/**
 * @vitest-environment jsdom
 *
 * E4-S0 / AC4 — the "reported" half. The criterion asks for orphans to be
 * *reported*, which a console.warn is not, so what earns a DOM test here is
 * exactly the part a pure-function test cannot see:
 *
 *   - the finding reaches actual rendered text a user can read, naming the
 *     document rather than an id nobody can act on;
 *   - the panel renders NOTHING on a healthy account, so it is a section
 *     that exists only where the problem does rather than a permanent
 *     "all clear" fixture;
 *   - it offers no destructive control. An orphaned document is text the
 *     user can no longer reach, so a "clean up" button's failure mode is
 *     deleting the only copy — pinned so nobody adds one later.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DocumentOrphan } from '../../utils/documentBookOrphans';

// This repo doesn't wire @testing-library/jest-dom, so assert on plain DOM
// state rather than its matchers (same note as TakeSelfieModal.test.tsx).

const { DocumentOrphanNotice } = await import('./DocumentOrphanNotice');

afterEach(cleanup);

const stranded: DocumentOrphan = {
  kind: 'owner-gone',
  bookId: 'doc-stranded',
  bookName: 'Ivy Dossier',
  ownerCharacterAvatar: 'deleted-character.png',
};

const leftover: DocumentOrphan = {
  kind: 'unresolved-registration',
  bookId: 'doc-vanished',
  bookName: null,
  ownerCharacterAvatar: null,
};

describe('DocumentOrphanNotice', () => {
  it('renders nothing at all when there are no orphans', () => {
    const { container } = render(<DocumentOrphanNotice orphans={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('names a stranded book and the owner that no longer resolves', () => {
    render(<DocumentOrphanNotice orphans={[stranded]} />);
    expect(screen.getByText('Ivy Dossier')).toBeTruthy();
    expect(screen.getByText('deleted-character.png')).toBeTruthy();
    // The consequence, not just the fact — this is why it matters.
    expect(screen.getByText(/out of every chat/i)).toBeTruthy();
  });

  it('calls a stranded book a lorebook, not a document', () => {
    // The stranded list covers every character-scoped book whose owner is
    // gone — a character's own embedded card lorebook was never a Data Bank
    // document, and calling it one sends the user looking in the wrong part
    // of the app for it.
    const card: DocumentOrphan = {
      kind: 'owner-gone',
      bookId: 'embedded-book',
      bookName: "Ghost's Lorebook",
      ownerCharacterAvatar: 'deleted-character.png',
    };
    const { container } = render(<DocumentOrphanNotice orphans={[card]} />);
    expect(screen.getByText(/This lorebook belongs/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/This document belongs/i);
  });

  it('reports an unresolved registration by id', () => {
    render(<DocumentOrphanNotice orphans={[leftover]} />);
    expect(screen.getByText('doc-vanished')).toBeTruthy();
  });

  it('reports both senses together, counted', () => {
    render(<DocumentOrphanNotice orphans={[stranded, leftover]} />);
    expect(screen.getByText(/Orphaned lorebooks \(2\)/)).toBeTruthy();
    expect(screen.getByText('Ivy Dossier')).toBeTruthy();
    expect(screen.getByText('doc-vanished')).toBeTruthy();
  });

  it('offers no button that could destroy the stranded text', () => {
    const { container } = render(
      <DocumentOrphanNotice orphans={[stranded, leftover]} />
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    // …and says so, so the panel does not read as an unfinished repair UI.
    expect(screen.getByText(/nothing has been deleted/i)).toBeTruthy();
  });
});
