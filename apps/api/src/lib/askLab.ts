/**
 * "Ask the Lab" / "Ask this paper" — grounded question-answering over the
 * Library corpus (R4). T1: the two Ask surfaces are one code path; every
 * function here is written so a caller cannot tell the two apart, only the
 * candidate list differs (routes/ask.ts).
 *
 * **The one thing that must not be got wrong** (build plan §5 R4, R4.md §0):
 * a `LINK_ONLY` entry's full text must never enter a request, because a
 * model holding it would republish it a paragraph at a time under Root's
 * name. That boundary is enforced by what goes into the request — never by
 * what the system prompt asks for — so `quotableFullText` is the single gate
 * and `buildDocumentBlocks` re-derives it itself rather than trusting a
 * caller-supplied flag (§0's "not enforceable by instruction" applies to
 * this file's own callers too, not just the model).
 */

import type { Readable } from 'node:stream';
import type { RightsBasis } from '@prisma/client';
import type Anthropic from '@anthropic-ai/sdk';
import { foldPersian } from './library.js';

export type AskLocale = 'fa' | 'en';

export type AskCandidateFile = {
  id: string;
  bytes: number;
  mime: string;
  originalName: string;
  key: string;
  anthropicFileId: string | null;
};

export type AskCandidate = {
  id: string;
  slug: string;
  titleOriginal: string;
  titleTranslated: string | null;
  originalLang: string;
  authors: string;
  venue: string | null;
  year: number | null;
  abstractOriginal: string | null;
  abstractTranslated: string | null;
  rightsBasis: RightsBasis;
  fullTextFile: AskCandidateFile | null;
};

/**
 * §0's boundary, in one function, called from nowhere else. A `LINK_ONLY`
 * entry contributes metadata and an abstract only — its full text is never
 * placed in a request, so there is nothing for the model to quote. This is
 * not enforceable by instruction: you cannot tell a model to un-read text
 * you put in front of it.
 */
export function quotableFullText(entry: Pick<AskCandidate, 'rightsBasis'>): boolean {
  return entry.rightsBasis !== 'LINK_ONLY';
}

/**
 * Model, retrieval and request-shape constants — one place to tune (R4.md
 * §3, §4, §5). `MAX_FULL_TEXT_TOTAL_BYTES` exists because the API's request
 * limit is 32 MB and an RESEARCH_TEXT upload is individually capped at 25 MB
 * (R1.md) — six full-size papers in one request would blow past it on their
 * own; the per-request cap below keeps the sum, not just the count, in
 * bounds.
 */
export const ASK_MODEL = 'claude-opus-4-8';
export const ASK_MAX_TOKENS = 4096;
export const CANDIDATE_LIMIT = 8;
export const MAX_FULL_TEXT_DOCS = 6;
export const MAX_FULL_TEXT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_QUESTION_LENGTH = 2000;
/** A pre-flight ceiling well under the 1M context window, leaving headroom
 *  for the answer — see `countTokens` in routes/ask.ts (R4.md §5). */
export const MAX_REQUEST_TOKENS = 900_000;

/**
 * **Deferred**, on the same reasoning R1 recorded for `tsvector` and this
 * stage's own §2.1 recorded for embeddings: detecting a PDF's real page
 * count needs a parser this codebase does not otherwise depend on, and the
 * byte cap above already keeps a request under the API's 32 MB ceiling for
 * the corpus sizes R1 allows (≤25 MB/file). **Trigger to revisit:** a real
 * request refused by the API's 600-page ceiling — until then this is a size
 * problem, not a page-count one, and the byte cap is the cheaper fix.
 */

/** The shortest folded token worth matching on — below this, a word is
 *  almost always a stopword ("the", "a", "در", "به") in either script and
 *  would drag in the whole corpus rather than narrow it. */
const MIN_SEARCH_TERM_LENGTH = 3;

