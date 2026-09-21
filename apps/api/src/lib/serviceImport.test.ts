import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffImportRows, summarizeRows, type RawImportRow, type PreviousRow } from './serviceImport.js';

function row(partial: Partial<RawImportRow> & { rowNumber: number }): RawImportRow {
  return {
    sku: null,
    nameFa: null,
    nameEn: null,
    priceRaw: null,
    stockRaw: null,
    raw: {},
    ...partial,
  };
}

// --- CREATE / UPDATE / UNCHANGED --------------------------------------

test('a SKU absent from the previous run diffs as CREATE', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'کالای یک', priceRaw: '10000' })], []);
  assert.equal(rows[0].action, 'CREATE');
  assert.equal(rows[0].price, 10000n);
});

test('an identical row against the previous run diffs as UNCHANGED', () => {
  const previous: PreviousRow[] = [{ sku: 'A-1', nameFa: 'کالای یک', nameEn: null, price: 10000n, stock: null }];
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'کالای یک', priceRaw: '10000' })], previous);
  assert.equal(rows[0].action, 'UNCHANGED');
});

test('a changed price against the previous run diffs as UPDATE', () => {
  const previous: PreviousRow[] = [{ sku: 'A-1', nameFa: 'کالای یک', nameEn: null, price: 10000n, stock: null }];
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'کالای یک', priceRaw: '12000' })], previous);
  assert.equal(rows[0].action, 'UPDATE');
  assert.equal(rows[0].price, 12000n);
});

// --- REJECTED rows carry a reason (the schema's own CHECK, mirrored here) --

test('a missing SKU is REJECTED with a reason, never silently dropped', () => {
  const rows = diffImportRows([row({ rowNumber: 2, nameFa: 'X', priceRaw: '1' })], []);
  assert.equal(rows[0].action, 'REJECTED');
  assert.ok(rows[0].rejectReason);
});

test('a missing name is REJECTED with a reason', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', priceRaw: '1' })], []);
  assert.equal(rows[0].action, 'REJECTED');
  assert.ok(rows[0].rejectReason);
});

test('a non-numeric price is REJECTED, never coerced to a default', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'X', priceRaw: 'free' })], []);
  assert.equal(rows[0].action, 'REJECTED');
});

test('a float price is REJECTED — no float ever touches a stored charge-shaped value', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'X', priceRaw: '10.5' })], []);
  assert.equal(rows[0].action, 'REJECTED');
});

test('a non-numeric stock is REJECTED even though stock is otherwise optional', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'X', priceRaw: '1', stockRaw: 'many' })], []);
  assert.equal(rows[0].action, 'REJECTED');
});

test('a blank stock cell is legal — stock is optional, unlike price', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'X', priceRaw: '1' })], []);
  assert.equal(rows[0].action, 'CREATE');
  assert.equal(rows[0].stock, null);
});

test('a duplicate SKU within the same file rejects the second occurrence, not the first', () => {
  const rows = diffImportRows(
    [
      row({ rowNumber: 2, sku: 'A-1', nameFa: 'اول', priceRaw: '1' }),
      row({ rowNumber: 3, sku: 'A-1', nameFa: 'دوم', priceRaw: '2' }),
    ],
    [],
  );
  assert.equal(rows[0].action, 'CREATE');
  assert.equal(rows[1].action, 'REJECTED');
  assert.match(rows[1].rejectReason ?? '', /duplicate/i);
});

// --- The fold, reused for comparison only — never for storage -------------

test('SKUs differing only by Arabic vs Persian yeh/kaf match the previous run (comparison reuses the fold)', () => {
  // ي (Arabic yeh, U+064A) vs ی (Persian yeh, U+06CC) — the same product,
  // typed with different keyboards across two uploads.
  const previous: PreviousRow[] = [{ sku: 'کالای', nameFa: 'X', nameEn: null, price: 100n, stock: null }];
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'كالاي', nameFa: 'X', priceRaw: '100' })], previous);
  assert.equal(rows[0].action, 'UNCHANGED');
});

test('the stored SKU is the customer\'s own text, verbatim — the fold never rewrites what is stored', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'كالاي', nameFa: 'X', priceRaw: '100' })], []);
  // Stored exactly as uploaded (Arabic yeh, kept), never folded to the
  // Persian form and never lowercased — this is the loud half of the trap.
  assert.equal(rows[0].sku, 'كالاي');
});

test('Persian digits in a price cell are parsed correctly (digit-script fold is safe for numeric parsing)', () => {
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: 'X', priceRaw: '۱۲۵۰۰۰' })], []);
  assert.equal(rows[0].price, 125000n);
});

test('a stored Persian product name keeps its ZWNJ — folding it would corrupt the catalogue', () => {
  const nameWithZwnj = 'می‌کنم'; // contains U+200C ZWNJ
  const rows = diffImportRows([row({ rowNumber: 2, sku: 'A-1', nameFa: nameWithZwnj, priceRaw: '1' })], []);
  assert.equal(rows[0].nameFa, nameWithZwnj);
  assert.ok(rows[0].nameFa.includes('‌'));
});

// --- summarizeRows -----------------------------------------------------

test('summarizeRows accounts for every row exactly once', () => {
  const rows = diffImportRows(
    [
      row({ rowNumber: 2, sku: 'A-1', nameFa: 'X', priceRaw: '1' }), // CREATE
      row({ rowNumber: 3, sku: 'A-2', nameFa: 'Y', priceRaw: 'bad' }), // REJECTED
    ],
    [{ sku: 'A-3', nameFa: 'Z', nameEn: null, price: 5n, stock: null }],
  );
  const summary = summarizeRows(rows);
  assert.equal(summary.createCount, 1);
  assert.equal(summary.rejectedCount, 1);
  assert.equal(summary.updateCount + summary.unchangedCount, 0);
  assert.equal(summary.createCount + summary.updateCount + summary.unchangedCount + summary.rejectedCount, rows.length);
});
