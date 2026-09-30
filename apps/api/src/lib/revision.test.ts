import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAmendmentSnapshot,
  buildContractSnapshot,
  buildDocumentSnapshot,
  AGREEMENT_FORMAT,
  SNAPSHOT_FORMAT,
  buildAgreementSnapshot,
  isAgreementSnapshot,
  readContractSnapshot,
  type AgreementParts,
  canonicalize,
  contentHash,
  diffSnapshots,
  draftState,
  type Block,
} from './revision.js';

const article = (number: number, bodyFa: string | null = null) => ({
  number,
  titleFa: `ماده ${number}`,
  titleEn: `Article ${number}`,
  bodyFa,
  bodyEn: null,
});

test('canonicalize sorts object keys so build order cannot change the bytes', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('canonicalize sorts nested keys too', () => {
  assert.equal(canonicalize({ x: { d: 1, c: 2 } }), '{"x":{"c":2,"d":1}}');
});

test('canonicalize preserves array order — article order is the contract order', () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('a BigInt fee becomes a decimal string rather than throwing', () => {
  const snapshot = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt('180000000') },
    [],
  );
  assert.equal(snapshot.amount, '180000000');
  // The real regression this guards: JSON.stringify throws on BigInt, so a
  // snapshot that kept the raw value would blow up at the first publish.
  assert.doesNotThrow(() => contentHash(snapshot));
});

test('articles are ordered by number, not by the order they were passed', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const forward = buildContractSnapshot(contract, [article(1), article(2), article(3)]);
  const shuffled = buildContractSnapshot(contract, [article(3), article(1), article(2)]);
  assert.equal(contentHash(forward), contentHash(shuffled));
});

test('changing any article body changes the hash', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const before = buildContractSnapshot(contract, [article(1, 'اول')]);
  const after = buildContractSnapshot(contract, [article(1, 'دوم')]);
  assert.notEqual(contentHash(before), contentHash(after));
});

test('changing the fee changes the hash', () => {
  const articles = [article(1)];
  const a = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt(1) },
    articles,
  );
  const b = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt(2) },
    articles,
  );
  assert.notEqual(contentHash(a), contentHash(b));
});

// ---------------------------------------------------------------------------
// C1 — a document snapshot hashes the same way, over blocks alone
// ---------------------------------------------------------------------------

const block = (id: string, text: string, kind: Block['kind'] = 'PARAGRAPH'): Block => ({ id, kind, text });

test('buildDocumentSnapshot: contentHash is stable under re-serialization of the same blocks', () => {
  const blocks = [block('b1', 'Hello'), block('b2', 'World')];
  const first = contentHash(buildDocumentSnapshot(blocks));
  const second = contentHash(buildDocumentSnapshot(JSON.parse(JSON.stringify(blocks))));
  assert.equal(first, second);
});

test("buildDocumentSnapshot: changing a block's text changes the hash", () => {
  const before = contentHash(buildDocumentSnapshot([block('b1', 'Hello')]));
  const after = contentHash(buildDocumentSnapshot([block('b1', 'Hello there')]));
  assert.notEqual(before, after);
});

test('buildDocumentSnapshot: reordering blocks changes the hash — order is content, like article order', () => {
  const a = contentHash(buildDocumentSnapshot([block('b1', 'First'), block('b2', 'Second')]));
  const b = contentHash(buildDocumentSnapshot([block('b2', 'Second'), block('b1', 'First')]));
  assert.notEqual(a, b);
});

test('buildDocumentSnapshot: renaming the document (path/title) does not change the hash — it is not part of the snapshot', () => {
  // There is no path/title on DocumentSnapshot at all (C1.md: "sha256 over
  // the canonical serialization of blocks") — this test is really asserting
  // that fact by construction: two snapshots built from the same blocks
  // always hash equal, regardless of what the caller later stores beside them.
  const blocks = [block('b1', 'Same content')];
  assert.equal(contentHash(buildDocumentSnapshot(blocks)), contentHash(buildDocumentSnapshot(blocks)));
});

