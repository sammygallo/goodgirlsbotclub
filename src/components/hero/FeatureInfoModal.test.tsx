/**
 * @vitest-environment jsdom
 *
 * D-H6: "FeatureInfoModal is built on Modal (size lg): heading, optional image,
 * body rendered with the existing MarkdownDoc." The checklist item is
 * "FeatureInfoModal is built on Modal + MarkdownDoc", so what is pinned here is
 * exactly that: it IS the shared dialog (role, name, containment), and the body
 * goes through Markdown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FeatureInfoModal } from './FeatureInfoModal';

afterEach(cleanup);

function mount(props: Partial<Parameters<typeof FeatureInfoModal>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <FeatureInfoModal isOpen onClose={onClose} heading="Selfie mode" bodyMarkdown={'Take a **selfie**.\n\n- one\n- two'} {...props} />,
  );
  return { ...utils, onClose };
}

describe('FeatureInfoModal', () => {
  it('is the shared dialog, named by the slide\'s heading', () => {
    mount();
    const dialog = screen.getByRole('dialog', { name: 'Selfie mode' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('renders the body as Markdown', () => {
    mount();
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('strong')?.textContent).toBe('selfie');
    expect(dialog.querySelectorAll('li')).toHaveLength(2);
  });

  it('shows the image only when the config gave one, and as decoration', () => {
    const { unmount } = mount();
    expect(screen.getByRole('dialog').querySelector('img')).toBeNull();
    unmount();

    mount({ image: '/hero/selfie-mode.webp' });
    const img = screen.getByRole('dialog').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/hero/selfie-mode.webp');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('closes from the header X and from its own Close button', () => {
    const { onClose } = mount();
    const closers = screen.getAllByRole('button', { name: 'Close' });
    expect(closers).toHaveLength(2);
    closers.forEach((b) => fireEvent.click(b));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape', () => {
    const { onClose } = mount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('contains focus: everything outside it is inert, and focus moves in', () => {
    const outside = document.createElement('button');
    outside.textContent = 'behind';
    document.body.appendChild(outside);
    const { container } = mount();
    expect(container.hasAttribute('inert')).toBe(true);
    expect(outside.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    outside.remove();
  });

  it('renders nothing when closed', () => {
    mount({ isOpen: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
