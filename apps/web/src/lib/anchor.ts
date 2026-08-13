/**
 * Turning a selection inside a rendered Review Room block into a durable
 * anchor, and back (C2.md §1, T1).
 *
 * A comment anchors to `(blockId, startOffset, endOffset)` into the block's
 * **rendered plain text** — not its markdown source. `marked`/`dompurify`
 * emit no source positions, and offsets into `**bold**` would count its own
 * asterisks; offsets into what the reviewer actually saw survive both
 * problems. C1 already froze the precondition this depends on: a block's
 * markdown never changes once published, so its rendered text — and every
 * offset into it — is stable for as long as the round exists.
 *
 * Every function here takes a DOM root explicitly rather than reading
 * `document`/`window` itself, which is what makes it testable over a
 * constructed fragment (jsdom in the unit tests) with no browser involved,
 * and is the whole reason this lives apart from any component.
 */

export type Offsets = { start: number; end: number };

// The numeric form, not the `NodeFilter.SHOW_TEXT` global constant — the
// global exists on `window` in a real browser but not in a plain Node test
// process, and `createTreeWalker` accepts either (DOM spec).
const SHOW_TEXT = 4;

function docOf(root: Node): Document {
  const doc = root.nodeType === 9 ? (root as unknown as Document) : root.ownerDocument;
  if (!doc) throw new Error('anchor.ts: node has no owner document');
  return doc;
}

/** The block's rendered text, exactly as a reviewer reads it — the string
 *  every offset in this file counts into. */
export function renderedPlainText(root: Node): string {
  const range = docOf(root).createRange();
  range.selectNodeContents(root);
  return range.toString();
}

/**
 * A DOM `Range`'s boundaries, expressed as character offsets into `root`'s
 * rendered text. Uses the same "prefix range's string length" trick a
 * browser's own selection reporting relies on, so it agrees with
 * `renderedPlainText` by construction rather than by a second, parallel walk
 * that could drift from it.
 */
export function rangeToOffsets(root: Node, range: Range): Offsets {
  const doc = docOf(root);

  const toStart = doc.createRange();
  toStart.selectNodeContents(root);
  toStart.setEnd(range.startContainer, range.startOffset);
  const start = toStart.toString().length;

  const toEnd = doc.createRange();
  toEnd.selectNodeContents(root);
  toEnd.setEnd(range.endContainer, range.endOffset);
  const end = toEnd.toString().length;

  return { start, end };
}

/**
 * The reverse of `rangeToOffsets`: walks `root`'s text nodes in document
 * order until it has consumed `start`/`end` characters, and returns a Range
 * whose boundaries land inside the actual text nodes at those positions.
 * Null when the offsets no longer fit the text at all (a shorter re-render,
 * say) — the caller treats that the same as a quote mismatch.
 */
export function offsetsToRange(root: Node, start: number, end: number): Range | null {
  const doc = docOf(root);
  const walker = doc.createTreeWalker(root, SHOW_TEXT);

  const range = doc.createRange();
  let pos = 0;
  let startSet = false;
  let node: Node | null;
  // eslint-disable-next-line no-cond-assign
  while ((node = walker.nextNode())) {
    const text = node as unknown as CharacterData;
    const len = text.data.length;
    if (!startSet && start <= pos + len) {
      range.setStart(node, Math.max(0, start - pos));
      startSet = true;
    }
    if (startSet && end <= pos + len) {
      range.setEnd(node, Math.max(0, end - pos));
      return range;
    }
    pos += len;
  }
  return null;
}

/**
 * Mutates `root`'s rendered DOM to visually mark `[start, end)`, wrapping
 * every text node the range touches in a `<mark>` — including a selection
 * that only partially overlaps an inline element (`**bold**` in the
 * middle), which is exactly the case `Range.surroundContents` refuses.
 * `Range.extractContents` already splits partial boundary text nodes per
 * spec, so re-inserting the extracted fragment inside one wrapper is enough.
 * Returns false (no-op) when the offsets no longer resolve to a range at all.
 */
export function highlightRange(root: Node, start: number, end: number): boolean {
  const range = offsetsToRange(root, start, end);
  if (!range || range.collapsed) return false;
  const mark = docOf(root).createElement('mark');
  mark.className = 'review-mark';
  mark.appendChild(range.extractContents());
  range.insertNode(mark);
  return true;
}

/**
 * The anchor's own witness, checked (C2.md §1.1). A mismatch means the
 * render has drifted from what was stored — a dependency bump, most
 * plausibly — and the caller must show the thread **detached**, never
 * re-find it by fuzzy matching.
 */
export function verifyAnchor(root: Node, start: number, end: number, quote: string): boolean {
  return renderedPlainText(root).slice(start, end) === quote;
}

/** Walks up from `node` to the nearest ancestor carrying `data-block-id`
 *  (the attribute `ReviewDocumentScreen` already renders per block), or
 *  null outside any block. */
export function closestBlockId(node: Node | null): string | null {
  let el: Element | null =
    node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  while (el) {
    const id = el.getAttribute('data-block-id');
    if (id) return id;
    el = el.parentElement;
  }
  return null;
}

export type SelectionAnchor =
  | { ok: true; blockId: string; startOffset: number; endOffset: number; quote: string }
  | { ok: false; reason: 'EMPTY' | 'CROSS_BLOCK' };

/**
 * Turns a live `Selection` into an anchor, refusing rather than truncating a
 * selection that crosses two blocks (T2) — there is no single block whose
 * rendered text the offsets would count into, and silently anchoring to
 * whichever block the selection started in would highlight something the
 * reviewer never selected.
 */
export function anchorFromSelection(selection: Pick<Selection, 'isCollapsed' | 'rangeCount' | 'getRangeAt'>): SelectionAnchor {
  if (selection.isCollapsed || selection.rangeCount === 0) return { ok: false, reason: 'EMPTY' };
  const range = selection.getRangeAt(0);

  const startBlockId = closestBlockId(range.startContainer);
  const endBlockId = closestBlockId(range.endContainer);
  if (!startBlockId || !endBlockId || startBlockId !== endBlockId) {
    return { ok: false, reason: 'CROSS_BLOCK' };
  }

  const blockRoot = closestBlockElement(range.startContainer);
  if (!blockRoot) return { ok: false, reason: 'CROSS_BLOCK' };

  const { start, end } = rangeToOffsets(blockRoot, range);
  if (start >= end) return { ok: false, reason: 'EMPTY' };

  const quote = renderedPlainText(blockRoot).slice(start, end);
  return { ok: true, blockId: startBlockId, startOffset: start, endOffset: end, quote };
}

function closestBlockElement(node: Node | null): Element | null {
  let el: Element | null =
    node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  while (el) {
    if (el.hasAttribute('data-block-id')) return el;
    el = el.parentElement;
  }
  return null;
}