// ---------------------------------------------------------------------------
// L1 — Appendix 1 as a view of the registry's agreed set. The trap this
// guards: a published revision's snapshot must stay byte-identical whether or
// not the caller ever heard of scopeItems.
// ---------------------------------------------------------------------------

test('omitting scopeItems hashes identically to passing an empty array — the shape every pre-L1 call site produced', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const withoutArg = buildContractSnapshot(contract, [article(1)]);
  const withEmptyArray = buildContractSnapshot(contract, [article(1)], []);
  assert.equal(contentHash(withoutArg), contentHash(withEmptyArray));
});

test('a non-empty agreed scope set changes the hash — it is real content, not decoration', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const without = buildContractSnapshot(contract, [article(1)]);
  const withScope = buildContractSnapshot(contract, [article(1)], [
    { key: 'bilingual', labelFa: 'دوزبانه', labelEn: 'Bilingual' },
  ]);
  assert.notEqual(contentHash(without), contentHash(withScope));
});

test('scope item order is content, like article order', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const a = buildContractSnapshot(contract, [], [
    { key: 'a', labelFa: 'الف', labelEn: 'A' },
    { key: 'b', labelFa: 'ب', labelEn: 'B' },
  ]);
  const b = buildContractSnapshot(contract, [], [
    { key: 'b', labelFa: 'ب', labelEn: 'B' },
    { key: 'a', labelFa: 'الف', labelEn: 'A' },
  ]);
  assert.notEqual(contentHash(a), contentHash(b));
});

test('draftState without a fourth argument behaves exactly as it did before L1', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const { hash } = draftState(contract, [article(1)], null);
  const { dirty } = draftState(contract, [article(1)], { contentHash: hash });
  assert.equal(dirty, false);
});

test('draftState goes dirty when only the agreed scope set changes', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const before = draftState(contract, [article(1)], null, []);
  const current = { contentHash: before.hash };
  const after = draftState(contract, [article(1)], current, [
    { key: 'bilingual', labelFa: 'دوزبانه', labelEn: 'Bilingual' },
  ]);
  assert.equal(after.dirty, true);
});

test('the hash is sha256 hex', () => {
  const snapshot = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null },
    [],
  );
  assert.match(contentHash(snapshot), /^[0-9a-f]{64}$/);
});

test('draftState is dirty against a null current revision', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const { dirty } = draftState(contract, [article(1)], null);
  assert.equal(dirty, true);
});

test('draftState is dirty against an unsealed current revision', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  // A backfilled v1 has no contentHash yet — "no hash" must read as "dirty",
  // or the publish that would seal it can never be reached.
  const { dirty } = draftState(contract, [article(1)], { contentHash: null });
  assert.equal(dirty, true);
});

test('draftState is clean when the hash matches the current revision', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const articles = [article(1)];
  const { hash } = draftState(contract, articles, null);
  const { dirty } = draftState(contract, articles, { contentHash: hash });
  assert.equal(dirty, false);
});

test('draftState goes dirty after an article body changes, clean again once reverted', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const { hash: published } = draftState(contract, [article(1, 'اول')], null);
  const current = { contentHash: published };

  const edited = draftState(contract, [article(1, 'دوم')], current);
  assert.equal(edited.dirty, true);

  const revertedBack = draftState(contract, [article(1, 'اول')], current);
  assert.equal(revertedBack.dirty, false);
});

test('an amendment snapshot hashes the same regardless of key order', () => {
  // The same property already held for a contract snapshot — an amendment's
  // contentHash is NOT NULL and sealed at creation (V2.md §3.2), so this one
  // matters even more: nothing ever gets a second chance to seal it.
  const a = buildAmendmentSnapshot({
    ordinal: 1,
    titleFa: 'الحاقیه',
    titleEn: 'Amendment',
    bodyFa: 'متن',
    bodyEn: 'Body',
  });
  const b = {
    bodyEn: 'Body',
    titleEn: 'Amendment',
    ordinal: 1,
    bodyFa: 'متن',
    titleFa: 'الحاقیه',
  };
  assert.equal(contentHash(a), contentHash(buildAmendmentSnapshot(b)));
});

