import { describe, it, expect } from 'vitest';
import {
  detectDocumentBookOrphans,
  type DetectDocumentOrphansInput,
} from './documentBookOrphans';
import type { WorldInfoBook } from '../stores/worldInfoStore';

// E4-S0 / AC4 — "already-orphaned character-scoped books are detected and
// reported." Two independent ways a book goes orphaned — a stranded owner,
// which is any character-scoped book and not just a registered document, and
// a registry record with no book behind it — and one way the detector could
// be worse than useless: firing during hydration, when a book that is merely
// late looks exactly like a book that is gone. Every readiness case below
// exists because the repair this ships alongside already lost that race once.

const AVATAR = 'seraphina.png';
const GONE_AVATAR = 'deleted-character.png';

function mkBook(over: Partial<WorldInfoBook> = {}): WorldInfoBook {
  const ownerCharacterAvatar = over.ownerCharacterAvatar ?? null;
  return {
    id: 'book-1',
    name: 'Field Notes',
    entries: [],
    ownerHandle: '',
    visibility: 'private',
    createdAt: 0,
    updatedAt: 0,
    ...over,
    ownerCharacterAvatar,
    scope: ownerCharacterAvatar != null ? 'character' : 'world',
  };
}

/** Everything settled and consistent — the shape a healthy account is in. */
function input(over: Partial<DetectDocumentOrphansInput> = {}): DetectDocumentOrphansInput {
  return {
    documentIds: [],
    books: [],
    characterAvatars: [AVATAR],
    booksSettled: true,
    charactersSettled: true,
    ...over,
  };
}

describe('detectDocumentBookOrphans — nothing to report', () => {
  it('reports nothing for an account with no documents at all', () => {
    expect(detectDocumentBookOrphans(input())).toEqual([]);
  });

  it('reports nothing when every document resolves and its owner exists', () => {
    const global = mkBook({ id: 'doc-global', name: 'Field Notes' });
    const owned = mkBook({
      id: 'doc-owned',
      name: 'Ivy Dossier',
      ownerCharacterAvatar: AVATAR,
    });
    expect(
      detectDocumentBookOrphans(
        input({
          documentIds: [global.id, owned.id],
          books: [global, owned],
        })
      )
    ).toEqual([]);
  });

  it('never blames a GLOBAL document on the character list', () => {
    // A world-scoped document has no owner to lose, so an empty character
    // list must not implicate it — not even on an account with zero
    // characters, which is otherwise the most orphan-looking state there is.
    const global = mkBook({ id: 'doc-global' });
    expect(
      detectDocumentBookOrphans(
        input({
          documentIds: [global.id],
          books: [global],
          characterAvatars: [],
        })
      )
    ).toEqual([]);
  });

  it('leaves an embedded card lorebook alone while its character exists', () => {
    // The registry is deliberately NON-empty and resolving here, so nothing
    // in this result can be explained by "the registry was empty, so the
    // detector had nothing to look at".
    const registered = mkBook({
      id: 'doc-owned',
      ownerCharacterAvatar: AVATAR,
    });
    const embedded = mkBook({
      id: 'embedded-book',
      name: "Seraphina's Lorebook",
      ownerCharacterAvatar: AVATAR,
    });
    expect(
      detectDocumentBookOrphans(
        input({
          documentIds: [registered.id],
          books: [registered, embedded],
        })
      )
    ).toEqual([]);
  });
});

