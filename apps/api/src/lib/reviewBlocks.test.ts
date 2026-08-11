import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFullCommitSha, isSafeRepoPath, splitBlocks } from './reviewBlocks.js';

test('splitBlocks: a heading becomes its own block, depth from the # count', () => {
  const blocks = splitBlocks('## A Title\n\nSome text.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'HEADING');
  assert.equal(blocks[0].depth, 2);
  assert.equal(blocks[0].text, '## A Title');
  assert.equal(blocks[1].kind, 'PARAGRAPH');
});

test('splitBlocks: consecutive plain lines are one paragraph, not one block per line', () => {
  const blocks = splitBlocks('Line one\nLine two\nLine three');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'PARAGRAPH');
  assert.equal(blocks[0].text, 'Line one\nLine two\nLine three');
});

test('splitBlocks: a document that is one long paragraph is exactly one block', () => {
  const text = Array.from({ length: 40 }, (_, i) => `sentence ${i}`).join(' ');
  const blocks = splitBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'PARAGRAPH');
});

test('splitBlocks: a fenced code block is one block, verbatim, fences included', () => {
  const md = 'before\n\n```ts\nconst x = 1;\n```\n\nafter';
  const blocks = splitBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['PARAGRAPH', 'CODE', 'PARAGRAPH'],
  );
  assert.equal(blocks[1].text, '```ts\nconst x = 1;\n```');
});

test('splitBlocks: content that looks like a heading inside a fence stays code', () => {
  const md = '```\n# not a heading\n```';
  const blocks = splitBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'CODE');
});

test('splitBlocks: an unterminated fence still becomes one code block, to EOF', () => {
  const blocks = splitBlocks('```\nno closing fence');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'CODE');
});

test('splitBlocks: consecutive list items are one block; a blank line ends the list', () => {
  const md = '- one\n- two\n- three\n\nafter';
  const blocks = splitBlocks(md);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['LIST', 'PARAGRAPH'],
  );
  assert.equal(blocks[0].text, '- one\n- two\n- three');
});

test('splitBlocks: a numbered list is a list too', () => {
  const blocks = splitBlocks('1. first\n2. second');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'LIST');
});

test('splitBlocks: a blockquote is its own block', () => {
  const blocks = splitBlocks('> quoted line one\n> quoted line two');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'QUOTE');
});

test('splitBlocks: a table is its own block', () => {
  const md = '| a | b |\n| - | - |\n| 1 | 2 |';
  const blocks = splitBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'TABLE');
});

test('splitBlocks: assigns stable, sequential ids in document order', () => {
  const blocks = splitBlocks('# H\n\npara\n\n- item');
  assert.deepEqual(
    blocks.map((b) => b.id),
    ['b1', 'b2', 'b3'],
  );
});

test('splitBlocks: blank input produces no blocks', () => {
  assert.deepEqual(splitBlocks(''), []);
  assert.deepEqual(splitBlocks('\n\n  \n'), []);
});

// ---------------------------------------------------------------------------
// isSafeRepoPath — the path-traversal refusal (C1.md §3.1)
// ---------------------------------------------------------------------------

test('isSafeRepoPath: an ordinary relative path is safe', () => {
  assert.equal(isSafeRepoPath('ecosystem/canon/02-pillars/learn.md'), true);
  assert.equal(isSafeRepoPath('review-manifest.json'), true);
});

test('isSafeRepoPath: refuses traversal, absolute paths, and empty input', () => {
  assert.equal(isSafeRepoPath('../secrets/personal-canon.md'), false);
  assert.equal(isSafeRepoPath('a/../../b.md'), false);
  assert.equal(isSafeRepoPath('/etc/passwd'), false);
  assert.equal(isSafeRepoPath('C:\\Windows\\system.ini'), false);
  assert.equal(isSafeRepoPath(''), false);
  assert.equal(isSafeRepoPath('   '), false);
});

// ---------------------------------------------------------------------------
// isFullCommitSha — refuses a symbolic ref (C1.md §3)
// ---------------------------------------------------------------------------

test('isFullCommitSha: a full 40-hex sha passes', () => {
  assert.equal(isFullCommitSha('a'.repeat(40)), true);
  assert.equal(isFullCommitSha('0123456789abcdef0123456789abcdef01234567'), true);
});

test('isFullCommitSha: a branch name, "HEAD", or a short sha is refused', () => {
  assert.equal(isFullCommitSha('main'), false);
  assert.equal(isFullCommitSha('HEAD'), false);
  assert.equal(isFullCommitSha('a1b2c3d'), false);
  assert.equal(isFullCommitSha('g'.repeat(40)), false); // not hex
});
