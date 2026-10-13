/**
 * @vitest-environment jsdom
 *
 * D-H6's runtime contract: "A failed fetch, invalid JSON, or an unknown
 * `version` yields zero feature slides and never blocks or errors the hero."
 *
 * The case that makes this more than a formality: nginx answers a MISSING
 * static file with 200 + index.html (the SPA fallback), so a 200 proves
 * nothing and `res.json()` is what actually rejects. If that rejection escapes,
 * the hook never settles and the hero sits on its loading placeholder forever.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useFeatureSlides } from './useFeatureSlides';

const URL_PATH = '/hero/feature-slides.json';

const entry = (id: string) => ({
  id,
  title: `Title ${id}`,
  body: 'Body',
  image: `/hero/${id}.webp`,
  cta: { label: 'Go', modal: { kind: 'feature', heading: 'H', bodyMarkdown: 'B' } },
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('useFeatureSlides', () => {
  it('fetches the shipped path with revalidation and an abort signal', async () => {
    const fetchFn = stubFetch(async () => ok({ version: 1, slides: [] }));
    const { result } = renderHook(() => useFeatureSlides());
    await waitFor(() => expect(result.current.settled).toBe(true));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_PATH);
    expect(init.cache).toBe('no-cache');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is unsettled with no slides until the response lands, then returns the valid entries in order', async () => {
    let resolve!: (v: unknown) => void;
    stubFetch(() => new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useFeatureSlides());
    expect(result.current).toEqual({ settled: false, slides: [] });

    resolve(ok({ version: 1, slides: [entry('a'), { kind: 'character', avatar: 'ivy.png' }, entry('b')] }));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.slides.map((s) => (s.kind === 'character' ? s.avatar : s.id))).toEqual([
      'a',
      'ivy.png',
      'b',
    ]);
  });

  it('settles with zero slides, silently, on a non-2xx', async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    const { result } = renderHook(() => useFeatureSlides());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.slides).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('settles with zero slides, silently, when the network fails', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const { result } = renderHook(() => useFeatureSlides());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.slides).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('settles with zero slides when a 200 is not JSON (the nginx index.html fallback), with one warning', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    }));
    const { result } = renderHook(() => useFeatureSlides());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.slides).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('settles with zero slides for an unknown version', async () => {
    stubFetch(async () => ok({ version: 2, slides: [entry('a')] }));
    const { result } = renderHook(() => useFeatureSlides());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.slides).toEqual([]);
  });

  it('skips a bad entry with one warning and keeps the rest', async () => {
    stubFetch(async () => ok({ version: 1, slides: [entry('good'), { id: 'broken' }, entry('also-good')] }));
    const { result } = renderHook(() => useFeatureSlides());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.slides).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('broken');
  });

  it('aborts the request on unmount', async () => {
    const fetchFn = stubFetch(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useFeatureSlides());
    const signal = (fetchFn.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('under StrictMode, the aborted first request cannot overwrite the second', async () => {
    // StrictMode mounts, unmounts and re-mounts. The FIRST request's response
    // arrives LAST here; if its result were applied it would clobber the second's.
    // (Rendered as explicit <StrictMode> JSX: renderHook's `wrapper` option did
    // not double-invoke effects in this setup.)
    const resolvers: Array<(v: unknown) => void> = [];
    const fetchFn = stubFetch(() => new Promise((r) => resolvers.push(r)));
    function Probe() {
      const { settled, slides } = useFeatureSlides();
      return <output>{settled ? slides.map((s) => (s.kind === 'feature' ? s.id : '')).join(',') || 'none' : 'loading'}</output>;
    }
    const { container } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    const text = () => container.querySelector('output')?.textContent;

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const signals = fetchFn.mock.calls.map((c) => (c[1] as RequestInit).signal as AbortSignal);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    resolvers[1](ok({ version: 1, slides: [entry('second')] }));
    await waitFor(() => expect(text()).toBe('second'));
    resolvers[0](ok({ version: 1, slides: [entry('first')] }));
    await new Promise((r) => setTimeout(r, 0));

    expect(text()).toBe('second');
  });
});
