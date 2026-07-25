import type { ReactNode } from 'react';
import { useApolloClient, useMutation } from '@apollo/client';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import LangSwitch from '@/components/LangSwitch';
import { SIGN_OUT, type User } from '@/lib/queries';
import { initialOf } from '@/lib/format';

export default function Topbar({ start, user }: { start: ReactNode; user: User }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const client = useApolloClient();
  const [signOut] = useMutation(SIGN_OUT);

  async function onSignOut() {
    await signOut().catch(() => undefined);
    await client.clearStore();
    navigate(lp(locale, '/portal'), { replace: true });
  }

  return (
    <header className="topbar">
      {start}
      <div className="topbar-right">
        <LangSwitch />
        <div className="user-chip">
          <span className="t-small">{user.name}</span>
          <span className="avatar" aria-hidden="true">
            {initialOf(user.name)}
          </span>
        </div>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onSignOut}>
          {t('portal.signOut')}
        </button>
      </div>
    </header>
  );
}
