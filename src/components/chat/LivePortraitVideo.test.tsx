/**
 * @vitest-environment jsdom
 *
 * LivePortraitVideo's `paused` prop (D-C6) and `rect` shape (D-C1). The
 * defaults must leave the mobile portrait and VN layers exactly as they were:
 * both clips play, rounded corners.
 *
 * jsdom implements no media playback, so play() and pause() are spied on the
 * prototype and the test reads which element each call landed on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LivePortraitVideo } from './LivePortraitVideo';

const clips = { idle: '/clips/idle.mp4', joy: '/clips/joy.mp4' };

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

/** The src of every element a spy was called on, in call order. */
function srcs(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.contexts.map((v) => (v as HTMLVideoElement).getAttribute('src') ?? '');
}

beforeEach(() => {
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play as unknown as () => Promise<void>);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause as unknown as () => void);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LivePortraitVideo playback', () => {
  it('plays both clips by default and never pauses', () => {
    const { container } = render(<LivePortraitVideo clips={clips} emotion="joy" fill />);
    expect(srcs(play)).toEqual(expect.arrayContaining([clips.idle, clips.joy]));
    expect(pause).not.toHaveBeenCalled();
    for (const v of container.querySelectorAll('video')) expect(v.autoplay).toBe(true);
  });

  it('when paused, pauses both clips, never plays, and drops autoplay', () => {
    const { container } = render(<LivePortraitVideo clips={clips} emotion="joy" fill paused />);
    expect(play).not.toHaveBeenCalled();
    expect(srcs(pause)).toEqual(expect.arrayContaining([clips.idle, clips.joy]));
    for (const v of container.querySelectorAll('video')) expect(v.autoplay).toBe(false);
  });

  it('plays again when unpaused', () => {
    const { rerender } = render(<LivePortraitVideo clips={clips} emotion="joy" fill paused />);
    expect(play).not.toHaveBeenCalled();
    rerender(<LivePortraitVideo clips={clips} emotion="joy" fill paused={false} />);
    expect(srcs(play)).toEqual(expect.arrayContaining([clips.idle, clips.joy]));
  });

  it('does not play an emotion clip that mounts while paused', () => {
    const { rerender } = render(<LivePortraitVideo clips={clips} emotion={null} fill paused />);
    rerender(<LivePortraitVideo clips={clips} emotion="joy" fill paused />);
    expect(play).not.toHaveBeenCalled();
    expect(srcs(pause)).toContain(clips.joy);
  });
});

describe('LivePortraitVideo shape', () => {
  it('rect has no radius; square keeps 8px', () => {
    const rect = render(<LivePortraitVideo clips={clips} fill shape="rect" />);
    expect((rect.container.firstChild as HTMLElement).style.borderRadius).toBe('0px');
    cleanup();
    const square = render(<LivePortraitVideo clips={clips} fill shape="square" />);
    expect((square.container.firstChild as HTMLElement).style.borderRadius).toBe('8px');
  });

  it('with no shape, keeps the pre-story default circle', () => {
    const { container } = render(<LivePortraitVideo clips={clips} fill />);
    expect((container.firstChild as HTMLElement).style.borderRadius).toBe('50%');
  });
});
