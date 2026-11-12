import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { ANONYMIZE_USER, DELETE_USER, REISSUE_INVITE, SET_USER_STATE, UPDATE_USER, type User } from '@/lib/queries';
import { peopleError } from './peopleErrors';

/**
 * US1 — the acts on one account that the Users page and the customer page
 * share: edit the details, hand over a fresh invite link, and delete — which
 * becomes "disable or anonymize" when the account has records.
 *
 * Who may is the API's (`setUserState`'s rule: sales for customers, an
 * administrator for anyone with a staff role); these components offer the
 * controls and show the refusal, the way the rest of `/desk/users` does
 * (house rule 1 — nothing here reads a role to predict a permission).
 */

function errorCodeOf(err: unknown): string | undefined {
  return (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions?.code;
}

/** A link on screen with a Copy button. The link stays selectable when the
 *  clipboard is refused (an insecure origin, a permissions policy). */
export function InviteLinkBox({ url, note }: { url: string; note: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="auth-notice invite-link" data-testid="invite-link">
      <p className="t-small">{note}</p>
      <div className="invite-link-row">
        <code className="desk-code" dir="ltr" data-testid="invite-link-url">
          {url}
        </code>
        <button className="btn btn-secondary btn-sm" type="button" onClick={onCopy} data-testid="invite-link-copy">
          {copied === 'yes' ? t('desk.people.account.copied') : t('desk.people.account.copy')}
        </button>
      </div>
      {copied === 'failed' ? <p className="t-caption">{t('desk.people.account.copyFailed')}</p> : null}
    </div>
  );
}

/** A fresh invite link for an account still INVITED. */
export function ReissueInvite({ user }: { user: User }) {
  const { t } = useTranslation();
  const [reissue, { loading }] = useMutation(REISSUE_INVITE);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (user.state !== 'INVITED') return null;

  async function onClick() {
    setError(null);
    try {
      const res = await reissue({ variables: { userId: user.id } });
      setUrl(res.data.reissueInvite.inviteUrl);
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  return (
    <div className="account-tools">
      <div>
        <button className="btn btn-secondary btn-sm" type="button" disabled={loading} onClick={onClick} data-testid="invite-reissue">
          {t('desk.people.account.reissue')}
        </button>
      </div>
      {url ? <InviteLinkBox url={url} note={t('desk.people.account.reissued')} /> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

/** Name, phone, email, and — for a customer — the company name. */
export function AccountEditForm({
  user,
  withClientName,
  onDone,
}: {
  user: User;
  withClientName: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  const [clientName, setClientName] = useState(user.clientName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_USER);
  const p = `acct-${user.id}`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: {
          userId: user.id,
          name,
          phone: phone.trim() || null,
          email: email.trim() || null,
          ...(withClientName ? { clientName: clientName.trim() || null } : {}),
        },
      });
      onDone();
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  return (
    <form className="auth-form account-tools" onSubmit={onSubmit} data-testid="account-edit">
      <div className="editor-grid-2">
        <div className="field">
          <label className="label" htmlFor={`${p}-name`}>
            {t('desk.inviteName')}
          </label>
          <input id={`${p}-name`} className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {withClientName ? (
          <div className="field">
            <label className="label" htmlFor={`${p}-client`}>
              {t('desk.people.account.clientName')}
            </label>
            <input id={`${p}-client`} className="input" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </div>
        ) : null}
      </div>
      <div className="editor-grid-2">
        <div className="field">
          <label className="label" htmlFor={`${p}-phone`}>
            {t('desk.invitePhone')}
          </label>
          <input id={`${p}-phone`} className="input" type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${p}-email`}>
            {t('desk.inviteEmail')}
          </label>
          <input id={`${p}-email`} className="input" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <p className="t-caption desk-muted">{t('desk.people.account.identifierHint')}</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="editor-card-actions">
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading} data-testid="account-save">
          {t('desk.people.account.save')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDone}>
          {t('desk.people.users.cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * Delete. An account nothing records is gone at once (after a confirm). One
 * with records answers `HAS_HISTORY`, and this turns into the choice the
 * founder settled: **disable** (reversible), or **anonymize** — the danger
 * zone, behind typing the account's name.
 */
export function DeleteAccount({ user, onDeleted }: { user: User; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [del, { loading: deleting }] = useMutation(DELETE_USER);
  const [setState, { loading: disabling }] = useMutation(SET_USER_STATE);
  const [anonymize, { loading: erasing }] = useMutation(ANONYMIZE_USER);
  const [hasHistory, setHasHistory] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (!confirm(t('desk.people.account.deleteConfirm', { name: user.name }))) return;
    setError(null);
    try {
      await del({ variables: { userId: user.id } });
      onDeleted();
    } catch (err) {
      if (errorCodeOf(err) === 'HAS_HISTORY') setHasHistory(true);
      else setError(peopleError(err, t));
    }
  }

  async function onDisable() {
    setError(null);
    try {
      await setState({ variables: { userId: user.id, state: 'DISABLED' } });
      setHasHistory(false);
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  async function onAnonymize(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await anonymize({ variables: { userId: user.id, confirmName } });
      setHasHistory(false);
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  if (!hasHistory) {
    return (
      <>
        <button className="btn btn-ghost btn-sm" type="button" disabled={deleting} onClick={onDelete} data-testid="account-delete">
          {t('desk.people.account.delete')}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </>
    );
  }

  return (
    <div className="account-tools" data-testid="account-has-history">
      <p className="t-small">{t('desk.people.account.hasHistory', { name: user.name })}</p>
      {user.state !== 'DISABLED' ? (
        <div>
          <button className="btn btn-secondary btn-sm" type="button" disabled={disabling} onClick={onDisable} data-testid="account-disable-instead">
            {t('desk.people.account.disableInstead')}
          </button>
        </div>
      ) : null}
      <form className="danger-zone" onSubmit={onAnonymize} data-testid="account-anonymize">
        <strong className="t-small">{t('desk.people.account.anonymizeTitle')}</strong>
        <p className="t-small">{t('desk.people.account.anonymizeBody')}</p>
        <label className="label" htmlFor={`anon-${user.id}`}>
          {t('desk.people.account.anonymizeConfirm', { name: user.name })}
        </label>
        <input
          id={`anon-${user.id}`}
          className="input"
          autoComplete="off"
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
        <div className="editor-card-actions">
          <button
            className="btn btn-danger btn-sm"
            type="submit"
            disabled={erasing || confirmName.trim() !== user.name.trim()}
            data-testid="account-anonymize-submit"
          >
            {t('desk.people.account.anonymizeCta')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setHasHistory(false)}>
            {t('desk.people.users.cancel')}
          </button>
        </div>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
