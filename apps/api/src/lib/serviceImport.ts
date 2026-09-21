/**
 * The product-import panel's own rules (spec §9; build plan L7) — parsing an
 * uploaded workbook, and the pure validate/diff logic the preview and the
 * apply step both read from a single source (house rule 3: one rule, one
 * file).
 *
 * ---------------------------------------------------------------------
 * **A loud note on R1's Persian fold, because the brief asked for exactly
 * this: reuse it, and say so loudly if it is wrong for this path rather
 * than quietly forking a second one.**
 *
 * `foldPersian` (lib/library.ts) is correct, and reused here, but only for
 * two narrow purposes — both purely *comparison*, never *storage*:
 *
 *   1. Matching an uploaded row's SKU against a previously-applied row's
 *      SKU, so "the same product, typed with a different yeh/kaf variant or
 *      digit script across two uploads" diffs as UPDATE/UNCHANGED rather
 *      than a spurious CREATE + a spurious REJECTED-duplicate.
 *   2. Normalizing the digit script inside a numeric cell (a price or a
 *      stock count) before it is parsed into an actual `bigint`/`number` —
 *      the *result* is a number, never text, so nothing about the fold's
 *      lossiness survives into what gets stored.
 *
 * **What this file does NOT do, on purpose, and what would go wrong if it
 * did:** it never writes a folded string back as `sku`/`nameFa`/`nameEn` on
 * a `ServiceRunRow`. `foldPersian` strips ZWNJ, harakat and tatweel, forces
 * Arabic yeh/kaf to their Persian forms, and lowercases the whole string —
 * every one of those is exactly right for *finding* a Library entry (R1's
 * own job) and exactly *wrong* for a product catalogue's own display text:
 *
 *   - **ZWNJ is not noise here.** Persian compounds like «می‌کنم» carry a
 *     zero-width non-joiner that changes how the word reads; R1 strips it
 *     because two spellings of the same searchable word should collide, but
 *     a product name that collides with itself after losing a ZWNJ is a
 *     product name silently rewritten wrong.
 *   - **A SKU is a machine key (house rule 14), and the fold lowercases.**
 *     `foldPersian("SKU-ABC")` is `"sku-abc"`. Folding it for a *comparison
 *     key* is fine — a case-insensitive SKU match is a reasonable thing to
 *     want — but writing the lowercased form back as the stored SKU would
 *     violate house rule 14 on the one column in this schema that is
 *     closest to a "ref" in the rule's own sense.
 *   - **Forcing Arabic yeh/kaf to Persian forms is a real orthographic
 *     rewrite**, not a normalization, for any text that is intentionally in
 *     Arabic script (a brand name, a loanword). R1 accepts that rewrite
 *     because search-matching benefits outweigh it for a *query*; a
 *     customer's own product name has no such trade to make.
 *
 * So: reused, not forked — and never on the write path. `sku`/`nameFa`/
 * `nameEn` on `ServiceRunRow` are the customer's own text, trimmed only.
 * ---------------------------------------------------------------------
 */

import ExcelJS from 'exceljs';
import { foldPersian } from './library.js';

type CanonicalField = 'sku' | 'nameFa' | 'nameEn' | 'price' | 'stock';

const REQUIRED_FIELDS: readonly CanonicalField[] = ['sku', 'nameFa', 'price'];

/** Header matching only — never applied to a cell's own data value. Strips
 *  whitespace/dashes on top of `foldPersian` so "کد محصول" and "کد-محصول"
 *  and "Product SKU" all resolve the same header, which `foldPersian` alone
 *  (it does not touch spaces) would not do. */
function normalizeHeader(text: string): string {
  return foldPersian(text).replace(/[\s_-]+/g, '');
}

const HEADER_ALIASES: Record<CanonicalField, string[]> = {
  sku: ['sku', 'کد', 'کدمحصول', 'کد محصول'].map(normalizeHeader),
  nameFa: ['namefa', 'نام', 'ناممحصول', 'نام محصول'].map(normalizeHeader),
  nameEn: ['nameen', 'name(en)', 'نامانگلیسی', 'نام انگلیسی'].map(normalizeHeader),
  price: ['price', 'قیمت'].map(normalizeHeader),
  stock: ['stock', 'موجودی', 'تعداد'].map(normalizeHeader),
};

