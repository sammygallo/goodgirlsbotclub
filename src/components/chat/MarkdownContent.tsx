import { useMemo, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { normalizeForDisplay, wrapDialogue } from '../../utils/messageFormatting';
import { getStandardizeMessageFormatting } from '../../hooks/displayPreferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TextSegment {
  type: 'dialogue' | 'action' | 'thought';
  content: string;
}

interface MarkdownContentProps {
  content: string;
  isUser: boolean;
  /** When true the content is still arriving token-by-token. Unclosed code
   *  fences are auto-closed before markdown parsing so they render as code
   *  rather than leaking raw backticks, and a blinking cursor is appended. */
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// RP parser — runs BEFORE markdown so roleplay formatting takes priority.
// Uses look-behind/ahead to skip ** and __ (markdown bold) while still
// capturing single *action* and _action_ markers.
// ---------------------------------------------------------------------------

const RP_REGEX =
  /((?<!\*)\*(?!\*)[^*]+\*(?!\*)|(?<!_)_(?!_)[^_]+_(?!_)|\{\{[^}]+\}\})/g;

/**
 * Parse RP segments while protecting code blocks and inline code from the RP
 * regex.  Fenced code blocks (``` … ```) and inline code (` … `) are replaced
 * with null-byte placeholders before RP matching, then restored into dialogue
 * segments so markdown can render them intact.
 */
