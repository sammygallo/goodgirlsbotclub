/**
 * @vitest-environment jsdom
 *
 * The group thumbnail strip's keyboard and ARIA contract (D-C12) and its
 * stable roster order (D-C7).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CharacterInfo } from '../../../api/client';
import { GroupThumbnailStrip } from './GroupThumbnailStrip';

const members = [
  { name: 'Ava', avatar: 'a.png' },
  { name: 'Bea', avatar: 'b.png' },
  { name: 'Cat', avatar: 'c.png' },
] as CharacterInfo[];

afterEach(cleanup);

function buttons() {
  return within(screen.getByRole('list', { name: 'Group members' })).getAllByRole('button');
}

describe('GroupThumbnailStrip', () => {
  it('labels each member and marks only the focused one pressed', () => {
    render(<GroupThumbnailStrip members={members} focusedAvatar="b.png" onPin={() => {}} />);
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Show Ava', 'Show Bea', 'Show Cat']);
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(buttons()[1].className).toContain('ring-2');
    expect(buttons()[1].className).toContain('ring-white');
    expect(buttons()[1].className).toContain('h-12');
    expect(buttons()[1].className).toContain('rounded-full');
  });

  it('is one Tab stop: the pressed button, else the first', () => {
    const { rerender } = render(<GroupThumbnailStrip members={members} focusedAvatar="c.png" onPin={() => {}} />);
    expect(buttons().map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
    rerender(<GroupThumbnailStrip members={members} focusedAvatar={null} onPin={() => {}} />);
    expect(buttons().map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it('ArrowRight/ArrowLeft wrap, Home/End jump', () => {
    render(<GroupThumbnailStrip members={members} focusedAvatar="a.png" onPin={() => {}} />);
    const [a, b, c] = buttons();
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: 'End' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'Home' });
    expect(document.activeElement).toBe(a);
  });

  it('consumes the keys it handles, so the strip and page do not also scroll', () => {
    render(<GroupThumbnailStrip members={members} focusedAvatar="a.png" onPin={() => {}} />);
    const [a] = buttons();
    // fireEvent returns false when the handler called preventDefault.
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(fireEvent.keyDown(a, { key })).toBe(false);
    }
    expect(fireEvent.keyDown(a, { key: 'Tab' })).toBe(true);
  });

  it('arrow keys move focus without pinning; activating a button pins it', () => {
    const onPin = vi.fn();
    render(<GroupThumbnailStrip members={members} focusedAvatar="a.png" onPin={onPin} />);
    const [a, b] = buttons();
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(onPin).not.toHaveBeenCalled();
    // Enter and Space activate a native <button> as a click.
    fireEvent.click(b);
    expect(onPin).toHaveBeenCalledWith('b.png');
  });

  it('keeps roster order as the focused speaker changes', () => {
    const { rerender } = render(<GroupThumbnailStrip members={members} focusedAvatar="a.png" onPin={() => {}} />);
    for (const focused of ['c.png', 'b.png', 'a.png']) {
      rerender(<GroupThumbnailStrip members={members} focusedAvatar={focused} onPin={() => {}} />);
      expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Show Ava', 'Show Bea', 'Show Cat']);
    }
  });

  it('scrolls sideways instead of wrapping', () => {
    render(<GroupThumbnailStrip members={members} focusedAvatar="a.png" onPin={() => {}} />);
    expect(screen.getByRole('list', { name: 'Group members' }).className).toContain('overflow-x-auto');
  });
});
