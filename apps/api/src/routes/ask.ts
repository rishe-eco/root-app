/**
 * POST /ask — "Ask the Lab" and "Ask this paper", one code path (R4.md T1).
 *
 * Plain HTTP, not GraphQL — the same reasoning `routes/files.ts` gives for
 * upload/download: this is a genuinely different transport shape (a
 * long-lived streamed response) that Apollo's JSON-only contract does not
 * fit, so it stays a boring Express route with its own body limit rather
 * than a special case bolted onto the schema.
 *
 * Server-Sent Events over a POST, by hand — not the browser `EventSource`
 * API, which is GET-only. A GET would put the question in a URL, and a URL
 * ends up in Nginx's access log next to the visitor's IP: exactly the
 * "record of what someone is reading" R4.md §4 says never to create.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { toFile } from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { storage } from '../lib/storage.js';
import { publiclyVisible, foldPersian } from '../lib/library.js';
import { getAnthropicClient } from '../lib/anthropicClient.js';
import { checkRateLimit, estimateCostUsd, recordSpend, spendCeilingExceeded } from '../lib/askRateLimit.js';
import {
  ASK_MAX_TOKENS,
  ASK_MODEL,
  CANDIDATE_LIMIT,
  MAX_QUESTION_LENGTH,
  MAX_REQUEST_TOKENS,
  buildAskMessages,
  buildAskSystemPrompt,
  buildDocumentBlocks,
  ensureAnthropicFileId,
  extractAnswer,
  extractSearchTerms,
  selectFullTextEntries,
  type AskCandidate,
  type AskLocale,
} from '../lib/askLab.js';

export const askRouter: Router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/** What the ask route needs from a LibraryEntry row — thin, same reasoning
 *  as R1/R2's row selects (T1 there, this file's own T1). */
const candidateSelect = {
  id: true,
  slug: true,
  titleOriginal: true,
  titleTranslated: true,
  originalLang: true,
  authors: true,
  venue: true,
  year: true,
  abstractOriginal: true,
  abstractTranslated: true,
  rightsBasis: true,
  fullTextFile: {
    select: { id: true, bytes: true, mime: true, originalName: true, key: true, anthropicFileId: true },
  },
} satisfies Prisma.LibraryEntrySelect;

type CandidateRow = Prisma.LibraryEntryGetPayload<{ select: typeof candidateSelect }>;

const toCandidate = (r: CandidateRow): AskCandidate => ({
  id: r.id,
  slug: r.slug,
  titleOriginal: r.titleOriginal,
  titleTranslated: r.titleTranslated,
  originalLang: r.originalLang,
  authors: r.authors,
  venue: r.venue,
  year: r.year,
  abstractOriginal: r.abstractOriginal,
  abstractTranslated: r.abstractTranslated,
  rightsBasis: r.rightsBasis,
  fullTextFile: r.fullTextFile,
});

function sendEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

type AskBody = { question?: unknown; locale?: unknown; entrySlug?: unknown };

function parseBody(body: AskBody): { question: string; locale: AskLocale; entrySlug: string | null } | null {
  if (typeof body.question !== 'string') return null;
  const question = body.question.trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) return null;
  if (body.locale !== 'fa' && body.locale !== 'en') return null;
  if (body.entrySlug !== undefined && typeof body.entrySlug !== 'string') return null;
  return { question, locale: body.locale, entrySlug: (body.entrySlug as string | undefined) ?? null };
}

