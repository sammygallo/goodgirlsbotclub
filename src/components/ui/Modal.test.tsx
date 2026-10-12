/**
 * @vitest-environment jsdom
 *
 * Modal + useModalFocus (E6-S2, D-G5). Modal is the repo's shared dialog
 * primitive: 37 files render it directly and ConfirmDialog adds ~20 callers, so
 * what is pinned here is the contract every one of them now inherits —
 * semantics (role/aria), containment (inert siblings), focus in/out, and
 * Escape.
 *
 * jsdom does not implement `inert` (it ignores the attribute: nothing becomes
 * unfocusable or unclickable), so containment is asserted on the ATTRIBUTE and
 * the real-browser behaviour belongs to QA's Tab walk. Everything else here —
 * focus movement, restore, Escape, stacking — is observable in jsdom as it is
 * in a browser.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

const EXIT_MS = 180;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

beforeEach(() => {
  document.body.innerHTML = '';
});

const escape = () => fireEvent.keyDown(document, { key: 'Escape' });

/** A page with an opener button and one Modal whose open state it owns. */
function Opener({
  body,
  onClose,
}: {
  body?: ReactNode;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal
        isOpen={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Hello"
      >
        {body ?? (
          <>
            <button>First</button>
            <button>Second</button>
          </>
        )}
      </Modal>
    </>
  );
}

function open(opener: HTMLElement) {
  opener.focus();
  fireEvent.click(opener);
}

describe('semantics', () => {
  it('is a modal dialog named by its title', () => {
    render(<Modal isOpen onClose={() => {}} title="Delete everything?">x</Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Delete everything?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Delete everything?');
    expect(document.getElementById(labelledBy!)?.tagName).toBe('H2');
  });

  it('gives two open modals two different title ids', () => {
    render(
      <>
        <Modal isOpen onClose={() => {}} title="One">a</Modal>
        <Modal isOpen onClose={() => {}} title="Two">b</Modal>
      </>,
    );
    const [one, two] = screen.getAllByRole('dialog');
    expect(one.getAttribute('aria-labelledby')).not.toBe(two.getAttribute('aria-labelledby'));
  });

  it('renders nothing while closed', () => {
    render(<Modal isOpen={false} onClose={() => {}} title="Hidden">x</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still closes on a backdrop click', () => {
    const onClose = vi.fn();
    render(<Modal isOpen onClose={onClose} title="T">x</Modal>);
    const backdrop = document.querySelector('.bg-black\\/60') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still locks body scroll while mounted, through the exit animation', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Modal isOpen onClose={() => {}} title="T">x</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Modal isOpen={false} onClose={() => {}} title="T">x</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    act(() => {
      vi.advanceTimersByTime(EXIT_MS + 20);
    });
    expect(document.body.style.overflow).toBe('');
  });
});

describe('containment: inert', () => {
  it('makes every other branch of <body> inert while open, and not the dialog itself', () => {
    const extra = document.createElement('div');
    document.body.appendChild(extra);
    const { container } = render(<Opener />);
    open(screen.getByText('Open'));

    const dialog = screen.getByRole('dialog');
    const root = dialog.parentElement!;
    expect(root.parentElement).toBe(document.body);
    expect(root.hasAttribute('inert')).toBe(false);
    expect(dialog.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('inert')).toBe(true);
    expect(extra.hasAttribute('inert')).toBe(true);
  });

  it('releases exactly what it set when the modal closes', () => {
    vi.useFakeTimers();
    const extra = document.createElement('div');
    document.body.appendChild(extra);
    const { container } = render(<Opener />);
    open(screen.getByText('Open'));
    fireEvent.click(screen.getByLabelText('Close'));

    expect(container.hasAttribute('inert')).toBe(false);
    expect(extra.hasAttribute('inert')).toBe(false);
  });

  it('never releases an inert it did not set (no blanket removal)', () => {
    vi.useFakeTimers();
    const preExisting = document.createElement('div');
    preExisting.setAttribute('inert', '');
    document.body.appendChild(preExisting);
    const { container } = render(<Opener />);
    open(screen.getByText('Open'));
    expect(preExisting.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByLabelText('Close'));

    expect(container.hasAttribute('inert')).toBe(false);
    expect(preExisting.hasAttribute('inert')).toBe(true);
  });

  it('releases on unmount while still open', () => {
    const { container, unmount } = render(<Modal isOpen onClose={() => {}} title="T">x</Modal>);
    expect(container.hasAttribute('inert')).toBe(true);
    unmount();
    expect(container.hasAttribute('inert')).toBe(false);
  });

  it('is live again the moment isOpen goes false, not after the exit animation', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Modal isOpen onClose={() => {}} title="T">x</Modal>);
    expect(container.hasAttribute('inert')).toBe(true);
    rerender(<Modal isOpen={false} onClose={() => {}} title="T">x</Modal>);
    // The dialog is still in the DOM, animating out...
    expect(screen.queryByRole('dialog')).not.toBeNull();
    // ...but the page behind it is already interactive.
    expect(container.hasAttribute('inert')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(EXIT_MS + 20);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('focus in', () => {
  it('moves focus to the first focusable element (the Close button)', () => {
    render(<Opener />);
    open(screen.getByText('Open'));
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
  });

  it('prefers an element marked data-autofocus', () => {
    render(
      <Opener
        body={
          <>
            <button>First</button>
            <button data-autofocus>Second</button>
          </>
        }
      />,
    );
    open(screen.getByText('Open'));
    expect(document.activeElement).toBe(screen.getByText('Second'));
  });

  it('leaves focus alone when the body already took it with autoFocus', () => {
    render(<Opener body={<input aria-label="Name" autoFocus />} />);
    open(screen.getByText('Open'));
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  describe('under StrictMode, whose extra mount cycle hands focus back to the opener in between', () => {
    /** The caller shape the cycle bites: a Modal mounted already open, behind a condition. */
    function Mounted({ body }: { body: ReactNode }) {
      const [show, setShow] = useState(false);
      return (
        <>
          <button onClick={() => setShow(true)}>Open</button>
          {show && (
            <Modal isOpen onClose={() => setShow(false)} title="t">
              {body}
            </Modal>
          )}
        </>
      );
    }

    it('leaves focus on the field the body took with autoFocus', () => {
      render(
        <StrictMode>
          <Mounted body={<input aria-label="f" autoFocus />} />
        </StrictMode>,
      );
      open(screen.getByText('Open'));
      expect(document.activeElement).toBe(screen.getByLabelText('f'));
    });

    it('still opens on the first focusable element when the body took nothing', () => {
      render(
        <StrictMode>
          <Mounted body={<button>First</button>} />
        </StrictMode>,
      );
      open(screen.getByText('Open'));
      expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    });

    it('still hands focus back to the opener on close', () => {
      vi.useFakeTimers();
      render(
        <StrictMode>
          <Mounted body={<input aria-label="f" autoFocus />} />
        </StrictMode>,
      );
      const opener = screen.getByText('Open');
      open(opener);
      fireEvent.click(screen.getByLabelText('Close'));
      expect(document.activeElement).toBe(opener);
    });
  });

  it('does not run activation again when the parent re-renders with a new onClose', () => {
    function Parent() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN(n + 1)}>Tick {n}</button>
          {/* A fresh inline onClose every render: the common caller shape. */}
          <Modal isOpen onClose={() => void n} title="T">
            <button>First</button>
            <button>Second</button>
          </Modal>
        </>
      );
    }
    render(<Parent />);
    screen.getByText('Second').focus();
    fireEvent.click(screen.getByText(/Tick/));
    expect(screen.getByText(/Tick 1/)).toBeTruthy();
    // Had activation re-run, focus would have snapped back to the Close button.
    expect(document.activeElement).toBe(screen.getByText('Second'));
  });
});

describe('focus out', () => {
  it('returns to the opener when isOpen goes false', () => {
    vi.useFakeTimers();
    render(<Opener />);
    const opener = screen.getByText('Open');
    open(opener);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByLabelText('Close'));
    // Immediately, while the exit animation is still playing.
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('returns to the opener when the modal unmounts while open', () => {
    function Conditional() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open && (
            <Modal isOpen onClose={() => setOpen(false)} title="T">
              <button>Inner</button>
            </Modal>
          )}
        </>
      );
    }
    render(<Conditional />);
    const opener = screen.getByText('Open');
    open(opener);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('returns to the opener even when the body took focus with autoFocus', () => {
    // The opener has to be read before React's commit applies autoFocus; read
    // in an effect it would be the (about to vanish) input, and focus would be
    // lost to <body> on close.
    vi.useFakeTimers();
    render(<Opener body={<input aria-label="Name" autoFocus />} />);
    const opener = screen.getByText('Open');
    open(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));

    fireEvent.click(screen.getByLabelText('Close'));
    expect(document.activeElement).toBe(opener);
  });

  it('returns to the opener after Escape', () => {
    vi.useFakeTimers();
    render(<Opener />);
    const opener = screen.getByText('Open');
    open(opener);
    escape();
    expect(document.activeElement).toBe(opener);
  });

  it('does not throw when the opener left the page while the modal was open', () => {
    vi.useFakeTimers();
    function Odd() {
      const [showOpener, setShowOpener] = useState(true);
      const [open, setOpen] = useState(false);
      return (
        <>
          {showOpener && <button onClick={() => setOpen(true)}>Open</button>}
          <button onClick={() => setShowOpener(false)}>Remove opener</button>
          <Modal isOpen={open} onClose={() => setOpen(false)} title="T">x</Modal>
        </>
      );
    }
    render(<Odd />);
    open(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Remove opener'));
    expect(() => fireEvent.click(screen.getByLabelText('Close'))).not.toThrow();
    act(() => {
      vi.advanceTimersByTime(EXIT_MS + 20);
    });
    // Nowhere to send focus to: it simply falls to <body>.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Escape', () => {
  it('closes an open modal', () => {
    const onClose = vi.fn();
    render(<Modal isOpen onClose={onClose} title="T">x</Modal>);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    render(<Modal isOpen onClose={onClose} title="T">x</Modal>);
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does nothing for a modal that is closed', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={false} onClose={onClose} title="T">x</Modal>);
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops listening once the last modal has closed', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(<Modal isOpen onClose={onClose} title="T">x</Modal>);
    rerender(<Modal isOpen={false} onClose={onClose} title="T">x</Modal>);
    act(() => {
      vi.advanceTimersByTime(EXIT_MS + 20);
    });
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls the LATEST onClose, not the one from when the modal opened', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Modal isOpen onClose={first} title="T">x</Modal>);
    rerender(<Modal isOpen onClose={second} title="T">x</Modal>);
    escape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('stacked modals', () => {
  /** B is opened from inside A, as a ConfirmDialog opens over a panel. */
  function Stack({ onCloseA, onCloseB }: { onCloseA?: () => void; onCloseB?: () => void }) {
    const [a, setA] = useState(false);
    const [b, setB] = useState(false);
    return (
      <>
        <button onClick={() => setA(true)}>Open A</button>
        <button onClick={() => setA(false)}>Close A from outside</button>
        <Modal
          isOpen={a}
          onClose={() => {
            onCloseA?.();
            setA(false);
          }}
          title="A"
        >
          <button onClick={() => setB(true)}>Open B</button>
        </Modal>
        <Modal
          isOpen={b}
          onClose={() => {
            onCloseB?.();
            setB(false);
          }}
          title="B"
        >
          <button>B inner</button>
        </Modal>
      </>
    );
  }

  const dialogOf = (name: string) => screen.getByRole('dialog', { name });
  const rootOf = (name: string) => dialogOf(name).parentElement!;

  it('Escape closes only the top modal, then the next press closes the one beneath', () => {
    vi.useFakeTimers();
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    render(<Stack onCloseA={onCloseA} onCloseB={onCloseB} />);
    open(screen.getByText('Open A'));
    fireEvent.click(screen.getByText('Open B'));

    escape();
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();

    escape();
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(onCloseB).toHaveBeenCalledTimes(1);
  });

  it('makes the lower modal inert while the upper is open, and live again after', () => {
    vi.useFakeTimers();
    render(<Stack />);
    open(screen.getByText('Open A'));
    expect(rootOf('A').hasAttribute('inert')).toBe(false);

    fireEvent.click(screen.getByText('Open B'));
    expect(rootOf('A').hasAttribute('inert')).toBe(true);
    expect(rootOf('B').hasAttribute('inert')).toBe(false);

    fireEvent.click(within(rootOf('B')).getByLabelText('Close'));
    expect(rootOf('A').hasAttribute('inert')).toBe(false);
  });

  it('keeps the page inert after the TOP modal closes, because A is still open', () => {
    vi.useFakeTimers();
    const { container } = render(<Stack />);
    open(screen.getByText('Open A'));
    fireEvent.click(screen.getByText('Open B'));
    fireEvent.click(within(rootOf('B')).getByLabelText('Close'));
    expect(container.hasAttribute('inert')).toBe(true);
  });

  it('keeps the trap on B when A closes out of order', () => {
    vi.useFakeTimers();
    const { container } = render(<Stack />);
    const openA = screen.getByText('Open A');
    open(openA);
    fireEvent.click(screen.getByText('Open B'));
    const bInner = screen.getByText('B inner');
    bInner.focus();

    fireEvent.click(screen.getByText('Close A from outside'));
    // A is gone from the stack; B is still the open surface.
    expect(container.hasAttribute('inert')).toBe(true);
    expect(rootOf('B').hasAttribute('inert')).toBe(false);
    // And A closing must not yank focus out of B back to A's opener (which is
    // connected and focusable here, so a restore that ignored the stack would
    // visibly land on it).
    expect(document.activeElement).not.toBe(openA);
    expect(document.activeElement).toBe(bInner);

    fireEvent.click(within(rootOf('B')).getByLabelText('Close'));
    expect(container.hasAttribute('inert')).toBe(false);
  });

  it('hands focus back to the button inside A that opened B', () => {
    vi.useFakeTimers();
    render(<Stack />);
    open(screen.getByText('Open A'));
    const openB = screen.getByText('Open B');
    openB.focus();
    fireEvent.click(openB);
    expect(document.activeElement).toBe(within(rootOf('B')).getByLabelText('Close'));

    fireEvent.click(within(rootOf('B')).getByLabelText('Close'));
    expect(document.activeElement).toBe(openB);
  });

  it('sends B\'s close to the element that opened A once A has gone, not to the button inside A that opened B', () => {
    vi.useFakeTimers();
    render(<Stack />);
    const openA = screen.getByText('Open A');
    open(openA);
    const openB = screen.getByText('Open B');
    openB.focus();
    fireEvent.click(openB);

    fireEvent.click(screen.getByText('Close A from outside'));
    fireEvent.click(within(rootOf('B')).getByLabelText('Close'));
    expect(document.activeElement).toBe(openA);
  });

  it('leaves a surface that was opened from elsewhere alone: its close still goes to its own opener', () => {
    vi.useFakeTimers();
    function Elsewhere() {
      const [a, setA] = useState(false);
      const [b, setB] = useState(false);
      return (
        <>
          <button onClick={() => setA(true)}>Open A</button>
          <button onClick={() => setB(true)}>Open B from the page</button>
          <button onClick={() => setA(false)}>Close A from outside</button>
          <Modal isOpen={a} onClose={() => setA(false)} title="A">
            a
          </Modal>
          <Modal isOpen={b} onClose={() => setB(false)} title="B">
            b
          </Modal>
        </>
      );
    }
    render(<Elsewhere />);
    open(screen.getByText('Open A'));
    // jsdom ignores `inert`, so the page behind A can still be reached here, as
    // a global shortcut or a toast action would reach it.
    open(screen.getByText('Open B from the page'));
    const fromPage = screen.getByText('Open B from the page');

    fireEvent.click(screen.getByText('Close A from outside'));
    fireEvent.click(within(rootOf('B')).getByLabelText('Close'));
    expect(document.activeElement).toBe(fromPage);
  });
});

describe('a nested modal on top of an outer one that unmounts', () => {
  /**
   * The CharacterEdit -> TransferOwnershipModal shape: the page mounts the outer
   * Modal behind a condition, the outer opens an inner one from a button inside
   * it, and the inner's Confirm tears both down in one batch. React runs the
   * outer's cleanup first on a deleted subtree, while the inner is still on top.
   */
  function Editor({ onDone }: { onDone: () => void }) {
    const [inner, setInner] = useState(false);
    return (
      <Modal isOpen onClose={onDone} title="Editor">
        <button onClick={() => setInner(true)}>Transfer</button>
        <Modal isOpen={inner} onClose={() => setInner(false)} title="Confirm">
          <button
            onClick={() => {
              onDone();
              setInner(false);
            }}
          >
            Confirm
          </button>
        </Modal>
      </Modal>
    );
  }
  function Page() {
    const [show, setShow] = useState(false);
    return (
      <>
        <button onClick={() => setShow(true)}>Edit</button>
        {show && <Editor onDone={() => setShow(false)} />}
      </>
    );
  }

  it('puts focus back on the element that opened the outer one', () => {
    render(<Page />);
    const edit = screen.getByText('Edit');
    open(edit);
    const transfer = screen.getByText('Transfer');
    transfer.focus();
    fireEvent.click(transfer);
    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(edit);
  });

  it('does the same under StrictMode, whose extra mount cycle runs the hook again around the stack', () => {
    render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    const edit = screen.getByText('Edit');
    open(edit);
    const transfer = screen.getByText('Transfer');
    transfer.focus();
    fireEvent.click(transfer);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(edit);
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('leaves nothing inert behind', () => {
    const { container } = render(<Page />);
    open(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Transfer'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(container.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('still closes the inner one alone back to the button that opened it', () => {
    render(<Page />);
    open(screen.getByText('Edit'));
    const transfer = screen.getByText('Transfer');
    transfer.focus();
    fireEvent.click(transfer);

    fireEvent.keyDown(document, { key: 'Escape' });
    // Inner closed, outer still up: focus is back inside the outer dialog.
    expect(screen.getByRole('dialog', { name: 'Editor' })).toBeTruthy();
    expect(document.activeElement).toBe(transfer);
  });
});

describe('a modal swapped for another in one handler', () => {
  /**
   * CharacterEdit's "Convert to persona": the outer Modal closes itself and a
   * sibling Modal mounts, in one handler. The sibling's opener is the button
   * inside the outer dialog, which is gone once the exit animation ends. The
   * sibling can open a confirm of its own, as PersonaManager's Delete does.
   */
  function Swap() {
    const [edit, setEdit] = useState(false);
    const [persona, setPersona] = useState(false);
    const [confirm, setConfirm] = useState(false);
    return (
      <>
        <button onClick={() => setEdit(true)}>Edit</button>
        <Modal isOpen={edit} onClose={() => setEdit(false)} title="Editor">
          <button
            onClick={() => {
              setEdit(false);
              setPersona(true);
            }}
          >
            Convert
          </button>
        </Modal>
        {persona && (
          <Modal isOpen onClose={() => setPersona(false)} title="Persona">
            <button onClick={() => setConfirm(true)}>Delete</button>
          </Modal>
        )}
        {confirm && (
          <Modal isOpen onClose={() => setConfirm(false)} title="Confirm">
            <button onClick={() => setConfirm(false)}>Cancel</button>
          </Modal>
        )}
      </>
    );
  }

  const settle = () =>
    act(() => {
      vi.advanceTimersByTime(EXIT_MS + 20);
    });

  it('puts focus back on the element that opened the first one when the second closes', () => {
    vi.useFakeTimers();
    render(<Swap />);
    const edit = screen.getByText('Edit');
    open(edit);
    open(screen.getByText('Convert'));
    settle();
    expect(screen.queryByRole('dialog', { name: 'Editor' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Persona' })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Close'));
    settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(edit);
  });

  it('does the same under StrictMode, whose trial cleanup of the new modal is not a departure', () => {
    vi.useFakeTimers();
    render(
      <StrictMode>
        <Swap />
      </StrictMode>,
    );
    const edit = screen.getByText('Edit');
    open(edit);
    open(screen.getByText('Convert'));
    settle();
    fireEvent.click(screen.getByLabelText('Close'));
    settle();
    expect(document.activeElement).toBe(edit);
  });

  it('survives a confirm opened and cancelled inside the second modal', () => {
    vi.useFakeTimers();
    render(<Swap />);
    const edit = screen.getByText('Edit');
    open(edit);
    open(screen.getByText('Convert'));
    settle();
    open(screen.getByText('Delete'));
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    // Cancelling put focus back on Delete, inside the persona dialog that is still open.
    expect(document.activeElement).toBe(screen.getByText('Delete'));

    fireEvent.click(screen.getByLabelText('Close'));
    settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(edit);
  });

  it('survives it under StrictMode too', () => {
    vi.useFakeTimers();
    render(
      <StrictMode>
        <Swap />
      </StrictMode>,
    );
    const edit = screen.getByText('Edit');
    open(edit);
    open(screen.getByText('Convert'));
    settle();
    open(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByLabelText('Close'));
    settle();
    expect(document.activeElement).toBe(edit);
  });

  it('does not lend the last restore target to a modal that never had an opener', () => {
    vi.useFakeTimers();
    function Tree({ mounted }: { mounted: boolean }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal isOpen={open} onClose={() => setOpen(false)} title="A">
            a
          </Modal>
          {mounted && (
            <Modal isOpen onClose={() => {}} title="B">
              b
            </Modal>
          )}
        </>
      );
    }
    const { rerender } = render(<Tree mounted={false} />);
    open(screen.getByText('Open'));
    fireEvent.click(screen.getByLabelText('Close'));
    settle();
    // Open is now the last element a departing surface restored focus to.
    expect(document.activeElement).toBe(screen.getByText('Open'));

    (document.activeElement as HTMLElement).blur();
    rerender(<Tree mounted />);
    rerender(<Tree mounted={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});

