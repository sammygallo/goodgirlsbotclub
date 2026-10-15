/**
 * @vitest-environment jsdom
 *
 * Avatar's alt text: an explicit empty alt is rendered as alt="" (a decorative
 * image), an omitted alt falls back to "Avatar", and a given alt passes through.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Avatar } from './Avatar';

afterEach(() => {
  cleanup();
});

const image = (container: HTMLElement) => container.querySelector('img') as HTMLImageElement;

describe('Avatar alt text', () => {
  it('renders an explicit empty alt as alt=""', () => {
    const { container } = render(<Avatar src="/ivy.png" alt="" />);
    expect(image(container).getAttribute('alt')).toBe('');
  });

  it('falls back to "Avatar" when alt is omitted', () => {
    const { container } = render(<Avatar src="/ivy.png" />);
    expect(image(container).getAttribute('alt')).toBe('Avatar');
  });

  it('passes a given alt through', () => {
    const { container } = render(<Avatar src="/ivy.png" alt="Ivy" />);
    expect(image(container).getAttribute('alt')).toBe('Ivy');
  });
});
