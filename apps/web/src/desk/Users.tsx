import { useState, type FormEvent } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can, type Role } from '@/lib/access';
import { ALL_USERS, INVITE_STAFF, SET_USER_ROLES, SET_USER_STATE, type User } from '@/lib/queries';
import { peopleError } from './peopleErrors';

/**
 * **The Users place — its first slice** (journeys build plan S3, PD-12). Every
 * account with its roles and state; inviting a member of staff; changing an
 * account's roles; disabling and restoring. `staff.manage`, which is ADMIN's
 * alone — sales looks after customers from the customer page.
 *
 * This is the seed of the place the founder means by "a place to keep track
 * of all users", not a page beside it: whatever else that place grows (a
 * profile per person, activity, sessions, an audit trail) builds on this
 * list and these four acts. Nothing below belongs to the customer page, and
 * nothing on the customer page should be copied here.
 *
 * Roles appear in this file as *data being edited*, never as a test of what
 * the signed-in person may do (house rule 1) — the only checks are
 * `can(me, 'staff.manage')` and the API's own refusals, mapped in
 * `peopleErrors.ts`.
 */

/** The roles a staff invite may carry. CUSTOMER is not one — customers are
 *  invited from the customers page — but a role *editor* also shows it, so an
 *  account that holds it keeps it unless someone unticks it. */
const STAFF_ROLES: Role[] = ['ADMIN', 'SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER'];
const ALL_ROLES: Role[] = [...STAFF_ROLES, 'CUSTOMER'];

