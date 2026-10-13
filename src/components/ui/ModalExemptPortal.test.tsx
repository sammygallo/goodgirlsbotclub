/**
 * @vitest-environment jsdom
 *
 * ModalExemptPortal gives a control its own container on <body>, carrying the
 * attribute useModalFocus's inert walk skips. What matters here is that the
 * container exists exactly while the portal does, is a sibling of the app root
 * (so it is not inside a branch that goes inert), and that the React side
 * survives the move: context and events still reach the children.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createContext, useContext } from 'react';
import { ModalExemptPortal } from './ModalExemptPortal';

afterEach(cleanup);

const holders = () => Array.from(document.body.querySelectorAll(':scope > [data-modal-exempt]'));

describe('ModalExemptPortal', () => {
  it('puts its children in a container that is a direct child of <body> and carries data-modal-exempt', () => {
    const { container } = render(
      <ModalExemptPortal>
        <button>Floating</button>
      </ModalExemptPortal>,
    );
    const holder = screen.getByText('Floating').closest('[data-modal-exempt]');
    expect(holder).not.toBeNull();
    expect(holder?.parentElement).toBe(document.body);
    // Not inside the app's own container, which is what goes inert.
    expect(container.contains(holder)).toBe(false);
  });

  it('gives each portal a container of its own', () => {
    render(
      <>
        <ModalExemptPortal>
          <button>One</button>
        </ModalExemptPortal>
        <ModalExemptPortal>
          <button>Two</button>
        </ModalExemptPortal>
      </>,
    );
    expect(holders()).toHaveLength(2);
    expect(screen.getByText('One').closest('[data-modal-exempt]')).not.toBe(screen.getByText('Two').closest('[data-modal-exempt]'));
  });

  it('removes its container when it unmounts, so nothing is left on <body>', () => {
    const { unmount } = render(
      <ModalExemptPortal>
        <button>Floating</button>
      </ModalExemptPortal>,
    );
    expect(holders()).toHaveLength(1);
    unmount();
    expect(holders()).toHaveLength(0);
  });

  it('keeps React context across the portal', () => {
    const Greeting = createContext('unset');
    function Reader() {
      return <span>{useContext(Greeting)}</span>;
    }
    render(
      <Greeting.Provider value="hello">
        <ModalExemptPortal>
          <Reader />
        </ModalExemptPortal>
      </Greeting.Provider>,
    );
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('delivers events from inside the portal to the children\'s handlers', () => {
    const onClick = vi.fn();
    render(
      <ModalExemptPortal>
        <button onClick={onClick}>Floating</button>
      </ModalExemptPortal>,
    );
    fireEvent.click(screen.getByText('Floating'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
