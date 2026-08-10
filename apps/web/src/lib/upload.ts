/**
 * POST /upload — plain HTTP, not GraphQL (build plan §F1). Errors come back
 * as `{ error, message }` JSON with an HTTP status, never as a GraphQL
 * error, so Apollo's error handling never sees them (V2.md §4, T2). The
 * server's `message` is English prose and must not reach a Persian reader —
 * only the mapped i18n key is ever shown.
 */

export const DESIGN_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A hint for the file input's `accept` attribute, and nothing more (T4). The
 * server decides what a file actually is from its own leading bytes
 * (`lib/files.ts`); mirroring this list as validation would be a second copy
 * of a policy that lives there.
 */
export const DESIGN_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

export type UploadResult = {
  id: string;
  url: string;
  mime: string;
  bytes: number;
  originalName: string;
};

export const RESEARCH_TEXT_MAX_BYTES = 25 * 1024 * 1024;

/** T4: what the file input's `accept` hints at, nothing more — the server
 *  sniffs the real bytes (`lib/files.ts`). */
export const RESEARCH_TEXT_ACCEPT = 'application/pdf';

const ERROR_KEYS: Record<string, string> = {
  UNAUTHENTICATED: 'upload.errAuth',
  FORBIDDEN: 'upload.errAuth',
  NOT_FOUND: 'upload.errNotFound',
  FILE_TOO_LARGE: 'upload.errTooLarge',
  UNSUPPORTED_TYPE: 'upload.errType',
  EMPTY_FILE: 'upload.errEmpty',
  // R1 (§6): the two ways the upload route refuses a hosted file at the only
  // moment RESEARCH_TEXT can be checked at all — it is PUBLIC, so nothing is
  // in the request path after this.
  RIGHTS_FORBID_HOSTING: 'desk.library.errRightsForbidHosting',
  ALREADY_HAS_FILE: 'desk.library.errAlreadyHasFile',
};

export class UploadFailure extends Error {
  constructor(readonly i18nKey: string) {
    super(i18nKey);
    this.name = 'UploadFailure';
  }
}

/** Uploads a design image (concept or page preview) for one contract. */
export async function uploadDesignImage(contractId: string, file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(
    `/upload?class=DESIGN_IMAGE&contractId=${encodeURIComponent(contractId)}`,
    { method: 'POST', credentials: 'include', body: form },
  );
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new UploadFailure(ERROR_KEYS[body?.error ?? ''] ?? 'upload.errGeneric');
  }
  return body as unknown as UploadResult;
}

/** Uploads a Library entry's hosted full text. The upload route itself sets
 *  `fullTextFileId` as part of the same transaction (R1.md §6) — unlike a
 *  design image, there is no separate attach step. */
export async function uploadResearchText(entryId: string, file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(
    `/upload?class=RESEARCH_TEXT&entryId=${encodeURIComponent(entryId)}`,
    { method: 'POST', credentials: 'include', body: form },
  );
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new UploadFailure(ERROR_KEYS[body?.error ?? ''] ?? 'upload.errGeneric');
  }
  return body as unknown as UploadResult;
}
