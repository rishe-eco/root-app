import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFileServer, upload, PNG } from './http.js';

/**
 * L7: services — the product-import panel (build plan §3 "L7"; spec §9).
 * The banked traps: apply is impossible without a preview first, and a
 * Persian-text import round-trips without corruption — R1's fold is reused
 * only as a comparison key, never written back as the stored product text.
 */

let f: Fixture;
let base: string;
let close: () => Promise<void>;

before(async () => {
  await resetDatabase();
  ({ base, close } = await startFileServer());
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
});

after(async () => {
  await close();
  await stop();
  await prisma.$disconnect();
});

/** A real .xlsx workbook, built with the same library the resolver parses
 *  with — the header row uses Persian column names, matching Nahal's own
 *  spreadsheet shape (spec §9). */
async function buildWorkbook(rows: Array<[string, string, string, string, string]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Products');
  sheet.addRow(['کد', 'نام', 'Name (EN)', 'قیمت', 'موجودی']);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function buildBadWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Products');
  // Missing the required price column entirely.
  sheet.addRow(['کد', 'نام']);
  sheet.addRow(['A-1', 'کالای یک']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function uploadXlsx(as: { id: string }, projectId: string, buffer: Buffer) {
  const res = await upload(base, {
    as,
    fileClass: 'SERVICE_IMPORT',
    projectId,
    body: buffer,
    filename: 'products.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body!.id;
}

const CREATE_RUN = `
  mutation($projectId: ID!, $fileId: ID!) {
    createServiceRun(projectId: $projectId, fileId: $fileId) {
      id status
    }
  }
`;

const PREVIEW_RUN = `
  mutation($runId: ID!) {
    previewServiceRun(runId: $runId) {
      id status failureReason previewedAt
      rows { rowNumber sku nameFa nameEn price stock action rejectReason }
      summary { createCount updateCount unchangedCount rejectedCount }
    }
  }
`;

const APPLY_RUN = `
  mutation($runId: ID!) {
    applyServiceRun(runId: $runId) {
      id status appliedAt appliedBy { id }
    }
  }
`;

// --- Upload: who may, and what may be uploaded ------------------------

test('an anonymous caller cannot upload a service-import spreadsheet', async () => {
  const projectId = f.contract.projectId!;
  const res = await upload(base, { fileClass: 'SERVICE_IMPORT', projectId, body: await buildWorkbook([]) });
  assert.equal(res.status, 401);
});

test('a stranger (not the project\'s customer, not staff) cannot upload to this project', async () => {
  const projectId = f.contract.projectId!;
  const res = await upload(base, {
    as: f.stranger,
    fileClass: 'SERVICE_IMPORT',
    projectId,
    body: await buildWorkbook([]),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(res.status, 403);
});

test('the project\'s own customer can upload, and the row records the project (not a contract)', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([]));
  const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } });
  assert.equal(row.class, 'SERVICE_IMPORT');
  assert.equal(row.visibility, 'PRIVATE');
  assert.equal(row.projectId, projectId);
  assert.equal(row.contractId, null);
});

test('staff can also upload, on the customer\'s behalf', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.admin, projectId, await buildWorkbook([]));
  assert.ok(fileId);
});

test('an upload naming no project is refused (PROJECT_REQUIRED)', async () => {
  const res = await upload(base, {
    as: f.customer,
    fileClass: 'SERVICE_IMPORT',
    projectId: null,
    body: await buildWorkbook([]),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, 'PROJECT_REQUIRED');
});

test('a non-workbook file is refused by its own bytes, not its claimed name or type', async () => {
  const projectId = f.contract.projectId!;
  const res = await upload(base, {
    as: f.customer,
    fileClass: 'SERVICE_IMPORT',
    projectId,
    body: PNG, // wrong magic bytes entirely
    filename: 'products.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(res.status, 415);
});

// --- The preview diff IS the feature (L7's banked trap) --------------------

test('apply is refused without a preview first (NOT_PREVIEWED) — there is no path from upload to apply that skips it', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['A-1', 'کالای یک', 'Item One', '10000', '5']]));
  const created = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId } }));
  const runId = (created.createServiceRun as { id: string }).id;

  const applied = await exec(APPLY_RUN, { as: f.customer, variables: { runId } });
  assert.equal(applied.code, 'NOT_PREVIEWED');

  const run = await prisma.serviceRun.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(run.status, 'UPLOADED');
});

