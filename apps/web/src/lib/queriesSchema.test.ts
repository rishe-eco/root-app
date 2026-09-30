import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Kind, buildSchema, parse, validate, type DefinitionNode, type DocumentNode } from 'graphql';
// The API's SDL is a plain string with no imports, so the web can read it
// directly — the one place the two workspaces meet on purpose.
import { typeDefs } from '../../../api/src/graphql/typeDefs';

/**
 * Every GraphQL document the web sends, validated against the schema the API
 * serves (J13 review). J13 found `Ticket.billingEntry` queried by nine web
 * documents since L6 while the SDL never declared it — the desk's Tickets and
 * the portal's Support failed validation at the server, and no suite noticed,
 * because the integration tests write their own documents and the e2e specs
 * that open those screens did not look at the ticket's billing line. This test
 * is the check that would have: a field, argument or type the web asks for
 * and the API does not have is a failure here, before any browser runs.
 *
 * **`queries.ts` is read as text**, not imported: `@apollo/client`'s `gql`
 * does not load under node's ESM loader, and the documents are plain template
 * literals whose only interpolations are other documents (`${USER_FIELDS}`),
 * which is exactly what `gql` itself resolves. A template with any other
 * interpolation fails the second test rather than being skipped.
 */

const source = readFileSync(new URL('./queries.ts', import.meta.url), 'utf8');
const templates = new Map<string, { exported: boolean; body: string }>();
for (const m of source.matchAll(/^(export )?const (\w+) = gql`([\s\S]*?)`;/gm)) {
  templates.set(m[2], { exported: m[1] !== undefined, body: m[3] });
}

/** One document with every interpolated fragment inlined — each fragment once,
 *  as `gql` dedupes them. */
function documentOf(name: string): DocumentNode {
  const seen = new Set<string>();
  const definitions: DefinitionNode[] = [];
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    const t = templates.get(n);
    if (!t) throw new Error(`${n} is interpolated but is not a gql document in queries.ts`);
    const text = t.body.replace(/\$\{(\w+)\}/g, (_all, inner: string) => {
      visit(inner);
      return '';
    });
    definitions.push(...parse(text).definitions);
  };
  visit(name);
  return { kind: Kind.DOCUMENT, definitions };
}

const schema = buildSchema(typeDefs);

test('queries.ts yields documents to check (the extraction is not silently empty)', () => {
  assert.ok(templates.size > 150, `found only ${templates.size} documents`);
});

test('every interpolation in a document is another document', () => {
  for (const [name, t] of templates) {
    for (const m of t.body.matchAll(/\$\{([^}]*)\}/g)) {
      assert.ok(/^\w+$/.test(m[1]) && templates.has(m[1]), `${name} interpolates \${${m[1]}}`);
    }
  }
});

for (const [name, t] of templates) {
  // A fragment-only document is validated where an operation spreads it; alone,
  // "fragment is never used" is the only thing validation could say about it.
  if (!t.exported || !/^\s*(query|mutation|subscription)\b/m.test(t.body)) continue;
  test(`${name} is valid against the API schema`, () => {
    const errors = validate(schema, documentOf(name)).map((e) => e.message);
    assert.deepEqual(errors, []);
  });
}