describe('detectDocumentBookOrphans — owner-gone (sense b)', () => {
  it('detects a character-scoped document whose owner no longer exists', () => {
    const stranded = mkBook({
      id: 'doc-stranded',
      name: 'Ivy Dossier',
      ownerCharacterAvatar: GONE_AVATAR,
    });
    expect(
      detectDocumentBookOrphans(
        input({ documentIds: [stranded.id], books: [stranded] })
      )
    ).toEqual([
      {
        kind: 'owner-gone',
        bookId: 'doc-stranded',
        bookName: 'Ivy Dossier',
        ownerCharacterAvatar: GONE_AVATAR,
      },
    ]);
  });

  it('reports the stranded one and leaves its healthy sibling alone', () => {
    const healthy = mkBook({
      id: 'doc-healthy',
      name: 'Live Dossier',
      ownerCharacterAvatar: AVATAR,
    });
    const stranded = mkBook({
      id: 'doc-stranded',
      name: 'Ghost Dossier',
      ownerCharacterAvatar: GONE_AVATAR,
    });
    const found = detectDocumentBookOrphans(
      input({
        documentIds: [healthy.id, stranded.id],
        books: [healthy, stranded],
      })
    );
    expect(found.map((o) => o.bookId)).toEqual(['doc-stranded']);
  });

  it('reports an embedded card lorebook that outlived its character', () => {
    // AC4 says character-scoped BOOKS, and the registry has no bearing on
    // being stranded: a card lorebook orphaned by a deletion from before
    // deleteCharacterBooks shipped is out of every scan for exactly the same
    // reason a stranded document is, and has exactly as little to show for
    // itself in the UI.
    //
    // The registry is EMPTY on purpose. This is the case a registry-keyed
    // detector — or a `documentIds.length === 0` early return in front of
    // one — cannot see at all, and it is the case the widening is for.
    const embedded = mkBook({
      id: 'embedded-book',
      name: "Ghost's Lorebook",
      ownerCharacterAvatar: GONE_AVATAR,
    });
    expect(
      detectDocumentBookOrphans(input({ documentIds: [], books: [embedded] }))
    ).toEqual([
      {
        kind: 'owner-gone',
        bookId: 'embedded-book',
        bookName: "Ghost's Lorebook",
        ownerCharacterAvatar: GONE_AVATAR,
      },
    ]);
  });

  it('judges by ownerCharacterAvatar, not the derived scope field', () => {
    // worldInfoStore calls `scope` "never authoritative" and recomputes it
    // at every write site. A book that arrived from storage with a stale
    // scope must still be judged on the field that actually routes it.
    const lying = {
      ...mkBook({ id: 'doc-lying', ownerCharacterAvatar: GONE_AVATAR }),
      scope: 'world' as const,
    };
    const found = detectDocumentBookOrphans(
      input({ documentIds: [lying.id], books: [lying] })
    );
    expect(found.map((o) => o.kind)).toEqual(['owner-gone']);
  });
});

describe('detectDocumentBookOrphans — unresolved registration (sense a)', () => {
  it('detects a registered document id with no book behind it', () => {
    expect(
      detectDocumentBookOrphans(input({ documentIds: ['doc-vanished'] }))
    ).toEqual([
      {
        kind: 'unresolved-registration',
        bookId: 'doc-vanished',
        bookName: null,
        ownerCharacterAvatar: null,
      },
    ]);
  });

  it('is not fooled by a non-empty book list that lacks the document', () => {
    // The exact state the activation repair had to be rewritten for: a
    // localStorage cache full of OTHER books is not evidence about this one.
    // Here the fetch has since succeeded, so the id really is unresolvable.
    const other = mkBook({ id: 'some-other-book' });
    const found = detectDocumentBookOrphans(
      input({ documentIds: ['doc-vanished'], books: [other] })
    );
    expect(found.map((o) => o.bookId)).toEqual(['doc-vanished']);
  });

  it('reports a duplicated registry id exactly once', () => {
    const found = detectDocumentBookOrphans(
      input({ documentIds: ['doc-vanished', 'doc-vanished'] })
    );
    expect(found).toHaveLength(1);
  });
});

