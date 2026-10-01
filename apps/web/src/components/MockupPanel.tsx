import { useEffect, useState } from 'react';
import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can, canAuthorDesign } from '@/lib/access';
import { formatCount, pick } from '@/lib/format';
import { isExhausted, roundCounter } from '@/lib/design';
import {
  APPROVE_MOCKUP,
  CONTRACT_FEEDBACK,
  CONTRACT_MOCKUP,
  MOCKUP_VIEW_URL,
  type Demo,
  type FeedbackItem,
} from '@/lib/queries';
import FeedbackPanel, { type FeedbackTarget } from '@/components/FeedbackPanel';
import DemoViewport from '@/components/DemoViewport';
import MockupAuthor, { mockupError } from '@/components/MockupAuthor';
import { AllowanceBox } from '@/components/DesignAuthor';
import type { StepPanelProps } from '@/components/StepPanels';

/**
 * Step 5 — the mockup (journeys build plan J9b), one panel for both sides.
 *
 * The customer browses the current iteration **inside the portal**, in the same
 * viewport the staging demo uses (`DemoViewport`), over the viewer's own grant
 * URL (`mockupViewUrl`): a real page on its own `*.mockup` subdomain, so the
 * mockup's own root-relative links work. They comment per page — and on the
 * frame's lines, "new" and "still missing" — in the one feedback model (S2,
 * through `FeedbackPanel`), see each note's fate once an iteration answers it, and
 * end in **Approve the mockup**, which the API refuses while any note is open
 * (`approveMockup`). "Mockup 2 of 3" is the wizard's own count.
 *
 * **The fixed line** — "a mockup: no real data, nothing is saved" — is a code from
 * the API worded here from the locale files (`mockup.fixed.*`), never a sentence
 * the designer typed or the database stored.
 *
 * **Staff** see the same page. The contract's designer also gets the authoring
 * controls (`MockupAuthor`: upload, declare, map, publish); sales reads it with
 * feedback controls and, with `contracts.author`, *Extend the allowance*. Whether
 * a control shows is `can()` and the assignment; whether it works is the API's.
 *
 * A draft iteration cannot be previewed here: the mockup host serves only a
 * published build (J9a), so the designer's first look at an iteration in the
 * portal is the moment the customer gets it.
 */

type MockupData = { contract: { id: string; mockup: Demo | null } };

const KIND_ORDER = ['NEW', 'KNOWN_MISSING'] as const;

