import { createContext, useContext, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { formatCount } from '@/lib/format';
import { errorCode } from '@/components/FeedbackPanel';

/**
 * The small pieces the desk's step editors share (DX1 built them inside
 * `RequirementsEditor`; DX2a moved the phases and the payment plan to their own
 * step, `PhasesEditor`, which needs the same accordion and the same refusal
 * wording, so they live here rather than in either).
 */

export type T = (key: string, opts?: Record<string, unknown>) => string;

/** A calendar day as the editors' `DayInput` speaks it: `YYYY-MM-DD`, or empty. */
export const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

/** A refusal's sentence: the code's own line when the locale has one, the message otherwise. */
export function refusalText(t: T, err: unknown): string {
  const code = errorCode(err);
  return code && t(`brief.error.${code}`, { defaultValue: '' }) ? t(`brief.error.${code}`) : (err as Error).message;
}

/** Inside an accordion the panel's title is on its header bar, so the card does not say it twice. */
export const InAccordion = createContext(false);

export function SectionHead({ title, help }: { title: string; help?: string }) {
  const inAccordion = useContext(InAccordion);
  return (
    <>
      {inAccordion ? null : <h4 className="t-h4">{title}</h4>}
      {help ? <p className="sec-help">{help}</p> : null}
    </>
  );
}


/** A collapsible sub-panel: a header bar that is the toggle, and the body kept mounted (hidden when closed) so a half-typed form survives a fold. */
export function Accordion({
  id,
  title,
  open,
  onToggle,
  missing,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** How many things this panel still lacks; 0 says "Complete". Null for a panel the completeness list says nothing about. */
  missing: number | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const body = useId();
  return (
    <section className="req-acc" data-testid={`acc-${id}`} data-open={open ? 'true' : 'false'}>
      <h4 className="req-acc-title">
        <button type="button" className="req-acc-head" aria-expanded={open} aria-controls={body} onClick={onToggle}>
          <span className="req-acc-name">{title}</span>
          {missing === null ? null : (
            <span className={`req-acc-state${missing > 0 ? ' req-acc-missing' : ''}`} data-missing={missing}>
              {missing > 0 ? t('brief.accordion.missing', { count: missing, n: formatCount(missing, locale) }) : t('brief.accordion.complete')}
            </span>
          )}
          <span className="req-acc-mark" aria-hidden="true">{open ? '▾' : locale === 'fa' ? '◂' : '▸'}</span>
        </button>
      </h4>
      <div id={body} hidden={!open}>
        <InAccordion.Provider value={true}>{children}</InAccordion.Provider>
      </div>
    </section>
  );
}

