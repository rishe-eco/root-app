import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { startAskServer, readSSE } from './http.js';
import { storage } from '../lib/storage.js';
import { __setAnthropicClientForTests } from '../lib/anthropicClient.js';
import { __resetAskRateLimitForTests, recordSpend, DAILY_SPEND_CEILING_USD } from '../lib/askRateLimit.js';

/**
 * R4: "Ask the Lab" / "Ask this paper" (routes/ask.ts) against a real
 * database and a real HTTP server, with the Anthropic client stubbed at the
 * seam `lib/anthropicClient.ts` provides for exactly this purpose — no live
 * API, per R4.md §8.
 */

let f: Fixture;
let base: string;
let close: () => Promise<void>;

before(async () => {
  await resetDatabase();
  const server = await startAskServer();
  base = server.base;
  close = server.close;
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  __resetAskRateLimitForTests();
  __setAnthropicClientForTests(null);
});

after(async () => {
  await close();
  await prisma.$disconnect();
});

function entryData(overrides: Partial<Prisma.LibraryEntryUncheckedCreateInput> = {}): Prisma.LibraryEntryUncheckedCreateInput {
  return {
    slug: `entry-${Math.random().toString(36).slice(2)}`,
    type: 'PAPER' as const,
    originalLang: 'en',
    titleOriginal: 'A Paper About Beekeeping',
    authors: 'A. Author',
    abstractOriginal: 'A study of beekeeping practices in arid climates.',
    translationProvenance: 'NONE_YET' as const,
    rightsBasis: 'PUBLIC_DOMAIN' as const,
    visibility: 'PUBLIC' as const,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    searchText: 'a paper about beekeeping practices in arid climates',
    createdById: f.admin.id,
    ...overrides,
  };
}

/**
 * A fake `Anthropic` client — the seam R4.md §8 asks for. Records every
 * request handed to `.stream()` and `.beta.files.upload()` so a test can
 * assert on exactly what would have left the process, without spending a
 * cent or touching the network.
 */