function parseRPSegments(text: string): TextSegment[] {
  // --- Step 1: shelter code from the RP regex ---
  const codePH: Map<string, string> = new Map();
  let n = 0;
  // Fenced code blocks first (greedy across lines)
  let safe = text.replace(/```[\s\S]*?```/g, (m) => {
    const k = `\x00C${n++}\x00`; codePH.set(k, m); return k;
  });
  // Then inline code
  safe = safe.replace(/`[^`]+`/g, (m) => {
    const k = `\x00C${n++}\x00`; codePH.set(k, m); return k;
  });

  // --- Step 2: run RP regex on code-free text ---
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  RP_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = RP_REGEX.exec(safe)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'dialogue', content: safe.slice(lastIndex, match.index) });
    }
    const m = match[0];
    if (m.startsWith('{{') && m.endsWith('}}')) {
      segments.push({ type: 'thought', content: m.slice(2, -2) });
    } else {
      segments.push({ type: 'action', content: m.slice(1, -1) });
    }
    lastIndex = match.index + m.length;
  }

  if (lastIndex < safe.length) {
    segments.push({ type: 'dialogue', content: safe.slice(lastIndex) });
  }
  if (segments.length === 0) {
    segments.push({ type: 'dialogue', content: safe });
  }

  // --- Step 3: restore code placeholders in ALL segment types ---
  // Dialogue, action, and thought segments now all render through
  // renderMarkdown, so sheltered code must be restored everywhere — otherwise
  // inline/fenced code inside *actions* or {{thoughts}} leaks its internal
  // \x00C{n}\x00 placeholder to the user.
  return segments.map((seg) => {
    let c = seg.content;
    for (const [k, v] of codePH) c = c.replaceAll(k, v);
    return { ...seg, content: c };
  });
}

// ---------------------------------------------------------------------------
// Marked configuration — executed once at module load.
// ---------------------------------------------------------------------------

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const validLang = lang && hljs.getLanguage(lang) ? lang : '';
      let highlighted: string;
      try {
        highlighted = validLang
          ? hljs.highlight(text, { language: validLang }).value
          : hljs.highlightAuto(text).value;
      } catch {
        // Fallback: escape HTML manually
        highlighted = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
      const label = lang || 'code';
      return (
        '<div class="code-block-wrapper">' +
          '<div class="code-block-header">' +
            `<span class="code-block-lang">${label}</span>` +
            '<button class="code-copy-btn" title="Copy code">Copy</button>' +
          '</div>' +
          `<pre><code class="hljs${validLang ? ` language-${validLang}` : ''}">${highlighted}</code></pre>` +
        '</div>'
      );
    },
  },
});

// ---------------------------------------------------------------------------
// DOMPurify — ensure all links open safely in new tabs.
// ---------------------------------------------------------------------------

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'del', 's',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'div', 'span', 'button',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr', 'sup', 'sub',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
};

// ---------------------------------------------------------------------------
// Markdown rendering helpers
// ---------------------------------------------------------------------------

/** Heuristic: does the text contain block-level markdown structures? */
const BLOCK_PATTERN = /\n\n|^#{1,6}\s|^```|^>\s|^[-*+]\s|^\d+\.\s|^\|.+\|/m;

/**
 * Split text into paragraphs on `\n\n` boundaries while keeping fenced code
 * blocks intact (a fenced block can legitimately contain blank lines and
 * must NOT be split). Returns one entry per paragraph, in order; empty
 * paragraphs are dropped.
 *
 * Splitting first — then parsing RP markers inside each paragraph — is what
 * keeps inline italics anchored to their paragraph instead of appearing as
 * orphan inline content sandwiched between two block-level dialogue
 * segments.
 */
function splitParagraphs(text: string): string[] {
  const codePH: Map<string, string> = new Map();
  let n = 0;
  // Shelter fenced code blocks (only these can contain \n\n we must preserve).
  const safe = text.replace(/```[\s\S]*?```/g, (m) => {
    const k = `\x00P${n++}\x00`;
    codePH.set(k, m);
    return k;
  });
  const paragraphs = safe.split(/\n{2,}/);
  return paragraphs
    .map((p) => {
      let restored = p;
      for (const [k, v] of codePH) restored = restored.replaceAll(k, v);
      return restored;
    })
    .filter((p) => p.trim().length > 0);
}

/**
 * Close any unclosed fenced code blocks so the markdown parser treats them as
 * code instead of leaking raw backticks into the output.  Only needed while
 * streaming — once the response is complete the fences are balanced.
 */
function closeOpenCodeFences(text: string): string {
  // Count occurrences of triple-backtick fence markers (``` with optional lang)
  const fenceMatches = text.match(/^`{3,}/gm);
  if (!fenceMatches || fenceMatches.length % 2 === 0) return text;
  // Odd number of fences → last one is unclosed. Append a closing fence.
  return text + '\n```';
}

function renderMarkdown(text: string, streaming?: boolean): { html: string; isBlock: boolean } {
  const prepared = streaming ? closeOpenCodeFences(text) : text;
  const isBlock = BLOCK_PATTERN.test(prepared);
  const raw = isBlock
    ? (marked.parse(prepared) as string)
    : (marked.parseInline(prepared) as string);
  return { html: DOMPurify.sanitize(raw, SANITIZE_CONFIG) as string, isBlock };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarkdownContent({ content, isUser, isStreaming }: MarkdownContentProps) {
  const standardize = getStandardizeMessageFormatting();
  const prepared = useMemo(
    () => (standardize ? normalizeForDisplay(content) : content),
    [content, standardize]
  );
  const paragraphs = useMemo(() => {
    const split = splitParagraphs(prepared);
    // Wrap "…" dialogue per paragraph BEFORE the RP parser splits at italic
    // markers. Otherwise an italic inside a quote (e.g. "Hello *world*.")
    // splits the quote across segments — the orphaned closing " can pair
    // with a later opening " from another quote, wrapping the plain text
    // between them instead of the actual quotation.
    return standardize ? split.map(wrapDialogue) : split;
  }, [prepared, standardize]);

  /** Copy-button click handler — uses event delegation. */
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('code-copy-btn')) return;
    const codeEl = target.closest('.code-block-wrapper')?.querySelector('code');
    if (!codeEl) return;
    navigator.clipboard?.writeText(codeEl.textContent || '').then(() => {
      target.textContent = 'Copied!';
      setTimeout(() => { target.textContent = 'Copy'; }, 2000);
    }).catch(() => {});
  }, []);

  return (
    <div className="markdown-content" onClick={handleClick}>
      {paragraphs.map((paragraph, paraIdx) => {
        const isLastPara = paraIdx === paragraphs.length - 1;
        const paraIsBlockMarkdown = BLOCK_PATTERN.test(paragraph);

        // Block-level markdown paragraphs (lists, headings, blockquotes,
        // code blocks, tables) bypass the RP parser — those structures and
        // *italic* markers don't compose well, and the RP regex can grab
        // list-bullet asterisks unintentionally.
        if (paraIsBlockMarkdown) {
          const { html } = renderMarkdown(paragraph, isStreaming && isLastPara);
          const cursorHtml = isStreaming && isLastPara
            ? html + '<span class="streaming-cursor"></span>'
            : html;
          return (
            <div
              key={paraIdx}
              className="md-paragraph md-segment"
              dangerouslySetInnerHTML={{ __html: cursorHtml }}
            />
          );
        }

        // Inline paragraph: parse RP markers, render each segment inline so
        // surrounding dialogue, *actions*, and {{thoughts}} all flow on the
        // same line(s) within this paragraph.
        const segments = parseRPSegments(paragraph);
        return (
          <div key={paraIdx} className="md-paragraph">
            {segments.map((segment, segIdx) => {
              const isLastSeg = isLastPara && segIdx === segments.length - 1;

              if (segment.type === 'dialogue' && !segment.content.trim()) {
                return null;
              }

              if (segment.type === 'action') {
                const { html: actionHtml } = renderMarkdown(segment.content, isStreaming && isLastSeg);
                const actionCursorHtml = isStreaming && isLastSeg
                  ? actionHtml + '<span class="streaming-cursor"></span>'
                  : actionHtml;
                return (
                  <span
                    key={segIdx}
                    className={`italic ${isUser ? 'text-white/70' : 'rp-action'}`}
                    dangerouslySetInnerHTML={{ __html: actionCursorHtml }}
                  />
                );
              }
              if (segment.type === 'thought') {
                const { html: thoughtHtml } = renderMarkdown(segment.content, isStreaming && isLastSeg);
                const thoughtCursorHtml = isStreaming && isLastSeg
                  ? thoughtHtml + '<span class="streaming-cursor"></span>'
                  : thoughtHtml;
                return (
                  <span
                    key={segIdx}
                    className={`italic ${isUser ? 'text-white/60' : 'rp-thought'}`}
                    dangerouslySetInnerHTML={{ __html: thoughtCursorHtml }}
                  />
                );
              }

              // Dialogue inside an inline paragraph — render via parseInline
              // (no block-level parsing since we already filtered those out).
              // wrapDialogue already ran at the paragraph level, so this
              // segment's content may contain partial <span class="dialogue">
              // markup that the browser will auto-balance.
              const { html } = renderMarkdown(segment.content, isStreaming && isLastSeg);
              const cursorHtml = isStreaming && isLastSeg
                ? html + '<span class="streaming-cursor"></span>'
                : html;
              return (
                <span
                  key={segIdx}
                  className="md-segment"
                  dangerouslySetInnerHTML={{ __html: cursorHtml }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