export type RawImportRow = {
  rowNumber: number;
  sku: string | null;
  nameFa: string | null;
  nameEn: string | null;
  priceRaw: string | null;
  stockRaw: string | null;
  /** The row exactly as read, before any validation — kept for
   *  `ServiceRunRow.raw` regardless of what happens to the typed fields. */
  raw: Record<string, unknown>;
};

export type ParseResult = { ok: true; rows: RawImportRow[] } | { ok: false; error: string };

function cellToString(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const v = value as { text?: unknown; result?: unknown };
    if ('text' in v && v.text !== undefined) return String(v.text).trim();
    if ('result' in v && v.result !== undefined) return String(v.result).trim();
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Reads the first worksheet, matches its header row against
 * `HEADER_ALIASES` (Persian or English, either order), and returns every
 * data row below it. Never throws — an unreadable workbook or a missing
 * required column is a `{ ok: false }` result, which the resolver turns
 * into `ServiceRun.status = FAILED` with `failureReason` set, not an
 * unhandled exception.
 */
export async function parseWorkbook(buffer: Buffer): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    return { ok: false, error: 'The file could not be read as an Excel workbook.' };
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { ok: false, error: 'The workbook has no sheet.' };
  }

  const columnFor: Partial<Record<CanonicalField, number>> = {};
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const text = normalizeHeader(cellToString(cell.value) ?? '');
    for (const field of Object.keys(HEADER_ALIASES) as CanonicalField[]) {
      if (HEADER_ALIASES[field].includes(text)) columnFor[field] = colNumber;
    }
  });

  const missing = REQUIRED_FIELDS.filter((f) => !columnFor[f]);
  if (missing.length > 0) {
    return { ok: false, error: `Missing required column(s): ${missing.join(', ')}.` };
  }

  const rows: RawImportRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cellText = (col: number | undefined) => (col ? cellToString(row.getCell(col).value) : null);
    const raw: Record<string, unknown> = {};
    for (const field of Object.keys(columnFor) as CanonicalField[]) {
      raw[field] = cellText(columnFor[field]);
    }
    if (Object.values(raw).every((v) => v === null)) return; // a fully blank row is not a row

    rows.push({
      rowNumber,
      sku: cellText(columnFor.sku),
      nameFa: cellText(columnFor.nameFa),
      nameEn: cellText(columnFor.nameEn),
      priceRaw: cellText(columnFor.price),
      stockRaw: cellText(columnFor.stock),
      raw,
    });
  });

  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// The diff — pure, no ExcelJS, no Prisma. Both previewServiceRun (which
// calls this) and this file's own tests exercise it the same way.
// ---------------------------------------------------------------------------

export type ServiceRowActionLike = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'REJECTED';

export type PreviousRow = {
  sku: string;
  nameFa: string;
  nameEn: string | null;
  price: bigint | null;
  stock: number | null;
};

export type DiffRow = {
  rowNumber: number;
  sku: string;
  nameFa: string;
  nameEn: string | null;
  price: bigint | null;
  stock: number | null;
  action: ServiceRowActionLike;
  rejectReason: string | null;
  raw: Record<string, unknown>;
};

/** The comparison key (see this file's own top comment) — folded, exactly
 *  as far as R1's fold is reused, and never the stored value. */
function matchKey(sku: string): string {
  return foldPersian(sku.trim());
}

/** Digit-script normalization before parsing into a real `bigint` — see
 *  this file's own top comment for why this is a legitimate reuse of the
 *  fold, unlike folding a name. */
function parseTomanCell(raw: string | null): bigint | 'INVALID' {
  if (raw === null || raw.trim() === '') return 'INVALID';
  const folded = foldPersian(raw).replace(/[,\s]/g, '');
  if (!/^\d+$/.test(folded)) return 'INVALID';
  return BigInt(folded);
}

/** Same reasoning as `parseTomanCell`; stock is optional, so a blank cell is
 *  legal (null) while a non-numeric one is not. */
