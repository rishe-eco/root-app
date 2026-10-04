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
  // P0-7: originCheck.ts refuses a cross-site request that carries the
  // session cookie. A same-origin upload from the portal itself never hits
  // this — it exists for the case reported to the user is not "your fault".
  ORIGIN_REFUSED: 'upload.errOrigin',
  // J9a/J9b: the mockup bundle's own refusals (`lib/mockupBundle.ts`, and the
  // streamed route's) — each one says what to fix in the zip, because a designer
  // who is told only "the upload failed" has nothing to act on.
  BUNDLE_TOO_LARGE: 'upload.errBundleTooLarge',
  BUNDLE_TOO_MANY_FILES: 'upload.errBundleTooManyFiles',
  BUNDLE_PATH_UNSAFE: 'upload.errBundlePathUnsafe',
  BUNDLE_TYPE_REFUSED: 'upload.errBundleTypeRefused',
  BUNDLE_NO_INDEX: 'upload.errBundleNoIndex',
  BUNDLE_UNREADABLE: 'upload.errBundleUnreadable',
  BUNDLE_ENCRYPTED_ENTRY: 'upload.errBundleEncrypted',
  // The route's own: no contract named, a contract that is not theirs, no file.
  CONTRACT_REQUIRED: 'upload.errContractRequired',
  NOT_ASSIGNED: 'upload.errNotAssigned',
  NO_FILE: 'upload.errNoFile',
};

/** The locale key for a code the upload route answered with, or the generic one. */
export function uploadErrorKey(code: string | null | undefined): string {
  return ERROR_KEYS[code ?? ''] ?? 'upload.errGeneric';
}

/** Every code with its own sentence — for the test that holds both locales to it. */
export const UPLOAD_ERROR_CODES = Object.keys(ERROR_KEYS);

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

// ---------------------------------------------------------------------------
// The product-import panel (build plan L7; spec §9) — the first upload a
// customer performs themself, matching the panel being self-serve.
// ---------------------------------------------------------------------------

export const SERVICE_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** T4: a hint for the file input, nothing more — the server sniffs the real
 *  bytes (lib/files.ts). Excel only, matching the spec's own framing
 *  ("the productization of Nahal's outstanding Excel panel"). */
export const SERVICE_IMPORT_ACCEPT =
  '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Attaches nothing itself — `createServiceRun(projectId, fileId)` (GraphQL)
 *  is the separate step that turns the uploaded file into a run, the same
 *  two-step shape `uploadDesignImage` + `setConceptImage` already uses. */
export async function uploadServiceImport(projectId: string, file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(
    `/upload?class=SERVICE_IMPORT&projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST', credentials: 'include', body: form },
  );
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new UploadFailure(ERROR_KEYS[body?.error ?? ''] ?? 'upload.errGeneric');
  }
  return body as unknown as UploadResult;
}

// ---------------------------------------------------------------------------
// The theme catalogue (journeys build plan T2) — a preview image per theme.
// ---------------------------------------------------------------------------

/** T4: a hint for the file input, nothing more — the server sniffs the real
 *  bytes (lib/files.ts). Same three raster types as a design image. */
export const THEME_PREVIEW_ACCEPT = DESIGN_IMAGE_ACCEPT;

/** Uploads a theme's preview. The upload route points the theme at the new
 *  file in the same transaction and removes the one it replaces, so — unlike a
 *  design image — there is no separate attach step. */
export async function uploadThemePreview(themeId: string, file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`/upload?class=THEME_PREVIEW&themeId=${encodeURIComponent(themeId)}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    // ERROR_KEYS words NOT_FOUND for a contract; this route means a theme.
    const key = body?.error === 'NOT_FOUND' ? 'upload.errThemeNotFound' : ERROR_KEYS[body?.error ?? ''];
    throw new UploadFailure(key ?? 'upload.errGeneric');
  }
  return body as unknown as UploadResult;
}

// ---------------------------------------------------------------------------
// The mockup bundle (journeys build plan J9b) — the one upload with progress.
// ---------------------------------------------------------------------------

export const MOCKUP_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;

/** A hint for the file input, nothing more — the server sniffs the real bytes. */
export const MOCKUP_BUNDLE_ACCEPT = '.zip,application/zip';

/**
 * Uploads a mockup bundle to a contract, reporting progress. `fetch` cannot say
 * how much of a request body has gone, and a 50 MB zip over a slow connection is
 * long enough that a bar is not decoration — so this is the one upload that uses
 * `XMLHttpRequest`. The server streams it to disk (`routes/files.ts`,
 * `receiveStreamedUpload`); nothing about that changes the request.
 *
 * `onProgress` gets a fraction between 0 and 1. Errors come back the way every
 * other upload's do — `UploadFailure` carrying a locale key, never the server's
 * English.
 */
export function uploadMockupBundle(contractId: string, file: File, onProgress?: (fraction: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload?class=MOCKUP_BUNDLE&contractId=${encodeURIComponent(contractId)}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new UploadFailure('upload.errGeneric'));
    xhr.onload = () => {
      let body: { error?: string } | null = null;
      try {
        body = JSON.parse(xhr.responseText) as { error?: string };
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        onProgress?.(1);
        resolve(body as unknown as UploadResult);
        return;
      }
      reject(new UploadFailure(uploadErrorKey(body?.error)));
    };
    xhr.send(form);
  });
}
