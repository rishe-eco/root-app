import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { POLICY } from './files.js';
import { canReadThemes, canSeeThemePreview, checkDemoUrl, parseLicenseCost, MAX_DEMO_URL_LENGTH } from './themes.js';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('checkDemoUrl: https passes; every other scheme is DEMO_URL_NOT_HTTPS; what does not parse is INVALID_DEMO_URL', () => {
  assert.equal(checkDemoUrl('https://demo.example.com'), null);
  assert.equal(checkDemoUrl('https://demo.example.com/a/b?c=d#e'), null);
  assert.equal(checkDemoUrl('HTTPS://DEMO.EXAMPLE.COM'), null, 'the scheme is case-insensitive');
  assert.equal(checkDemoUrl('http://demo.example.com'), 'DEMO_URL_NOT_HTTPS');
  assert.equal(checkDemoUrl('javascript:alert(1)'), 'DEMO_URL_NOT_HTTPS');
  assert.equal(checkDemoUrl('data:text/html,hi'), 'DEMO_URL_NOT_HTTPS');
  assert.equal(checkDemoUrl('demo.example.com'), 'INVALID_DEMO_URL');
  assert.equal(checkDemoUrl('https://'), 'INVALID_DEMO_URL');
  assert.equal(checkDemoUrl(''), 'INVALID_DEMO_URL');
  assert.equal(checkDemoUrl(`https://example.com/${'a'.repeat(MAX_DEMO_URL_LENGTH)}`), 'INVALID_DEMO_URL');
});

test('parseLicenseCost: whole Toman up to BIGINT\'s ceiling; anything else is null, and zero is not a refusal', () => {
  assert.equal(parseLicenseCost('0'), 0n);
  assert.equal(parseLicenseCost('4500000'), 4_500_000n);
  assert.equal(parseLicenseCost(' 4500000 '), 4_500_000n);
  assert.equal(parseLicenseCost('9223372036854775807'), 9_223_372_036_854_775_807n);
  assert.equal(parseLicenseCost('9223372036854775808'), null);
  for (const bad of ['', '-1', '1.5', '1,000', '1e3', 'ten', '۱۲۳']) assert.equal(parseLicenseCost(bad), null, bad);
});

test('the catalogue readers: the template capabilities and contracts.author read; contract readers may also open a preview; a customer does neither', () => {
  const as = (...roles: string[]) => ({ roles }) as never;
  for (const role of ['ADMIN', 'DESIGNER', 'SALES']) {
    assert.equal(canReadThemes(as(role)), true, role);
    assert.equal(canSeeThemePreview(as(role)), true, role);
  }
  for (const role of ['DEVELOPER']) {
    assert.equal(canReadThemes(as(role)), false, role);
    assert.equal(canSeeThemePreview(as(role)), true, `${role}: contracts.readActive`);
  }
  for (const role of ['CUSTOMER', 'CONTRIBUTOR', 'REVIEWER']) {
    assert.equal(canReadThemes(as(role)), false, role);
    assert.equal(canSeeThemePreview(as(role)), false, role);
  }
});

test('THEME_PREVIEW is a private, theme-owned raster class written by templates.types — and never SVG', () => {
  const p = POLICY.THEME_PREVIEW;
  assert.equal(p.visibility, 'PRIVATE');
  assert.equal(p.owner, 'theme');
  assert.equal(p.uploader, 'templates.types');
  assert.deepEqual(p.accepted.map((t) => t.mime).sort(), ['image/jpeg', 'image/png', 'image/webp']);
});

test('the migration widens the private-file CHECK to name a theme, and keeps the two older owners in it', () => {
  const sql = read('../../prisma/migrations/20260929170000_t2_themes/migration.sql');
  assert.match(
    sql,
    /CHECK \("visibility" <> 'PRIVATE' OR "contractId" IS NOT NULL OR "projectId" IS NOT NULL OR "themeId" IS NOT NULL\)/,
  );
  assert.match(sql, /Invariant change/, 'the widening is recorded in the header');
});

test('every SDL mutation the catalogue adds is templates.types-guarded in the resolver, and the SDL names no delete', () => {
  const sdl = read('../graphql/typeDefs.ts');
  assert.doesNotMatch(sdl, /deleteTheme/);
  const resolver = read('../graphql/resolvers/themes.ts');
  // Three mutations, each opening with the capability guard.
  assert.equal((resolver.match(/requireCapability\(ctx, 'templates\.types'\)/g) ?? []).length, 3);
});