describe('detectDocumentBookOrphans — the cold-start window', () => {
  it('stays silent about an unresolved id while the book fetch is unsettled', () => {
    // Cold start: dataBankStore's registry is restored from localStorage
    // instantly, worldInfoStore's books arrive over the network. Reporting
    // here would tell every returning user their documents are gone, once
    // per page load, and a report cannot retry its way back from that.
    expect(
      detectDocumentBookOrphans(
        input({ documentIds: ['doc-late'], booksSettled: false })
      )
    ).toEqual([]);
  });

  it('stays silent about a partially-hydrated book list', () => {
    // The genuinely nasty shape: SOME books have landed (from the stale
    // cache), so "the list is non-empty" is true and still proves nothing.
    const cached = mkBook({ id: 'cached-book' });
    expect(
      detectDocumentBookOrphans(
        input({
          documentIds: ['doc-late'],
          books: [cached],
          booksSettled: false,
        })
      )
    ).toEqual([]);
  });

  it('stays silent about owners while the character list is unsettled', () => {
    const owned = mkBook({
      id: 'doc-owned',
      ownerCharacterAvatar: AVATAR,
    });
    expect(
      detectDocumentBookOrphans(
        input({
          documentIds: [owned.id],
          books: [owned],
          // characterStore before its first fetch: `[]`, and NOT because the
          // account is empty.
          characterAvatars: [],
          charactersSettled: false,
        })
      )
    ).toEqual([]);
  });

  it('stays silent about an UNREGISTERED orphan while characters are unsettled', () => {
    // The widened sense gets the same gate, and needs it just as badly: a
    // character-scoped book is the normal state of every card lorebook on
    // the account, so a detector that ran before the character list landed
    // would report the user's entire library as stranded.
    //
    // This one is empty-registry by necessity (the widened sense is what is
    // under test), which means an early return would ALSO produce `[]` here.
    // What keeps it honest is 'reports an embedded card lorebook that
    // outlived its character' above: that case, same empty registry, must
    // report — so the two together can only both pass on a detector that
    // reads the gate rather than the registry's length.
    const embedded = mkBook({
      id: 'embedded-book',
      ownerCharacterAvatar: GONE_AVATAR,
    });
    expect(
      detectDocumentBookOrphans(
        input({
          documentIds: [],
          books: [embedded],
          characterAvatars: [],
          charactersSettled: false,
        })
      )
    ).toEqual([]);
  });

  it('stays fully silent on a cold start with both fetches outstanding', () => {
    // The whole-app cold boot, which is what a false positive would actually
    // ship on: nothing settled, nothing reported — the registered document
    // and the card lorebook that is in no registry at all alike.
    const stranded = mkBook({
      id: 'doc-stranded',
      ownerCharacterAvatar: GONE_AVATAR,
    });
    const embedded = mkBook({
      id: 'embedded-book',
      ownerCharacterAvatar: GONE_AVATAR,
    });
    expect(
      detectDocumentBookOrphans({
        documentIds: ['doc-late', stranded.id],
        books: [stranded, embedded],
        characterAvatars: [],
        booksSettled: false,
        charactersSettled: false,
      })
    ).toEqual([]);
  });

  it('reports each sense as soon as ITS OWN fetch settles, not both', () => {
    // The two gates are independent — a slow character fetch must not
    // suppress an unresolved registration the book fetch has already proven,
    // and a failed book fetch must not suppress a stranded owner.
    const stranded = mkBook({
      id: 'doc-stranded',
      ownerCharacterAvatar: GONE_AVATAR,
    });
    const booksOnly = detectDocumentBookOrphans({
      documentIds: ['doc-vanished', stranded.id],
      books: [stranded],
      characterAvatars: [],
      booksSettled: true,
      charactersSettled: false,
    });
    expect(booksOnly.map((o) => o.kind)).toEqual(['unresolved-registration']);

    const charactersOnly = detectDocumentBookOrphans({
      documentIds: ['doc-vanished', stranded.id],
      books: [stranded],
      characterAvatars: [AVATAR],
      booksSettled: false,
      charactersSettled: true,
    });
    expect(charactersOnly.map((o) => o.kind)).toEqual(['owner-gone']);
  });
});