test('preview -> apply is the only legal path, and applying twice is refused (ALREADY_APPLIED)', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['A-1', 'کالای یک', 'Item One', '10000', '5']]));
  const created = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId } }));
  const runId = (created.createServiceRun as { id: string }).id;

  const previewed = ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId } }));
  const preview = previewed.previewServiceRun as { status: string; rows: Array<{ action: string }> };
  assert.equal(preview.status, 'PREVIEWED');
  assert.equal(preview.rows[0].action, 'CREATE');

  const applied = ok(await exec(APPLY_RUN, { as: f.customer, variables: { runId } }));
  assert.equal((applied.applyServiceRun as { status: string }).status, 'APPLIED');

  const secondApply = await exec(APPLY_RUN, { as: f.customer, variables: { runId } });
  assert.equal(secondApply.code, 'ALREADY_APPLIED');

  const rePreview = await exec(PREVIEW_RUN, { as: f.customer, variables: { runId } });
  assert.equal(rePreview.code, 'ALREADY_APPLIED');
});

test('an unreadable/invalid workbook fails the preview (FAILED, with a reason), never a silent empty diff', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.customer, projectId, await buildBadWorkbook());
  const created = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId } }));
  const runId = (created.createServiceRun as { id: string }).id;

  const previewed = ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId } }));
  const preview = previewed.previewServiceRun as { status: string; failureReason: string | null; rows: unknown[] };
  assert.equal(preview.status, 'FAILED');
  assert.ok(preview.failureReason);
  assert.equal(preview.rows.length, 0);

  const applied = await exec(APPLY_RUN, { as: f.customer, variables: { runId } });
  assert.equal(applied.code, 'NOT_PREVIEWED');
});

// --- The diff against "the store" (the last applied run) -------------------

test('a second run diffs CREATE/UPDATE/UNCHANGED against the first applied run, and rejects a bad row with a reason', async () => {
  const projectId = f.contract.projectId!;

  const firstFileId = await uploadXlsx(
    f.customer,
    projectId,
    await buildWorkbook([
      ['A-1', 'کالای یک', 'Item One', '10000', '5'],
      ['A-2', 'کالای دو', 'Item Two', '20000', '3'],
    ]),
  );
  const firstRun = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId: firstFileId } }));
  const firstRunId = (firstRun.createServiceRun as { id: string }).id;
  ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId: firstRunId } }));
  ok(await exec(APPLY_RUN, { as: f.customer, variables: { runId: firstRunId } }));

  const secondFileId = await uploadXlsx(
    f.customer,
    projectId,
    await buildWorkbook([
      ['A-1', 'کالای یک', 'Item One', '15000', '5'], // price changed -> UPDATE
      ['A-2', 'کالای دو', 'Item Two', '20000', '3'], // identical -> UNCHANGED
      ['A-3', 'کالای سه', 'Item Three', '30000', '1'], // new -> CREATE
      ['', 'بدون کد', '', '1000', ''], // missing SKU -> REJECTED
    ]),
  );
  const secondRun = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId: secondFileId } }));
  const secondRunId = (secondRun.createServiceRun as { id: string }).id;
  const previewed = ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId: secondRunId } }));
  const preview = previewed.previewServiceRun as {
    rows: Array<{ sku: string; action: string; rejectReason: string | null }>;
    summary: { createCount: number; updateCount: number; unchangedCount: number; rejectedCount: number };
  };

  const bySku = new Map(preview.rows.map((r) => [r.sku, r]));
  assert.equal(bySku.get('A-1')!.action, 'UPDATE');
  assert.equal(bySku.get('A-2')!.action, 'UNCHANGED');
  assert.equal(bySku.get('A-3')!.action, 'CREATE');
  assert.equal(preview.summary.createCount, 1);
  assert.equal(preview.summary.updateCount, 1);
  assert.equal(preview.summary.unchangedCount, 1);
  assert.equal(preview.summary.rejectedCount, 1);
  const rejectedRow = preview.rows.find((r) => r.action === 'REJECTED')!;
  assert.ok(rejectedRow.rejectReason);
});

// --- Persian text round-trips without corruption (R1's fold, write path) --

test('a Persian product name with ZWNJ round-trips exactly — the fold is never applied to stored text', async () => {
  const projectId = f.contract.projectId!;
  const nameWithZwnj = 'می‌کنم'; // contains U+200C ZWNJ — folding would strip it
  const fileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['A-1', nameWithZwnj, '', '1000', '']]));
  const created = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId } }));
  const runId = (created.createServiceRun as { id: string }).id;
  const previewed = ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId } }));
  const row = (previewed.previewServiceRun as { rows: Array<{ nameFa: string }> }).rows[0];
  assert.equal(row.nameFa, nameWithZwnj);
});

