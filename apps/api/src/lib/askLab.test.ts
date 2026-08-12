import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { RightsBasis } from '@prisma/client';
import {
  buildDocumentBlocks,
  ensureAnthropicFileId,
  extractAnswer,
  extractSearchTerms,
  quotableFullText,
  selectFullTextEntries,
  type AskCandidate,
} from './askLab.js';

test('extractSearchTerms: splits a question into its distinct, foldable words rather than requiring the whole sentence as one substring', () => {
  assert.deepEqual(extractSearchTerms('What does the research say about bees?'), [
    'what',
    'does',
    'the',
    'research',
    'say',
    'about',
    'bees',
  ]);
  // Short words (below the minimum) are dropped — "is", "a" — but nothing
  // requires stopword removal beyond that; §2.1 prefers over-matching to
  // silently matching nothing.
  assert.deepEqual(extractSearchTerms('Is a bee a fly?'), ['bee', 'fly']);
  // Persian folds the same way buildSearchText does when it is stored —
  // including a ZWNJ inside a word (می‌سازند) disappearing entirely rather
  // than acting as a separator, since foldPersian strips it before this
  // ever splits on whitespace/punctuation.
  assert.deepEqual(extractSearchTerms('زنبورها چگونه عسل می‌سازند؟'), ['زنبورها', 'چگونه', 'عسل', 'میسازند']);
});

const RIGHTS_BASES: RightsBasis[] = ['PUBLIC_DOMAIN', 'OPEN_LICENCE', 'PERMISSION_GRANTED', 'LINK_ONLY'];

test('quotableFullText: every rights basis but LINK_ONLY may contribute its full text', () => {
  for (const rightsBasis of RIGHTS_BASES) {
    assert.equal(quotableFullText({ rightsBasis }), rightsBasis !== 'LINK_ONLY');
  }
});

function candidate(over: Partial<AskCandidate> & { id: string }): AskCandidate {
  return {
    slug: over.id,
    titleOriginal: `Entry ${over.id}`,
    titleTranslated: null,
    originalLang: 'en',
    authors: 'Someone',
    venue: null,
    year: 2020,
    abstractOriginal: 'An abstract.',
    abstractTranslated: null,
    rightsBasis: 'PUBLIC_DOMAIN',
    fullTextFile: null,
    ...over,
  };
}

function file(id: string, bytes: number, anthropicFileId: string | null = `anthropic-${id}`) {
  return { id, bytes, mime: 'application/pdf', originalName: `${id}.pdf`, key: `public/${id}.pdf`, anthropicFileId };
}

test('selectFullTextEntries: smallest first, and only quotable entries with a hosted file are eligible', () => {
  const candidates = [
    candidate({ id: 'big', fullTextFile: file('big', 5_000_000) }),
    candidate({ id: 'small', fullTextFile: file('small', 100_000) }),
    candidate({ id: 'linkonly', rightsBasis: 'LINK_ONLY', fullTextFile: file('linkonly', 1_000) }),
    candidate({ id: 'nofile', fullTextFile: null }),
    candidate({ id: 'medium', fullTextFile: file('medium', 500_000) }),
  ];
  const selected = selectFullTextEntries(candidates);
  assert.deepEqual([...selected].sort(), ['big', 'medium', 'small'].sort());
  assert.ok(!selected.has('linkonly'), 'LINK_ONLY must never be selected for full text');
  assert.ok(!selected.has('nofile'), 'an entry with no hosted file has nothing to select');
});

test('selectFullTextEntries: degrades to abstracts once the count cap is reached', () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    candidate({ id: `e${i}`, fullTextFile: file(`e${i}`, 1000 + i) }),
  );
  const selected = selectFullTextEntries(candidates);
  assert.equal(selected.size, 6, 'MAX_FULL_TEXT_DOCS is 6');
  // Smallest six by bytes: e0..e5 (bytes 1000..1005).
  assert.deepEqual([...selected].sort(), ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'].sort());
});

test('selectFullTextEntries: degrades to abstracts once the cumulative byte cap is reached', () => {
  const candidates = [
    candidate({ id: 'a', fullTextFile: file('a', 15 * 1024 * 1024) }),
    candidate({ id: 'b', fullTextFile: file('b', 10 * 1024 * 1024) }),
  ];
  // Smallest first: b (10MB) is tried before a (15MB). b alone fits; adding
  // a would make 25MB, over the 20MB cap, so a is dropped even though the
  // count cap (6) is nowhere near binding.
  const selected = selectFullTextEntries(candidates);
  assert.deepEqual([...selected], ['b']);
});

