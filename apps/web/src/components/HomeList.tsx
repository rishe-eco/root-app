import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import type { HomeItem } from '@/lib/queries';
import { pick, relativeTime } from '@/lib/format';
import { attentionText } from '@/lib/wizard';

/**
 * A list of what is waiting on someone (journeys build plan J12) — the one
 * renderer behind the customer's dashboard and the desk's *My work*, so the two
 * cannot word an item differently. Each row is a link: the sentence (written for
 * the reader — `item.audience` picks `attention.<kind>.<variant>.<customer|staff>`),
 * what it is about, how long it has waited, and a route the API chose.
 *
 * **Nothing here is stored or dismissible.** A row disappears when the act that
 * clears it happens — the customer approves, sales answers, an invoice is paid —
 * and for no other reason, which is what makes the list safe to trust.
 */
export default function HomeList({ items, label }: { items: HomeItem[]; label: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <ul className="attention-list home-list" aria-label={label}>
      {items.map((item, i) => {
        const audience = item.audience === 'CUSTOMER' ? 'customer' : 'staff';
        const title = pick(item.subject, 'title', locale);
        // A contract is named by its title and ref; a request, ticket or invoice by what it says;
        // staff also read whose it is.
        const context = [audience === 'staff' ? item.subject.customerName : null, title || null].filter(Boolean).join(' · ');
        return (
          <li
            key={`${item.kind}:${item.variant}:${item.contractId ?? ''}:${item.phaseId ?? ''}:${i}`}
            className={`attention-item attention-${item.waitingOn.toLowerCase()}`}
            data-testid="home-item"
            data-kind={item.kind}
            data-waiting-on={item.waitingOn}
          >
            <Link className="home-item-link" to={lp(locale, item.route)}>
              <span className="attention-text">{attentionText(t, locale, item, audience)}</span>
              <span className="home-item-context t-caption">
                {context}
                {item.subject.ref ? (
                  <>
                    {context ? ' · ' : ''}
                    <span className="num-latin">{item.subject.ref}</span>
                  </>
                ) : null}
              </span>
              <span className="attention-since">{t('statusArea.since', { when: relativeTime(item.since, locale) })}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
