import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { Contract, StepKind, User, WizardStep } from '@/lib/queries';
import { instantDate } from '@/lib/format';
import { stepLabel, type Audience } from '@/lib/wizard';
import Lock from '@/components/Lock';
import RequirementsPanel from '@/components/RequirementsPanel';
import ScopePanel from '@/components/ScopePanel';
import DraftPanel from '@/components/DraftPanel';
import AgreementPanel from '@/components/AgreementPanel';
import DesignPanel from '@/components/DesignPanel';
import SummaryPanel from '@/components/SummaryPanel';
import MockupPanel from '@/components/MockupPanel';
import DemoPanel from '@/components/DemoPanel';

/**
 * One panel per wizard step (journeys build plan J3) — the portal's wizard and
 * the desk's Steps tab both render a step through `StepPanel`, so a step has
 * one body, seen by the customer and authored by staff with the same component
 * (author controls decided by `audience` and `me.capabilities`, the way every
 * desk tab already is).
 *
 * Until a stage fills a step in, its panel says so honestly ("not available
 * yet") rather than showing nothing.
 *
 * ## How a later stage extends this file
 *
 * Register the stage's panel in `PANELS` below — one line each:
 *
 * - J4  `REQUIREMENTS` — ✔ built: the brief as read-only cards with a note on every
 *   field (`RequirementsPanel`), and for staff the form above them
 *   (`RequirementsEditor`)
 * - J5  `SCOPE`        — ✔ built: pages, features and deliverables, the customer's
 *   proposals and Root's decisions (`ScopePanel`)
 * - J6  `DRAFT`        — ✔ built: the published draft article by article with its
 *   anchored notes and where each note's article is now (`DraftPanel`)
 * - J7  `AGREEMENT`    — ✔ built: the snapshot as a document, then Approve and Sign on one
 *   screen (`AgreementPanel`); approval locks steps 1–3
 * - J8  `DESIGN`       — ✔ built: a gallery of themes (pre-made) or wireframes and a
 *   palette (custom), the round counter, and approving the design (`DesignPanel`,
 *   the designer's half in `DesignAuthor`)
 * - J9  `MOCKUP`       — ✔ built (J9b): the mockup browsed in the portal's viewport, a
 *   note per page, "mockup 2 of 3", and approving it (`MockupPanel`; the designer's
 *   half — upload, declare, map, publish — in `MockupAuthor`)
 * - J10 `DEMO`         — ✔ built: one phase's demo in the viewport, "version 2 of 3", a note per
 *   page, and the customer's approval of that phase (`DemoPanel`); the developer's half —
 *   readiness, the page map, each version — is `DemoSubmission`, in the desk's Phases tab
 * - J11 `SUMMARY`      — ✔ built: the record (`SummaryDocument`), and for staff the handover and the close (`SummaryPanel`)
 *
 * A panel gets the contract (with `wizard`, `statusSummary`, `attention`
 * already loaded by `WizardFields`), its own `WizardStep`, who is reading, and
 * `me`. It must respect `step.locked` (the API refuses an edit to a locked
 * step with `STEP_LOCKED`, but a control that can only fail is worse than one
 * that is not there) and must not read `Contract.status`.
 */

export type StepPanelProps = {
  contract: Contract;
  step: WizardStep;
  audience: Audience;
  me: User;
  /** Reading through "view as customer": a panel that fetches something of its
   *  own (a step's feedback) asks the API as the customer would be asked, so a
   *  pending answer is as invisible here as on the customer's own screen. */
  asCustomer?: boolean;
};

const PANELS: Partial<Record<StepKind, ComponentType<StepPanelProps>>> = {
  REQUIREMENTS: RequirementsPanel,
  SCOPE: ScopePanel,
  DRAFT: DraftPanel,
  AGREEMENT: AgreementPanel,
  DESIGN: DesignPanel,
  SUMMARY: SummaryPanel,
  MOCKUP: MockupPanel,
  DEMO: DemoPanel,
};

function NotYet({ step, audience }: Pick<StepPanelProps, 'step' | 'audience'>) {
  const { t } = useTranslation();
  if (step.status === 'DONE') {
    return <p className="t-small desk-muted">{t('wizard.panel.doneNote')}</p>;
  }
  if (step.step === 'SUMMARY') {
    return <p className="t-small desk-muted">{t('wizard.panel.summaryNote')}</p>;
  }
  return (
    <div className="step-notyet" data-testid="step-not-yet">
      <Lock />
      <div>
        <p className="step-notyet-title">{t('wizard.panel.notYetTitle')}</p>
        <p className="t-small desk-muted">
          {audience === 'customer' ? t('wizard.panel.notYetCustomer') : t('wizard.panel.notYetStaff')}
        </p>
      </div>
    </div>
  );
}

export default function StepPanel(props: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { step } = props;
  const Panel = PANELS[step.step];

  return (
    <section className="step-panel" data-testid="step-panel" data-step={step.step} data-status={step.status}>
      <header className="step-panel-head">
        <h2 className="t-h3">{stepLabel(t, locale, step)}</h2>
        <span className={`step-chip step-chip-${step.status.toLowerCase()}`}>{t(`wizard.state.${step.status}`)}</span>
      </header>
      {step.locked && step.lockedAt ? (
        <p className="locknote">
          <Lock />
          <span>{t('wizard.lockedSince', { when: instantDate(step.lockedAt, locale) })}</span>
        </p>
      ) : null}
      {Panel ? <Panel {...props} /> : <NotYet step={step} audience={props.audience} />}
    </section>
  );
}
