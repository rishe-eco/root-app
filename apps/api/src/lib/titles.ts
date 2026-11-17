/**
 * DX4: a title in one language is enough (desk UX review item 26, decision log
 * rows 20, 21 and 23). The nine tables whose titles are typed on the desk's
 * contract workspace (Contract, Article, Amendment, Phase, ScopeItem,
 * PlannedInvoice, Dependency, DemoPage, PageDesign) keep two `NOT NULL` text
 * columns; one of them may be `''`, and a CHECK per table says at least one is
 * not. Library, templates, services and site types keep both required.
 *
 * **One rule, one file** (house rule 3), API side. `requireOneTitle` is the
 * write half: every mutation that used to demand both languages trims them and
 * asks this instead. `inLocale` and `fillPairs` are the read half: whoever
 * picks a language on the server (a mail, today) falls back to the other
 * language when the reader's is blank, plainly and with no mark. The web side
 * has its own copy of the read half in `apps/web/src/lib/format.ts` (`pick`) —
 * `apps/web` and `apps/api` share no types — and a test on each side pins them
 * to the same behaviour.
 */

import { GraphQLError } from 'graphql';

/** Whether a title pair says anything: at least one of the two has a visible character. */
export function hasOneTitle(fa: string | null | undefined, en: string | null | undefined): boolean {
  return (fa ?? '').trim() !== '' || (en ?? '').trim() !== '';
}

/**
 * Trim both; refuse when both are blank. `code` is `TITLE_REQUIRED` unless the
 * mutation already refused with another code (`LABEL_REQUIRED` in the plan, the
 * registry and the design step), which clients and tests assert on — its
 * meaning is now "both blank".
 */
export function requireOneTitle(
  fa: string | null | undefined,
  en: string | null | undefined,
  code: 'TITLE_REQUIRED' | 'LABEL_REQUIRED' = 'TITLE_REQUIRED',
): { fa: string; en: string } {
  const a = (fa ?? '').trim();
  const b = (en ?? '').trim();
  if (a === '' && b === '') {
    throw new GraphQLError('A title in at least one language is required.', { extensions: { code } });
  }
  return { fa: a, en: b };
}

/**
 * The text a reader in `locale` should see: their language's, and when that is
 * blank, the other's. `base` is the column name without its suffix (`title`,
 * `label`, `projectTitle`), so `inLocale(phase, 'title', 'en')` reads
 * `titleEn` and then `titleFa`.
 */
export function inLocale(row: object, base: string, locale: 'fa' | 'en'): string {
  const r = row as Record<string, unknown>;
  const mine = r[`${base}${locale === 'fa' ? 'Fa' : 'En'}`];
  const other = r[`${base}${locale === 'fa' ? 'En' : 'Fa'}`];
  if (typeof mine === 'string' && mine.trim() !== '') return mine;
  return typeof other === 'string' ? other : typeof mine === 'string' ? mine : '';
}

/**
 * A params bag with every `xFa` / `xEn` string pair that has one blank side
 * filled from the other. The notification router calls this once, so no mail
 * template has to remember to (a template reads `projectTitleFa` in Persian
 * and `projectTitleEn` in English, and a one-language project would otherwise
 * print an empty title in the other).
 */
export function fillPairs<T extends object>(params: T): T {
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (!key.endsWith('Fa')) continue;
    const base = key.slice(0, -2);
    const en = `${base}En`;
    if (typeof out[key] !== 'string' || typeof out[en] !== 'string') continue;
    if ((out[key] as string).trim() === '') out[key] = out[en];
    else if ((out[en] as string).trim() === '') out[en] = out[key];
  }
  return out as T;
}