function RoleBoxes({
  idPrefix,
  roles,
  options,
  onChange,
}: {
  idPrefix: string;
  roles: Role[];
  options: Role[];
  onChange: (next: Role[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="people-roles">
      {options.map((role) => (
        <label className="people-role-option" key={role} htmlFor={`${idPrefix}-${role}`}>
          <input
            id={`${idPrefix}-${role}`}
            type="checkbox"
            checked={roles.includes(role)}
            onChange={(e) => onChange(e.target.checked ? [...roles, role] : roles.filter((r) => r !== role))}
          />
          {t(`desk.people.role.${role}`)}
        </label>
      ))}
    </div>
  );
}

function UserRow({ user, isMe, onError }: { user: User; isMe: boolean; onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Role[]>(user.roles);
  const [setRoles, { loading: rolesBusy }] = useMutation(SET_USER_ROLES);
  const [setState, { loading: stateBusy }] = useMutation(SET_USER_STATE);
  const disabled = user.state === 'DISABLED';

  async function onSaveRoles() {
    onError(null);
    try {
      await setRoles({ variables: { userId: user.id, roles: draft } });
      setEditing(false);
    } catch (err) {
      onError(peopleError(err, t));
    }
  }

  async function onToggleState() {
    const message = disabled
      ? t('desk.people.users.restoreConfirm', { name: user.name })
      : t('desk.people.users.disableConfirm', { name: user.name });
    if (!confirm(message)) return;
    onError(null);
    try {
      await setState({ variables: { userId: user.id, state: disabled ? 'ACTIVE' : 'DISABLED' } });
    } catch (err) {
      onError(peopleError(err, t));
    }
  }

  return (
    <tr>
      <td>
        {user.name}
        {isMe ? <span className="badge badge-neutral people-you">{t('desk.people.users.you')}</span> : null}
      </td>
      <td>
        <div dir="ltr">{user.phone ?? '—'}</div>
        <div dir="ltr" className="t-caption desk-muted">
          {user.email ?? ''}
        </div>
      </td>
      <td>
        {editing ? (
          <>
            <RoleBoxes idPrefix={`roles-${user.id}`} roles={draft} options={ALL_ROLES} onChange={setDraft} />
            <div className="editor-card-actions">
              <button className="btn btn-primary btn-sm" type="button" disabled={rolesBusy} onClick={onSaveRoles}>
                {t('desk.people.users.saveRoles')}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => {
                  setDraft(user.roles);
                  setEditing(false);
                }}
              >
                {t('desk.people.users.cancel')}
              </button>
            </div>
          </>
        ) : (
          <div className="people-roles">
            {user.roles.map((role) => (
              <span className="badge" key={role}>
                {t(`desk.people.role.${role}`)}
              </span>
            ))}
          </div>
        )}
      </td>
      <td>
        <span className={disabled ? 'badge badge-danger' : 'badge badge-neutral'}>
          {t(`desk.people.state.${user.state}`)}
        </span>
      </td>
      <td>
        <div className="editor-card-actions">
          {editing ? null : (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setDraft(user.roles);
                setEditing(true);
              }}
            >
              {t('desk.people.users.editRoles')}
            </button>
          )}
          {/* Nobody disables themselves — the API refuses it, and offering the
              button only to refuse it would be a trap in the one place a
              careless click is expensive. */}
          {isMe ? null : (
            <button className="btn btn-ghost btn-sm" type="button" disabled={stateBusy} onClick={onToggleState}>
              {disabled ? t('desk.people.users.restore') : t('desk.people.users.disable')}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function Users() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const allowed = can(me, 'staff.manage');

  const { data, loading } = useQuery<{ allUsers: User[] }>(ALL_USERS, { skip: !allowed });
  const [invite, { loading: inviting }] = useMutation(INVITE_STAFF, { refetchQueries: [{ query: ALL_USERS }] });

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!allowed) return <Navigate to={lp(locale, '/desk')} replace />;

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInviteUrl(null);
    try {
      const res = await invite({
        variables: { name, roles, phone: phone || null, email: email || null },
      });
      setInviteUrl(res.data.inviteStaff.inviteUrl);
      setName('');
      setPhone('');
      setEmail('');
      setRoles([]);
    } catch (err) {
      setError(peopleError(err, t));
    }
  }

  const users = data?.allUsers ?? [];

  return (
    <div className="desk-section">
      <div>
        <h2 className="t-h2">{t('desk.people.users.title')}</h2>
        <p className="t-lead">{t('desk.people.users.lede')}</p>
      </div>

      <section className="card">
        <h3 className="t-h3">{t('desk.people.users.inviteTitle')}</h3>
        <form className="auth-form" onSubmit={onInvite}>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label" htmlFor="u-name">
                {t('desk.inviteName')}
              </label>
              <input id="u-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="u-phone">
                {t('desk.invitePhone')}
              </label>
              <input
                id="u-phone"
                className="input"
                type="tel"
                dir="ltr"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <span className="t-caption desk-muted">{t('desk.people.users.phoneHint')}</span>
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="u-email">
              {t('desk.inviteEmail')}
            </label>
            <input
              id="u-email"
              className="input"
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <fieldset className="field people-fieldset">
            <legend className="label">{t('desk.people.users.rolesLabel')}</legend>
            <RoleBoxes idPrefix="invite-role" roles={roles} options={STAFF_ROLES} onChange={setRoles} />
          </fieldset>
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={inviting || roles.length === 0}>
              {t('desk.people.users.inviteCta')}
            </button>
          </div>
        </form>

        {error ? <p className="error">{error}</p> : null}
        {inviteUrl ? (
          <div className="auth-notice">
            <p className="t-small">{t('desk.inviteOnce')}</p>
            <code className="desk-code" dir="ltr">
              {inviteUrl}
            </code>
          </div>
        ) : null}
      </section>

      <section className="card">
        {loading && users.length === 0 ? (
          <p className="t-small">{t('portal.loading')}</p>
        ) : (
          <div className="table-wrap">
            <table className="ctable">
              <thead>
                <tr>
                  <th>{t('desk.inviteName')}</th>
                  <th>{t('desk.people.users.colContact')}</th>
                  <th>{t('desk.people.users.rolesLabel')}</th>
                  <th>{t('desk.colStatus')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.id} user={u} isMe={u.id === me.id} onError={setError} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
