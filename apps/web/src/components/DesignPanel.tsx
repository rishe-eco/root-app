import { useState, type FormEvent } from 'react';
import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can, canAuthorDesign } from '@/lib/access';
import { formatCount, pick } from '@/lib/format';
import { chosenConcept, currentRevisionId, pathOfContract, paletteByKind, roundCounter } from '@/lib/design';
import {
  APPROVE_DESIGN,
  CHOOSE_CONCEPT,
  CONTRACT_FEEDBACK,
  REQUEST_OTHER_OPTIONS,
  SET_PAGE_APPROVAL,
  type Contract,
  type DesignConcept,
  type DesignPaletteItem,
  type FeedbackItem,
  type PageDesign,
} from '@/lib/queries';
import FeedbackPanel, { type FeedbackTarget } from '@/components/FeedbackPanel';
import DesignAuthor, { AllowanceBox, designError } from '@/components/DesignAuthor';
import { PaletteItemView, PaletteKindTitle } from '@/components/PaletteView';
import type { StepPanelProps } from '@/components/StepPanels';

/**
 * Step 4 — the design (journeys build plan J8), one panel for both sides.
 *
 * **Pre-made:** the customer sees a gallery of the round's themes — a preview
 * image, the name and vendor, an "open the demo" link, and *Choose* — and can ask
 * "show me other options". **Custom:** a wireframe per page with an approve
 * button, and the palette as swatches and type specimens in both scripts. Both
 * show "round 2 of 3" (the wizard's `iterationsUsed` / `allowance`), keep one
 * thread per theme, page and palette item plus the step's shared thread (the S2
 * model, through `FeedbackPanel`), and end in **Approve the design** — enabled
 * when the API's own `designMissing` is empty, and refused by `approveDesign`
 * on exactly that list.
 *
 * **A theme's demo is never framed.** Third-party demo sites refuse framing more
 * often than not and the portal's CSP does not allow them (plan J8's `frame-src`
 * trap, decided: preview image in the page, the demo in a new tab). The link
 * opens with `rel="noopener noreferrer"`: the vendor's page gets neither the
 * opener nor the referrer of a customer's private portal address.
 *
 * **Staff** see the same page. The assigned designer also gets the authoring
 * controls (`DesignAuthor`); sales reads it with feedback controls and, with
 * `contracts.author`, *Extend the allowance* (`AllowanceBox`). Whether a control
 * shows is `can()` and the assignment; whether it works is the API's.
 */

// --- the pre-made gallery ----------------------------------------------------------