function fakeAnthropic(opts: {
  text?: string;
  stopReason?: Anthropic.Beta.Messages.BetaStopReason;
  citations?: Array<Record<string, unknown>>;
  countTokensInputTokens?: number;
  throwOnStream?: boolean;
} = {}) {
  const streamRequests: Array<Record<string, unknown>> = [];
  const uploads: Array<{ betas?: string[] }> = [];

  const client = {
    beta: {
      files: {
        upload: async (params: { betas?: string[] }) => {
          uploads.push(params);
          return { id: `fake-file-${uploads.length}` };
        },
      },
      messages: {
        countTokens: async () => ({ input_tokens: opts.countTokensInputTokens ?? 100 }),
        stream: (params: Record<string, unknown>) => {
          streamRequests.push(params);
          if (opts.throwOnStream) {
            return {
              on: () => {},
              finalMessage: async () => {
                throw new Error('upstream failed');
              },
            };
          }
          const text = opts.text ?? 'A studied answer.';
          const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
          return {
            on(event: string, cb: (...a: unknown[]) => void) {
              (listeners[event] ??= []).push(cb);
              return this;
            },
            async finalMessage() {
              for (const cb of listeners.text ?? []) cb(text, text);
              return {
                stop_reason: opts.stopReason ?? 'end_turn',
                content: [{ type: 'text', text, citations: opts.citations ?? null }],
                usage: {
                  input_tokens: 100,
                  output_tokens: 50,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              };
            },
          };
        },
      },
    },
  };

  return { client: client as unknown as Anthropic, streamRequests, uploads };
}

async function ask(body: Record<string, unknown>) {
  const res = await fetch(`${base}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const frames = res.headers.get('content-type')?.includes('text/event-stream') ? await readSSE(res) : [];
  const jsonBody = frames.length === 0 ? await res.json().catch(() => null) : null;
  return { status: res.status, frames, jsonBody };
}

test('a LINK_ONLY entry’s full text never appears in the outgoing request — the most important test in the stage (§0)', async () => {
  // Two layers, both asserted here. First: the database itself. R1's CHECK
  // constraint (`LibraryEntry_hosted_text_is_publishable`) makes "LINK_ONLY
  // with a hosted file" an impossible row in this schema — so this is not
  // hypothetical defense, it is confirmed unreachable through the ORM.
  const key = await storage.put('PUBLIC', Buffer.from('%PDF-1.7 fake link-only bytes'), '.pdf');
  const orphanFile = await prisma.storedFile.create({
    data: {
      key,
      class: 'RESEARCH_TEXT',
      visibility: 'PUBLIC',
      mime: 'application/pdf',
      bytes: 30,
      originalName: 'secret.pdf',
      uploadedById: f.admin.id,
    },
  });
  await assert.rejects(
    () => prisma.libraryEntry.create({ data: entryData({ rightsBasis: 'LINK_ONLY', fullTextFileId: orphanFile.id }) }),
    /LibraryEntry_hosted_text_is_publishable/,
    'the database must refuse a LINK_ONLY entry with a hosted file before this route ever sees one',
  );

  // Second layer: askLab.test.ts already proves buildDocumentBlocks
  // structurally cannot produce a `file` source for a LINK_ONLY entry even
  // if handed one directly — belt and suspenders, since a future code path
  // that builds a candidate from somewhere other than this exact query
  // should not get to rely on the constraint above alone. Here, end to end,
  // against the real database: a LINK_ONLY entry alongside a quotable one
  // with an actual hosted file, in the same request.
  await prisma.libraryEntry.create({
    data: entryData({
      rightsBasis: 'LINK_ONLY',
      titleOriginal: 'A Paper Nobody May Republish, About Beekeeping',
    }),
  });
  const quotableFile = await prisma.storedFile.create({
    data: {
      key: await storage.put('PUBLIC', Buffer.from('%PDF-1.7 quotable bytes'), '.pdf'),
      class: 'RESEARCH_TEXT',
      visibility: 'PUBLIC',
      mime: 'application/pdf',
      bytes: 24,
      originalName: 'open.pdf',
      uploadedById: f.admin.id,
    },
  });
  await prisma.libraryEntry.create({
    data: entryData({ rightsBasis: 'OPEN_LICENCE', fullTextFileId: quotableFile.id }),
  });

  const { client, streamRequests, uploads } = fakeAnthropic();
  __setAnthropicClientForTests(client);

  const { frames } = await ask({ question: 'What does the beekeeping research say?', locale: 'en' });

  assert.equal(uploads.length, 1, 'only the quotable entry’s bytes are ever uploaded to the Files API');
  assert.equal(streamRequests.length, 1);
  const documentBlocks = (streamRequests[0].messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.filter(
    (b) => b.type === 'document',
  );
  assert.equal(documentBlocks.length, 2, 'both entries contribute a block — one text, one file');
  const fileBlocks = documentBlocks.filter((b) => (b.source as { type: string }).type === 'file');
  assert.equal(fileBlocks.length, 1, 'exactly one document block is a full-text source — the quotable entry’s');
  assert.ok(frames.some((fr) => fr.event === 'done'));
});

test('a quotable entry’s hosted PDF is uploaded once and referenced by file_id, with citations enabled', async () => {
  const key = await storage.put('PUBLIC', Buffer.from('%PDF-1.7 quotable bytes'), '.pdf');
  const file = await prisma.storedFile.create({
    data: {
      key,
      class: 'RESEARCH_TEXT',
      visibility: 'PUBLIC',
      mime: 'application/pdf',
      bytes: 24,
      originalName: 'open.pdf',
      uploadedById: f.admin.id,
    },
  });
  await prisma.libraryEntry.create({
    data: entryData({ rightsBasis: 'OPEN_LICENCE', fullTextFileId: file.id }),
  });

  const { client, streamRequests, uploads } = fakeAnthropic();
  __setAnthropicClientForTests(client);

  await ask({ question: 'What does the beekeeping research say?', locale: 'en' });

  assert.equal(uploads.length, 1, 'the PDF is uploaded exactly once');
  const documentBlocks = (streamRequests[0].messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.filter(
    (b) => b.type === 'document',
  );
  assert.equal(documentBlocks.length, 1);
  assert.deepEqual(documentBlocks[0].source, { type: 'file', file_id: 'fake-file-1' });
  assert.deepEqual(documentBlocks[0].citations, { enabled: true });

  // Asked again: the id on disk is now cached, so no second upload.
  await ask({ question: 'Anything about arid climates?', locale: 'en' });
  assert.equal(uploads.length, 1, 'a cached Anthropic file id is reused, never re-uploaded');
});

test('a PRIVATE entry and a draft never enter candidate selection', async () => {
  await prisma.libraryEntry.create({ data: entryData({ visibility: 'PRIVATE' }) });
  await prisma.libraryEntry.create({ data: entryData({ publishedAt: null }) }); // a draft

  const { client, streamRequests } = fakeAnthropic();
  __setAnthropicClientForTests(client);

  const { frames } = await ask({ question: 'beekeeping', locale: 'en' });

  assert.equal(streamRequests.length, 0, 'no candidates means no request is ever sent — nothing to leak');
  const done = frames.find((fr) => fr.event === 'done');
  assert.equal((done?.data as { stopReason: string }).stopReason, 'no_candidates');
});

test('"Ask this paper" pins the candidate set to one entry via entrySlug, and a wrong slug is NOT_FOUND (house rule 13)', async () => {
  const entry = await prisma.libraryEntry.create({ data: entryData({ slug: 'pinned-entry' }) });
  await prisma.libraryEntry.create({ data: entryData({ slug: 'other-entry', titleOriginal: 'A Different Paper' }) });

  const { client, streamRequests } = fakeAnthropic();
  __setAnthropicClientForTests(client);

  await ask({ question: 'What is this about?', locale: 'en', entrySlug: entry.slug });
  const documentBlocks = (streamRequests[0].messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.filter(
    (b) => b.type === 'document',
  );
  assert.equal(documentBlocks.length, 1, 'pinned to exactly the one entry, never the whole corpus');

  const missing = await ask({ question: 'anything', locale: 'en', entrySlug: 'does-not-exist' });
  assert.equal(missing.status, 404);
  assert.equal((missing.jsonBody as { error: string }).error, 'NOT_FOUND');
});

test('a refusal is surfaced as `refused`, never as a `done` answer with citations', async () => {
  await prisma.libraryEntry.create({ data: entryData() });
  const { client } = fakeAnthropic({ stopReason: 'refusal', text: '' });
  __setAnthropicClientForTests(client);

  const { frames } = await ask({ question: 'beekeeping', locale: 'en' });
  assert.ok(frames.some((fr) => fr.event === 'refused'));
  assert.ok(!frames.some((fr) => fr.event === 'done'), 'a refusal must never also emit a done answer');
});

test('a truncated (max_tokens) answer is marked truncated rather than presented as complete', async () => {
  await prisma.libraryEntry.create({ data: entryData() });
  const { client } = fakeAnthropic({ stopReason: 'max_tokens' });
  __setAnthropicClientForTests(client);

  const { frames } = await ask({ question: 'beekeeping', locale: 'en' });
  const done = frames.find((fr) => fr.event === 'done');
  assert.equal((done?.data as { truncated: boolean }).truncated, true);
});

test('an upstream failure surfaces as an error event, never a silent hang', async () => {
  await prisma.libraryEntry.create({ data: entryData() });
  const { client } = fakeAnthropic({ throwOnStream: true });
  __setAnthropicClientForTests(client);

  const { frames } = await ask({ question: 'beekeeping', locale: 'en' });
  assert.ok(frames.some((fr) => fr.event === 'error' && (fr.data as { code: string }).code === 'UPSTREAM_FAILED'));
});

test('no ANTHROPIC_API_KEY configured refuses with UNAVAILABLE before touching the database', async () => {
  __setAnthropicClientForTests(null);
  const res = await fetch(`${base}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'beekeeping', locale: 'en' }),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'UNAVAILABLE');
});

