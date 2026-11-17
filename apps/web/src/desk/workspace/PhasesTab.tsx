import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can, canAuthorBuild } from '@/lib/access';
import { pick, formatCount, calendarDate } from '@/lib/format';
import {
  CREATE_PHASE,
  UPDATE_PHASE,
  DELETE_PHASE,
  ASSIGN_SCOPE_ITEM_TO_PHASE,
  CREATE_DEMO,
  type Contract,
  type Phase,
  type User,
  type ScopeItem,
} from '@/lib/queries';
import DemoSetup from '@/components/DemoSetup';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';
import { useWorkspaceMutation, type WorkspaceContext } from './ContractWorkspace';

/**
 * The desk phase board (build plan L2; spec §4 stage 6, §6) — Root's own
 * surface for shaping phases, attaching a live demo to one, and declaring the
 * page list a reported path is matched against (lib/demoPages.ts). The
 * portal never sees this screen; it sees `Project.progress` (derived,
 * lib/phase.ts) and the same `DemoViewport` this tab uses to preview a demo
 * before telling the customer about it.
 */

// House rule 6: this codebase's existing, uneven convention is `err.message`
// straight from the server (see ScopeTab.tsx). The one exception carved out
// here is the staging-URL validation this stage explicitly calls for — the
// server returns a code, and this is where it becomes a sentence.
const KNOWN_ERROR_CODES = new Set(['STAGING_NOT_HTTPS', 'INVALID_STAGING_URL', 'STAGING_HOST_NOT_ALLOWED', 'STEP_LOCKED']);

/** Structural rather than i18next's TFunction — same reasoning as lib/changelog.ts's T. */
type T = (key: string, opts?: Record<string, unknown>) => string;

function errorMessage(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  if (code && KNOWN_ERROR_CODES.has(code)) return t(`workspace.demoError.${code}`, { example: 'nahal.staging.m-root.com' });
  return (err as { message?: string })?.message ?? String(err);
}

type PageDesignOption = { id: string; label: string };

