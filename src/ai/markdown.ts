/**
 * Markdown + LaTeX rendering for assistant replies.
 *
 * Loaded only via dynamic import, so KaTeX and its stylesheet stay out of the
 * initial bundle.
 *
 * Two orderings here are deliberate and easy to get wrong:
 *  - Math is lifted out *before* Marked runs, because Markdown's emphasis and
 *    escape rules happily chew through `\frac{a}{b}` and `x^*`.
 *  - KaTeX runs *after* DOMPurify, writing into the already-sanitised DOM.
 *    Sanitising KaTeX's own output would strip the markup it depends on.
 */

import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';

marked.setOptions({ gfm: true, breaks: true });

/** Replaces math spans with placeholders Marked will leave alone. */
function protectMath(markdown: string): string {
  const block = (tex: string) =>
    `<div class="ai-math-block" data-ai-math="${encodeURIComponent(tex.trim())}"></div>`;
  const inline = (tex: string) =>
    `<span class="ai-math-inline" data-ai-math="${encodeURIComponent(tex.trim())}"></span>`;

  // Order matters: $$ before $, and the inline rule needs a non-backslash
  // prefix so an escaped \$ stays a literal dollar sign.
  const withBlocks = markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (_all, latex: string) => block(latex))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_all, latex: string) => block(latex));
  return withBlocks
    .replace(/\\\(([^\n]+?)\\\)/g, (_all, latex: string) => inline(latex))
    .replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_all, prefix: string, latex: string) =>
      `${prefix}${inline(latex)}`);
}

export function renderAiMarkdown(markdown: string): DocumentFragment {
  const template = document.createElement('template');
  const parsed = marked.parse(protectMath(markdown), { async: false }) as string;

  // Raw HTML from the model is dropped here; only the math placeholder
  // attribute is allowed through.
  template.innerHTML = DOMPurify.sanitize(parsed, { ADD_ATTR: ['data-ai-math'] });

  for (const el of template.content.querySelectorAll<HTMLElement>('[data-ai-math]')) {
    const encoded = el.dataset.aiMath || '';
    let tex = '';
    try { tex = decodeURIComponent(encoded); } catch { tex = encoded; }
    try {
      katex.render(tex, el, {
        displayMode: el.classList.contains('ai-math-block'),
        throwOnError: false,
        strict: 'warn',
        trust: false,
      });
    } catch {
      // A malformed equation should show as its source, not vanish.
      el.textContent = tex;
    }
  }

  // Links from a model are untrusted: only http(s) survive, and they leave
  // without handing the opener over.
  for (const anchor of template.content.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    let protocol = '';
    try { protocol = new URL(href, location.href).protocol; } catch { protocol = ''; }
    if (protocol === 'http:' || protocol === 'https:') {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    } else {
      anchor.removeAttribute('href');
    }
  }

  return template.content;
}
