import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calendarDate } from './format.js';
import { STEP_KINDS, attentionText, captionFor, defaultStep, nextUp, pillMissing, pillState, sameStep, showBuildTimeline, stepFromParams, stepLabel, stepLink, timelineText } from './wizard.js';
import type { AttentionItem, TimelineItem, WizardStep } from './queries.js';

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '../i18n/locales');
const messages = (lang: 'fa' | 'en'): Record<string, unknown> =>
  JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8'));

/** A `t` over the real locale file, with i18next's `{{var}}` and `_one`/`_other` behaviour. */
function translator(lang: 'fa' | 'en') {
  const flat: Record<string, string> = {};
  const walk = (o: unknown, prefix: string) => {
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
    else flat[prefix] = String(o);
  };
  walk(messages(lang), '');
  return (key: string, options: Record<string, unknown> = {}) => {
    const count = typeof options.count === 'number' ? options.count : null;
    const template = (count !== null && (flat[`${key}_${count === 1 ? 'one' : 'other'}`] ?? flat[`${key}_other`])) || flat[key];
    if (template === undefined) return `«${key}»`;
    return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? ''));
  };
}

const step = (over: Partial<WizardStep> = {}): WizardStep => ({
  step: 'REQUIREMENTS',
  phaseId: null,
  phaseNumber: null,
  status: 'UPCOMING',
  locked: false,
  lockedAt: null,
  takesInput: true,
  iterationsUsed: null,
  allowance: null,
  finishedAt: null,
  ...over,
});

test('stepLabel: every step has a name in both languages; a demo names its phase in the reader’s digits', () => {
  for (const lang of ['fa', 'en'] as const) {
    const t = translator(lang);
    for (const kind of STEP_KINDS) {
      assert.doesNotMatch(stepLabel(t, lang, { step: kind }), /^«/, `${lang} ${kind}`);
    }
  }
  assert.equal(stepLabel(translator('en'), 'en', { step: 'DEMO', phaseNumber: 2 }), 'Demo · phase 2');
  assert.equal(stepLabel(translator('fa'), 'fa', { step: 'DEMO', phaseNumber: 2 }), 'دمو · فاز ۲');
  // A demo with no phase yet is just the demo.
  assert.equal(stepLabel(translator('en'), 'en', { step: 'DEMO', phaseNumber: null }), 'Demo');
});

test('sameStep and defaultStep: a demo is one place per phase; the wizard opens on the current step', () => {
  assert.equal(sameStep({ step: 'DEMO', phaseId: 'a' }, { step: 'DEMO', phaseId: 'a' }), true);
  assert.equal(sameStep({ step: 'DEMO', phaseId: 'a' }, { step: 'DEMO', phaseId: 'b' }), false);
  assert.equal(sameStep(null, { step: 'DEMO', phaseId: 'b' }), false);
  const wizard = [step({ status: 'DONE' }), step({ step: 'SCOPE', status: 'CURRENT' }), step({ step: 'DRAFT' })];
  assert.equal(defaultStep(wizard)!.step, 'SCOPE');
  assert.equal(defaultStep(wizard.map((s) => ({ ...s, status: 'DONE' as const })))!.step, 'REQUIREMENTS');
  assert.equal(defaultStep([]), null);
});

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  kind: 'ROUND_PUBLISHED',
  variant: 'default',
  contractId: 'c',
  phaseId: null,
  waitingOn: 'CUSTOMER',
  role: null,
  since: '2026-09-20T00:00:00.000Z',
  params: [],
  ...over,
});

test('attentionText: counts select the plural form and print the reader’s digits; versions stay Latin', () => {
  const round = item({ params: [{ key: 'count', value: '3' }] });
  assert.equal(attentionText(translator('en'), 'en', round, 'customer'), 'The design changed — 3 pages are waiting for your approval.');
  assert.equal(attentionText(translator('en'), 'en', item({ params: [{ key: 'count', value: '1' }] }), 'customer'), 'The design changed — 1 page is waiting for your approval.');
  assert.match(attentionText(translator('fa'), 'fa', round, 'customer'), /۳ صفحه/);

  const draft = item({ kind: 'DRAFT_TO_REVIEW', variant: 'contract', params: [{ key: 'fromVersion', value: '1' }, { key: 'toVersion', value: '2' }] });
  assert.match(attentionText(translator('fa'), 'fa', draft, 'customer'), /v2/);
});

test('attentionText: the reader’s audience picks the sentence, and a bilingual title is picked for the language', () => {
  const late = item({
    kind: 'COMMITMENT_OVERDUE',
    variant: 'customer',
    params: [{ key: 'titleFa', value: 'ارسال محتوا' }, { key: 'titleEn', value: 'Send the copy' }],
  });
  assert.equal(attentionText(translator('en'), 'en', late, 'customer'), '“Send the copy” is past its due date and has not been confirmed.');
  assert.equal(attentionText(translator('en'), 'en', late, 'staff'), 'The customer is late on “Send the copy”.');
  assert.match(attentionText(translator('fa'), 'fa', late, 'staff'), /ارسال محتوا/);
});