/**
 * §2.1: retrieval reuses R2's `searchText`/`foldPersian`/`contains` query —
 * but R2's search box takes a few typed keywords, and a `contains` filter
 * requires its *whole* argument to appear as one substring. A natural-
 * language question passed through unchanged would need an entry's
 * `searchText` to contain that exact sentence, which is essentially never
 * true, so retrieval would silently return nothing for almost every real
 * question. This splits the question into words and matches an entry that
 * contains *any* of them — still exactly `searchText`/`foldPersian`, no
 * `tsvector`, no embeddings, just an OR over the same `contains` clause R2
 * already runs, which is what "reuses R2's query" can actually mean for a
 * question instead of a keyword.
 */
export function extractSearchTerms(question: string): string[] {
  const words = foldPersian(question)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= MIN_SEARCH_TERM_LENGTH);
  return [...new Set(words)];
}

/**
 * **No pgvector, no embeddings — deferred**, on the same reasoning R1
 * recorded for `tsvector` (`lib/library.ts`, above `slugify`) and this
 * stage's own §2.1 restates: the corpus is tens of entries, so a folded
 * keyword-OR over `searchText` finds everything relevant, and an embedding
 * index adds a migration, a write-time side effect to keep in sync, and an
 * embedding-model dependency for recall the corpus does not yet need.
 * **Trigger to revisit:** keyword recall visibly misses relevant entries at
 * corpus scale. Not before.
 */

/** Selects which quotable full-text candidates fit the request, smallest
 *  first (R4.md §2.3: "cheapest-first by size") — maximizing how many whole
 *  papers fit rather than spending the whole budget on the largest one.
 *  Every other candidate (LINK_ONLY, no hosted file, or simply over the cap)
 *  contributes its abstract instead of nothing — see `buildDocumentBlocks`. */
export function selectFullTextEntries(candidates: readonly AskCandidate[]): Set<string> {
  const eligible = candidates
    .filter((e) => quotableFullText(e) && e.fullTextFile !== null)
    .slice()
    .sort((a, b) => a.fullTextFile!.bytes - b.fullTextFile!.bytes);

  const selected = new Set<string>();
  let totalBytes = 0;
  for (const entry of eligible) {
    if (selected.size >= MAX_FULL_TEXT_DOCS) break;
    const bytes = entry.fullTextFile!.bytes;
    // Sorted ascending: the first one that doesn't fit means nothing larger
    // will either, so this is a break, not a continue.
    if (totalBytes + bytes > MAX_FULL_TEXT_TOTAL_BYTES) break;
    selected.add(entry.id);
    totalBytes += bytes;
  }
  return selected;
}

function abstractDocumentText(entry: AskCandidate): string {
  const lines = [
    `Title: ${entry.titleOriginal}`,
    entry.titleTranslated ? `Translated title: ${entry.titleTranslated}` : null,
    `Authors: ${entry.authors}`,
    entry.venue ? `Venue: ${entry.venue}` : null,
    entry.year ? `Year: ${entry.year}` : null,
    '',
    entry.abstractOriginal ?? '(no abstract on file)',
    entry.abstractTranslated ?? null,
  ].filter((line): line is string => line !== null);
  return lines.join('\n');
}

export type AskDocumentBlock = Anthropic.Beta.Messages.BetaRequestDocumentBlock;

/**
 * Builds one document block per candidate — a full-text `file` source for
 * an entry in `fullTextIds`, an abstract-only `text` source for everyone
 * else. `fullTextIds` is expected to already be `selectFullTextEntries`'s
 * output, but this function does not trust it: it re-derives
 * `quotableFullText` and re-checks that a resolved Anthropic file id exists
 * before ever building a `file` source, so a bug upstream that mismarked a
 * LINK_ONLY entry cannot produce a request that quotes it (§0's boundary is
 * structural, not procedural — it has to hold even against this file's own
 * callers, not only against the model).
 */
export function buildDocumentBlocks(
  candidates: readonly AskCandidate[],
  fullTextIds: ReadonlySet<string>,
): AskDocumentBlock[] {
  const blocks = candidates.map((entry): AskDocumentBlock => {
    const anthropicFileId = entry.fullTextFile?.anthropicFileId ?? null;
    const full = fullTextIds.has(entry.id) && quotableFullText(entry) && anthropicFileId !== null;

    if (full && anthropicFileId) {
      return {
        type: 'document',
        source: { type: 'file', file_id: anthropicFileId },
        title: entry.titleOriginal,
        citations: { enabled: true },
      };
    }
    return {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: abstractDocumentText(entry) },
      title: entry.titleOriginal,
      citations: { enabled: true },
    };
  });

  // §3.1/§5: the last document block is the caching prefix's end — this is
  // the one placement that pays off for "Ask this paper", where a reader's
  // follow-up questions about the same entry share the same document set.
  const last = blocks.at(-1);
  if (last) last.cache_control = { type: 'ephemeral' };

  return blocks;
}