test('changing an amendment body changes its hash', () => {
  const base = { ordinal: 1, titleFa: 'ت', titleEn: 't', bodyFa: 'الف', bodyEn: 'a' };
  const before = buildAmendmentSnapshot(base);
  const after = buildAmendmentSnapshot({ ...base, bodyEn: 'b' });
  assert.notEqual(contentHash(before), contentHash(after));
});

test('diffSnapshots with a null before reports every article added, and the title/amount flags as changed', () => {
  const after = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt(1) },
    [article(1), article(2)],
  );
  const diff = diffSnapshots(null, after);
  assert.equal(diff.titleChanged, true);
  assert.equal(diff.amountChanged, true);
  assert.deepEqual(
    diff.articles.map((a) => a.kind),
    ['added', 'added'],
  );
});

test('diffSnapshots reports a changed body as changed and an identical article as unchanged', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const before = buildContractSnapshot(contract, [article(1, 'اول'), article(2, 'دوم')]);
  const after = buildContractSnapshot(contract, [article(1, 'ویرایش‌شده'), article(2, 'دوم')]);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.articles.find((a) => a.number === 1)?.kind, 'changed');
  assert.equal(diff.articles.find((a) => a.number === 2)?.kind, 'unchanged');
});

test('diffSnapshots reports an article present before and absent after as removed', () => {
  const contract = { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: null };
  const before = buildContractSnapshot(contract, [article(1), article(2)]);
  const after = buildContractSnapshot(contract, [article(1)]);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.articles.find((a) => a.number === 2)?.kind, 'removed');
});

test('diffSnapshots sets title/amount flags independently and leaves untouched articles unchanged', () => {
  const before = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt(1) },
    [article(1)],
  );
  const titleOnly = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'تغییر', titleEn: 't2', amount: BigInt(1) },
    [article(1)],
  );
  const amountOnly = buildContractSnapshot(
    { ref: 'RC-1', titleFa: 'ت', titleEn: 't', amount: BigInt(2) },
    [article(1)],
  );

  const titleDiff = diffSnapshots(before, titleOnly);
  assert.equal(titleDiff.titleChanged, true);
  assert.equal(titleDiff.amountChanged, false);
  assert.equal(titleDiff.articles[0].kind, 'unchanged');

  const amountDiff = diffSnapshots(before, amountOnly);
  assert.equal(amountDiff.titleChanged, false);
  assert.equal(amountDiff.amountChanged, true);
  assert.equal(amountDiff.articles[0].kind, 'unchanged');
});

// ---- J7 — format 1 is untouched; format 2 is by addition ---------------------------------

test('format 1 is byte-for-byte what it was before J7: a golden snapshot and its hash, recorded on main at a9cc4df', () => {
  const snapshot = buildContractSnapshot(
    { ref: 'RC-G-001', titleFa: 'قرارداد', titleEn: 'Contract', amount: 180000000n },
    [
      { number: 2, titleFa: 'ب', titleEn: 'B', bodyFa: 'متن', bodyEn: 'Body' },
      { number: 1, titleFa: 'الف', titleEn: 'A', bodyFa: null, bodyEn: null },
    ],
    [{ key: 'home', labelFa: 'خانه', labelEn: 'Home' }],
  );
  assert.equal(
    canonicalize(snapshot as never),
    '{"amount":"180000000","articles":[{"bodyEn":null,"bodyFa":null,"number":1,"titleEn":"A","titleFa":"الف"},{"bodyEn":"Body","bodyFa":"متن","number":2,"titleEn":"B","titleFa":"ب"}],"format":1,"ref":"RC-G-001","scopeItems":[{"key":"home","labelEn":"Home","labelFa":"خانه"}],"titleEn":"Contract","titleFa":"قرارداد"}',
  );
  assert.equal(contentHash(snapshot), '85eee05b03989e3c951bcc8743ea15c71de4c0249d54e14302e21fe71fdfa56d');
  assert.equal(snapshot.format, SNAPSHOT_FORMAT);
  // A row that merely *carries* a sensitive flag (a Prisma Article does) does not put it into format 1.
  const withFlag = buildContractSnapshot(
    { ref: 'RC-G-001', titleFa: 'قرارداد', titleEn: 'Contract', amount: 180000000n },
    [{ number: 1, titleFa: 'الف', titleEn: 'A', bodyFa: null, bodyEn: null, sensitive: true }],
  );
  assert.ok(!('sensitive' in withFlag.articles[0]));
});