function PhaseCard({
  phase,
  unassignedItems,
  designOptions,
  canManagePhases,
  canBuild,
  canConvertToTicket,
  onChanged,
  contract,
  me,
}: {
  contract: Contract;
  me: User;
  phase: Phase;
  unassignedItems: ScopeItem[];
  designOptions: PageDesignOption[];
  /** contracts.author — the phase itself and which scope items sit in it. */
  canManagePhases: boolean;
  /** builds.author plus being this contract's developer (canAuthorBuild) —
   *  the demos and declared pages underneath the phase. */
  canBuild: boolean;
  canConvertToTicket: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [titleFa, setTitleFa] = useState(phase.titleFa);
  const [titleEn, setTitleEn] = useState(phase.titleEn);
  const [milestoneLabel, setMilestoneLabel] = useState(phase.milestoneLabel ?? '');
  const [update] = useWorkspaceMutation(UPDATE_PHASE);
  const [remove] = useWorkspaceMutation(DELETE_PHASE);
  const [assign] = useWorkspaceMutation(ASSIGN_SCOPE_ITEM_TO_PHASE);

  const [addingDemo, setAddingDemo] = useState(false);
  const [stagingUrl, setStagingUrl] = useState('');
  const [demoError, setDemoError] = useState<string | null>(null);
  const [createDemo, { loading: creatingDemo }] = useWorkspaceMutation(CREATE_DEMO);

  const [pickedItem, setPickedItem] = useState('');

  // DX4 (review 27): the edit form saves when a field is left; `updatePhase` takes the title and the
  // milestone together.
  const autosave = useAutosave({
    value: { titleFa, titleEn, milestoneLabel },
    baseline: { titleFa: phase.titleFa, titleEn: phase.titleEn, milestoneLabel: phase.milestoneLabel ?? '' },
    valid: (v) => hasOneTitle(v.titleFa, v.titleEn),
    save: (v) => update({ variables: { phaseId: phase.id, titleFa: v.titleFa, titleEn: v.titleEn, milestoneLabel: v.milestoneLabel || null } }),
    errorText: (err) => errorMessage(err, t),
  });

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeletePhase'))) return;
    await remove({ variables: { phaseId: phase.id } });
  }

  async function onAssign() {
    if (!pickedItem) return;
    await assign({ variables: { scopeItemId: pickedItem, phaseId: phase.id } });
    setPickedItem('');
  }

  async function onUnassign(itemId: string) {
    await assign({ variables: { scopeItemId: itemId, phaseId: null } });
  }

  async function onCreateDemo(e: FormEvent) {
    e.preventDefault();
    setDemoError(null);
    try {
      await createDemo({ variables: { phaseId: phase.id, stagingUrl } });
      setAddingDemo(false);
      setStagingUrl('');
    } catch (err) {
      setDemoError(errorMessage(err, t));
    }
  }

  return (
    <div className="card phase-card">
      <div className="phase-card-head">
        <span className="t-h3">
          <span className="num-latin">{formatCount(phase.number, locale)}</span> ·{' '}
          {pick(phase, 'title', locale)}
        </span>
        {canManagePhases ? (
          <div className="workspace-row" style={{ gap: '0.5rem' }}>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing((v) => !v)}>
              {t('workspace.edit')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete}>
              {t('workspace.delete')}
            </button>
          </div>
        ) : null}
      </div>

      {phase.milestoneLabel ? <p className="t-caption">{phase.milestoneLabel}</p> : null}
      {phase.plannedEndAt ? (
        <p className="t-caption" data-testid="phase-planned-end">
          {t('brief.phases.endsOn', { date: calendarDate(phase.plannedEndAt, locale) })}
        </p>
      ) : null}

      {editing && canManagePhases ? (
        <form className="card editor-card auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
          <TitleField
            idBase={`phase-card-${phase.number}`}
            testId="phase-card-title"
            fa={titleFa}
            en={titleEn}
            onChange={(v) => {
              setTitleFa(v.fa);
              setTitleEn(v.en);
            }}
          />
          <div className="field">
            <label className="label">{t('workspace.phaseMilestone')}</label>
            <input className="input" value={milestoneLabel} onChange={(e) => setMilestoneLabel(e.target.value)} />
          </div>
          <AutosaveNote autosave={autosave} testId="phase-card-autosave" />
        </form>
      ) : null}

      <div>
        <p className="t-eyebrow">{t('workspace.phaseScopeItems')}</p>
        <div className="workspace-row" style={{ flexWrap: 'wrap' }}>
          {phase.scopeItems.length === 0 ? (
            <span className="t-small muted">{t('workspace.phaseNoItems')}</span>
          ) : (
            phase.scopeItems.map((i) => (
              <span key={i.id} className="badge">
                {pick(i, 'label', locale)}
                {canManagePhases ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={t('workspace.phaseUnassign')}
                    onClick={() => onUnassign(i.id)}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))
          )}
        </div>
        {unassignedItems.length > 0 && canManagePhases ? (
          <div className="workspace-row">
            <select className="input" value={pickedItem} onChange={(e) => setPickedItem(e.target.value)}>
              <option value="">{t('workspace.phasePickItem')}</option>
              {unassignedItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {pick(i, 'label', locale)}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onAssign} disabled={!pickedItem}>
              {t('workspace.phaseAssign')}
            </button>
          </div>
        ) : null}
      </div>

      <div>
        <div className="workspace-row">
          <p className="t-eyebrow">{t('workspace.demosTitle')}</p>
          {canBuild ? (
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingDemo((v) => !v)}>
              {t('workspace.addDemo')}
            </button>
          ) : null}
        </div>

        {addingDemo && canBuild ? (
          <form className="card editor-card auth-form" onSubmit={onCreateDemo}>
            <div className="field">
              <label className="label">{t('workspace.demoStagingUrl')}</label>
              <input
                className="input num-latin"
                dir="ltr"
                required
                placeholder="https://…"
                value={stagingUrl}
                onChange={(e) => setStagingUrl(e.target.value)}
              />
            </div>
            {demoError ? <p className="error">{demoError}</p> : null}
            <div>
              <button className="btn btn-primary btn-sm" type="submit" disabled={creatingDemo}>
                {t('workspace.save')}
              </button>
            </div>
          </form>
        ) : null}

        {phase.demos.length === 0 ? (
          <p className="t-small muted">{t('workspace.phaseNoDemo')}</p>
        ) : (
          phase.demos.map((d) => (
            <DemoSetup
              key={d.id}
              contract={contract}
              me={me}
              phase={phase}
              demo={d}
              designOptions={designOptions}
              editable={canBuild}
              canConvertToTicket={canConvertToTicket}
              onChanged={onChanged}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default function PhasesTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { contract, refetch, me } = useOutletContext<WorkspaceContext>();
  const project = contract.project;
  // Journeys build plan S1: the phase itself is contracts.author (part of
  // the agreement); the demos and declared pages under it are builds.author
  // plus being this contract's own developer (canAuthorBuild) — the plan's
  // guard-mapping table splits `admin/phases.ts` exactly this way.
  const canManagePhases = can(me, 'contracts.author');
  const canBuild = canAuthorBuild(me, contract);
  const canConvertToTicket = can(me, 'tickets.answer');

  const [adding, setAdding] = useState(false);
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createPhase, { loading }] = useMutation(CREATE_PHASE);

  if (!project) {
    return <p className="t-small muted">{t('workspace.phaseNoProject')}</p>;
  }

  // This contract's phases (J4, PD-5): the project holds every contract's, and a
  // board that listed them all would let a designer edit another contract's demos.
  const phases = project.phases.filter((p) => p.contractId === contract.id).sort((a, b) => a.number - b.number);
  const nextNumber = phases.length === 0 ? 1 : Math.max(...phases.map((p) => p.number)) + 1;
  const unassignedItems = contract.scopeItems.filter((i) => i.phaseId === null);

  const designOptions: PageDesignOption[] = contract.concepts.flatMap((c) =>
    c.pages.map((p) => ({ id: p.id, label: `${c.key} · ${pick(p, 'label', locale)}` })),
  );

  const progress = project.progress;

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createPhase({ variables: { contractId: contract.id, number: nextNumber, titleFa, titleEn } });
      setAdding(false);
      setTitleFa('');
      setTitleEn('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="phase-board">
      {/* The same derived read the portal shows — F5's own trap: never a
          hand-typed percentage. Shown here too so Root sees exactly what the
          customer sees, not a second, drifting number. */}
      <div className="phase-progress-line">
        <span className="t-eyebrow">{t('workspace.phaseProgressLabel')}</span>
        <span className="t-small">
          {progress.totalPhases === 0
            ? t('demo.progress.none')
            : t('demo.progress.line', {
                current: progress.currentPhaseNumber,
                total: progress.totalPhases,
                n: formatCount(progress.currentPhaseNumber ?? 0, locale),
                nTotal: formatCount(progress.totalPhases, locale),
              })}
        </span>
      </div>

      <div className="workspace-row">
        <h3 className="t-h3">{t('workspace.phasesTitle')}</h3>
        {canManagePhases ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding((v) => !v)}>
            {t('workspace.addPhase')}
          </button>
        ) : null}
      </div>

      {adding && canManagePhases ? (
        <form className="card editor-card auth-form" onSubmit={onAdd}>
          <TitleField idBase="phase-add" testId="phase-add-title" fa={titleFa} en={titleEn} onChange={(v) => { setTitleFa(v.fa); setTitleEn(v.en); }} />
          {error ? <p className="error">{error}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading || !hasOneTitle(titleFa, titleEn)}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      {phases.length === 0 ? (
        <p className="t-small muted">{t('workspace.phasesEmpty')}</p>
      ) : (
        phases.map((phase) => (
          <PhaseCard
            key={phase.id}
            phase={phase}
            unassignedItems={unassignedItems}
            designOptions={designOptions}
            canManagePhases={canManagePhases}
            canBuild={canBuild}
            canConvertToTicket={canConvertToTicket}
            onChanged={refetch}
            contract={contract}
            me={me}
          />
        ))
      )}
    </div>
  );
}
