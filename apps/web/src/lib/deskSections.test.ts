import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESK_SECTIONS, canSeeSection, visibleSections } from '../desk/sections.js';
import type { Capability } from './access.js';

/**
 * A nav row can be gated on one capability or on *any of* a list (T1's
 * Templates: a designer keeps the types, sales the scope). The nav and the
 * section's own route guard both read `canSeeSection`, so this is the one
 * place their agreement is pinned.
 */

const holding = (...capabilities: Capability[]) => ({ capabilities });
const templates = DESK_SECTIONS.find((s) => s.key === 'templates')!;

test('templates is visible with either of its two capabilities, and with neither it is not', () => {
  assert.equal(canSeeSection(holding('templates.types'), templates), true);
  assert.equal(canSeeSection(holding('templates.scope'), templates), true);
  assert.equal(canSeeSection(holding('templates.types', 'templates.scope'), templates), true);
  assert.equal(canSeeSection(holding('contracts.author', 'builds.author', 'review.participate'), templates), false);
  assert.equal(canSeeSection(holding(), templates), false);
  assert.equal(canSeeSection(null, templates), false);
});

test('the nav offers exactly the rows canSeeSection accepts', () => {
  const me = holding('templates.scope', 'library.write');
  assert.deepEqual(
    visibleSections(me).map((s) => s.key),
    ['work', 'library', 'templates'],
  );
});

test('users (S3) is staff.manage and nothing else: no other capability, however broad, opens it', () => {
  const users = DESK_SECTIONS.find((s) => s.key === 'users')!;
  assert.equal(canSeeSection(holding('staff.manage'), users), true);
  assert.equal(
    canSeeSection(holding('customers.manage', 'contracts.author', 'apiTokens.manage', 'assignments.override'), users),
    false,
  );
  assert.equal(canSeeSection(holding(), users), false);
});

test('single-capability rows and the any-staff row behave as before', () => {
  const tokens = DESK_SECTIONS.find((s) => s.key === 'apiTokens')!;
  const work = DESK_SECTIONS.find((s) => s.key === 'work')!;
  assert.equal(canSeeSection(holding('apiTokens.manage'), tokens), true);
  assert.equal(canSeeSection(holding('templates.types'), tokens), false);
  assert.equal(canSeeSection(holding('templates.types'), work), true);
  assert.equal(canSeeSection(holding(), work), false);
});

/**
 * Journeys build plan J12: **My work is every staff member's home** — the first
 * row, held by any capability — and Overview (V4's tiles and Needs-Root queue) is
 * the whole book's view, so it needs the capability that reads the whole book. A
 * designer or a reviewer is no longer shown it, which is what lets `DeskHome` send
 * everyone to the one section they all hold.
 */
test('work is first and any staff capability opens it; overview needs contracts.readAll and nothing narrower', () => {
  assert.equal(DESK_SECTIONS[0].key, 'work');
  const work = DESK_SECTIONS.find((s) => s.key === 'work')!;
  const overview = DESK_SECTIONS.find((s) => s.key === 'overview')!;
  for (const caps of [['review.participate'], ['library.write'], ['design.author', 'contracts.readActive'], ['builds.author'], ['contracts.readAll']] as Capability[][]) {
    assert.equal(canSeeSection(holding(...caps), work), true, caps.join(','));
  }
  assert.equal(canSeeSection(holding(), work), false, 'a customer holds no capability and has no desk');

  assert.equal(canSeeSection(holding('contracts.readAll'), overview), true);
  assert.equal(canSeeSection(holding('contracts.readActive', 'design.author'), overview), false);
  assert.equal(canSeeSection(holding('contracts.author', 'builds.author', 'review.participate'), overview), false);
});

test('each role’s nav, in order: sales and ADMIN keep Overview beside My work; the others have My work and their own rows', () => {
  const keys = (...caps: Capability[]) => visibleSections(holding(...caps)).map((s) => s.key);
  assert.deepEqual(keys('contracts.readAll', 'contracts.readActive', 'contracts.author'), ['work', 'overview', 'contracts', 'requests']);
  assert.deepEqual(keys('contracts.readActive', 'design.author'), ['work', 'contracts']);
  assert.deepEqual(keys('review.participate'), ['work', 'review']);
});

/**
 * Journeys build plan J2: requests are a sales conversation, gated on
 * `contracts.readAll` — the capability the API's `allRequests` checks — and
 * not on `contracts.readActive`, which design and development also hold. If
 * the row were gated on the narrower one they would be offered a link that
 * only ever bounces.
 */
test('requests is visible with contracts.readAll and not with contracts.readActive alone', () => {
  const requests = DESK_SECTIONS.find((s) => s.key === 'requests')!;
  assert.equal(canSeeSection(holding('contracts.readAll', 'contracts.readActive'), requests), true);
  assert.equal(canSeeSection(holding('contracts.readActive', 'design.author'), requests), false);
  assert.equal(canSeeSection(holding('contracts.readActive', 'builds.author'), requests), false);
  assert.equal(canSeeSection(holding('contracts.author'), requests), false, 'authoring without reading is not a reason to see the inbox');
  assert.equal(canSeeSection(null, requests), false);
});
