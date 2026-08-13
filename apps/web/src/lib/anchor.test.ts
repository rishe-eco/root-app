import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  renderedPlainText,
  rangeToOffsets,
  offsetsToRange,
  highlightRange,
  verifyAnchor,
  closestBlockId,
  anchorFromSelection,
} from './anchor.js';

/** A constructed fragment (T1) — no component, no browser. */
function fragment(html: string) {
  const dom = new JSDOM(`<!doctype html><div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root')!;
  return { dom, root };
}

function rangeFor(doc: Document, startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

test('renderedPlainText concatenates text across inline markup, ignoring tags', () => {
  const { root } = fragment('<p>Some <strong>bold</strong> text.</p>');
  assert.equal(renderedPlainText(root), 'Some bold text.');
});

test('rangeToOffsets: a range inside one text node', () => {
  const { root, dom } = fragment('<p>Hello world.</p>');
  const textNode = root.querySelector('p')!.firstChild!;
  const range = rangeFor(dom.window.document, textNode, 6, textNode, 11);
  assert.deepEqual(rangeToOffsets(root, range), { start: 6, end: 11 });
  assert.equal(renderedPlainText(root).slice(6, 11), 'world');
});

test('rangeToOffsets: a range spanning two inline elements (bold in the middle)', () => {
  const { root, dom } = fragment('<p>Some <strong>bold</strong> text.</p>');
  const p = root.querySelector('p')!;
  const before = p.childNodes[0]; // "Some "
  const after = p.childNodes[2]; // " text."
  // Selects "e bold t" — starts inside the plain-text run ("Som|e "), ends
  // inside the one after the <strong> (" t|ext."), so the range genuinely
  // straddles an element.
  const range = rangeFor(dom.window.document, before, 3, after, 2);
  const offsets = rangeToOffsets(root, range);
  assert.equal(renderedPlainText(root).slice(offsets.start, offsets.end), 'e bold t');
});

test('offsetsToRange round-trips with rangeToOffsets', () => {
  const { root } = fragment('<p>Some <strong>bold</strong> text.</p>');
  const text = renderedPlainText(root);
  const start = text.indexOf('bold');
  const end = start + 'bold'.length;

  const range = offsetsToRange(root, start, end);
  assert.ok(range);
  assert.equal(range!.toString(), 'bold');
  assert.deepEqual(rangeToOffsets(root, range!), { start, end });
});

test('offsetsToRange returns null once the offsets no longer fit the text', () => {
  const { root } = fragment('<p>Short.</p>');
  assert.equal(offsetsToRange(root, 0, 999), null);
});

test('highlightRange wraps the selected text in <mark>, even across an inline element boundary', () => {
  const { root } = fragment('<p>Some <strong>bold</strong> text.</p>');
  const text = renderedPlainText(root);
  const start = text.indexOf('e bold t');
  const end = start + 'e bold t'.length;

  const ok = highlightRange(root, start, end);
  assert.ok(ok);
  const mark = root.querySelector('mark.review-mark');
  assert.ok(mark, 'expected a <mark class="review-mark"> to be inserted');
  assert.equal(mark!.textContent, 'e bold t');
  // The visible text is unchanged — only wrapped, nothing lost or duplicated.
  assert.equal(renderedPlainText(root), 'Some bold text.');
});

test('verifyAnchor: matching quote passes, drifted quote is caught', () => {
  const { root } = fragment('<p>Some bold text.</p>');
  assert.equal(verifyAnchor(root, 5, 9, 'bold'), true);
  assert.equal(verifyAnchor(root, 5, 9, 'BOLD'), false);
  // Simulates a render that shifted underneath a stored anchor.
  const { root: shifted } = fragment('<p>Some very bold text.</p>');
  assert.equal(verifyAnchor(shifted, 5, 9, 'bold'), false);
});

test('closestBlockId finds the nearest data-block-id ancestor, or null outside any block', () => {
  const { root, dom } = fragment('<div data-block-id="b1"><p>Some <strong>bold</strong> text.</p></div><p>Outside.</p>');
  const strong = root.querySelector('strong')!.firstChild!;
  assert.equal(closestBlockId(strong), 'b1');
  const outside = root.querySelectorAll('p')[1]!.firstChild!;
  assert.equal(closestBlockId(outside), null);
  assert.equal(closestBlockId(dom.window.document.getElementById('root')), null);
});

test('anchorFromSelection refuses an empty (collapsed) selection', () => {
  const anchor = anchorFromSelection({ isCollapsed: true, rangeCount: 1, getRangeAt: () => {
    throw new Error('should not be called');
  } });
  assert.deepEqual(anchor, { ok: false, reason: 'EMPTY' });
});

test('anchorFromSelection refuses a selection with no range at all', () => {
  const anchor = anchorFromSelection({ isCollapsed: false, rangeCount: 0, getRangeAt: () => {
    throw new Error('should not be called');
  } });
  assert.deepEqual(anchor, { ok: false, reason: 'EMPTY' });
});

test('anchorFromSelection: a selection inside one block resolves to (blockId, start, end, quote)', () => {
  const { root, dom } = fragment('<div data-block-id="b1"><p>Some <strong>bold</strong> text.</p></div>');
  const p = root.querySelector('p')!;
  const range = rangeFor(dom.window.document, p.childNodes[0], 5, p.childNodes[1].firstChild!, 4);

  const anchor = anchorFromSelection({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
  });
  assert.deepEqual(anchor, { ok: true, blockId: 'b1', startOffset: 5, endOffset: 9, quote: 'bold' });
});

test('anchorFromSelection: a selection crossing two blocks is refused, not truncated to the first', () => {
  const { root, dom } = fragment(
    '<div data-block-id="b1"><p>First block.</p></div><div data-block-id="b2"><p>Second block.</p></div>',
  );
  const firstText = root.querySelectorAll('p')[0]!.firstChild!;
  const secondText = root.querySelectorAll('p')[1]!.firstChild!;
  const range = rangeFor(dom.window.document, firstText, 0, secondText, 6);

  const anchor = anchorFromSelection({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
  });
  assert.deepEqual(anchor, { ok: false, reason: 'CROSS_BLOCK' });
});

test('T3: offsets are logical (character index), not visual — unaffected by a Persian block mixed with Latin words', () => {
  // "متن Root است" — Persian rendered right-to-left with a Latin word inside.
  // The DOM's text order is still logical/source order regardless of the
  // bidi algorithm's *visual* reordering, so offset arithmetic sees exactly
  // the same string dir="ltr" text would.
  const { root, dom } = fragment('<p dir="rtl">متن Root است</p>');
  const text = renderedPlainText(root);
  const start = text.indexOf('Root');
  const end = start + 'Root'.length;
  assert.equal(text.slice(start, end), 'Root');

  const textNode = root.querySelector('p')!.firstChild!;
  const range = rangeFor(dom.window.document, textNode, start, textNode, end);
  assert.deepEqual(rangeToOffsets(root, range), { start, end });
  assert.equal(verifyAnchor(root, start, end, 'Root'), true);
});