function ThemeCard({
  contractId,
  concept,
  canChoose,
  onChanged,
}: {
  contractId: string;
  concept: DesignConcept;
  canChoose: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [choose, { loading }] = useMutation(CHOOSE_CONCEPT);
  const [error, setError] = useState<string | null>(null);
  const snapshot = concept.themeSnapshot;
  const name = snapshot?.name ?? pick(concept, 'label', locale);

  return (
    <div className="design-card" data-testid="theme-card" data-theme={name} data-chosen={concept.chosen ? 'true' : 'false'}>
      <div className="design-card-image">
        {concept.imageUrl ? <img src={concept.imageUrl} alt={name} /> : <span className="t-caption">{t('design.gallery.noPreview')}</span>}
      </div>
      <div className="design-card-body">
        <span className="design-theme-name">{name}</span>
        {snapshot?.vendor ? <span className="t-caption">{t('design.gallery.vendor', { vendor: snapshot.vendor })}</span> : null}
        <div className="workspace-row">
          {snapshot?.demoUrl ? (
            // Never framed; a new tab, with no opener and no referrer.
            <a className="btn btn-ghost btn-sm" href={snapshot.demoUrl} target="_blank" rel="noopener noreferrer" data-testid="theme-demo">
              {t('design.gallery.openDemo')}
            </a>
          ) : null}
          {concept.chosen ? (
            <span className="badge design-chosen" data-testid="theme-chosen">
              {t('design.gallery.chosen')}
            </span>
          ) : canChoose ? (
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={loading}
              data-testid="theme-choose"
              onClick={async () => {
                setError(null);
                try {
                  await choose({ variables: { contractId, conceptId: concept.id } });
                  onChanged();
                } catch (err) {
                  setError(designError(t, err));
                }
              }}
            >
              {t('design.gallery.choose')}
            </button>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}

// --- a custom page -------------------------------------------------------------------

function PageCard({ page, canApprove }: { page: PageDesign; canApprove: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [setApproval, { loading }] = useMutation(SET_PAGE_APPROVAL);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="design-card design-page-card" data-testid="page-card" data-key={page.key} data-approved={page.approved ? 'true' : 'false'}>
      <div className="design-card-image design-card-wide">
        {page.imageUrl ? <img src={page.imageUrl} alt={pick(page, 'label', locale)} /> : <span className="t-caption">{t('design.page.noImage')}</span>}
      </div>
      <div className="design-card-body">
        <span className="design-theme-name">{pick(page, 'label', locale)}</span>
        <div className="workspace-row">
          {page.approved ? <span className="badge design-chosen">{t('design.page.approved')}</span> : null}
          {canApprove ? (
            <button
              className={`btn btn-sm ${page.approved ? 'btn-ghost' : 'btn-primary'}`}
              type="button"
              disabled={loading}
              data-testid="page-approve"
              onClick={async () => {
                setError(null);
                try {
                  await setApproval({ variables: { pageDesignId: page.id, approved: !page.approved } });
                } catch (err) {
                  setError(designError(t, err));
                }
              }}
            >
              {page.approved ? t('design.page.unapprove') : t('design.page.approve')}
            </button>
          ) : null}
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}

// --- "show me other options" ---------------------------------------------------------

function OtherOptions({ contract, waiting, onChanged }: { contract: Contract; waiting: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [ask, { loading }] = useMutation(REQUEST_OTHER_OPTIONS);
  const [error, setError] = useState<string | null>(null);

  if (waiting) {
    return (
      <p className="t-small req-notice" data-testid="other-options-waiting">
        {t('design.other.waiting')}
      </p>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await ask({ variables: { contractId: contract.id, note: note.trim() || null } });
      setOpen(false);
      setNote('');
      onChanged();
    } catch (err) {
      setError(designError(t, err));
    }
  }

  return (
    <div className="design-other" data-testid="other-options">
      <p className="t-small desk-muted">{t('design.other.help')}</p>
      {open ? (
        <form className="feedback-comment-form" onSubmit={submit}>
          <label className="label" htmlFor="other-note">
            {t('design.other.noteLabel')}
          </label>
          <textarea id="other-note" className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid="other-note" />
          <div className="workspace-row">
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading} data-testid="other-send">
              {t('design.other.send')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
              {t('feedback.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => setOpen(true)} data-testid="other-open">
          {t('design.other.action')}
        </button>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

// --- approving ---------------------------------------------------------------------

function ApproveDesign({ contract, missing }: { contract: Contract; missing: string[] }) {
  const { t } = useTranslation();
  const [approve, { loading }] = useMutation(APPROVE_DESIGN);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="feedback-approve" data-testid="design-approve">
      <p className="t-small">{t('design.approve.help')}</p>
      {missing.length > 0 ? (
        <ul className="design-missing" data-testid="design-missing">
          {missing.map((code) => (
            <li key={code} className="t-caption" data-code={code}>
              {t(`design.approve.blocked.${code}`, { defaultValue: code })}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="workspace-row">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={loading || missing.length > 0}
          data-testid="approve-design"
          onClick={async () => {
            setError(null);
            try {
              await approve({ variables: { contractId: contract.id } });
            } catch (err) {
              setError(designError(t, err));
            }
          }}
        >
          {t('design.approve.action')}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert" data-testid="approve-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// --- the panel ---------------------------------------------------------------------

export default function DesignPanel({ contract, step, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const staff = audience === 'staff';
  const path = pathOfContract(contract);

  const client = useApolloClient();
  const { data } = useQuery<{ contract: { id: string; feedbackItems: FeedbackItem[] } }>(CONTRACT_FEEDBACK, {
    variables: { id: contract.id, step: 'DESIGN', phaseId: null, asCustomer: asCustomer || null },
    fetchPolicy: 'cache-and-network',
  });
  const items = data?.contract.feedbackItems ?? [];
  // A note or an answer moves state the panel draws from elsewhere (the ask marker,
  // the status area) and neither mutation returns a Contract.
  const refresh = () => void client.refetchQueries({ include: 'active' });

  const counter = roundCounter(step);
  const revisionId = currentRevisionId(contract);
  const concepts = contract.concepts;
  const palette = contract.palette ?? [];
  const missing = contract.designMissing ?? [];
  const customerActs = !staff && !step.locked && !asCustomer;

  if (step.status === 'UPCOMING') {
    return (
      <p className="t-small desk-muted" data-testid="design-not-open">
        {t('design.notOpen')}
      </p>
    );
  }

  const roundLine =
    counter.used === 0
      ? t('design.noRound')
      : counter.total === null
        ? t('design.roundOpen', { n: formatCount(counter.used, locale) })
        : t('design.round', { n: formatCount(counter.used, locale), total: formatCount(counter.total, locale) });

  // --- the targets the round's threads hang on ---
  const targets: FeedbackTarget[] = [];
  const anchor = (extra: object) => ({ designRevisionId: revisionId!, ...extra });
  const itemFor = (pick_: (i: FeedbackItem) => boolean) => items.find(pick_) ?? null;

  if (revisionId && path === 'PREMADE') {
    concepts.forEach((concept, i) => {
      targets.push({
        key: `concept:${concept.id}`,
        group: i === 0 ? t('design.gallery.title') : undefined,
        label: <ThemeCard contractId={contract.id} concept={concept} canChoose={customerActs} onChanged={refresh} />,
        input: anchor({ conceptId: concept.id }),
        item: itemFor((x) => x.conceptId === concept.id),
      });
    });
  }
  if (revisionId && path === 'CUSTOM') {
    const pages = concepts.flatMap((c) => c.pages);
    pages.forEach((page, i) => {
      targets.push({
        key: `page:${page.id}`,
        group: i === 0 ? t('design.page.title') : undefined,
        label: <PageCard page={page} canApprove={customerActs} />,
        input: anchor({ pageDesignId: page.id }),
        item: itemFor((x) => x.pageDesignId === page.id),
      });
    });
    const byKind = paletteByKind(palette);
    let first = true;
    for (const kind of ['COLOR', 'FONT', 'LOGO_USAGE'] as const) {
      byKind[kind].forEach((item: DesignPaletteItem, i) => {
        targets.push({
          key: `palette:${item.id}`,
          group: first ? t('design.palette.title') : undefined,
          label: (
            <div className="design-palette-target">
              {i === 0 ? <PaletteKindTitle kind={kind} /> : null}
              <PaletteItemView item={item} />
            </div>
          ),
          input: anchor({ paletteItemId: item.id }),
          item: itemFor((x) => x.paletteItemId === item.id),
        });
        first = false;
      });
    }
  }
  const general = items.find((i) => i.general) ?? null;
  const asked = general?.otherOptionsAskedAt != null;
  const hasRound = revisionId !== null;
  const done = step.locked;

  return (
    <div className="design-step" data-testid="design-panel" data-path={path ?? 'NONE'}>
      <div className="design-head">
        <span className="badge design-round" data-testid="design-round">
          {roundLine}
        </span>
      </div>
      <p className="t-small desk-muted">
        {path === null
          ? ''
          : staff
            ? t(path === 'PREMADE' ? 'design.lede.staffPremade' : 'design.lede.staffCustom')
            : t(path === 'PREMADE' ? 'design.lede.customerPremade' : 'design.lede.customerCustom')}
      </p>

      {staff && path ? (
        <>
          <AllowanceBox contract={contract} step={step} me={me} />
          <DesignAuthor contract={contract} step={step} me={me} path={path} />
          {!canAuthorDesign(me, contract) ? <p className="t-caption desk-muted" data-testid="design-read-only">{t('design.readOnly')}</p> : null}
        </>
      ) : null}

      {!hasRound || path === null ? (
        <p className="t-small desk-muted" data-testid="design-empty">
          {staff ? t('design.empty.staff') : t('design.empty.customer')}
        </p>
      ) : (
        <>
          {path === 'PREMADE' && !chosenConcept(concepts) && !done && !staff ? (
            <p className="t-caption" data-testid="none-chosen">
              {t('design.gallery.noneChosen')}
            </p>
          ) : null}
          {path === 'PREMADE' ? <p className="t-caption">{t('design.gallery.note')}</p> : <p className="t-caption">{t('design.palette.specimenNote')}</p>}
          <FeedbackPanel
            contractId={contract.id}
            step="DESIGN"
            targets={targets}
            generalItem={general}
            canRaise={customerActs}
            canAnswer={staff && can(me, 'feedback.answer')}
            answerDirect={can(me, 'answers.direct.design')}
            locked={done}
            onChanged={refresh}
            onAnswered={refresh}
          />
          {path === 'PREMADE' && customerActs ? <OtherOptions contract={contract} waiting={asked} onChanged={refresh} /> : null}
          {customerActs ? <ApproveDesign contract={contract} missing={missing} /> : null}
          {done ? (
            <p className="t-small locknote" data-testid="design-approved">
              {t('design.approve.done')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
