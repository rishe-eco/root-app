import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { logText } from '@/lib/changelog';
import { clockTime, formatCount, initialOf, pick, relativeTime } from '@/lib/format';
import { ADD_COMMENT, type Contract } from '@/lib/queries';
import type { WorkspaceContext } from './ContractWorkspace';

function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}

/**
 * The customer's side of the contract, and the only place on the desk that
 * shows it — the change log records that a comment happened (`COMMENTED`) and
 * has never carried its body, so before this the text was reachable only by
 * opening the customer's own portal page.
 *
 * Replying is the point. `addComment` decides which way to nudge the status
 * from an *ownership* edge rather than a capability (resolvers/customer.ts:290),
 * so a reply posted here is not the customer's: it moves the contract to
 * WAITING_ON_CUSTOMER and drops out of the Needs-Root queue on its own.
 */
function Conversation({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [addComment, { loading }] = useMutation(ADD_COMMENT);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      // No refetch: the mutation returns ContractFields for this same
      // contract, so the normalized cache updates the workspace query on its
      // own — the convention ContractWorkspace.tsx:14 states for every tab.
      //
      // `target` is left off deliberately. It defaults to CONTRACT, and no UI
      // on either side has ever written a DESIGN comment or read the field
      // back; a picker here would invent a distinction the portal, which
      // renders all comments as one thread, does not make.
      await addComment({ variables: { contractId: contract.id, body: body.trim() } });
      setBody('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="workspace-comments">
      <div>
        <h3 className="t-h3">{t('workspace.commentsTitle')}</h3>
        <p className="t-small desk-muted">{t('workspace.commentsHelp')}</p>
      </div>

      {contract.comments.length === 0 ? (
        <p className="t-small desk-muted">{t('workspace.commentsEmpty')}</p>
      ) : (
        <div className="thread">
          {contract.comments.map((c) => {
            // The same visual grammar as the portal: clay avatar for the
            // customer, dark for Root. There it is keyed on "is this me",
            // which works because the viewer is always the customer. Here the
            // viewer is staff, so it is keyed on the edge that made it mean
            // that in the first place.
            const theirs = c.author.id === contract.customer.id;
            return (
              <div className="comment" key={c.id}>
                <span className={`avatar-sm ${theirs ? 'av-you' : 'av-root'}`} aria-hidden="true">
                  {initialOf(c.author.name)}
                </span>
                <div className="comment-body">
                  <div className="comment-meta">
                    <span className="comment-who">{c.author.name}</span>
                    <span className="comment-when">
                      {relativeTime(c.createdAt, locale)} · {clockTime(c.createdAt, locale)}
                    </span>
                  </div>
                  <div className="comment-text">{c.body}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error ? <p className="error">{error}</p> : null}

      <form className="comment-form" onSubmit={onSubmit}>
        <textarea
          className="textarea"
          placeholder={t('workspace.commentPlaceholder')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !body.trim()}>
          {t('workspace.commentCta')}
        </button>
      </form>
    </div>
  );
}

export default function ActivityTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { contract } = useOutletContext<WorkspaceContext>();

  const contractRevisions = contract.contractRevisions ?? [];
  const designRevisions = contract.designRevisions ?? [];

  // The same sentences the customer reads on the portal (lib/changelog.ts),
  // in staff wording where the two differ, with page and scope keys named
  // from this contract the way ContractDetail.tsx names them.
  const chosen = contract.concepts.find((c) => c.chosen);
  const helpers = {
    labelForPage: (key: string) => {
      const page = chosen?.pages.find((p) => p.key === key);
      return page ? pick(page, 'label', locale) : null;
    },
    labelForScope: (key: string) => {
      const item = contract.scopeItems.find((s) => s.key === key);
      return item ? pick(item, 'label', locale) : null;
    },
  };

  return (
    <>
      {/* First on the tab, ahead of the history. Arriving here from the
          Needs-Root queue means a customer said something, and the reply box
          is the one actionable thing on this screen — putting it under two
          lineage columns and a change log would bury it. */}
      <Conversation contract={contract} />

      <div>
        <h3 className="t-h3">{t('workspace.lineagesTitle')}</h3>
        <p className="t-small desk-muted">{t('workspace.lineagesHelp')}</p>
      </div>
      <div className="lineage-columns">
        <div className="lineage-col">
          <p className="t-eyebrow">{t('workspace.contractLineage')}</p>
          {contractRevisions.length === 0 ? (
            <p className="t-small desk-muted">{t('workspace.lineageEmpty')}</p>
          ) : (
            contractRevisions.map((r) => (
              <div key={r.id} className="lineage-row">
                <span className="num-latin">v{r.version}</span>
                <span className="t-small desk-muted">
                  {r.signedAt
                    ? t('workspace.lineageSigned')
                    : r.approvedAt
                      ? t('workspace.lineageApproved')
                      : r.supersededAt
                        ? t('workspace.lineageSuperseded')
                        : r.publishedAt
                          ? t('workspace.lineagePublished')
                          : t('workspace.lineageUnsealed')}
                </span>
                <span className="t-caption">
                  {r.amendmentCount > 0 ? `+${formatCount(r.amendmentCount, locale)}` : ''}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="lineage-col">
          <p className="t-eyebrow">{t('workspace.designLineage')}</p>
          {designRevisions.length === 0 ? (
            <p className="t-small desk-muted">{t('workspace.lineageEmpty')}</p>
          ) : (
            designRevisions.map((r) => (
              <div key={r.id} className="lineage-row">
                <span className="num-latin">v{r.version}</span>
                <span className="t-small desk-muted">
                  {r.supersededAt
                    ? t('workspace.lineageSuperseded')
                    : r.publishedAt
                      ? t('workspace.lineagePublished')
                      : t('workspace.lineageUnsealed')}
                </span>
                <span className="t-caption">
                  {formatCount(r.conceptCount, locale)}×{formatCount(r.pageCount, locale)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <h3 className="t-h3">{t('workspace.changeLogTitle')}</h3>
        <div className="editor-list">
          {contract.changeLog.map((e) => (
            <div key={e.id} className="lineage-row">
              <span className="t-small">
                {e.actor.name} — {logText(e, t, helpers, 'staff')}
              </span>
              <span className="t-caption desk-muted">{relativeTime(e.createdAt, locale)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