const contract = { ref: 'RC-7', titleFa: 'ت', titleEn: 't', amount: 180n };
const parts = (over: Partial<AgreementParts> = {}): AgreementParts => ({
  brief: {
    kind: 'NEW_SITE',
    existingSiteUrl: null,
    templateType: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' },
    designTier: 'THEME_PICK',
    budgetCap: 150000000n,
    idealDeadline: null,
    hardDeadline: new Date('2026-10-23T00:00:00Z'),
    domainName: 'nahal.ir',
    domainProvidedBy: 'CUSTOMER',
    hostProvidedBy: 'ROOT',
    contentProvidedBy: 'CUSTOMER',
    supportMonths: 6,
    premadeRounds: 2,
    wireframeIterations: 2,
    mockupIterations: null,
    demoIterationsPerPhase: 2,
  },
  plan: {
    split: 'INSTALLMENTS',
    invoices: [
      { ordinal: 2, labelFa: 'ب', labelEn: 'B', amount: 80n, phaseId: null, paymentTermDays: 7 },
      { ordinal: 1, labelFa: 'الف', labelEn: 'A', amount: 100n, phaseId: 'p1', paymentTermDays: 0 },
    ],
  },
  phases: [
    { id: 'p2', number: 2, titleFa: 'دو', titleEn: 'Two', plannedEndAt: null, milestoneLabel: null },
    { id: 'p1', number: 1, titleFa: 'یک', titleEn: 'One', plannedEndAt: new Date('2026-11-10T00:00:00Z'), milestoneLabel: 'M1' },
  ],
  plannedStartAt: new Date('2026-10-12T00:00:00Z'),
  plannedEndAt: new Date('2026-12-20T00:00:00Z'),
  ...over,
});
const appendix = [{ key: 'home', labelFa: 'خانه', labelEn: 'Home', kind: 'PAGE' as const }];

