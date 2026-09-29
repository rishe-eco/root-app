import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { Contract } from '@/lib/queries';
import { pick, relativeTime } from '@/lib/format';
import RequestThread from '@/components/RequestThread';

/**
 * The two rail cards the portal's contract screen shares between its two
 * roads (journeys build plan J3): the legacy page and the new-road wizard show
 * the same commitments and the same origin request, so they are written once
 * — extracted verbatim from `ContractDetail`, which imports them back.
 */

/** Build plan L5, spec §7/§11: "own commitments with due dates staring back."
 *  Customer-side only — Root's own commitments are tracked on the same board
 *  (symmetry is the point of the stage), but this card is the customer's, not
 *  a status report on Root. */
export function CommitmentsCard({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (!contract.project.dependencies.some((d) => d.side === 'CUSTOMER')) return null;
  return (
    <div className="rail-card">
      <p className="rail-cap">{t('detail.commitmentsCap')}</p>
      <div className="log">
        {contract.project.dependencies
          .filter((d) => d.side === 'CUSTOMER')
          .map((d) => (
            <div className={`logitem${d.overdue ? ' commitment-overdue' : ''}`} key={d.id}>
              <span className="lwhat">{pick(d, 'title', locale)}</span>
              <span className="lwhen">
                {d.verifiedAt
                  ? t('detail.commitmentVerified')
                  : d.overdue
                    ? t('detail.commitmentOverdue')
                    : relativeTime(d.dueAt, locale)}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Journeys build plan J2: how this contract began — the customer's own
 *  request and the conversation around it, read-only from here (the thread
 *  closed when the request became this contract). */
export function OriginRequestCard({ contract, meId }: { contract: Contract; meId: string }) {
  const { t } = useTranslation();
  if (!contract.request) return null;
  return (
    <div className="rail-card" id="origin-request">
      <p className="rail-cap">{t('requests.originTitle')}</p>
      <p className="t-small muted">{t('requests.originLede')}</p>
      <p className="t-small" dir="auto">
        <strong>{contract.request.title}</strong>
      </p>
      <RequestThread request={contract.request} meId={meId} canPost={false} />
    </div>
  );
}
