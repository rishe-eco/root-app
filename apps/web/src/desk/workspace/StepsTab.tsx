import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { WizardStep } from '@/lib/queries';
import { defaultStep, sameStep } from '@/lib/wizard';
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
  const [picked, setPicked] = useState<WizardStep | null>(() => defaultStep(wizard));
  const selected = wizard.find((s) => sameStep(s, picked)) ?? defaultStep(wizard);

  return (
    <>
      <StepList steps={wizard} selected={selected} onSelect={setPicked} />
      {selected ? <StepPanel contract={contract} step={selected} audience="staff" me={me} /> : null}
    </>
  );
}