askRouter.post(
  '/ask',
  express.json({ limit: '10kb' }),
  wrap(async (req, res) => {
    // Every code below is a stable identifier only — house rule 6 puts every
    // user-facing string in fa.json/en.json, so this route never composes
    // prose for a reader. The client maps `error` to a locale string; what
    // ships here is for an operator's log, not a browser.
    const parsed = parseBody(req.body as AskBody);
    if (!parsed) {
      res.status(400).json({ error: 'BAD_REQUEST' });
      return;
    }
    const { question, locale, entrySlug } = parsed;

    const client = getAnthropicClient();
    if (!client) {
      res.status(503).json({ error: 'UNAVAILABLE' });
      return;
    }

    // req.ip, not the raw socket address — env.ts's TRUST_PROXY_HOPS is what
    // makes this the visitor's address rather than a proxy's, the same
    // reasoning Signature.ip already relies on.
    const ip = req.ip ?? 'unknown';
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: 'RATE_LIMITED' });
      return;
    }
    if (spendCeilingExceeded()) {
      // §4: "the Lab is resting" — a plain refusal, not a 500, and it fails
      // closed rather than quietly spending past the ceiling.
      res.status(503).json({ error: 'RESTING' });
      return;
    }

    // Candidate selection: the pinned single entry for "Ask this paper", or
    // R2's own search query with a larger limit for "Ask the Lab" (§2.1) —
    // both filtered through publiclyVisible, so a draft or a PRIVATE entry
    // is never a candidate (T6), the same "not found" as everywhere else in
    // the public reader (house rule 13) when a pinned slug doesn't resolve.
    let rows: CandidateRow[];
    if (entrySlug) {
      const row = await prisma.libraryEntry.findFirst({
        where: { ...publiclyVisible, slug: entrySlug },
        select: candidateSelect,
      });
      if (!row) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      rows = [row];
    } else {
      const terms = extractSearchTerms(question);
      rows = await prisma.libraryEntry.findMany({
        where: {
          ...publiclyVisible,
          ...(terms.length > 0
            ? { OR: terms.map((term) => ({ searchText: { contains: term } })) }
            : { searchText: { contains: foldPersian(question) } }),
        },
        orderBy: { publishedAt: 'desc' },
        take: CANDIDATE_LIMIT,
        select: candidateSelect,
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx: do not buffer the stream
    res.flushHeaders?.();

    if (rows.length === 0) {
      // Honest and free: nothing in the corpus matches, so there is nothing
      // to ask the model — §3.2's "say so plainly" without spending a token
      // on it. No `text` — the client renders its own locale string for
      // `stopReason: 'no_candidates'` rather than display server prose.
      sendEvent(res, 'done', { text: '', citations: [], truncated: false, stopReason: 'no_candidates' });
      res.end();
      return;
    }

    const candidates = rows.map(toCandidate);
    const fullTextIds = selectFullTextEntries(candidates);

    // Upload-once (R4.md §2.3): only for the entries selected for full text,
    // and only ever the first time — ensureAnthropicFileId is a no-op once
    // StoredFile.anthropicFileId is set.
    //
    // Inside a try, because the headers are already flushed: past this point
    // a thrown error can no longer become a status code, and Express's
    // default handler would answer it by destroying the socket. The client
    // reads that as a clean end of stream with no terminal frame and waits
    // forever. **Every path past flushHeaders owes the client exactly one
    // terminal event** — that is the invariant this try, and the one below,
    // exist to keep.
    try {
      await Promise.all(
        candidates
          .filter((c) => fullTextIds.has(c.id) && c.fullTextFile)
          .map((c) =>
            ensureAnthropicFileId(c.fullTextFile!, {
              read: (key) => storage.read(key),
              upload: async ({ data, filename, mime }) => {
                const uploaded = await client.beta.files.upload({
                  file: await toFile(data, filename, { type: mime }),
                  betas: ['files-api-2025-04-14'],
                });
                return uploaded.id;
              },
              persist: async (storedFileId, anthropicFileId) => {
                await prisma.storedFile.update({
                  where: { id: storedFileId },
                  data: { anthropicFileId, anthropicFileUploadedAt: new Date() },
                });
                // Keep the in-memory candidate in step so buildDocumentBlocks
                // (below, same request) sees the id it just resolved.
                const c = candidates.find((x) => x.fullTextFile?.id === storedFileId);
                if (c?.fullTextFile) c.fullTextFile.anthropicFileId = anthropicFileId;
              },
            }),
          ),
      );
    } catch (err) {
      // Never the question itself (R4.md §4) — only that preparing this
      // request's documents failed, and why.
      console.error('[ask] document upload failed', err instanceof Error ? err.message : err);
      sendEvent(res, 'error', { code: 'UPSTREAM_FAILED' });
      res.end();
      return;
    }

    const documentBlocks = buildDocumentBlocks(candidates, fullTextIds);
    const messages = buildAskMessages(question, documentBlocks);
    const system = buildAskSystemPrompt(locale);
    const usesFile = documentBlocks.some((b) => b.source.type === 'file');

    const requestParams = {
      model: ASK_MODEL,
      max_tokens: ASK_MAX_TOKENS,
      thinking: { type: 'adaptive' as const },
      output_config: { effort: 'medium' as const },
      system: [{ type: 'text' as const, text: system }],
      messages,
      betas: usesFile ? ['files-api-2025-04-14' as const] : undefined,
    };

    // §5: count before sending rather than guessing from file size — refuse
    // gracefully if this question's document set would not fit rather than
    // let the request fail mid-stream.
    try {
      const counted = await client.beta.messages.countTokens({
        model: requestParams.model,
        system: requestParams.system,
        messages: requestParams.messages,
        betas: requestParams.betas,
      });
      if (counted.input_tokens > MAX_REQUEST_TOKENS) {
        sendEvent(res, 'error', { code: 'TOO_LARGE' });
        res.end();
        return;
      }
    } catch (err) {
      console.error('[ask] countTokens failed', err instanceof Error ? err.message : err);
      // Not fatal on its own — proceed and let the real request be the
      // final word, the same way a pre-flight check failing softly should.
    }

    try {
      const stream = client.beta.messages.stream(requestParams);
      stream.on('text', (delta) => sendEvent(res, 'delta', { text: delta }));

      const finalMessage = await stream.finalMessage();
      recordSpend(estimateCostUsd(finalMessage.usage));

      // T7: check stop_reason before trusting content. A classifier refusal
      // or a mid-citation truncation must never be presented as a complete,
      // sourced answer.
      if (finalMessage.stop_reason === 'refusal') {
        sendEvent(res, 'refused', {});
        res.end();
        return;
      }

      const { text, citations } = extractAnswer(finalMessage.content);
      const mappedCitations = citations
        .map((c) => {
          const entry = candidates[c.documentIndex];
          return entry
            ? {
                citedText: c.citedText,
                entrySlug: entry.slug,
                entryTitle: entry.titleOriginal,
                entryOriginalLang: entry.originalLang,
                entryUrl: `/library/research/${encodeURIComponent(entry.slug)}`,
              }
            : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null);

      sendEvent(res, 'done', {
        text,
        citations: mappedCitations,
        truncated: finalMessage.stop_reason === 'max_tokens',
        stopReason: finalMessage.stop_reason,
      });
      res.end();
    } catch (err) {
      // Never log the question itself (R4.md §4) — only that a request for
      // this ip failed, and why, at the level an operator needs.
      console.error('[ask] request failed', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'UPSTREAM_FAILED' });
        return;
      }
      sendEvent(res, 'error', { code: 'UPSTREAM_FAILED' });
      res.end();
    }
  }),
);

export function askErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  console.error('[ask] unhandled', err);
  res.status(500).json({ error: 'INTERNAL' });
}