/**
 * §3.2 — the part instructions *can* do. Deliberately not where §0's
 * boundary lives; that boundary is structural (above) and this is
 * best-effort behaviour, kept visibly separate so the two are never read as
 * one list of equally-binding rules.
 */
export function buildAskSystemPrompt(locale: AskLocale): string {
  const languageLine =
    locale === 'fa'
      ? 'Answer in Persian — the reader’s own language — regardless of what language the question or the source documents are written in.'
      : 'Answer in English — the reader’s own language — regardless of what language the question or the source documents are written in.';

  return [
    'You are the Research Lab’s agent for Root (ریشه), a bilingual Persian/English research library.',
    'Answer only from the documents supplied in this request. If they do not contain the answer, say so plainly rather than inventing one — a research corpus’s agent inventing an answer is the failure that discredits the whole Library.',
    languageLine,
    'Cite entry titles exactly as given, in their own script — never transliterate them.',
  ].join('\n\n');
}

export function buildAskMessages(
  question: string,
  documentBlocks: readonly AskDocumentBlock[],
): Anthropic.Beta.Messages.BetaMessageParam[] {
  // §3.1: document blocks precede the question — also the right order for
  // the cache breakpoint above, since the question is what varies per call.
  return [{ role: 'user', content: [...documentBlocks, { type: 'text', text: question }] }];
}

export type AskCitation = {
  citedText: string;
  documentIndex: number;
  documentTitle: string | null;
};

/**
 * T4 — the response is several `text` blocks once citations are on, and
 * `content[0].text` shows the reader the first fragment and drops the rest.
 * Walks every block, concatenating text and collecting every citation in
 * the order the model produced them.
 */
export function extractAnswer(content: readonly Anthropic.Beta.Messages.BetaContentBlock[]): {
  text: string;
  citations: AskCitation[];
} {
  let text = '';
  const citations: AskCitation[] = [];
  for (const block of content) {
    if (block.type !== 'text') continue;
    text += block.text;
    for (const citation of block.citations ?? []) {
      // The corpus is sent as `document` blocks only (no web search, no
      // search-result tool), so every citation this feature ever produces
      // is one of these two location kinds — narrowed explicitly because
      // `BetaTextCitation` is a union shared with tools this route never
      // uses, and only these two carry `document_index`.
      if (citation.type !== 'char_location' && citation.type !== 'page_location') continue;
      citations.push({
        citedText: citation.cited_text,
        documentIndex: citation.document_index,
        documentTitle: citation.document_title,
      });
    }
  }
  return { text, citations };
}

/**
 * Uploads a hosted PDF to the Files API the first time a quotable entry is
 * asked about, and never again (R4.md §2.3: "upload once, store the
 * `file_id` on the entry, reuse forever"). `deps` is dependency-injected —
 * same reasoning as `publishRound.ts`'s `readFile` parameter — so the
 * integration suite can prove the upload-once behaviour and the LINK_ONLY
 * boundary without a live API or real bytes on disk.
 */
export type EnsureAnthropicFileDeps = {
  upload: (file: { data: Readable | Buffer; filename: string; mime: string }) => Promise<string>;
  persist: (storedFileId: string, anthropicFileId: string) => Promise<void>;
  read: (key: string) => Readable;
};

export async function ensureAnthropicFileId(
  file: AskCandidateFile,
  deps: EnsureAnthropicFileDeps,
): Promise<string> {
  if (file.anthropicFileId) return file.anthropicFileId;
  const anthropicFileId = await deps.upload({
    data: deps.read(file.key),
    filename: file.originalName,
    mime: file.mime,
  });
  await deps.persist(file.id, anthropicFileId);
  return anthropicFileId;
}