function ApproveMockup({ contractId, canApprove }: { contractId: string; canApprove: boolean }) {
  const { t } = useTranslation();
  const [approve, { loading }] = useMutation(APPROVE_MOCKUP);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="feedback-approve" data-testid="mockup-approve">
      <p className="t-small">{t('mockup.approve.help')}</p>
      <div className="workspace-row">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={loading || !canApprove}
          data-testid="approve-mockup"
          onClick={async () => {
            setError(null);
            try {
              await approve({ variables: { contractId } });
            } catch (err) {
              setError(mockupError(t, err));
            }
          }}
        >
          {t('mockup.approve.action')}
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

/** The viewer's grant URL for the demo's current published iteration; refetched when a newer one is out. */
function useViewUrl(demoId: string | null, published: number): string | null {
  const { data, refetch } = useQuery<{ mockupViewUrl: string }>(MOCKUP_VIEW_URL, {
    variables: { demoId },
    skip: !demoId || published === 0,
    // A URL is a credential with an expiry: never serve a cached one.
    fetchPolicy: 'network-only',
  });
  useEffect(() => {
    if (demoId && published > 0) void refetch();
  }, [demoId, published, refetch]);
  return data?.mockupViewUrl ?? null;
}

export default function MockupPanel({ contract, step, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const staff = audience === 'staff';
  const client = useApolloClient();

  const { data, refetch: refetchMockup } = useQuery<MockupData>(CONTRACT_MOCKUP, {
    variables: { id: contract.id, asCustomer: asCustomer || null },
    fetchPolicy: 'cache-and-network',
  });
  const { data: feedback, refetch: refetchFeedback } = useQuery<{ contract: { id: string; feedbackItems: FeedbackItem[] } }>(CONTRACT_FEEDBACK, {
    variables: { id: contract.id, step: 'MOCKUP', phaseId: null, asCustomer: asCustomer || null },
    fetchPolicy: 'cache-and-network',
  });
  const demo = data?.contract.mockup ?? null;
  const items = feedback?.contract.feedbackItems ?? [];
  const published = (demo?.builds ?? []).filter((b) => b.publishedAt !== null).length;
  const viewUrl = useViewUrl(demo?.id ?? null, published);

  // A note, an answer, an upload or a publish moves state drawn from several
  // places (the counter, the status area, the frame) and not every mutation
  // returns a Contract.
  const refresh = () => {
    void refetchMockup();
    void refetchFeedback();
    void client.refetchQueries({ include: 'active' });
  };

  const counter = roundCounter(step);
  const canAuthor = staff && canAuthorDesign(me, contract);
  const customerActs = !staff && !step.locked && !asCustomer;

  if (step.status === 'UPCOMING') {
    return (
      <p className="t-small desk-muted" data-testid="mockup-not-open">
        {t('mockup.notOpen')}
      </p>
    );
  }

  const roundLine =
    published === 0
      ? t('mockup.noIteration')
      : counter.total === null
        ? t('mockup.iterationOpen', { n: formatCount(counter.used, locale) })
        : t('mockup.iteration', { n: formatCount(counter.used, locale), total: formatCount(counter.total, locale) });

  // --- the targets the iteration's threads hang on ---
  const targets: FeedbackTarget[] = [];
  const lines = [...(demo?.frame?.lines ?? [])]
    .filter((l) => (KIND_ORDER as readonly string[]).includes(l.kind))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind as 'NEW') - KIND_ORDER.indexOf(b.kind as 'NEW') || a.position - b.position);
  if (demo) {
    for (const line of lines) {
      targets.push({
        key: `line:${line.id}`,
        group: t(`mockup.kind.${line.kind}`),
        label: pick(line, 'text', locale),
        input: { demoId: demo.id, frameLineId: line.id },
        item: items.find((i) => i.frameLine?.id === line.id) ?? null,
      });
    }
    demo.pages.forEach((page, index) => {
      targets.push({
        key: `page:${page.id}`,
        group: index === 0 ? t('feedback.pagesTitle') : undefined,
        label: pick(page, 'label', locale),
        input: { demoId: demo.id, demoPageId: page.id },
        item: items.find((i) => i.demoPage?.id === page.id) ?? null,
      });
    });
  }
  const general = items.find((i) => i.general) ?? null;
  const openItems = items.filter((i) => i.status === 'OPEN');

  return (
    <div className="mockup-step design-step" data-testid="mockup-panel">
      <div className="design-head">
        <span className="badge design-round" data-testid="mockup-iteration">
          {roundLine}
        </span>
      </div>
      <p className="t-small desk-muted">{staff ? t('mockup.lede.staff') : t('mockup.lede.customer')}</p>

      {staff ? (
        <>
          {can(me, 'contracts.author') || canAuthor ? (
            <div data-testid="mockup-allowance">
              <AllowanceBox contract={contract} step={step} me={me} kind="MOCKUP" />
            </div>
          ) : null}
          {canAuthor ? (
            <MockupAuthor
              contractId={contract.id}
              demo={demo}
              openItems={openItems}
              locked={step.locked}
              exhausted={isExhausted(counter)}
              onChanged={refresh}
            />
          ) : (
            <p className="t-caption desk-muted" data-testid="mockup-read-only">
              {t('mockup.readOnly')}
            </p>
          )}
        </>
      ) : null}

      {!demo || published === 0 ? (
        <p className="t-small desk-muted" data-testid="mockup-empty">
          {staff ? t('mockup.empty.staff') : t('mockup.empty.customer')}
        </p>
      ) : (
        <>
          <p className="t-caption" data-testid="mockup-fixed">
            {demo.fixedFrameLines?.map((code) => (
              <span key={code} data-code={code}>
                {t(`mockup.fixed.${code}`, { defaultValue: '' })}
              </span>
            ))}
          </p>
          <div data-testid="mockup-viewport">
            <DemoViewport demo={demo} src={viewUrl} />
          </div>
          <FeedbackPanel
            contractId={contract.id}
            step="MOCKUP"
            targets={targets}
            generalItem={general}
            canRaise={customerActs}
            answerDirect={can(me, 'answers.direct.mockup')}
            canAnswer={staff && can(me, 'feedback.answer')}
            locked={step.locked}
            onChanged={refresh}
            onAnswered={refresh}
          />
          {customerActs ? <ApproveMockup contractId={contract.id} canApprove={published > 0} /> : null}
          {step.locked ? (
            <p className="t-small locknote" data-testid="mockup-approved">
              {t('mockup.approve.done')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