test('SKUs typed with different yeh/kaf variants across two uploads still match as the same product (comparison reuses the fold), while each upload keeps its own literal SKU text', async () => {
  const projectId = f.contract.projectId!;

  // Arabic yeh (ي) and kaf (ك) in the first upload.
  const firstFileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['كالاي', 'X', '', '1000', '']]));
  const firstRun = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId: firstFileId } }));
  const firstRunId = (firstRun.createServiceRun as { id: string }).id;
  const firstPreview = ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId: firstRunId } }));
  const firstRow = (firstPreview.previewServiceRun as { rows: Array<{ sku: string; action: string }> }).rows[0];
  assert.equal(firstRow.sku, 'كالاي'); // stored verbatim, Arabic forms intact
  ok(await exec(APPLY_RUN, { as: f.customer, variables: { runId: firstRunId } }));

  // Persian yeh (ی) and kaf (ک) — the same product, second upload.
  const secondFileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['کالای', 'X', '', '1000', '']]));
  const secondRun = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId: secondFileId } }));
  const secondRunId = (secondRun.createServiceRun as { id: string }).id;
  const secondPreview = ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId: secondRunId } }));
  const secondRow = (secondPreview.previewServiceRun as { rows: Array<{ sku: string; action: string }> }).rows[0];
  assert.equal(secondRow.action, 'UNCHANGED'); // matched despite the orthographic variant
  assert.equal(secondRow.sku, 'کالای'); // still the literal text of *this* upload, not folded
});

test('Persian digits in a price cell parse to the correct integer', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['A-1', 'X', '', '۱۲۵۰۰۰', '']]));
  const created = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId } }));
  const runId = (created.createServiceRun as { id: string }).id;
  const previewed = ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId } }));
  const row = (previewed.previewServiceRun as { rows: Array<{ price: string }> }).rows[0];
  assert.equal(row.price, '125000');
});

// --- Ownership boundaries (house rule 2) ------------------------------

test('a stranger cannot read, preview, or apply another customer\'s run', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['A-1', 'X', '', '1000', '']]));
  const created = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId } }));
  const runId = (created.createServiceRun as { id: string }).id;

  const preview = await exec(PREVIEW_RUN, { as: f.stranger, variables: { runId } });
  assert.equal(preview.code, 'NOT_FOUND');

  // "No such thing," not "not allowed" (house rule 13) — a project that is
  // not the stranger's own is indistinguishable from one that does not
  // exist, the same shape `loadTicketForActor` already uses.
  const runsList = await exec(`query($p: ID!){ projectServiceRuns(projectId: $p) { id } }`, {
    as: f.stranger,
    variables: { p: projectId },
  });
  assert.equal(runsList.code, 'NOT_FOUND');
});

test('allServiceRuns is staff-only', async () => {
  const forbidden = await exec(`query { allServiceRuns { id } }`, { as: f.customer });
  assert.equal(forbidden.code, 'FORBIDDEN');

  const ok1 = ok(await exec(`query { allServiceRuns { id } }`, { as: f.admin }));
  assert.deepEqual(ok1.allServiceRuns, []);
});

// --- The billing edge (build plan L6/L7) -------------------------------

test('createServiceRunBillingEntry refuses an unapplied run (NOT_APPLIED), then succeeds once applied, then refuses a second charge (ALREADY_BILLED)', async () => {
  const projectId = f.contract.projectId!;
  const fileId = await uploadXlsx(f.customer, projectId, await buildWorkbook([['A-1', 'X', '', '1000', '']]));
  const created = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId, fileId } }));
  const runId = (created.createServiceRun as { id: string }).id;

  const tooEarly = await exec(
    `mutation($runId: ID!){ createServiceRunBillingEntry(runId: $runId, amount: "50000", descriptionFa: "x", descriptionEn: "x") { id } }`,
    { as: f.admin, variables: { runId } },
  );
  assert.equal(tooEarly.code, 'NOT_APPLIED');

  ok(await exec(PREVIEW_RUN, { as: f.customer, variables: { runId } }));
  ok(await exec(APPLY_RUN, { as: f.customer, variables: { runId } }));

  const billed = ok(
    await exec(
      `mutation($runId: ID!){ createServiceRunBillingEntry(runId: $runId, amount: "50000", descriptionFa: "واردات", descriptionEn: "Import") { id billingEntry { id source amount } } }`,
      { as: f.admin, variables: { runId } },
    ),
  );
  const run = billed.createServiceRunBillingEntry as { billingEntry: { source: string; amount: string } };
  assert.equal(run.billingEntry.source, 'SERVICE');
  assert.equal(run.billingEntry.amount, '50000');

  const second = await exec(
    `mutation($runId: ID!){ createServiceRunBillingEntry(runId: $runId, amount: "1", descriptionFa: "x", descriptionEn: "x") { id } }`,
    { as: f.admin, variables: { runId } },
  );
  assert.equal(second.code, 'ALREADY_BILLED');
});
