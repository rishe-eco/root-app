import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import type { Contract, User, WizardStep } from '@/lib/queries';
import { pick } from '@/lib/format';
import { defaultStep, sameStep, showBuildTimeline } from '@/lib/wizard';
import StatusArea from '@/components/StatusArea';
import StepList from '@/components/StepList';
import BuildTimeline from '@/components/BuildTimeline';
import StepPanel from '@/components/StepPanels';
import Timeline from '@/components/Timeline';
import { CommitmentsCard, OriginRequestCard } from '@/components/RailCards';
import ViewAsBanner, { ReadOnlyScope } from '@/components/ViewAsBanner';
import Topbar from './Topbar';

/**
 * The customer's contract for a new-road (`AGREEMENT_FIRST`) contract
 * (journeys build plan J3): the status area, the step list, and one panel — the
 * step selected in the list, which opens on the current one. `ContractDetail`
 * renders this for that road and its own sections for the legacy one.
 *
 * What is in each panel is `components/StepPanels.tsx`'s registry, filled in
 * stage by stage (J4–J11); until then a step says it is not available yet.
 * The rail is the new road's: the same commitments and origin-request cards the
 * legacy page has, and the derived timeline in place of `changeLog`.
 */
export default function Wizard({ contract, me, asCustomer }: { contract: Contract; me: User; asCustomer: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const wizard: WizardStep[] = contract.wizard ?? [];
  // Pinned to the step the page opened on (J4), for the same reason as the desk's
  // Steps tab: a panel that swaps itself when its step is finished is a panel
  // the reader loses. Opening still lands on the current step.
  const [picked, setPicked] = useState<WizardStep | null>(() => defaultStep(wizard));
  // Re-resolved against the live wizard on every render, so a step that just
  // changed state (an approval landed) shows its new state, not a stale copy.
  const selected = wizard.find((s) => sameStep(s, picked)) ?? defaultStep(wizard);
  const title = pick(contract, 'title', locale);
  const viewerId = asCustomer ? contract.customer.id : me.id;

  return (
    <>
      {asCustomer ? (
        <ViewAsBanner contract={contract} />
      ) : (
        <Topbar
          user={me}
          start={
            <div className="crumb">
              <Link to={lp(locale, '/app/contracts')}>{t('portal.navContracts')}</Link>
              <span>/</span>
              <span className="crumb-now">{title}</span>
            </div>
          }
        />
      )}

      <ReadOnlyScope on={asCustomer}>
        <div className="detail">
          <div className="detail-main" data-testid="wizard">
            <div className="detail-head">
              <div className="detail-head-row">
                <h1 className="t-h2">{title}</h1>
              </div>
              <p className="t-lead">
                {contract.customer.clientName ?? contract.customer.name} · <span className="num-latin">{contract.ref}</span>
              </p>
            </div>

            <StatusArea contract={contract} audience="customer" />
            <StepList steps={wizard} selected={selected} onSelect={setPicked} />
            {/* J10 (Q22): the build, between the design's approval and the end — each phase with
                the versions Root has shown. Derived on the API; nothing here is typed by hand. */}
            {showBuildTimeline(wizard, contract.buildTimeline ?? []) ? <BuildTimeline entries={contract.buildTimeline ?? []} /> : null}
            {selected ? <StepPanel contract={contract} step={selected} audience="customer" me={me} asCustomer={asCustomer} /> : null}
          </div>

          <aside className="rail">
            <CommitmentsCard contract={contract} />
            <OriginRequestCard contract={contract} meId={viewerId} />
            <Timeline items={contract.timeline ?? []} audience="customer" />
          </aside>
        </div>
      </ReadOnlyScope>
    </>
  );
}
