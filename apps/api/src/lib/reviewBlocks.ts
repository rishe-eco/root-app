import type { Block } from './revision.js';

/**
 * The Review Room's block splitter (C1.md §2) — the decision C2 depends on.
 * Rendered HTML shifts when the renderer changes, and a single raw string
 * needs the renderer to hand back source offsets to anchor into; an ordered
 * list of small, typed blocks needs neither. This is deliberately a
 * hand-rolled line classifier, not a full CommonMark parser: it only has to
 * bucket source into coarse, stable chunks — the per-block markdown-to-HTML
 * rendering (a real parser) happens later, in the reading UI, from each
 * block's own `text`.
 *
 * Used by both `prisma/publish-round.ts` (the CLI, which actually splits a
 * document) and the unit tests. The resolver never calls this — it receives
 * already-split blocks and only validates their shape (T1: one function, one
 * caller for splitting; the server is not a second implementation of it).
 */

const HEADING_RE = /^(#{1,6})\s+/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^\s*([-*+]|\d+[.)])\s+/;
const QUOTE_RE = /^\s*>/;
const TABLE_ROW_RE = /^\s*\|/;

export function splitBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let n = 0;
  let i = 0;

  const push = (kind: Block['kind'], text: string, depth?: number) => {
    n += 1;
    blocks.push(depth === undefined ? { id: `b${n}`, kind, text } : { id: `b${n}`, kind, text, depth });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      push('HEADING', line, heading[1].length);
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1][0];
      const closes = new RegExp(`^${marker}{3,}\\s*$`);
      const start = i;
      i += 1;
      // Consume through the matching close fence, or to EOF for an unclosed
      // block — an unterminated fence is still one code block, not a
      // paragraph wearing three backticks.
      while (i < lines.length && !closes.test(lines[i])) i += 1;
      if (i < lines.length) i += 1;
      push('CODE', lines.slice(start, i).join('\n'));
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const start = i;
      while (i < lines.length && lines[i].trim() !== '' && QUOTE_RE.test(lines[i])) i += 1;
      push('QUOTE', lines.slice(start, i).join('\n'));
      continue;
    }

    if (TABLE_ROW_RE.test(line)) {
      const start = i;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) i += 1;
      push('TABLE', lines.slice(start, i).join('\n'));
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const start = i;
      // A list item's continuation lines are indented, non-blank, and not
      // the start of some other block — consumed into the same item.
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        (LIST_ITEM_RE.test(lines[i]) || /^\s+\S/.test(lines[i]))
      ) {
        i += 1;
      }
      push('LIST', lines.slice(start, i).join('\n'));
      continue;
    }

    // Paragraph: consecutive plain lines, stopping at a blank line or the
    // start of any other block kind — a document that is one long paragraph
    // never hits any of those and becomes exactly one block.
    const start = i;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !HEADING_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !TABLE_ROW_RE.test(lines[i]) &&
      !LIST_ITEM_RE.test(lines[i])
    ) {
      i += 1;
    }
    push('PARAGRAPH', lines.slice(start, i).join('\n'));
  }

  return blocks;
}

/**
 * A path the way the manifest may name one: relative, inside the repo, no
 * traversal. `git show <sha>:<path>` will happily resolve `../../etc/passwd`
 * against the wrong tree without complaint (C1.md §3.1) — this refuses it
 * before a shell ever sees it. Used by both the CLI and the mutation, which
 * revalidates rather than trusts what the CLI already checked.
 */
export function isSafeRepoPath(path: string): boolean {
  if (!path || path.trim() === '') return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[/\\]/.test(path)) return false; // a Windows-style absolute path
  const segments = path.split(/[/\\]/);
  return segments.every((seg) => seg !== '..' && seg !== '.');
}

/**
 * A round names an immutable commit, not "whatever main was" (C1.md §3) — a
 * branch name or `HEAD` is a symbolic ref and is refused; only a full 40-hex
 * commit sha is accepted.
 */
export function isFullCommitSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/i.test(sha);
}
