import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import type { WizardStep } from '@/lib/queries';
import { defaultStep, sameStep, stepFromParams } from '@/lib/wizard';
import StepList from '@/components/StepList';
import StepPanel from '@/components/StepPanels';
import type { WorkspaceContext } from './ContractWorkspace';

/**
 * The desk's view of the new road's steps (journeys build plan J3): the same
 * step list and the same panels the customer's wizard renders, here with
 * `audience="staff"` — the panel decides its author controls from `me`'s
 * capabilities, as every desk tab does. Only `AGREEMENT_FIRST` contracts have
 * this tab; a legacy contract's steps are the tabs beside it (Design, Contract,
 * Phases), unchanged.
 *
 * Each stage that fills a step in (J4–J11) registers its panel in
 * `components/StepPanels.tsx`, and it appears here and in the portal at once.
 */
export default function StepsTab() {
  const { contract, me } = useOutletContext<WorkspaceContext>();
  const wizard: WizardStep[] = contract.wizard ?? [];
  // Pinned to the step the tab opened on (J4): a step that becomes done while its
  // form is on screen — the brief, once nothing is missing — must not swap the
  // panel out from under the person still using it. The road still moves on
  // (the list marks the new current step); the panel follows the click.
  // A link from My work names the step (`?step=MOCKUP&phase=…`, J12) and opens on it.
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<WizardStep | null>(() => stepFromParams(wizard, params) ?? defaultStep(wizard));
  const selected = wizard.find((s) => sameStep(s, picked)) ?? defaultStep(wizard);
  // The "what's next" line (DX1) links to this tab with a step in the address; when the tab is already open the
  // address changes and the panel must follow it — the initial state above only ever read it once.
  useEffect(() => {
    const named = stepFromParams(wizard, params);
    if (named) setPicked(named);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  return (
    <>
      {/* DX1 (desk UX review 21, 22, 31): the pill you are on stands out, and each says where its step stands. */}
      <StepList
        steps={wizard}
        selected={selected}
        onSelect={setPicked}
        nextMoveOn={contract.statusSummary?.nextMoveOn ?? null}
        briefMissing={contract.briefCompleteness?.length ?? 0}
        planMissing={contract.planCompleteness?.length ?? 0}
      />
      {selected ? <StepPanel contract={contract} step={selected} audience="staff" me={me} /> : null}
    </>
  );
}
