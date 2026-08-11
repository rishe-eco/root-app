import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Rendering the Review Room's frozen blocks (C1.md §4). Per block, not the
 * whole document — each block's markdown source is a self-contained snippet
 * of one kind, and rendering it alone (rather than the document as a whole)
 * is what keeps block boundaries as real DOM nodes for a future comment
 * (C2) to anchor to.
 *
 * marked and dompurify are both pinned to an exact version in package.json
 * (no `^`) — a "frozen" round whose rendering shifts on a dependency bump
 * would not be frozen (C1.md §4).
 */

marked.setOptions({ gfm: true, breaks: false });

/** Sanitized before it ever reaches the DOM. The corpus is Root's own
 *  writing, but it renders into the app's own origin for an outside
 *  reviewer — `dangerouslySetInnerHTML` over unsanitized HTML is a
 *  stored-XSS waiting for the day someone pastes a snippet into canon. */
export function renderBlockHtml(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

const PERSIAN_RE = /[؀-ۿݐ-ݿ]/g;

/**
 * A block's dominant script, guessed from its own characters. root-sot's
 * canon is described as "mostly English with Persian passages" (C1.md §4),
 * mixed at the paragraph level with no per-block language field to read
 * instead — this is the one thing that decides `lang`/`dir` per block, the
 * same way `originalLang` does for the Library reader (R2.md §1). Good
 * enough for choosing a script; not a translation detector.
 */
export function blockLocale(text: string): { lang: 'fa' | 'en'; dir: 'rtl' | 'ltr' } {
  const persian = text.match(PERSIAN_RE)?.length ?? 0;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const isPersian = letters > 0 && persian / letters > 0.3;
  return isPersian ? { lang: 'fa', dir: 'rtl' } : { lang: 'en', dir: 'ltr' };
}
