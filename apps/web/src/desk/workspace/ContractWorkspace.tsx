import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import type { DocumentNode } from 'graphql';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  ASSIGNABLE_USERS,
  ASSIGN_CONTRACT,
  CONTRACT_WORKSPACE,
  type Contract,
  type User,
} from '@/lib/queries';
import { pick } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';

/**
 * `refetch` is the one deliberate exception to "no tab calls refetch" (see
 * below): `submitFeedback` (build plan L3) returns `FeedbackSubmitResult`,
 * not `Contract!`, because an interception result is not a Contract-shaped
 * fact — so `DemoFeedbackPanel` is the one caller in this codebase that
 * needs it, for the one case Apollo's normalized cache cannot help with: a
 * brand new FeedbackItem the cache has nowhere to insert itself into.
 *
 * `me` (journeys build plan S1) is threaded through from `DeskLayout`'s own
 * outlet context so every tab can decide what it may author from the same
 * capabilities the API checks, without each tab running its own `ME` query.
 */
export type WorkspaceContext = { contract: Contract; refetch: () => void; me: User };

/**
 * `useMutation` for a mutation that acts on the project's registry, phases,
 * demos or commitments — and so returns `Contract!` for *some* contract of
 * the project. Since J2 a project can have two, and which one comes back
 * matters: the scope list on the screen is `contract.scopeItems`, and it only
 * refreshes on the contract the response is about. This binds the mutation's
 * optional `contractId` to the contract the workspace is open on, as a hook-
 * level default that Apollo merges under each call's own variables.
 */
export function useWorkspaceMutation(document: DocumentNode) {
  const { contract } = useOutletContext<WorkspaceContext>();
  return useMutation(document, { variables: { contractId: contract.id } });
}

const TABS = ['contract', 'design', 'scope', 'phases', 'dependencies', 'activity'] as const;

const ASSIGN_ERROR_CODES = new Set(['ASSIGNEE_LACKS_CAPABILITY', 'ASSIGNEE_INACTIVE']);

function assignErrorMessage(err: unknown, t: (key: string) => string): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]
    ?.extensions?.code;
  if (code && ASSIGN_ERROR_CODES.has(code)) return t(`workspace.assignError.${code}`);
  return (err as { message?: string })?.message ?? String(err);
}

/**
 * The current designer and developer, and — for whoever holds
 * `contracts.author` — a change control (journeys build plan S1, Q-S4).
 * Read-only for everyone else: this is sales's edge to move, not the
 * designer's or developer's own to reassign.
 */
function AssignmentControl({ contract, canAssign }: { contract: Contract; canAssign: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [designerId, setDesignerId] = useState(contract.designer?.id ?? '');
  const [developerId, setDeveloperId] = useState(contract.developer?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const { data: designers } = useQuery<{ assignableUsers: User[] }>(ASSIGNABLE_USERS, {
    variables: { job: 'DESIGN' },
    skip: !editing,
  });
  const { data: developers } = useQuery<{ assignableUsers: User[] }>(ASSIGNABLE_USERS, {
    variables: { job: 'BUILD' },
    skip: !editing,
  });
  const [assign, { loading }] = useMutation(ASSIGN_CONTRACT);

  const line = t('workspace.assignmentLine', {
    designer: contract.designer?.name ?? t('workspace.unassigned'),
    developer: contract.developer?.name ?? t('workspace.unassigned'),
  });

  if (!canAssign) {
    return <p className="t-caption desk-muted">{line}</p>;
  }

  if (!editing) {
    return (
      <div className="workspace-row">
        <p className="t-caption desk-muted">{line}</p>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => {
            setDesignerId(contract.designer?.id ?? '');
            setDeveloperId(contract.developer?.id ?? '');
            setError(null);
            setEditing(true);
          }}
        >
          {t('workspace.changeAssignment')}
        </button>
      </div>
    );
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await assign({
        variables: { contractId: contract.id, designerId: designerId || null, developerId: developerId || null },
      });
      setEditing(false);
    } catch (err) {
      setError(assignErrorMessage(err, t));
    }
  }

  return (
    <form className="workspace-row" onSubmit={onSave}>
      <select className="select" value={designerId} onChange={(e) => setDesignerId(e.target.value)}>
        <option value="">{t('workspace.unassigned')}</option>
        {(designers?.assignableUsers ?? []).map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <select className="select" value={developerId} onChange={(e) => setDeveloperId(e.target.value)}>
        <option value="">{t('workspace.unassigned')}</option>
        {(developers?.assignableUsers ?? []).map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
        {t('workspace.save')}
      </button>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(false)}>
        {t('feedback.cancel')}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}

/**
 * The shell every tab renders inside. One query (`CONTRACT_WORKSPACE`) owns
 * the data; every mutation a tab fires returns the same shape, so Apollo's
 * normalized cache keeps this in sync without any tab calling `refetch` —
 * see `WorkspaceContext`'s own comment for the one exception.
 */
export default function ContractWorkspace() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { id = '' } = useParams();
  const me = useOutletContext<User>();
  const { data, loading, error, refetch } = useQuery<{ contract: Contract | null }>(CONTRACT_WORKSPACE, {
    variables: { id },
  });

  if (loading && !data) {
    return <div className="desk-section">{t('portal.loading')}</div>;
  }
  if (error || !data?.contract) {
    return <div className="desk-section">{t('portal.errorTitle')}</div>;
  }

  const contract = data.contract;

  return (
    <div className="desk-section">
      <div className="workspace-head">
        <div>
          <p className="t-caption num-latin">{contract.ref}</p>
          <h2 className="t-h2">{pick(contract, 'title', locale)}</h2>
          <AssignmentControl contract={contract} canAssign={can(me, 'contracts.author')} />
          {/* J2: the request this contract began as (its thread, read-only) —
              only for those who may read one, so a designer never sees the link. */}
          {contract.request ? (
            <p className="t-caption">
              <Link to={lp(locale, `/desk/requests/${contract.request.id}`)}>{t('requests.desk.openRequest')}</Link>
            </p>
          ) : null}
        </div>
        <StatusBadge status={contract.status} />
      </div>

      <nav className="workspace-tabs">
        {TABS.map((tab) => (
          <NavLink
            key={tab}
            end
            className={({ isActive }) => `workspace-tab${isActive ? ' workspace-tab-active' : ''}`}
            to={lp(locale, `/desk/contracts/${id}/${tab}`)}
          >
            {t(`workspace.tab${tab[0].toUpperCase()}${tab.slice(1)}`)}
          </NavLink>
        ))}
      </nav>

      <div className="workspace-panel">
        <Outlet context={{ contract, refetch: () => void refetch(), me } satisfies WorkspaceContext} />
      </div>
    </div>
  );
}
