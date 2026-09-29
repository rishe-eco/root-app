import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import type { Contract } from '@/lib/queries';

/**
 * The frame around "view as customer" (journeys build plan J3). The screen
 * inside it is the portal's own (`ContractDetail`, `Wizard`), fed by a query
 * the API answers through the customer's eyes — so there is nothing to keep in
 * step here, only a banner that says what this is, and a read-only scope.
 */

export default function ViewAsBanner({ contract }: { contract: Pick<Contract, 'id' | 'customer'> }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <div className="view-as-banner" role="status" data-testid="view-as-banner">
      <p>{t('viewAs.banner', { name: contract.customer.clientName ?? contract.customer.name })}</p>
      <Link className="btn btn-secondary btn-sm" to={lp(locale, `/desk/contracts/${contract.id}`)}>
        {t('viewAs.back')}
      </Link>
    </div>
  );
}

/**
 * Every control inside is disabled by the browser itself (`<fieldset
 * disabled>`), so the customer's screen cannot be used to act as the
 * customer. The API would not let a staff member sign as one either — this
 * only keeps the buttons from offering it. Renders nothing extra when off, so
 * the portal's own DOM is exactly what it was.
 */
export function ReadOnlyScope({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? (
    <fieldset disabled className="view-as-scope">
      {children}
    </fieldset>
  ) : (
    <>{children}</>
  );
}

/** The message to show when the view could not load: a contract not yet
 *  handed over has a sentence of its own, everything else the portal's. */
export function viewAsErrorKey(error: unknown): string {
  const code = (error as { graphQLErrors?: Array<{ extensions?: { code?: string } }> } | undefined)?.graphQLErrors?.[0]
    ?.extensions?.code;
  return code === 'NOT_VISIBLE_TO_CUSTOMER' ? 'viewAs.notVisible' : 'portal.errorTitle';
}
