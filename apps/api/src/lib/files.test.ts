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

  test('a private class must be contract-, project- or theme-owned — the private read gate (routes/files.ts) only knows how to check those three edges', () => {
    // Build plan L7 widened this from "contract-owned" alone: SERVICE_IMPORT
    // is PRIVATE and owned by a Project, the first class this schema
    // attaches to a project rather than a contract. Widening the read gate
    // to a *third* owner kind without a matching test here is exactly the
    // silent-gap this test exists to catch. Journeys build plan T2 is that
    // third owner: THEME_PREVIEW is PRIVATE and owned by a Theme, and the GET
    // handler checks it (`canSeeThemePreview`) beside the other two.
    for (const policy of Object.values(POLICY)) {
      if (policy.visibility === 'PRIVATE') {
        assert.ok(
          policy.owner === 'contract' || policy.owner === 'project' || policy.owner === 'theme',
          `${policy.owner} is PRIVATE but has no ownership check in routes/files.ts's GET /files/:id`,
        );
      }
    }
  });
});

describe('MOCKUP_BUNDLE (journeys build plan J9)', () => {
  const bundle = POLICY.MOCKUP_BUNDLE;

  test('is the one streamed class: private, contract-owned, 50 MB, uploaded by design.author', () => {
    assert.equal(bundle.streamed, true);
    assert.equal(bundle.visibility, 'PRIVATE');
    assert.equal(bundle.owner, 'contract');
    assert.equal(bundle.uploader, 'design.author');
    assert.equal(bundle.maxBytes, 50 * 1024 * 1024);
    // Every other class keeps today's buffered path byte-for-byte.
    for (const [name, policy] of Object.entries(POLICY)) {
      if (name !== 'MOCKUP_BUNDLE') assert.equal(policy.streamed, undefined, name);
    }
  });

  test('is a zip by its first bytes — and only a zip', () => {
    assert.equal(sniff(Buffer.from('PK\x03\x04rest of the archive'), bundle).mime, 'application/zip');
    assert.throws(() => sniff(pdf(), bundle), (err: UploadError) => err.code === 'UNSUPPORTED_TYPE');
    assert.throws(() => sniff(Buffer.from('<html></html>'), bundle), (err: UploadError) => err.status === 415);
    // An empty archive has no index to serve and starts differently.
    assert.throws(() => sniff(Buffer.from('PK\x05\x06' + '\0'.repeat(18)), bundle), UploadError);
  });

  test('checkSize refuses past the 50 MB cap with FILE_TOO_LARGE', () => {
    assert.doesNotThrow(() => checkSize(bundle.maxBytes, bundle));
    assert.throws(() => checkSize(bundle.maxBytes + 1, bundle), (err: UploadError) => err.code === 'FILE_TOO_LARGE' && err.status === 413);
  });

  test('SVG stays refused as an upload class even though a bundle may contain one', () => {
    // The rule is about whose origin serves the bytes: a bundle is served from
    // the mockup origin (routes/mockups.ts), never from the portal's.
    assert.ok(!bundle.accepted.some((t) => t.mime.includes('svg')));
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
