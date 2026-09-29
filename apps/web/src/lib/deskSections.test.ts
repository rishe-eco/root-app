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
    ['overview', 'library', 'templates'],
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
  const overview = DESK_SECTIONS.find((s) => s.key === 'overview')!;
  assert.equal(canSeeSection(holding('apiTokens.manage'), tokens), true);
  assert.equal(canSeeSection(holding('templates.types'), tokens), false);
  assert.equal(canSeeSection(holding('templates.types'), overview), true);
  assert.equal(canSeeSection(holding(), overview), false);
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
