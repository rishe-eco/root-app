import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { ContractSummary, ScopeKind, SummaryItem } from '@/lib/queries';
import { calendarDate, formatAmount, formatCount, pick } from '@/lib/format';
import { stepLabel } from '@/lib/wizard';

/**
 * The summary as a document (journeys build plan J11; Q-S8): **a record, not a
 * review** — what was agreed, what became of each item, the changes nobody asked
 * for, each step's rounds and finish date, planned against actual dates, the
 * money, the support period. **One component for the two places it is read**, as
 * `AgreementDocument` is: the wizard's SUMMARY step (`SummaryPanel`, which adds
 * the desk's handover and close controls) and the print route
 * (`portal/SummaryPrint.tsx`, which adds the letterhead). It draws what the API
 * gives it and nothing else; there is no feedback in it because there is none in
 * the data (the API's `ContractSummary` type has no such field), and no input —
 * the step "never takes input".
 *
 * **Every date is a calendar day in UTC** (PD-19) — `calendarDate`, planned and
 * actual alike, so the 1st of the month a contract was delivered on is the 1st
 * on a machine in Tehran and on one west of Greenwich. Money goes through
 * `formatAmount`, counts through `formatCount` (the locale's own digits, house
 * rule 14), versions and references stay Latin.
 *
 * **A `null` is a viewer the API refused, or a number nobody counts — never a
 * zero.** Money is null for staff without `money.read` (drawn as one line saying
 * so); a step's `iterationsUsed` is null where no stage counts its rounds yet
 * (drawn "not counted"). Both are drawn as what they are.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

const KINDS: ScopeKind[] = ['PAGE', 'FEATURE', 'DELIVERABLE', 'EXTRA'];

function Fact({ label, children, latin = false }: { label: string; children: string | null; latin?: boolean }) {
  return (
    <div className="doc-fact">
      <dt>{label}</dt>
      <dd className={latin ? 'num-latin' : undefined}>{children}</dd>
    </div>
  );
}

const money = (t: T, amount: string, locale: 'fa' | 'en') => t('print.toman', { amount: formatAmount(amount, locale) });
const day = (iso: string | null, locale: 'fa' | 'en') => (iso ? calendarDate(iso, locale) : '—');

/** Where an item ended, and why, in one line of the table. */
function ItemNote({ item }: { item: SummaryItem }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const notes: string[] = [];
  if (item.declinedReason) notes.push(t('summary.items.declinedBecause', { reason: item.declinedReason }));
  if (item.tradePartner) {
    notes.push(
      t(item.tradePartner.direction === 'OUT' ? 'summary.items.tradedFor' : 'summary.items.replaced', {
        label: pick(item.tradePartner, 'label', locale),
        when: day(item.tradePartner.executedAt, locale),
      }),
    );
  }
  if (!item.inAgreement) notes.push(t('summary.items.cameLater'));
  if (item.phaseNumber !== null) notes.push(t('summary.items.inPhase', { n: formatCount(item.phaseNumber, locale) }));
  return <>{notes.join(' · ')}</>;
}

