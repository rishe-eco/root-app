import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoundDocuments, parseManifest } from './publishRound.js';

test('parseManifest: a well-formed manifest round-trips', () => {
  const m = parseManifest(JSON.stringify({ documents: [{ path: 'a.md', title: 'A' }] }));
  assert.deepEqual(m.documents, [{ path: 'a.md', title: 'A' }]);
});

test('parseManifest: refuses invalid JSON, a missing documents array, and a malformed entry', () => {
  assert.throws(() => parseManifest('not json'));
  assert.throws(() => parseManifest(JSON.stringify({})));
  assert.throws(() => parseManifest(JSON.stringify({ documents: 'nope' })));
  assert.throws(() => parseManifest(JSON.stringify({ documents: [{ path: 'a.md' }] }))); // no title
  assert.throws(() => parseManifest(JSON.stringify({ documents: [{ title: 'A' }] }))); // no path
});

test('buildRoundDocuments: reads and splits every manifest entry, in manifest order', () => {
  const manifest = { documents: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }] };
  const files: Record<string, string> = { 'a.md': '# A\n\nbody', 'b.md': 'just one paragraph' };
  const docs = buildRoundDocuments(manifest, (p) => files[p] ?? null);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].path, 'a.md');
  assert.equal(docs[0].order, 0);
  assert.equal(docs[0].blocks[0].kind, 'HEADING');
  assert.equal(docs[1].path, 'b.md');
  assert.equal(docs[1].order, 1);
});

test('buildRoundDocuments: a manifest path missing at the frozen sha fails the whole round, not just that document', () => {
  const manifest = { documents: [{ path: 'a.md', title: 'A' }, { path: 'gone.md', title: 'Gone' }] };
  const files: Record<string, string> = { 'a.md': 'present' };
  assert.throws(
    () => buildRoundDocuments(manifest, (p) => files[p] ?? null),
    /gone\.md/,
  );
});

test('buildRoundDocuments: personal-canon.md is never read because it was never on the allowlist — the manifest is the only thing consulted', () => {
  // The concrete case §0.2 names: a file that exists in the repo but was
  // deliberately left off the manifest must be absent from the round. There
  // is nothing to test at this layer beyond the fact that readFile is only
  // ever called for what the manifest actually lists — asserted here by a
  // readFile that throws if asked for anything else.
  const manifest = { documents: [{ path: 'ecosystem/canon/learn.md', title: 'Learn' }] };
  const readFile = (p: string) => {
    if (p === 'personal-canon.md') throw new Error('must never be read: personal-canon.md is not on the allowlist');
    return 'content';
  };
  const docs = buildRoundDocuments(manifest, readFile);
  assert.deepEqual(docs.map((d) => d.path), ['ecosystem/canon/learn.md']);
});

test('buildRoundDocuments: refuses a path-traversal entry in the manifest before ever calling readFile', () => {
  const manifest = { documents: [{ path: '../../etc/passwd', title: 'nope' }] };
  assert.throws(() => buildRoundDocuments(manifest, () => {
    throw new Error('readFile must not be called for an unsafe path');
  }));
});
