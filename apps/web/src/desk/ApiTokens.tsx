import { useState, type FormEvent } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  MY_API_TOKENS,
  CREATE_API_TOKEN,
  REVOKE_API_TOKEN,
  type ApiToken,
  type ApiTokenScope,
  type User,
} from '@/lib/queries';
import { fullDateTime } from '@/lib/format';

/**
 * Personal access tokens — issuing, listing, revoking.
 *
 * **The screen is built around one moment**: the secret is readable exactly
 * once, in the response to the mutation that created it, and after that it
 * does not exist anywhere the server can reach. So the created token is not a
 * toast and not a row — it is a panel that stays until dismissed, says plainly
 * that it will not be shown again, and offers a copy button, because a person
 * re-selecting a 48-character string by hand will eventually get it wrong and
 * blame the API.
 *
 * Everything shown in the table is deliberately non-secret. `prefix` is the
 * leading characters only, which is enough to answer "is the one on that
 * server the one I am about to revoke" and not enough to be the token.
 */
export default function ApiTokens() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const canManage = can(me, 'apiTokens.manage');

  const { data, loading } = useQuery<{ myApiTokens: ApiToken[] }>(MY_API_TOKENS, {
    skip: !canManage,
  });
  const [create] = useMutation(CREATE_API_TOKEN, { refetchQueries: [{ query: MY_API_TOKENS }] });
  // Revocation returns the updated row, and Apollo writes it into the cache by
  // id on its own — no refetch, so the button does not cost a round trip to
  // re-read a list the response already corrected.
  const [revoke] = useMutation(REVOKE_API_TOKEN);

  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiTokenScope>('READ');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) return <Navigate to={lp(locale, '/desk')} replace />;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setCopied(false);
    try {
      const days = expiresInDays.trim();
      const res = await create({
        variables: {
          name,
          scope,
          // Blank means "does not expire", which is a different thing from
          // zero — the server refuses zero rather than treating it as absent.
          expiresInDays: days === '' ? null : Number(days),
        },
      });
      setCreated(res.data.createApiToken.token);
      setName('');
      setScope('READ');
      setExpiresInDays('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onCopy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (an insecure origin, a permissions
      // policy). The token is still on screen and still selectable, so this
      // is not an error worth a red message — it just means the button did
      // not do its job, and saying so is enough.
      setError(t('desk.apiTokens.copyFailed'));
    }
  }

  async function onRevoke(token: ApiToken) {
    if (!confirm(t('desk.apiTokens.revokeConfirm', { name: token.name }))) return;
    setError(null);
    try {
      await revoke({ variables: { id: token.id } });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const tokens = data?.myApiTokens ?? [];
  const isExpired = (tk: ApiToken) => tk.expiresAt !== null && new Date(tk.expiresAt) <= new Date();

  /** Revoked beats expired: both mean unusable, and the one someone chose is
   *  more informative than the one the clock did. */
  function statusOf(tk: ApiToken): string {
    if (tk.revokedAt !== null) return t('desk.apiTokens.statusRevoked');
    if (isExpired(tk)) return t('desk.apiTokens.statusExpired');
    return t('desk.apiTokens.statusActive');
  }

  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.apiTokens.title')}</h2>
      <p className="t-small">{t('desk.apiTokens.intro')}</p>

      <section className="card">
        <h3 className="t-h3">{t('desk.apiTokens.newTitle')}</h3>
        <form className="auth-form" onSubmit={onCreate}>
          <div className="field">
            <label className="label" htmlFor="tk-name">
              {t('desk.apiTokens.fieldName')}
            </label>
            <input
              id="tk-name"
              className="input"
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="t-caption">{t('desk.apiTokens.fieldNameHint')}</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="tk-scope">
              {t('desk.apiTokens.fieldScope')}
            </label>
            <select
              id="tk-scope"
              className="input"
              value={scope}
              onChange={(e) => setScope(e.target.value as ApiTokenScope)}
            >
              <option value="READ">{t('desk.apiTokens.scopeRead')}</option>
              <option value="WRITE">{t('desk.apiTokens.scopeWrite')}</option>
            </select>
            <p className="t-caption">{t('desk.apiTokens.fieldScopeHint')}</p>
          </div>

          <div className="field">
            <label className="label" htmlFor="tk-expiry">
              {t('desk.apiTokens.fieldExpiry')}
            </label>
            <input
              id="tk-expiry"
              className="input"
              type="number"
              min={1}
              max={3650}
              dir="ltr"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
            <p className="t-caption">{t('desk.apiTokens.fieldExpiryHint')}</p>
          </div>

          <div>
            <button className="btn btn-primary btn-sm" type="submit">
              {t('desk.apiTokens.createCta')}
            </button>
          </div>
        </form>

        {error ? <p className="error">{error}</p> : null}

        {created ? (
          <div className="auth-notice">
            <p className="t-small">{t('desk.apiTokens.createdOnce')}</p>
            {/* dir="ltr" because the token is a Latin identifier and would
                otherwise render with its parts reordered under an RTL
                paragraph — persian-pass.md §1.6's rule for identifiers. */}
            <code className="desk-code" dir="ltr">
              {created}
            </code>
            <div className="desk-actions">
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => onCopy(created)}>
                {copied ? t('desk.apiTokens.copied') : t('desk.apiTokens.copy')}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setCreated(null)}>
                {t('desk.apiTokens.dismiss')}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.apiTokens.listTitle')}</h3>
        {loading ? (
          <p className="t-small">{t('portal.loading')}</p>
        ) : tokens.length === 0 ? (
          <p className="t-small">{t('desk.apiTokens.empty')}</p>
        ) : (
          <div className="table-wrap table-wrap-wide">
            <table className="ctable">
              <thead>
                <tr>
                  <th>{t('desk.apiTokens.colName')}</th>
                  <th>{t('desk.apiTokens.colPrefix')}</th>
                  <th>{t('desk.apiTokens.colScope')}</th>
                  <th>{t('desk.apiTokens.colLastUsed')}</th>
                  <th>{t('desk.apiTokens.colExpires')}</th>
                  <th>{t('desk.apiTokens.colStatus')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((tk) => {
                  const dead = tk.revokedAt !== null || isExpired(tk);
                  return (
                    <tr key={tk.id}>
                      <td>{tk.name}</td>
                      <td dir="ltr">
                        <code className="desk-code">{tk.prefix}…</code>
                      </td>
                      <td>
                        {tk.scope === 'WRITE'
                          ? t('desk.apiTokens.scopeWrite')
                          : t('desk.apiTokens.scopeRead')}
                      </td>
                      <td>
                        {tk.lastUsedAt
                          ? fullDateTime(tk.lastUsedAt, locale)
                          : t('desk.apiTokens.neverUsed')}
                      </td>
                      <td>
                        {tk.expiresAt
                          ? fullDateTime(tk.expiresAt, locale)
                          : t('desk.apiTokens.noExpiry')}
                      </td>
                      <td>{statusOf(tk)}</td>
                      <td>
                        {/* A revoked or expired token keeps its row — the row
                            is the record that the credential existed — but
                            there is nothing left to revoke. */}
                        {dead ? null : (
                          <button
                            className="btn btn-ghost btn-sm"
                            type="button"
                            onClick={() => onRevoke(tk)}
                          >
                            {t('desk.apiTokens.revoke')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