test('attentionText (J12): a phase number is in the reader’s digits, a due day is the calendar day it is, an invoice number stays Latin', () => {
  const demo = { kind: 'DEMO_READY_TO_APPROVE', variant: 'default', params: [{ key: 'phase', value: '2' }, { key: 'step', value: 'DEMO' }] };
  assert.equal(attentionText(translator('en'), 'en', demo, 'customer'), 'The demo for phase 2 is ready — try it, leave comments, or approve it.');
  assert.match(attentionText(translator('fa'), 'fa', demo, 'customer'), /دموی فاز ۲ آماده است/);

  const due = { kind: 'INVOICE_DUE', variant: 'default', params: [{ key: 'invoiceId', value: 'x' }, { key: 'number', value: 'INV-000001' }, { key: 'dueAt', value: '2026-10-11' }] };
  assert.equal(attentionText(translator('en'), 'en', due, 'customer'), `Invoice INV-000001 is due on ${calendarDate('2026-10-11', 'en')}.`);
  const fa = attentionText(translator('fa'), 'fa', due, 'customer');
  assert.ok(fa.includes('INV-000001') && fa.includes(calendarDate('2026-10-11', 'fa')), fa);
});

test('attentionText (J12): every new kind has a sentence for the audience the API gives it, in both languages', () => {
  const rows: Array<[string, string, 'customer' | 'staff']> = [
    ['STEP_WAITING', 'DESIGN', 'customer'],
    ['STEP_WAITING', 'MOCKUP', 'staff'],
    ['STEP_WAITING', 'DEMO', 'staff'],
    ['ITERATION_PUBLISHED', 'default', 'customer'],
    ['DEMO_READY_TO_APPROVE', 'default', 'staff'],
    ['DEMO_NOT_READY', 'default', 'staff'],
    ['INVOICE_DUE', 'default', 'customer'],
    ['INVOICE_ISSUABLE', 'default', 'staff'],
    ['REQUEST_MESSAGE', 'reply', 'customer'],
    ['REQUEST_MESSAGE', 'sent', 'customer'],
    ['REQUEST_MESSAGE', 'unanswered', 'staff'],
    ['TICKET_REPLY', 'reply', 'customer'],
    ['TICKET_REPLY', 'open', 'customer'],
    ['TICKET_REPLY', 'unanswered', 'staff'],
  ];
  for (const lang of ['en', 'fa'] as const) {
    for (const [kind, variant, audience] of rows) {
      const text = attentionText(translator(lang), lang, { kind, variant, params: [{ key: 'count', value: '2' }, { key: 'phase', value: '1' }, { key: 'title', value: 'T' }, { key: 'subject', value: 'S' }] }, audience);
      assert.doesNotMatch(text, /^«/, `${lang} ${kind}/${variant}/${audience}`);
    }
  }
});

test('timelineText: a step approval names the step; a revision names its version', () => {
  const at = '2026-09-20T00:00:00.000Z';
  const t = translator('en');
  const approved: TimelineItem = { id: 'a', at, kind: 'STEP_APPROVED', by: 'ROOT', step: 'DEMO', phaseNumber: 2, number: null };
  assert.equal(timelineText(t, 'en', approved), 'Demo · phase 2 approved');
  const published: TimelineItem = { id: 'r', at, kind: 'REVISION_PUBLISHED', by: 'ROOT', step: null, phaseNumber: null, number: 3 };
  assert.equal(timelineText(t, 'en', published), 'Contract text v3 published');
});

test('captionFor: the desk list’s line — nothing when the road is finished', () => {
  const t = translator('en');
  assert.equal(
    captionFor(t, 'en', { currentStep: 'DESIGN', currentPhaseNumber: null, nextMoveOn: 'CUSTOMER' }),
    'Design · waiting on the customer',
  );
  assert.equal(captionFor(t, 'en', { currentStep: null, currentPhaseNumber: null, nextMoveOn: null }), null);
});

