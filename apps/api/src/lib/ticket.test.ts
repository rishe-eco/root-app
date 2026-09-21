import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canChooseTicketType, briefPageFromTarget, compileAnnotation } from './ticket.js';

// --- canChooseTicketType (spec §5: admin requests are staff's own classification) -

test('canChooseTicketType: a customer may choose any of the original three, never ADMIN_REQUEST', () => {
  assert.equal(canChooseTicketType(false, 'CHANGE_REQUEST'), true);
  assert.equal(canChooseTicketType(false, 'BUG'), true);
  assert.equal(canChooseTicketType(false, 'QUESTION'), true);
  assert.equal(canChooseTicketType(false, 'ADMIN_REQUEST'), false);
});

test('canChooseTicketType: staff may choose any type, including ADMIN_REQUEST', () => {
  for (const type of ['CHANGE_REQUEST', 'BUG', 'QUESTION', 'ADMIN_REQUEST'] as const) {
    assert.equal(canChooseTicketType(true, type), true);
  }
});

// --- briefPageFromTarget (build plan L4: "carrying its page…") -------------

test('briefPageFromTarget: a demo-page target reads the page\'s own labels', () => {
  const result = briefPageFromTarget({ demoPage: { labelFa: 'خانه', labelEn: 'Home' }, frameLine: null });
  assert.deepEqual(result, { fa: 'خانه', en: 'Home' });
});

test('briefPageFromTarget: a frame-line target reads the line\'s own text', () => {
  const result = briefPageFromTarget({ demoPage: null, frameLine: { textFa: 'پیامک هنوز اضافه نشده', textEn: 'SMS not yet added' } });
  assert.deepEqual(result, { fa: 'پیامک هنوز اضافه نشده', en: 'SMS not yet added' });
});

// --- compileAnnotation (verbatim, oldest first) -----------------------------

test('compileAnnotation: joins comments verbatim, oldest first, with the author named', () => {
  const result = compileAnnotation([
    { author: { name: 'نهال' }, body: 'رنگ اشتباه است' },
    { author: { name: 'Root' }, body: 'بررسی می‌کنیم' },
  ]);
  assert.equal(result, 'نهال: رنگ اشتباه است\n\nRoot: بررسی می‌کنیم');
});

test('compileAnnotation: empty for no comments', () => {
  assert.equal(compileAnnotation([]), '');
});
