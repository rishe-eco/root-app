/**
 * What may be uploaded, and what it is allowed to be.
 *
 * Kept separate from the route so the rules are testable without HTTP, and
 * separate from `storage.ts` so the storage layer stays about bytes rather
 * than policy. One table per file class, because a 2 MB limit that suits a
 * design preview is absurd for a research PDF and vice versa (build plan §F1).
 */

import type { FileClass, FileVisibility } from '@prisma/client';
import type { Capability } from './capabilities.js';

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

type AcceptedType = {
  mime: string;
  ext: string;
  /** Leading bytes every file of this type starts with, and where. */
  magic: Array<{ offset: number; bytes: number[] }>;
};

const PNG: AcceptedType = {
  mime: 'image/png',
  ext: '.png',
  magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
};

const JPEG: AcceptedType = {
  mime: 'image/jpeg',
  ext: '.jpg',
  magic: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
};

const WEBP: AcceptedType = {
  mime: 'image/webp',
  ext: '.webp',
  // RIFF container: "RIFF" ␣␣␣␣ "WEBP" — the four size bytes between are not
  // fixed, hence two fragments rather than one twelve-byte prefix.
  magic: [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
};

const PDF: AcceptedType = {
  mime: 'application/pdf',
  ext: '.pdf',
  magic: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }], // "%PDF-"
};

export type ClassPolicy = {
  visibility: FileVisibility;
  maxBytes: number;
  accepted: AcceptedType[];
  /** What a caller must be able to do in order to upload into this class. */
  uploader: Capability;
  /** Whether the upload must name the contract it belongs to. */
  requiresContract: boolean;
};

/**
 * **SVG is deliberately not accepted anywhere.** It is a document that can
 * carry script, and these files are served from the app's own origin — an
 * uploaded SVG is a stored-XSS with a picture on it. If vector previews are
 * ever wanted, they get rasterised on upload or served from a separate origin;
 * they do not get added to this list.
 */
export const POLICY: Record<FileClass, ClassPolicy> = {
  DESIGN_IMAGE: {
    visibility: 'PRIVATE',
    maxBytes: 2 * 1024 * 1024,
    accepted: [PNG, JPEG, WEBP],
    uploader: 'contracts.manage',
    requiresContract: true,
  },
  // Nothing produces this yet — the Research Lab's R1 does. It is defined now
  // because the public/private split had to exist from the first migration
  // (build plan §F1), and a split with only one side is not a split.
  RESEARCH_TEXT: {
    visibility: 'PUBLIC',
    maxBytes: 25 * 1024 * 1024,
    accepted: [PDF],
    // A contributor's own remit, once R1 exists — the hosted full text is part
    // of writing a Library entry, not a separate privilege.
    uploader: 'library.write',
    requiresContract: false,
  },
};

export function policyFor(name: string): { fileClass: FileClass; policy: ClassPolicy } {
  const fileClass = name as FileClass;
  const policy = POLICY[fileClass];
  if (!policy) {
    throw new UploadError(
      400,
      'UNKNOWN_FILE_CLASS',
      `Unknown file class "${name}". Expected one of: ${Object.keys(POLICY).join(', ')}.`,
    );
  }
  return { fileClass, policy };
}

function matches(data: Buffer, type: AcceptedType): boolean {
  return type.magic.every(
    ({ offset, bytes }) =>
      data.length >= offset + bytes.length &&
      bytes.every((b, i) => data[offset + i] === b),
  );
}

/**
 * What the file actually is, decided from its own first bytes.
 *
 * The browser's `Content-Type` and the filename extension are both supplied by
 * the caller and neither is evidence. This is what gets stored on the row and
 * what gets sent back on download, so a `.png` full of something else is
 * refused at the door rather than served back later with a type that invites a
 * browser to guess.
 */
export function sniff(data: Buffer, policy: ClassPolicy): AcceptedType {
  const found = policy.accepted.find((t) => matches(data, t));
  if (!found) {
    throw new UploadError(
      415,
      'UNSUPPORTED_TYPE',
      `That file is not one of the accepted types (${policy.accepted
        .map((t) => t.mime)
        .join(', ')}). What matters is the file's contents, not its name.`,
    );
  }
  return found;
}

export function checkSize(bytes: number, policy: ClassPolicy): void {
  if (bytes === 0) {
    throw new UploadError(400, 'EMPTY_FILE', 'That file is empty.');
  }
  if (bytes > policy.maxBytes) {
    throw new UploadError(
      413,
      'FILE_TOO_LARGE',
      `That file is ${mb(bytes)} MB; the limit for this kind is ${mb(policy.maxBytes)} MB.`,
    );
  }
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);

/**
 * A filename safe to echo back in a `Content-Disposition`.
 *
 * The stored name is only ever a label — it never touches a path — but it does
 * come back out in a header, so anything that could end or extend that header
 * is removed. Persian names survive intact; the header itself is encoded with
 * RFC 5987 at the point of use, which is what makes that possible.
 */
export function safeDownloadName(original: string, ext: string): string {
  const cleaned = original
    // Control characters, quotes, path separators and the header's own
    // delimiters. Everything else — Persian included — is left alone.
    .replace(/[\u0000-\u001f\u007f"'\\/;]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  const base = cleaned || `file${ext}`;
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}
