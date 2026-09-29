/** Structural rather than i18next's TFunction — same reasoning as lib/changelog.ts's T. */
type T = (key: string, opts?: Record<string, unknown>) => string;

/**
 * The API answers a refused write with a code (house rule 12), and the desk
 * says it in the reader's language: `desk.templates.errors.<CODE>`, with one
 * generic line for a code nobody wrote a sentence for. Never the server's
 * English message — it is a developer's aid, and this is Persian-first.
 */
export function refusalMessage(t: T, err: unknown): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  return t(`desk.templates.errors.${code ?? 'UNKNOWN'}`, { defaultValue: t('desk.templates.errors.UNKNOWN') });
}
