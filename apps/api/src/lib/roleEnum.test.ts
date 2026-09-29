import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `Role` lives in two places that nothing connects: the Prisma enum the
 * database stores and the SDL enum the client is promised. S1 added SALES and
 * DESIGNER to the first and not the second, and the result was not a type
 * error but a runtime one — `Enum "Role" cannot represent value: "SALES"` on
 * any selection of `User.roles`, which includes `signIn`'s own payload, so a
 * sales account could not sign in at all (found by the S1 web lane's e2e).
 * The integration suite missed it because the in-process harness injects the
 * user and few tests select `roles`. Same remedy as `changeAction.test.ts`:
 * read both as text and require them to agree.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function enumValues(source: string, label: string): string[] {
  const match = source.match(/enum Role \{([\s\S]*?)\}/);
  assert.ok(match, `no "enum Role" block found in ${label}`);
  return match[1]
    .split('\n')
    .map((l) => l.replace(/\/\/\/?.*$/, '').replace(/"[^"]*"/g, '').trim())
    .filter((l) => /^[A-Z_]+$/.test(l));
}

test('the SDL Role enum and the Prisma Role enum name the same roles', () => {
  const prisma = enumValues(read('../../prisma/schema.prisma'), 'schema.prisma');
  const sdl = enumValues(read('../graphql/typeDefs.ts'), 'typeDefs.ts');
  assert.ok(prisma.length >= 7, `parsed only ${prisma.length} Prisma roles — has the regex drifted?`);
  assert.deepEqual([...sdl].sort(), [...prisma].sort());
});
