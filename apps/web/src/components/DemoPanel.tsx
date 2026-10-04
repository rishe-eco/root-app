import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { formatCount, instantDate } from '@/lib/format';
import { roundCounter } from '@/lib/design';
import Lock from '@/components/Lock';
import DemoViewport from '@/components/DemoViewport';
import DemoFeedbackPanel from '@/components/DemoFeedbackPanel';
import { ReadinessStep, mayRecordReadiness, useDemoReadiness } from '@/components/DemoSubmission';
import type { StepPanelProps } from '@/components/StepPanels';
import type { Demo, Phase } from '@/lib/queries';

/**
 * Step 6 — one phase's demo (journeys build plan J10), for both sides. The live
 * staging site in the portal's viewport, a note per page and per frame line (S2's
 * one feedback model, through `DemoFeedbackPanel`), "version 2 of 3" from the
 * wizard's own count, the versions Root has shown with their dates, and — for the
 * customer — **Approve this phase**, which the API refuses while any note is open
 * (`approveDemo`) and which, once it lands, accepts the phase's scope and locks it.
 *
 * Staff read the same page. Authoring a demo — its address, frame, versions and
 * the readiness check — is the contract's Phases tab (`PhasesTab`, with
 * `DemoSubmission`); a staff viewer who may record readiness still records it from
 * here too, because the viewport that hears the staging site is the same
 * component wherever it is shown.
 */

/** The phase's demo as this viewer may read it: staff the newest (a draft is theirs), anyone else the newest published. */
function demoOf(phase: Phase, staff: boolean): Demo | null {
  return phase.demos.find((d) => staff || d.publishedAt !== null) ?? null;
}

function NotYet({ staff }: { staff: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="step-notyet" data-testid="demo-not-yet">
      <Lock />
      <p className="t-small desk-muted">{staff ? t('demoStep.notYet.staff') : t('demoStep.notYet.customer')}</p>
    </div>
  );
}

export default function DemoPanel({ contract, step, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const staff = audience === 'staff';
  const phase = contract.project?.phases.find((p) => p.id === step.phaseId) ?? null;
  const demo = phase ? demoOf(phase, staff) : null;
  const counter = roundCounter(step);

  // Readiness is recorded by the phase's developer's or sales' browser, from whichever
  // viewport hears the site first (see `DemoSubmission`). Never a customer's.
  const canRecord = staff && !!demo && demo.kind !== 'MOCKUP' && mayRecordReadiness(me, contract);
  const readiness = useDemoReadiness(demo ?? ({ id: '', readyAt: null } as Demo), contract.id, canRecord, step.locked);

  if (!phase || !demo) return <NotYet staff={staff} />;
  if (!staff && !demo.publishedAt) return <NotYet staff={false} />;

  const shown = [...(phase.builds ?? [])].filter((b) => b.publishedAt !== null).sort((a, b) => a.number - b.number);
  const versionLine =
    counter.used === 0
      ? t('demoStep.noVersion')
      : counter.total === null
        ? t('demoStep.iterationOpen', { n: formatCount(counter.used, locale) })
        : t('demoStep.iteration', { n: formatCount(counter.used, locale), total: formatCount(counter.total, locale) });

  return (
    <div className="demo-step" data-testid="demo-panel" data-phase={phase.id}>
      <div className="design-head">
        <span className="badge design-round" data-testid="demo-iteration">
          {versionLine}
        </span>
      </div>
      <p className="t-small desk-muted">{staff ? t('demoStep.lede.staff') : t('demoStep.lede.customer')}</p>

      {staff && demo.publishedAt === null ? (
        <ReadinessStep demo={demo} canRecord={canRecord} recording={readiness.recording} error={readiness.error} />
      ) : null}

      <div data-testid="demo-viewport">
        <DemoViewport demo={demo} onFirstReport={readiness.record} />
      </div>

      {shown.length > 0 ? (
        <div data-testid="demo-builds">
          <p className="t-eyebrow">{t('demoStep.builds.title')}</p>
          <ul className="design-extension-list">
            {shown.map((b) => (
              <li key={b.id} className="t-caption" data-build={b.number}>
                {t('demoStep.builds.line', { n: b.number, date: instantDate(b.publishedAt!, locale) })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <DemoFeedbackPanel
        demo={demo}
        contractId={contract.id}
        phaseId={phase.id}
        audience={audience}
        canAuthor={false}
        canAnswer={staff && can(me, 'feedback.answer')}
        answerDirect={can(me, 'answers.direct.demo')}
        locked={step.locked}
        canApprove={audience === 'customer'}
        asCustomer={asCustomer}
        onChanged={() => undefined}
      />
    </div>
  );
}