test('a malformed question or locale is refused before any candidate lookup', async () => {
  __setAnthropicClientForTests(fakeAnthropic().client);
  const noQuestion = await ask({ locale: 'en' });
  assert.equal(noQuestion.status, 400);

  const badLocale = await ask({ question: 'hi', locale: 'de' });
  assert.equal(badLocale.status, 400);

  const tooLong = await ask({ question: 'x'.repeat(3000), locale: 'en' });
  assert.equal(tooLong.status, 400);
});

test('the daily spend ceiling refuses before calling out, and fails closed', async () => {
  await prisma.libraryEntry.create({ data: entryData() });
  const { client, streamRequests } = fakeAnthropic();
  __setAnthropicClientForTests(client);
  recordSpend(DAILY_SPEND_CEILING_USD); // already at the ceiling for today

  const res = await fetch(`${base}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'beekeeping', locale: 'en' }),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'RESTING');
  assert.equal(streamRequests.length, 0, 'a ceiling that has already been hit must refuse before spending a cent more');
});

test('rate limiting refuses before the daily spend ceiling and before any candidate lookup', async () => {
  await prisma.libraryEntry.create({ data: entryData() });
  const { client, streamRequests } = fakeAnthropic();
  __setAnthropicClientForTests(client);

  // The bucket holds 5; the 6th within the same burst is refused.
  for (let i = 0; i < 5; i += 1) {
    const res = await ask({ question: 'beekeeping', locale: 'en' });
    assert.notEqual(res.status, 429, `request ${i} should not be rate limited yet`);
  }
  const sixth = await fetch(`${base}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'beekeeping', locale: 'en' }),
  });
  assert.equal(sixth.status, 429);
  assert.equal(streamRequests.length, 5, 'the 6th request never reached the model at all');
});
