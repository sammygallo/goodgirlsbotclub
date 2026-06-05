import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { looksLikeHtml } from '../../utils/characterRichText';

interface CharacterRichTextProps {
  /** The raw character field content. May contain HTML/CSS markup. */
  content: string;
  /** Tailwind classes for the wrapper. Defaults match the regular preview text. */
  className?: string;
}

// Tags that creators reasonably reach for when styling a character blurb:
// inline formatting, headings, lists, quotes, simple typography, plus img
// for illustrations. Deliberately omits script/iframe/embed/object/link/meta
// (XSS surface) and form/input/button (interactive controls that don't
// belong inside a read-only preview).
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'del', 's', 'small', 'mark',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'a', 'div', 'span', 'section', 'article',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
  'hr', 'sub', 'sup',
  'img', 'figure', 'figcaption',
];

// `style` lets creators colour text and pull off the visual flair the issue
// is asking for; DOMPurify sanitises the CSS inside it (strips expression(),
// behavior:, javascript:/data: URLs, @import, etc.). `class` is mostly inert
// in our app (Tailwind classes need source compilation) but we keep it so
// creators porting blurbs from other sites don't end up with naked text.
const ALLOWED_ATTR = [
  'href', 'title', 'target', 'rel',
  'class', 'style',
  'src', 'alt', 'width', 'height', 'loading',
  'colspan', 'rowspan',
];

// Add a hook so any anchor that survives the sanitiser opens safely. Safe to
// register at module scope — DOMPurify deduplicates identical hooks and our
// chat MarkdownContent already registers the same one with the same body.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const SANITIZE_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  // Keep relative URLs intact; block the obvious dangerous schemes.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/(?:png|jpe?g|gif|webp|svg\+xml));|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

/**
 * Render a character-info field that may contain HTML/CSS markup. Plain text
 * falls through to a `whitespace-pre-wrap` paragraph so existing characters
 * look identical. HTML content is sanitised via DOMPurify (no scripts, no
 * iframes, no event handlers) and rendered inside an isolated container that
 * prevents the character's CSS from leaking into the rest of the app.
 *
 * Surface area is intentionally limited to the read-only preview so that a
 * malicious card can't intercept clicks on chat controls or persona forms —
 * the worst it can do is style itself badly inside its own preview pane.
 */
export function CharacterRichText({ content, className }: CharacterRichTextProps) {
  const sanitized = useMemo(() => {
    if (!content) return '';
    if (!looksLikeHtml(content)) return null;
    return DOMPurify.sanitize(content, SANITIZE_CONFIG) as string;
  }, [content]);

  const baseClass =
    'text-sm text-[var(--color-text-primary)] whitespace-pre-wrap break-words';
  const cls = className ? `${baseClass} ${className}` : baseClass;

  if (sanitized === null) {
    // Plain text — keep existing rendering exactly as it was.
    return <p className={cls}>{content}</p>;
  }

  // HTML content. `character-rich` provides the isolation/containment that
  // keeps creator CSS scoped to its own pane (see index.css).
  return (
    <div
      className={`${cls} character-rich`}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
