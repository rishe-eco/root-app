import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { User } from '@/lib/queries';
import Lock from '@/components/Lock';
import Topbar from './Topbar';

/**
 * Services and Billing are modelled in the database and reserved in the nav,
 * but not built yet. The page says so rather than pretending. Support left
 * this list at build plan L4 — see Support.tsx.
 */
export default function Stub({ section }: { section: 'services' | 'billing' }) {
  const { t } = useTranslation();
  const me = useOutletContext<User>();
  const title = t(`stub.${section}Title`);

  return (
    <>
      <Topbar user={me} start={<h1 className="t-h3 topbar-title">{title}</h1>} />
      <div className="content">
        <div className="stub">
          <h1 className="t-h2">{title}</h1>
          <p className="t-lead">{t(`stub.${section}Body`)}</p>
          <div className="locknote">
            <Lock />
            <span>{t('stub.comingLater')}</span>
          </div>
        </div>
      </div>
    </>
  );
}
