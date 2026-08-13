import express from 'express';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import type { User } from '@prisma/client';

import { filesRouter, filesErrorHandler } from '../routes/files.js';
import { askRouter, askErrorHandler } from '../routes/ask.js';
import { signSession } from '../auth/tokens.js';
import { env } from '../lib/env.js';

/**
 * A real HTTP server for the file routes.
 *
 * Unlike `graphql.ts`, these tests cannot skip the transport: the things worth
 * checking here *are* transport — a status code, a `Content-Disposition`, a
 * cookie that was or was not sent, a body that stops being read at a limit.
 *
 * The wiring below mirrors `index.ts`: cookie parsing, the router, and the
 * error handler last. It deliberately does **not** mount `express.json`,
 * because index.ts mounts that on `/graphql` alone — if that ever changes, an
 * upload here would start being parsed as JSON and these tests should be the
 * ones to notice.
 */
export async function startFileServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(cookieParser());
  app.use(filesRouter);
  app.use(filesErrorHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');

  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A real HTTP server for the ask route (R4) — same reasoning as
 *  `startFileServer`: SSE framing, status codes and header order are
 *  transport, and a real server is the only way to exercise them. */
export async function startAskServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(askRouter);
  app.use(askErrorHandler);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');

  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Reads a whole SSE response body into its `{event, data}` frames. Ask's
 *  responses are short-lived (one question, one answer), so collecting the
 *  full stream rather than yielding it incrementally is the simpler and
 *  entirely sufficient shape for a test. */
export async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Array<{ event: string; data: unknown }> = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      let dataLine = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) dataLine += line.slice('data:'.length).trim();
      }
      if (dataLine) frames.push({ event, data: JSON.parse(dataLine) });
    }
  }
  return frames;
}

/** The same cookie `buildContext` reads in production, signed the same way. */
export function cookieFor(user: Pick<User, 'id'>): string {
  return `${env.COOKIE_NAME}=${signSession({ sub: user.id })}`;
}

export const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

export const PDF = Buffer.from('%PDF-1.7\n%some research text\n');

export type UploadOpts = {
  as?: Pick<User, 'id'> | null;
  fileClass?: string;
  contractId?: string | null;
  entryId?: string | null;
  filename?: string;
  body?: Buffer;
  type?: string;
};

export async function upload(base: string, opts: UploadOpts = {}) {
  const form = new FormData();
  form.set(
    'file',
    new File([new Uint8Array(opts.body ?? PNG)], opts.filename ?? 'mockup.png', {
      type: opts.type ?? 'image/png',
    }),
  );

  const params = new URLSearchParams({ class: opts.fileClass ?? 'DESIGN_IMAGE' });
  if (opts.contractId) params.set('contractId', opts.contractId);
  if (opts.entryId) params.set('entryId', opts.entryId);

  const res = await fetch(`${base}/upload?${params}`, {
    method: 'POST',
    body: form,
    headers: opts.as ? { cookie: cookieFor(opts.as) } : {},
  });
  const json = res.ok || res.status < 500 ? await res.json().catch(() => null) : null;
  return { status: res.status, body: json as Record<string, string> | null };
}