test('buildDocumentBlocks: §0 — a LINK_ONLY entry’s full text never enters the request, even if wrongly marked for full text upstream', () => {
  const linkOnly = candidate({ id: 'lo', rightsBasis: 'LINK_ONLY', fullTextFile: file('lo', 1000) });
  const quotable = candidate({ id: 'q', fullTextFile: file('q', 1000) });
  const candidates = [linkOnly, quotable];

  // Deliberately wrong input: both marked as selected for full text, as if a
  // caller upstream had a bug. buildDocumentBlocks must not trust this.
  const fullTextIds = new Set(['lo', 'q']);
  const blocks = buildDocumentBlocks(candidates, fullTextIds);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].source.type, 'text', 'LINK_ONLY must always degrade to a text (abstract) source');
  assert.doesNotMatch(
    JSON.stringify(blocks[0]),
    /anthropic-lo/,
    'the LINK_ONLY entry’s file id must not appear anywhere in its block',
  );
  assert.equal(blocks[1].source.type, 'file', 'a quotable entry with a resolved file id gets the full-text source');
  if (blocks[1].source.type === 'file') {
    assert.equal(blocks[1].source.file_id, 'anthropic-q');
  }
});

test('buildDocumentBlocks: an entry with no resolved Anthropic file id degrades to text even if selected', () => {
  const noFileId = candidate({ id: 'nf', fullTextFile: file('nf', 1000, null) });
  const blocks = buildDocumentBlocks([noFileId], new Set(['nf']));
  assert.equal(blocks[0].source.type, 'text');
});

test('buildDocumentBlocks: every block has citations enabled, and only the last carries the cache breakpoint', () => {
  const candidates = [candidate({ id: 'a' }), candidate({ id: 'b' })];
  const blocks = buildDocumentBlocks(candidates, new Set());
  for (const block of blocks) assert.equal(block.citations?.enabled, true);
  assert.equal(blocks[0].cache_control, undefined);
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' });
});

test('extractAnswer: concatenates text across blocks and collects citations, ignoring non-document citation kinds', () => {
  const content = [
    { type: 'text', text: 'First. ', citations: null },
    {
      type: 'text',
      text: 'Second, cited.',
      citations: [
        { type: 'char_location', cited_text: 'a snippet', document_index: 0, document_title: 'Paper A', start_char_index: 0, end_char_index: 9, file_id: null },
        // A citation kind this route never produces (no web search tool is
        // ever declared) — extractAnswer must not choke on it or mistake it
        // for a document citation.
        { type: 'web_search_result_location', cited_text: 'web thing', title: 'Some Page', url: 'https://example.com', encrypted_index: 'x' },
      ],
    },
    { type: 'text', text: ' Third from a PDF.', citations: [
      { type: 'page_location', cited_text: 'pdf snippet', document_index: 1, document_title: 'Paper B', start_page_number: 3, end_page_number: 4, file_id: 'f1' },
    ] },
    // A non-text block (e.g. thinking) must be skipped entirely.
    { type: 'thinking', thinking: 'reasoning...' },
    // biome-ignore lint: fixture only needs to satisfy the block shape extractAnswer reads
  ] as unknown as Parameters<typeof extractAnswer>[0];

  const { text, citations } = extractAnswer(content);
  assert.equal(text, 'First. Second, cited. Third from a PDF.');
  assert.equal(citations.length, 2);
  assert.deepEqual(citations[0], { citedText: 'a snippet', documentIndex: 0, documentTitle: 'Paper A' });
  assert.deepEqual(citations[1], { citedText: 'pdf snippet', documentIndex: 1, documentTitle: 'Paper B' });
});

test('ensureAnthropicFileId: uploads and persists only when no id is cached yet', async () => {
  const uploaded: string[] = [];
  const persisted: Array<[string, string]> = [];
  const f = file('new', 1000, null);

  const id = await ensureAnthropicFileId(f, {
    read: (key) => {
      uploaded.push(key);
      return Readable.from([Buffer.from('bytes')]);
    },
    upload: async () => 'anthropic-new-123',
    persist: async (storedFileId, anthropicFileId) => {
      persisted.push([storedFileId, anthropicFileId]);
    },
  });

  assert.equal(id, 'anthropic-new-123');
  assert.deepEqual(uploaded, ['public/new.pdf']);
  assert.deepEqual(persisted, [['new', 'anthropic-new-123']]);
});

test('ensureAnthropicFileId: a already-cached id is reused — never re-uploaded', async () => {
  const f = file('cached', 1000, 'anthropic-cached-456');
  let calls = 0;

  const id = await ensureAnthropicFileId(f, {
    read: () => {
      calls += 1;
      return Readable.from([]);
    },
    upload: async () => {
      calls += 1;
      return 'should-not-happen';
    },
    persist: async () => {
      calls += 1;
    },
  });

  assert.equal(id, 'anthropic-cached-456');
  assert.equal(calls, 0, 'upload once means never again — reading, uploading and persisting must all be skipped');
});