test('calendarDate renders the stored day in UTC, whatever the machine’s zone', () => {
  // A `date` column arrives at midnight UTC. Formatted in a zone west of
  // Greenwich the same instant would be the day before; UTC keeps the day.
  const original = process.env.TZ;
  try {
    for (const tz of ['America/Los_Angeles', 'Asia/Tehran', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      assert.equal(calendarDate('2026-10-01T00:00:00.000Z', 'en'), 'Oct 1, 2026', tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('showBuildTimeline (J10): from the design’s approval until the summary closes — and not before there is anything to show', () => {
  const road = (...states: Array<[WizardStep['step'], WizardStep['status']]>) => states.map(([stepName, status]) => step({ step: stepName, status }));
  const entries = [{}];
  const custom = road(['REQUIREMENTS', 'DONE'], ['AGREEMENT', 'DONE'], ['DESIGN', 'DONE'], ['MOCKUP', 'DONE'], ['DEMO', 'CURRENT'], ['DEMO', 'UPCOMING'], ['SUMMARY', 'UPCOMING']);
  assert.equal(showBuildTimeline(custom, entries), true, 'design and mockup approved, no demo yet');
  assert.equal(showBuildTimeline(road(['REQUIREMENTS', 'DONE'], ['DESIGN', 'DONE'], ['MOCKUP', 'CURRENT'], ['DEMO', 'UPCOMING']), entries), false, 'the mockup is still being reviewed');
  assert.equal(showBuildTimeline(road(['REQUIREMENTS', 'DONE'], ['DESIGN', 'CURRENT'], ['DEMO', 'UPCOMING']), entries), false, 'the design is not approved yet');
  assert.equal(showBuildTimeline(road(['REQUIREMENTS', 'DONE'], ['DESIGN', 'DONE'], ['DEMO', 'CURRENT'], ['SUMMARY', 'UPCOMING']), entries), true, 'the pre-made road has no mockup');
  assert.equal(showBuildTimeline(custom, []), false, 'no phases, nothing to show');
  assert.equal(showBuildTimeline(road(['DESIGN', 'DONE'], ['DEMO', 'DONE'], ['SUMMARY', 'DONE']), entries), false, 'delivered');
  assert.equal(showBuildTimeline(road(['DESIGN', 'DONE'], ['SUMMARY', 'UPCOMING']), entries), false, 'a road with no demo step');
});

test('pillState: done and upcoming are what they say; the current step says whose move it is, from the API’s own answer', () => {
  assert.equal(pillState({ status: 'DONE' }, 'ROOT'), 'DONE');
  assert.equal(pillState({ status: 'UPCOMING' }, 'CUSTOMER'), 'UPCOMING');
  assert.equal(pillState({ status: 'CURRENT' }, 'CUSTOMER'), 'WAITING_CUSTOMER');
  assert.equal(pillState({ status: 'CURRENT' }, 'ROOT'), 'YOUR_TURN');
  assert.equal(pillState({ status: 'CURRENT' }, null), 'CURRENT');
  assert.equal(pillState({ status: 'CURRENT' }, undefined), 'CURRENT');
});

test('pillMissing: only Requirements counts, only while it is not done, and a zero is no count at all', () => {
  assert.equal(pillMissing({ step: 'REQUIREMENTS', status: 'CURRENT' }, 2), 2);
  assert.equal(pillMissing({ step: 'REQUIREMENTS', status: 'UPCOMING' }, 1), 1);
  assert.equal(pillMissing({ step: 'REQUIREMENTS', status: 'CURRENT' }, 0), null);
  assert.equal(pillMissing({ step: 'REQUIREMENTS', status: 'CURRENT' }, undefined), null);
  assert.equal(pillMissing({ step: 'REQUIREMENTS', status: 'DONE' }, 3), null);
  assert.equal(pillMissing({ step: 'SCOPE', status: 'CURRENT' }, 3), null);
  // DX2a: Phases and payment counts its own list, not the brief's.
  assert.equal(pillMissing({ step: 'PHASES', status: 'CURRENT' }, 3, 2), 2);
  assert.equal(pillMissing({ step: 'PHASES', status: 'UPCOMING' }, 3, 0), null);
  assert.equal(pillMissing({ step: 'PHASES', status: 'DONE' }, 3, 2), null);
  assert.equal(pillMissing({ step: 'PHASES', status: 'CURRENT' }, 3), null);
});

const aItem = (waitingOn: 'ROOT' | 'CUSTOMER', kind = 'X'): AttentionItem =>
  ({ kind, variant: 'v', contractId: 'c1', phaseId: null, waitingOn, role: null, since: '2026-11-01T00:00:00.000Z', params: [] });

test('nextUp: the API’s step and whose move it is, with the first attention item of that side — and nothing once the road is done', () => {
  const summary = { currentStep: 'DRAFT' as const, currentPhaseId: null, currentPhaseNumber: null, nextMoveOn: 'ROOT' as const };
  const n = nextUp(summary, [aItem('CUSTOMER', 'A'), aItem('ROOT', 'B'), aItem('ROOT', 'C')])!;
  assert.deepEqual([n.who, n.step, n.attention?.kind], ['ROOT', 'DRAFT', 'B']);
  assert.equal(nextUp({ ...summary, nextMoveOn: 'CUSTOMER' }, [aItem('ROOT')])!.attention, null, 'no item on that side: the line names the step');
  assert.equal(nextUp({ ...summary, nextMoveOn: null }, [aItem('ROOT')])!.attention, null);
  assert.equal(nextUp({ ...summary, currentStep: null }, []), null);
});

test('stepLink names the step, and a demo’s phase; stepFromParams reads it back', () => {
  const wizard = [
    { step: 'REQUIREMENTS', phaseId: null },
    { step: 'DEMO', phaseId: 'p1' },
    { step: 'DEMO', phaseId: 'p2' },
  ] as WizardStep[];
  assert.equal(stepLink('c1', { step: 'DRAFT', phaseId: null }), '/desk/contracts/c1/steps?step=DRAFT');
  const url = new URL(`http://x${stepLink('c1', { step: 'DEMO', phaseId: 'p2' })}`);
  assert.equal(stepFromParams(wizard, url.searchParams), wizard[2]);
});
