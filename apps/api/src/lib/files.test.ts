import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  POLICY,
  UploadError,
  checkSize,
  policyFor,
  safeDownloadName,
  sniff,
} from './files.js';

const design = POLICY.DESIGN_IMAGE;
const research = POLICY.RESEARCH_TEXT;

const png = (extra: number[] = []) =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const webp = () =>
  Buffer.from([0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const pdf = () => Buffer.from('%PDF-1.7\n');

describe('sniff — the file is what its bytes say, not what it is called', () => {
  test('recognises each accepted image type', () => {
    assert.equal(sniff(png(), design).mime, 'image/png');
    assert.equal(sniff(jpeg(), design).mime, 'image/jpeg');
    assert.equal(sniff(webp(), design).mime, 'image/webp');
  });

  test('a PDF is refused from the image class even though it is an accepted type elsewhere', () => {
    assert.throws(() => sniff(pdf(), design), (err: UploadError) => err.code === 'UNSUPPORTED_TYPE');
    assert.equal(sniff(pdf(), research).mime, 'application/pdf');
  });

  /** The whole point of sniffing: a script that claims to be a picture. */
  test('an HTML payload named like an image is refused', () => {
    const html = Buffer.from('<svg onload="alert(1)"></svg>');
    assert.throws(() => sniff(html, design), (err: UploadError) => err.status === 415);
  });

  test('SVG is not accepted anywhere — it can carry script and we serve same-origin', () => {
    for (const policy of Object.values(POLICY)) {
      assert.ok(!policy.accepted.some((t) => t.mime.includes('svg')));
    }
  });

  test('a truncated header does not read past the end of the buffer', () => {
    assert.throws(() => sniff(Buffer.from([0x89, 0x50]), design), UploadError);
    // "RIFF" with nothing after it is not a WEBP, and must not crash on the
    // second fragment's offset.
    assert.throws(() => sniff(Buffer.from([0x52, 0x49, 0x46, 0x46]), design), UploadError);
  });
});

describe('checkSize', () => {
  test('accepts up to the limit and refuses past it', () => {
    assert.doesNotThrow(() => checkSize(design.maxBytes, design));
    assert.throws(
      () => checkSize(design.maxBytes + 1, design),
      (err: UploadError) => err.status === 413,
    );
  });

  test('an empty file is a mistake, not a zero-byte upload', () => {
    assert.throws(() => checkSize(0, design), (err: UploadError) => err.code === 'EMPTY_FILE');
  });

  test('the classes really do have different limits', () => {
    assert.notEqual(design.maxBytes, research.maxBytes);
    assert.doesNotThrow(() => checkSize(design.maxBytes * 4, research));
  });
});

describe('policyFor', () => {
  test('rejects an unknown class rather than defaulting to one', () => {
    assert.throws(
      () => policyFor('ANYTHING'),
      (err: UploadError) => err.code === 'UNKNOWN_FILE_CLASS',
    );
    assert.throws(() => policyFor(''), UploadError);
  });

  test('design images are private and research text is public', () => {
    assert.equal(policyFor('DESIGN_IMAGE').policy.visibility, 'PRIVATE');
    assert.equal(policyFor('RESEARCH_TEXT').policy.visibility, 'PUBLIC');
  });

  test('a private class must require a contract — otherwise nobody can be authorised', () => {
    for (const policy of Object.values(POLICY)) {
      if (policy.visibility === 'PRIVATE') assert.ok(policy.requiresContract);
    }
  });
});

describe('safeDownloadName', () => {
  test('keeps Persian names intact', () => {
    assert.equal(safeDownloadName('طرح-صفحه-اصلی.png', '.png'), 'طرح-صفحه-اصلی.png');
  });

  test('strips quotes and separators that could break out of the header', () => {
    const out = safeDownloadName('a"; rm -rf /\\b.png', '.png');
    assert.ok(!/["\\/;]/.test(out));
  });

  test('strips control characters', () => {
    assert.equal(safeDownloadName('sha\r\nSet-Cookie: x=1.png', '.png').includes('\n'), false);
  });

  test('never produces a dotfile or an empty name', () => {
    assert.equal(safeDownloadName('...', '.png'), 'file.png');
    assert.equal(safeDownloadName('', '.jpg'), 'file.jpg');
    assert.ok(!safeDownloadName('.hidden', '.png').startsWith('.'));
  });

  test('appends the real extension when the name lacks it, and does not double it', () => {
    assert.equal(safeDownloadName('mockup', '.png'), 'mockup.png');
    assert.equal(safeDownloadName('mockup.png', '.png'), 'mockup.png');
    // The extension comes from the sniffed type, so a lying name gets both —
    // deliberately, so what lands on disk is honest about what it is.
    assert.equal(safeDownloadName('mockup.pdf', '.png'), 'mockup.pdf.png');
  });

  test('caps the length', () => {
    assert.ok(safeDownloadName('x'.repeat(500), '.png').length <= 125);
  });
});
