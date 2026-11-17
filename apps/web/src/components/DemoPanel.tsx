import { useState, type FormEvent } from 'react';
import { useApolloClient, useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can, canAuthorBuild } from '@/lib/access';
import { formatCount, instantDate, pick } from '@/lib/format';
import { roundCounter } from '@/lib/design';
import Lock from '@/components/Lock';
import DemoViewport from '@/components/DemoViewport';
import DemoFeedbackPanel from '@/components/DemoFeedbackPanel';
import { mayRecordReadiness, useDemoReadiness } from '@/components/DemoSubmission';
import DemoSetup from '@/components/DemoSetup';
import { errorCode } from '@/components/FeedbackPanel';
import type { StepPanelProps } from '@/components/StepPanels';
import { CREATE_DEMO, type Demo, type Phase } from '@/lib/queries';

/**
 * Step 6 — one phase's demo (journeys build plan J10), for both sides. The live
 * staging site in the portal's viewport, a note per page and per frame line (S2's
 * one feedback model, through `DemoFeedbackPanel`), "version 2 of 3" from the
 * wizard's own count, the versions Root has shown with their dates, and — for the
 * customer — **Approve this phase**, which the API refuses while any note is open
 * (`approveDemo`) and which, once it lands, accepts the phase's scope and locks it.
 *
 * Staff read the same page, **and — since DX2a (desk UX review 19) — set the
 * demo up on it**: the live demo link (the staging address, build ref, review
 * window), the readiness check, the frame, each version and the declared demo
 * pages are `DemoSetup`, which was the desk's Phases tab (still the legacy
 * road's). A phase with no demo yet offers the staging address to create one. The
 * step stays open until its demo is approved, so a demo is set up after the plan
 * has locked. The viewport that hears the staging site is the same component
 * wherever it is shown, and `DemoSetup` draws it for staff.
 */

/** Creating a phase's demo: its staging address, which is all a demo needs to exist. */
function CreateDemo({ phase, contractId }: { phase: Phase; contractId: string }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [create, { loading }] = useMutation(CREATE_DEMO);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create({ variables: { phaseId: phase.id, stagingUrl: url, contractId } });
      setUrl('');
    } catch (err) {
      const code = errorCode(err);
      setError(code && t(`workspace.demoError.${code}`, { defaultValue: '', example: 'nahal.staging.m-root.com' }) ? t(`workspace.demoError.${code}`, { example: 'nahal.staging.m-root.com' }) : (err as Error).message);
    }
  }

  return (
    <form className="card editor-card auth-form" onSubmit={submit} data-testid="demo-create">
      <div className="field">
        <label className="label" htmlFor={`demo-create-url-${phase.id}`}>
          {t('workspace.demoStagingUrl')}
        </label>
        <input
          id={`demo-create-url-${phase.id}`}
          className="input num-latin"
          dir="ltr"
          required
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
          {t('workspace.addDemo')}
        </button>
      </div>
    </form>
  );
}

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
  const client = useApolloClient();
  const canBuild = staff && canAuthorBuild(me, contract);

  // Readiness is recorded by the phase's developer's or sales' browser, from whichever
  // viewport hears the site first (see `DemoSubmission`). Never a customer's.
  const canRecord = staff && !!demo && demo.kind !== 'MOCKUP' && mayRecordReadiness(me, contract);
  const readiness = useDemoReadiness(demo ?? ({ id: '', readyAt: null } as Demo), contract.id, canRecord, step.locked);

  if (phase && !demo && staff && canBuild) {
    return (
      <div className="demo-step" data-testid="demo-panel" data-phase={phase.id}>
        <NotYet staff />
        <CreateDemo phase={phase} contractId={contract.id} />
      </div>
    );
  }
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

      {staff ? null : (
        <div data-testid="demo-viewport">
          <DemoViewport demo={demo} onFirstReport={readiness.record} />
        </div>
      )}

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

      {staff ? (
        <DemoSetup
          contract={contract}
          me={me}
          phase={phase}
          demo={demo}
          designOptions={contract.concepts.flatMap((c) => c.pages.map((p) => ({ id: p.id, label: `${c.key} · ${pick(p, 'label', locale)}` })))}
          editable={canBuild}
          canConvertToTicket={can(me, 'tickets.answer')}
          // A frame line or a note is not a Contract-shaped fact the cache can place (see the workspace's `refetch`).
          onChanged={() => void client.refetchQueries({ include: 'active' })}
        />
      ) : (
        <DemoFeedbackPanel
          demo={demo}
          contractId={contract.id}
          phaseId={phase.id}
          audience={audience}
          canAuthor={false}
          canAnswer={false}
          answerDirect={can(me, 'answers.direct.demo')}
          locked={step.locked}
          canApprove={audience === 'customer'}
          asCustomer={asCustomer}
          onChanged={() => undefined}
        />
      )}
    </div>
  );
}
