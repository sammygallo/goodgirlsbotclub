/**
 * Helpers for handling character-info fields that may contain HTML/CSS markup
 * (description, personality, creator notes, …). Kept out of the component file
 * so the renderer can stay component-only for Fast Refresh.
 */

/** Heuristic: does `content` contain any HTML-looking markup? Anything that
 *  starts with `<letter` or `</letter` counts. We use this to keep plain-text
 *  blurbs rendering identically to before — only blurbs that opted into HTML
 *  go through the sanitiser. */
export function looksLikeHtml(content: string): boolean {
  return /<\/?[a-zA-Z]/.test(content);
}

/**
 * Flatten a possibly-HTML blurb to readable plain text. Used by condensed
 * surfaces (sidebar list rows, the collapsed portrait teaser) where rendering
 * full markup would break the layout — and where naively truncating raw HTML
 * would leak half-open tags like `<div style="color:re…` into the preview.
 *
 * Parsing happens in a detached document via DOMParser: scripts never run and
 * the nodes are never attached, so reading `textContent` is safe with no need
 * to sanitise first. Input without any markup is returned untouched; HTML input
 * has its tags dropped and entities decoded (e.g. `<b>A &amp; B</b>` → `A & B`).
 */
export function htmlToPlainText(content?: string): string {
  if (!content) return '';
  if (!looksLikeHtml(content) || typeof DOMParser === 'undefined') return content;
  const doc = new DOMParser().parseFromString(content, 'text/html');
  return doc.body.textContent ?? '';
}