test('format 2 keeps every format-1 key and adds steps 1 and 2, with money as strings and days as YYYY-MM-DD', () => {
  const s = buildContractSnapshot(contract, [article(1)], appendix, parts());
  assert.ok(isAgreementSnapshot(s));
  assert.equal(s.format, AGREEMENT_FORMAT);
  assert.deepEqual([s.ref, s.titleEn, s.amount], ['RC-7', 't', '180']);
  assert.deepEqual(s.brief?.budgetCap, '150000000');
  assert.deepEqual([s.brief?.hardDeadline, s.brief?.idealDeadline], ['2026-10-23', null]);
  assert.deepEqual(s.brief?.templateType, { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' });
  assert.deepEqual(s.allowances, { premadeRounds: 2, wireframeIterations: 2, mockupIterations: null, demoIterationsPerPhase: 2 });
  assert.ok(!('premadeRounds' in (s.brief as object)), 'one copy of each allowance');
  assert.deepEqual([s.plannedStartAt, s.plannedEndAt], ['2026-10-12', '2026-12-20']);
  assert.deepEqual(s.scopeItems, appendix);
  assert.equal(s.articles[0].sensitive, false);
});

test('format 2 puts every array in a total order and every absent value at null — the same state hashes the same however it was handed over', () => {
  const a = buildContractSnapshot(contract, [article(2), article(1)], appendix, parts());
  const reversed = parts();
  reversed.phases = [...reversed.phases].reverse();
  reversed.plan!.invoices = [...reversed.plan!.invoices].reverse();
  const b = buildContractSnapshot(contract, [article(1), article(2)], appendix, reversed);
  assert.equal(contentHash(a), contentHash(b));
  assert.deepEqual((a as never as { phases: Array<{ number: number }> }).phases.map((p) => p.number), [1, 2]);
  assert.deepEqual((a as never as { paymentPlan: { invoices: Array<{ ordinal: number; phaseNumber: number | null }> } }).paymentPlan.invoices.map((i) => [i.ordinal, i.phaseNumber]), [[1, 1], [2, null]]);
  // Twice from the same inputs.
  assert.equal(contentHash(buildContractSnapshot(contract, [article(1)], appendix, parts())), contentHash(buildContractSnapshot(contract, [article(1)], appendix, parts())));
  // No undefined leaks into the bytes (canonicalize would drop or throw on one).
  const bare = buildContractSnapshot(contract, [article(1)], [], { brief: null, plan: null, phases: [], plannedStartAt: null, plannedEndAt: null });
  assert.doesNotThrow(() => canonicalize(bare as never));
  assert.deepEqual([(bare as never as Record<string, unknown>).brief, (bare as never as Record<string, unknown>).paymentPlan, (bare as never as Record<string, unknown>).allowances], [null, null, null]);
});

test('format 2 changes its hash for each thing it added, and only for what it added', () => {
  const base = contentHash(buildContractSnapshot(contract, [article(1)], appendix, parts()));
  const changed = (over: Partial<AgreementParts>) => contentHash(buildContractSnapshot(contract, [article(1)], appendix, parts(over)));
  assert.notEqual(changed({ plannedEndAt: new Date('2026-12-21T00:00:00Z') }), base);
  assert.notEqual(changed({ plannedStartAt: null }), base);
  assert.notEqual(changed({ phases: [{ id: 'p1', number: 1, titleFa: 'یک', titleEn: 'One', plannedEndAt: new Date('2026-11-11T00:00:00Z'), milestoneLabel: 'M1' }] }), base);
  const brief = { ...parts().brief!, supportMonths: 7 };
  assert.notEqual(changed({ brief }), base);
  assert.notEqual(changed({ brief: { ...parts().brief!, wireframeIterations: 3 } }), base, 'an allowance');
  const plan = parts().plan!;
  assert.notEqual(changed({ plan: { ...plan, invoices: plan.invoices.map((i) => ({ ...i, paymentTermDays: i.paymentTermDays + 1 })) } }), base);
  assert.equal(changed({}), base);
  // The plan is the approved *rows*: nothing in the input can carry issuance state, so it cannot enter the bytes.
  assert.ok(!JSON.stringify(buildContractSnapshot(contract, [article(1)], appendix, parts())).includes('issued'));
  // An appendix item without a kind is a caller’s bug, refused loudly rather than guessed into a group.
  assert.throws(() => buildContractSnapshot(contract, [], [{ key: 'x', labelFa: 'ا', labelEn: 'x' }], parts()), /needs one/);
});

test('draftState with an agreement is a format-2 draft: dirty when steps 1–2 move, clean against its own published hash', () => {
  const published = draftState(contract, [article(1)], null, appendix, parts());
  assert.equal(published.snapshot.format, AGREEMENT_FORMAT);
  assert.equal(draftState(contract, [article(1)], { contentHash: published.hash }, appendix, parts()).dirty, false);
  assert.equal(draftState(contract, [article(1)], { contentHash: published.hash }, appendix, parts({ plannedStartAt: null })).dirty, true);
  // A format-1 draft against a format-2 hash (or the reverse) is dirty: publishing would change the bytes.
  assert.equal(draftState(contract, [article(1)], { contentHash: published.hash }, appendix.map(({ key, labelFa, labelEn }) => ({ key, labelFa, labelEn }))).dirty, true);
});

test('readContractSnapshot reads formats 1 and 2 and nothing else', () => {
  const one = buildContractSnapshot(contract, [article(1)]);
  const two = buildContractSnapshot(contract, [article(1)], appendix, parts());
  assert.equal(readContractSnapshot(JSON.parse(JSON.stringify(one)))?.format, 1);
  assert.equal(readContractSnapshot(JSON.parse(JSON.stringify(two)))?.format, 2);
  assert.equal(readContractSnapshot({ ...one, format: 3 }), null);
  assert.equal(readContractSnapshot(null), null);
  assert.equal(readContractSnapshot([one]), null);
  // …and the stored JSON round-trips to the same hash — the property a signature relies on.
  assert.equal(contentHash(readContractSnapshot(JSON.parse(JSON.stringify(two)))!), contentHash(two));
  assert.equal(buildAgreementSnapshot(contract, [article(1)], appendix, parts()).format, 2);
});