export default function SummaryDocument({
  summary,
}: {
  summary: ContractSummary;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { agreed, dates } = summary;
  const brief = agreed.agreement?.brief ?? null;
  const delivered = summary.deliveredAt !== null;

  const stepRows = summary.steps;
  const itemGroups = KINDS.map((kind) => ({ kind, rows: summary.items.filter((i) => i.kind === kind) })).filter((g) => g.rows.length > 0);
  const deliverables = summary.items.filter((i) => i.kind === 'DELIVERABLE' && i.status !== 'DECLINED' && i.status !== 'TRADED');

  return (
    <div data-testid="summary-document" data-delivered={delivered ? 'true' : 'false'}>
      <section className="doc-sec" data-testid="summary-overview">
        <dl className="doc-facts">
          <Fact label={t('summary.facts.version')} latin>{`v${agreed.version}`}</Fact>
          <Fact label={t('summary.facts.signed')}>{day(agreed.signedAt, locale)}</Fact>
          <Fact label={t('summary.facts.delivered')}>{delivered ? day(summary.deliveredAt, locale) : t('summary.facts.notYet')}</Fact>
          {brief ? <Fact label={t('brief.label.templateType')}>{pick(brief.templateType, 'label', locale)}</Fact> : null}
        </dl>
      </section>

      <section className="doc-sec" data-testid="summary-agreed">
        <h2 className="doc-h">{t('summary.agreed.title')}</h2>
        {brief ? (
          <dl className="doc-facts">
            <Fact label={t('brief.label.designTier')}>{t(`brief.tier.${brief.designTier}`)}</Fact>
            {brief.hardDeadline ? <Fact label={t('brief.label.hardDeadline')}>{calendarDate(brief.hardDeadline, locale)}</Fact> : null}
            {brief.supportMonths !== null ? (
              <Fact label={t('brief.label.supportMonths')}>
                {t('brief.months', { count: brief.supportMonths, n: formatCount(brief.supportMonths, locale) })}
              </Fact>
            ) : null}
            {agreed.agreement?.paymentPlan ? (
              <Fact label={t('brief.plan.total')}>{money(t, agreed.agreement.paymentPlan.total, locale)}</Fact>
            ) : null}
          </dl>
        ) : null}
        <h3 className="doc-art-h">{t('summary.agreed.scope')}</h3>
        {agreed.scopeItems.length === 0 ? (
          <p className="doc-art-body doc-art-empty">{t('print.appendixEmpty')}</p>
        ) : (
          <ul className="doc-list">
            {agreed.scopeItems.map((s) => (
              <li key={s.key}>
                {pick(s, 'label', locale)}
                {s.kind ? <span className="t-caption"> · {t(`summary.kind.${s.kind}`)}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {agreed.amendments.length > 0 || agreed.trades.length > 0 ? (
          <>
            <h3 className="doc-art-h">{t('summary.agreed.changes')}</h3>
            <ul className="doc-list" data-testid="summary-amendments">
              {agreed.amendments.map((a) => (
                <li key={a.id}>
                  <span className="num-latin">A{a.ordinal}.</span> {pick(a, 'title', locale)}
                  {a.signature ? (
                    <span className="t-caption"> · {t('summary.agreed.signedOn', { date: day(a.signature.signedAt, locale) })}</span>
                  ) : null}
                </li>
              ))}
              {agreed.trades.map((tr) => (
                <li key={`${tr.out.key}-${tr.in.key}`}>
                  {t('summary.agreed.trade', {
                    out: pick(tr.out, 'label', locale),
                    in: pick(tr.in, 'label', locale),
                    when: day(tr.executedAt, locale),
                  })}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="doc-sec" data-testid="summary-items">
        <h2 className="doc-h">{t('summary.items.title')}</h2>
        {itemGroups.map((g) => (
          <div key={g.kind}>
            <h3 className="doc-art-h">{t(`summary.group.${g.kind}`)}</h3>
            <table className="doc-table">
              <thead>
                <tr>
                  <th>{t('summary.items.item')}</th>
                  <th>{t('summary.items.endedAs')}</th>
                  <th>{t('summary.items.note')}</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((i) => (
                  <tr key={i.id} data-status={i.status} data-key={i.key}>
                    <td>{pick(i, 'label', locale)}</td>
                    <td>{t(`summary.status.${i.status}`)}</td>
                    <td>
                      <ItemNote item={i} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section className="doc-sec" data-testid="summary-handover">
        <h2 className="doc-h">{t('summary.handover.title')}</h2>
        {deliverables.length === 0 ? (
          <p className="doc-art-body doc-art-empty">{t('summary.handover.none')}</p>
        ) : (
          deliverables.map((d) => (
            <div className="doc-art" key={d.id} data-key={d.key} data-handed-over={d.handedOverAt ? 'true' : 'false'}>
              <h3 className="doc-art-h">{pick(d, 'label', locale)}</h3>
              {d.handedOverAt ? (
                <>
                  <p className="doc-art-body">{d.handoverNote}</p>
                  <p className="doc-art-meta">
                    {t('summary.handover.on', { date: day(d.handedOverAt, locale) })}
                    {d.handedOverBy ? ` · ${t('summary.handover.by', { name: d.handedOverBy })}` : ''}
                  </p>
                </>
              ) : (
                <p className="doc-art-body doc-art-empty">{t('summary.handover.pending')}</p>
              )}
            </div>
          ))
        )}
      </section>

      {summary.unpromptedChanges.length > 0 ? (
        <section className="doc-sec" data-testid="summary-unprompted">
          <h2 className="doc-h">{t('summary.unprompted.title')}</h2>
          <p className="t-small">{t('summary.unprompted.help')}</p>
          <ul className="doc-list">
            {summary.unpromptedChanges.map((c) => (
              <li key={c.id}>
                {c.writtenUp ? (
                  pick(c, 'text', locale)
                ) : (
                  // Staff only: the API sends a raw note to nobody else. Say what it is
                  // and what is owed, rather than letting it pass for the customer's text.
                  <span className="t-caption" data-testid="summary-unwritten">
                    {t('summary.unprompted.unwritten', { note: c.note ?? '' })}
                  </span>
                )}
                <span className="t-caption"> · {t('summary.unprompted.in', { step: stepLabel(t, locale, { step: c.step }), n: c.buildNumber })}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="doc-sec" data-testid="summary-steps">
        <h2 className="doc-h">{t('summary.steps.title')}</h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th>{t('summary.steps.step')}</th>
              <th>{t('summary.steps.rounds')}</th>
              <th>{t('summary.steps.finished')}</th>
            </tr>
          </thead>
          <tbody>
            {stepRows.map((s) => (
              <tr key={`${s.step}-${s.phaseId ?? ''}`} data-step={s.step}>
                <td>{stepLabel(t, locale, { step: s.step, phaseNumber: s.phaseNumber })}</td>
                <td data-testid={`summary-rounds-${s.step}`}>
                  <Rounds step={s} />
                </td>
                <td>{day(s.finishedAt, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="doc-sec" data-testid="summary-dates">
        <h2 className="doc-h">{t('summary.dates.title')}</h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th />
              <th>{t('summary.dates.planned')}</th>
              <th>{t('summary.dates.actual')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('summary.dates.start')}</td>
              <td>{day(dates.plannedStartAt, locale)}</td>
              <td>{day(dates.startedAt ?? dates.signedAt, locale)}</td>
            </tr>
            {dates.phases.map((p) => (
              <tr key={p.number}>
                <td>{t('summary.dates.phase', { n: formatCount(p.number, locale), title: pick(p, 'title', locale) })}</td>
                <td>{day(p.plannedEndAt, locale)}</td>
                <td>{day(p.acceptedAt, locale)}</td>
              </tr>
            ))}
            <tr>
              <td>{t('summary.dates.delivery')}</td>
              <td>{day(dates.plannedEndAt, locale)}</td>
              <td>{day(dates.deliveredAt, locale)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="doc-sec" data-testid="summary-money">
        <h2 className="doc-h">{t('summary.money.title')}</h2>
        {summary.invoices ? (
          <dl className="doc-facts">
            <Fact label={t('summary.money.invoices')}>{formatCount(summary.invoices.count, locale)}</Fact>
            <Fact label={t('summary.money.issued')}>{money(t, summary.invoices.issued, locale)}</Fact>
            <Fact label={t('summary.money.paid')}>{money(t, summary.invoices.paid, locale)}</Fact>
            <Fact label={t('summary.money.outstanding')}>{money(t, summary.invoices.outstanding, locale)}</Fact>
          </dl>
        ) : (
          <p className="doc-art-body doc-art-empty" data-testid="summary-money-hidden">{t('agreement.moneyHidden')}</p>
        )}
      </section>

      {summary.support ? (
        <section className="doc-sec" data-testid="summary-support">
          <h2 className="doc-h">{t('summary.support.title')}</h2>
          <p className="doc-art-body">
            {summary.support.from && summary.support.until
              ? t('summary.support.period', {
                  months: t('brief.months', { count: summary.support.months, n: formatCount(summary.support.months, locale) }),
                  from: calendarDate(summary.support.from, locale),
                  until: calendarDate(summary.support.until, locale),
                })
              : t('summary.support.promised', {
                  months: t('brief.months', { count: summary.support.months, n: formatCount(summary.support.months, locale) }),
                })}
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** "2 of 3", "2 of 3 (+1 extra)", or "not counted" where nobody counts the rounds yet. */
function Rounds({ step }: { step: ContractSummary['steps'][number] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (step.iterationsUsed === null && step.allowance === null) return <>—</>;
  const used = step.iterationsUsed === null ? t('summary.steps.notCounted') : formatCount(step.iterationsUsed, locale);
  const base =
    step.allowance === null ? used : t('summary.steps.usedOf', { used, allowance: formatCount(step.allowance, locale) });
  return <>{step.extensions > 0 ? t('summary.steps.withExtra', { text: base, extra: formatCount(step.extensions, locale) }) : base}</>;
}
