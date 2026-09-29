/**
 * One place that turns a people-management refusal into a sentence (journeys
 * build plan S3). The Users page and the customer page call the same
 * mutations and meet the same codes, so they share the map rather than each
 * keeping a copy that could drift — the API's codes are the interface, and
 * `desk.people.errors.*` holds one line for each in both languages.
 *
 * A code with no line falls back to `UNKNOWN`, never to the server's English
 * message: a Persian reader is not shown English because a code is new.
 */

type T = (key: string) => string;

export function peopleError(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]
    ?.extensions?.code;
  const key = `desk.people.errors.${code ?? 'UNKNOWN'}`;
  const text = t(key);
  // i18next returns the key itself for a missing one.
  return text === key ? t('desk.people.errors.UNKNOWN') : text;
}
