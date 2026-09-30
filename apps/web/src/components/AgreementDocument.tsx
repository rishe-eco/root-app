import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { Contract, ContractRevision } from '@/lib/queries';
import { calendarDate, formatAmount, formatCount, pick } from '@/lib/format';
import { groupScopeByKind, isPaymentScheduleArticle } from '@/lib/agreement';

/**
 * The agreement as a document (journeys build plan J7) — the parties, steps 1
 * and 2 as they were frozen, the articles and Appendix 1 — **one component for
 * the two places it is read**: the print route (`portal/ContractPrint.tsx`,
 * which adds the letterhead, the amendments and the signature block) and the
 * wizard's step 3 (`AgreementPanel`, which adds the Approve and Sign controls).
 * Both render the *snapshot*, never Root's working copy: everything here comes
 * out of `contract.revision` (title, fee, `agreement`), `contract.articles` and
 * `contract.agreedScopeItems`, which the API fills from the frozen bytes the
 * `contentHash` covers. A copy of this markup somewhere else is a document that
 * can disagree with the one that is signed.
 *
 * **The customer signs the whole snapshot** (the plan's first trap). Nothing
 * here filters by who is reading: the budget cap, the payment plan and a
 * sensitive article's body arrive from the API in full for the customer — the
 * API withholds them from *other staff* — and this component only has to draw
 * what it is given. A `null` is therefore never "hide this from the customer"; it
 * is a viewer the API refused, and is drawn as one line saying so rather than
 * as an empty article that looks like a mistake.
 *
 * **The payment schedule is data, not prose** (the second trap). On a format-2
 * revision Article 5 (*Payment Schedule*, matched exactly as the API matches it)
 * has no body; the plan is rendered beneath its title from the snapshot's
 * `paymentPlan`, so there is one schedule and it cannot disagree with itself.
 * A format-1 revision has no plan and its article 5 renders its body as any
 * other.
 *
 * Money goes through `formatAmount` into the locale's own digits; counts through
 * `formatCount`; calendar days through `calendarDate` (UTC, PD-19); ordinals and
 * references stay Latin (README rule 14).
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

function Fact({ label, children, latin = false }: { label: string; children: string | null; latin?: boolean }) {
  return (
    <div className="doc-fact">
      <dt>{label}</dt>
      <dd className={latin ? 'num-latin' : undefined}>{children}</dd>
    </div>
  );
}

const money = (t: T, amount: string, locale: 'fa' | 'en') => t('print.toman', { amount: formatAmount(amount, locale) });

/** The days a term stands for — "on delivery" for none, otherwise "within N days". */
function termText(t: T, days: number, locale: 'fa' | 'en') {
  return days === 0 ? t('brief.plan.termNow') : t('brief.plan.termDays', { count: days, n: formatCount(days, locale) });
}