function parseOptionalCount(raw: string | null): number | null | 'INVALID' {
  if (raw === null || raw.trim() === '') return null;
  const folded = foldPersian(raw).replace(/[,\s]/g, '');
  if (!/^\d+$/.test(folded)) return 'INVALID';
  return Number(folded);
}

function rejected(row: RawImportRow, reason: string): DiffRow {
  return {
    rowNumber: row.rowNumber,
    sku: row.sku?.trim() ?? '',
    nameFa: row.nameFa?.trim() ?? '',
    nameEn: row.nameEn?.trim() || null,
    price: null,
    stock: null,
    action: 'REJECTED',
    rejectReason: reason,
    raw: row.raw,
  };
}

/**
 * Validates every parsed row and diffs it against "the store" — spec §9's
 * "preview diff against the store: rows to create, update, leave, plus
 * rejected rows with reasons." **"The store" here is the last *applied*
 * run's own rows**, not a live call to an external system: this codebase
 * has no target-store integration (WooCommerce or otherwise) — the plan's
 * own sequencing note says that mechanics are deliberately unspecified here
 * and belong to a stage grounded in the real customer's real store. Root's
 * own record of the last applied run is the honest, working "current state"
 * to diff against absent that integration, and it is what makes apply
 * meaningful: applying commits this run's rows as the new "last applied"
 * state the *next* run will diff against.
 *
 * Every row gets exactly one outcome — CREATE/UPDATE/UNCHANGED/REJECTED —
 * so a run's summary always accounts for every parsed row (no row is
 * silently dropped, matching this codebase's "a fate must never be silent"
 * precedent from L3b, applied here to rows instead of feedback items).
 */
export function diffImportRows(rawRows: readonly RawImportRow[], previousRows: readonly PreviousRow[]): DiffRow[] {
  const previousByKey = new Map(previousRows.map((r) => [matchKey(r.sku), r] as const));
  const seenKeys = new Set<string>();
  const results: DiffRow[] = [];

  for (const row of rawRows) {
    const sku = row.sku?.trim() ?? '';
    const nameFa = row.nameFa?.trim() ?? '';

    if (!sku) {
      results.push(rejected(row, 'Missing SKU.'));
      continue;
    }
    if (!nameFa) {
      results.push(rejected(row, 'Missing product name.'));
      continue;
    }

    const price = parseTomanCell(row.priceRaw);
    if (price === 'INVALID') {
      results.push(rejected(row, 'Price is missing or not a whole number.'));
      continue;
    }

    const stock = parseOptionalCount(row.stockRaw);
    if (stock === 'INVALID') {
      results.push(rejected(row, 'Stock is not a whole number.'));
      continue;
    }

    const key = matchKey(sku);
    if (seenKeys.has(key)) {
      results.push(rejected(row, 'Duplicate SKU within this file.'));
      continue;
    }
    seenKeys.add(key);

    const nameEn = row.nameEn?.trim() || null;
    const previous = previousByKey.get(key);

    let action: ServiceRowActionLike;
    if (!previous) {
      action = 'CREATE';
    } else if (previous.nameFa === nameFa && previous.nameEn === nameEn && previous.price === price && previous.stock === stock) {
      action = 'UNCHANGED';
    } else {
      action = 'UPDATE';
    }

    results.push({ rowNumber: row.rowNumber, sku, nameFa, nameEn, price, stock, action, rejectReason: null, raw: row.raw });
  }

  return results;
}

export type ServiceRunSummaryLike = {
  createCount: number;
  updateCount: number;
  unchangedCount: number;
  rejectedCount: number;
};

/** Derived, never stored (the same F5 discipline every other computed
 *  summary in this codebase holds to) — a run's own `rows` are the only
 *  source of truth. */
export function summarizeRows(rows: readonly { action: ServiceRowActionLike }[]): ServiceRunSummaryLike {
  return {
    createCount: rows.filter((r) => r.action === 'CREATE').length,
    updateCount: rows.filter((r) => r.action === 'UPDATE').length,
    unchangedCount: rows.filter((r) => r.action === 'UNCHANGED').length,
    rejectedCount: rows.filter((r) => r.action === 'REJECTED').length,
  };
}