function BriefSection({ revision }: { revision: ContractRevision }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const a = revision.agreement;
  const brief = a?.brief;
  if (!a || !brief) return null;
  const allowances = a.allowances;
  const path = brief.designTier === 'THEME_PICK' ? 'PREMADE' : 'CUSTOM';

  return (
    <section className="doc-sec" data-testid="agreement-brief">
      <h2 className="doc-h">{t('agreement.brief')}</h2>
      <dl className="doc-facts">
        <Fact label={t('brief.label.kind')}>{t(`brief.kind.${brief.kind}`)}</Fact>
        {brief.existingSiteUrl ? <Fact label={t('brief.label.existingSiteUrl')} latin>{brief.existingSiteUrl}</Fact> : null}
        <Fact label={t('brief.label.templateType')}>{pick(brief.templateType, 'label', locale)}</Fact>
        <Fact label={t('brief.label.designTier')}>{t(`brief.tier.${brief.designTier}`)}</Fact>
        <Fact label={t('agreement.designPath')}>{t(`brief.path.${path}`)}</Fact>
        {/* The customer's own statement of a ceiling — null only for staff the API
            refused (`mayReadMoney`), never for the customer who signs it. */}
        <Fact label={t('brief.label.budgetCap')}>
          {brief.budgetCap !== null ? money(t, brief.budgetCap, locale) : t('agreement.moneyHidden')}
        </Fact>
        {brief.idealDeadline ? <Fact label={t('brief.label.idealDeadline')}>{calendarDate(brief.idealDeadline, locale)}</Fact> : null}
        {brief.hardDeadline ? <Fact label={t('brief.label.hardDeadline')}>{calendarDate(brief.hardDeadline, locale)}</Fact> : null}
        {brief.domainName ? <Fact label={t('brief.form.domainName')} latin>{brief.domainName}</Fact> : null}
        {brief.domainProvidedBy ? <Fact label={t('brief.form.provider.domain')}>{t(`brief.side.${brief.domainProvidedBy}`)}</Fact> : null}
        {brief.hostProvidedBy ? <Fact label={t('brief.form.provider.host')}>{t(`brief.side.${brief.hostProvidedBy}`)}</Fact> : null}
        {brief.contentProvidedBy ? <Fact label={t('brief.form.provider.content')}>{t(`brief.side.${brief.contentProvidedBy}`)}</Fact> : null}
        {brief.supportMonths !== null ? (
          <Fact label={t('brief.label.supportMonths')}>
            {t('brief.months', { count: brief.supportMonths, n: formatCount(brief.supportMonths, locale) })}
          </Fact>
        ) : null}
      </dl>
      {allowances ? (
        <>
          <h3 className="doc-art-h">{t('brief.group.allowances')}</h3>
          <ul className="doc-list" data-testid="agreement-allowances">
            {allowances.premadeRounds !== null ? (
              <li>{t('brief.allowance.premadeRounds', { count: allowances.premadeRounds, n: formatCount(allowances.premadeRounds, locale) })}</li>
            ) : null}
            <li>{t('brief.allowance.wireframes', { count: allowances.wireframeIterations, n: formatCount(allowances.wireframeIterations, locale) })}</li>
            {allowances.mockupIterations !== null ? (
              <li>{t('brief.allowance.mockups', { count: allowances.mockupIterations, n: formatCount(allowances.mockupIterations, locale) })}</li>
            ) : null}
            {allowances.demoIterationsPerPhase !== null ? (
              <li>{t('brief.allowance.demos', { count: allowances.demoIterationsPerPhase, n: formatCount(allowances.demoIterationsPerPhase, locale) })}</li>
            ) : null}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function PhasesSection({ revision }: { revision: ContractRevision }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const a = revision.agreement;
  if (!a) return null;
  return (
    <section className="doc-sec" data-testid="agreement-phases">
      <h2 className="doc-h">{t('agreement.phasesAndDates')}</h2>
      <dl className="doc-facts">
        {a.plannedStartAt ? <Fact label={t('agreement.plannedStart')}>{calendarDate(a.plannedStartAt, locale)}</Fact> : null}
        {a.plannedEndAt ? <Fact label={t('agreement.plannedEnd')}>{calendarDate(a.plannedEndAt, locale)}</Fact> : null}
      </dl>
      {a.phases.length > 0 ? (
        <table className="doc-table">
          <thead>
            <tr>
              <th>{t('agreement.phase')}</th>
              <th>{t('agreement.plannedEnd')}</th>
            </tr>
          </thead>
          <tbody>
            {a.phases.map((p) => (
              <tr key={p.number}>
                <td>
                  <span className="num-latin">{p.number}.</span> {pick(p, 'title', locale)}
                  {p.milestoneLabel ? <span className="t-caption"> · {p.milestoneLabel}</span> : null}
                </td>
                <td>{p.plannedEndAt ? calendarDate(p.plannedEndAt, locale) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="doc-art-body doc-art-empty">{t('agreement.noPhases')}</p>
      )}
    </section>
  );
}

/** The payment plan as a schedule — rendered under Article 5's title, in place of a body. */
function PaymentSchedule({ revision }: { revision: ContractRevision }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const plan = revision.agreement?.paymentPlan;
  if (!plan) return <p className="doc-art-body doc-art-empty" data-testid="agreement-plan-hidden">{t('agreement.moneyHidden')}</p>;
  return (
    <div data-testid="agreement-plan">
      <table className="doc-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t('agreement.planRow')}</th>
            <th>{t('agreement.planAmount')}</th>
            <th>{t('agreement.planTerm')}</th>
          </tr>
        </thead>
        <tbody>
          {plan.invoices.map((row) => (
            <tr key={row.ordinal}>
              <td className="num-latin">{row.ordinal}</td>
              <td>
                {pick(row, 'label', locale)}
                {row.phaseNumber !== null ? (
                  <span className="t-caption"> · {t('brief.plan.afterPhase', { n: formatCount(row.phaseNumber, locale) })}</span>
                ) : null}
              </td>
              <td>{money(t, row.amount, locale)}</td>
              <td>{termText(t, row.paymentTermDays, locale)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2}>{t('brief.plan.total')}</th>
            <th colSpan={2}>{money(t, plan.total, locale)}</th>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ArticlesSection({ contract, revision }: { contract: Contract; revision: ContractRevision }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <section className="doc-sec">
      <h2 className="doc-h">{t('print.articles')}</h2>
      {contract.articles.map((a) => {
        const generated = revision.agreement !== null && isPaymentScheduleArticle(a.number, a.titleEn);
        const raw = locale === 'fa' ? a.bodyFa : a.bodyEn;
        return (
          <div className="doc-art" key={a.id} data-article={a.number}>
            <h3 className="doc-art-h">
              <span className="num-latin">{a.number}.</span> {pick(a, 'title', locale)}
            </h3>
            {generated ? (
              <PaymentSchedule revision={revision} />
            ) : raw === null ? (
              // The API withheld a sensitive body from a viewer who may not read
              // money — never the customer, who signs it.
              <p className="doc-art-body doc-art-empty" data-testid="article-withheld">
                {t('agreement.bodyWithheld')}
              </p>
            ) : raw ? (
              <p className="doc-art-body" data-testid="article-body">
                {raw}
              </p>
            ) : (
              <p className="doc-art-body doc-art-empty">{t('print.articleEmpty')}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Appendix 1 — grouped by kind on a format-2 revision, a flat list on a format-1 one. */
function AppendixSection({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const groups = groupScopeByKind(contract.agreedScopeItems);
  return (
    <section className="doc-sec" data-testid="agreement-appendix">
      <h2 className="doc-h">{t('print.appendix')}</h2>
      {groups.length === 0 ? (
        <p className="doc-art-body doc-art-empty">{t('print.appendixEmpty')}</p>
      ) : (
        groups.map((g) => (
          <div key={g.kind ?? 'flat'} data-kind={g.kind ?? 'flat'}>
            {g.kind ? <h3 className="doc-art-h">{t(`agreement.kindGroup.${g.kind}`)}</h3> : null}
            <ul className="doc-list">
              {g.items.map((s) => (
                <li key={s.key}>{pick({ labelFa: s.labelFa, labelEn: s.labelEn }, 'label', locale)}</li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

export default function AgreementDocument({ contract, revision }: { contract: Contract; revision: ContractRevision }) {
  const { t } = useTranslation();
  const client = contract.customer.clientName ?? contract.customer.name;
  return (
    <>
      <section className="doc-sec doc-parties">
        <h2 className="doc-h">{t('print.parties')}</h2>
        <div className="doc-party">
          <span className="doc-party-role">{t('print.provider')}</span>
          <span className="doc-party-name">{t('brand.main')}</span>
        </div>
        <div className="doc-party">
          <span className="doc-party-role">{t('print.client')}</span>
          <span className="doc-party-name">{client}</span>
        </div>
      </section>
      <BriefSection revision={revision} />
      <PhasesSection revision={revision} />
      <ArticlesSection contract={contract} revision={revision} />
      <AppendixSection contract={contract} />
    </>
  );
}
