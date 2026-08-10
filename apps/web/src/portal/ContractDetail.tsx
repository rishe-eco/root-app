import { useState, type FormEvent } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import {
  ADD_COMMENT,
  APPROVE_AMENDMENT,
  APPROVE_CONTRACT,
  CHOOSE_CONCEPT,
  CONTRACT,
  SET_PAGE_APPROVAL,
  SET_SCOPE_ITEM,
  SIGN_AMENDMENT,
  SIGN_CONTRACT,
  type ChangeLogEntry,
  type Contract,
  type ContractRevisionSummary,
  type DesignRevisionSummary,
  type User,
} from '@/lib/queries';
import { clockTime, initialOf, pick, relativeTime } from '@/lib/format';
import { logText as buildLogText } from '@/lib/changelog';
import StatusBadge from '@/components/StatusBadge';
import Lock from '@/components/Lock';
import Topbar from './Topbar';

const MIN_SIGN_NAME = 2;

export default function ContractDetail() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { id = '' } = useParams();

  const { data, loading, error, refetch } = useQuery<{ contract: Contract | null }>(CONTRACT, {
    variables: { id },
  });

  const [chooseConcept] = useMutation(CHOOSE_CONCEPT);
  const [setPageApproval] = useMutation(SET_PAGE_APPROVAL);
  const [approveContract] = useMutation(APPROVE_CONTRACT);
  const [setScopeItem] = useMutation(SET_SCOPE_ITEM);
  const [signContract] = useMutation(SIGN_CONTRACT);
  const [addComment] = useMutation(ADD_COMMENT);
  const [approveAmendment] = useMutation(APPROVE_AMENDMENT);
  const [signAmendment] = useMutation(SIGN_AMENDMENT);

  const [openArticle, setOpenArticle] = useState<number | null>(null);
  const [signName, setSignName] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [amendmentSignName, setAmendmentSignName] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading && !data) {
    return (
      <>
        <Topbar user={me} start={<span className="crumb" />} />
        <div className="content">{t('portal.loading')}</div>
      </>
    );
  }

  const contract = data?.contract;
  if (error || !contract) {
    return (
      <>
        <Topbar user={me} start={<span className="crumb" />} />
        <div className="content">
          <div className="empty">
            <p className="t-small">{t('portal.errorTitle')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
              {t('portal.retry')}
            </button>
          </div>
        </div>
      </>
    );
  }

  const { gate } = contract;
  const chosen = contract.concepts.find((c) => c.chosen) ?? null;

  /* T1: when the design also moved, the gate refuses `approveContract` until
     the design is complete again — so the banner's one action is always the
     design's when both are pending, never the contract's. Contract-revised
     and amendment-pending never co-occur (a signed contract cannot also carry
     an unapproved revision — see V3.md §3.3), so this is the whole priority. */
  const pending = contract.pending;
  const pendingMode: 'design' | 'contract' | 'amendment' | null = !pending
    ? null
    : pending.designChanges.length > 0
      ? 'design'
      : pending.contractDiff
        ? 'contract'
        : pending.amendment
          ? 'amendment'
          : null;

  /* The heading has to name the same document as the articles under it.
     `contract.articles` comes out of the frozen snapshot, so the title comes
     from the revision too — the identically named fields on Contract are Root's
     working draft and can already have moved on. Publishing and then renaming
     used to leave a draft title sitting above published text, which is what
     `ContractPrint` has always avoided by reading only from the revision.

     `revision` is null in two cases: nothing published yet, and a backfilled v1
     that `npm run backfill` has not sealed. Neither has a frozen title to show,
     so the draft stands in — alongside an empty article list, since `articles`
     comes from the same absent snapshot. The screen is then honestly empty
     rather than mixing the two. */
  const title = pick(contract.revision ?? contract, 'title', locale);

  /* Every mutation returns the whole contract, so the gate, the status and
     the history all move together — the client never recomputes them. */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  async function onSign(e: FormEvent) {
    e.preventDefault();
    if (signName.trim().length < MIN_SIGN_NAME) return;
    await run(() => signContract({ variables: { contractId: contract!.id, typedName: signName } }));
  }

  async function onSignAmendment(e: FormEvent, amendmentId: string) {
    e.preventDefault();
    if (amendmentSignName.trim().length < MIN_SIGN_NAME) return;
    await run(() =>
      signAmendment({ variables: { amendmentId, typedName: amendmentSignName } }).then(() =>
        setAmendmentSignName(''),
      ),
    );
  }

  async function onComment(e: FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    await run(() =>
      addComment({ variables: { contractId: contract!.id, body: commentBody } }).then(() =>
        setCommentBody(''),
      ),
    );
  }

  const logText = (e: ChangeLogEntry) =>
    buildLogText(e, t, { labelForPage: (key) => labelForPage(key), labelForScope: (key) => labelForScope(key) });

  function labelForPage(key: string | null) {
    if (!key) return null;
    const page = chosen?.pages.find((p) => p.key === key);
    return page ? pick(page, 'label', locale) : t(`pages.${key}`, { defaultValue: key });
  }

  function labelForScope(key: string | null) {
    if (!key) return null;
    const item = contract!.scopeItems.find((s) => s.key === key);
    return item ? pick(item, 'label', locale) : key;
  }

  function contractVersionLabel(r: ContractRevisionSummary) {
    if (r.signedAt) return t('detail.versions.signed', { when: relativeTime(r.signedAt, locale) });
    if (r.approvedAt) return t('detail.versions.approved', { when: relativeTime(r.approvedAt, locale) });
    if (r.supersededAt) return t('detail.versions.superseded');
    if (r.publishedAt) return t('detail.versions.published', { when: relativeTime(r.publishedAt, locale) });
    return t('detail.versions.unsealed');
  }

  /* The current design revision's row names how many pages still await the
     customer rather than a bare "published" — that count is what the design
     half of the banner already points at, so the rail agrees with it. */
  function designVersionLabel(r: DesignRevisionSummary) {
    const isCurrent = r.supersededAt === null && r.publishedAt !== null;
    const remaining = gate.totalPageCount - gate.approvedPageCount;
    if (isCurrent && remaining > 0) return t('detail.versions.awaiting', { count: remaining });
    if (r.supersededAt) return t('detail.versions.superseded');
    if (r.publishedAt) return t('detail.versions.published', { when: relativeTime(r.publishedAt, locale) });
    return t('detail.versions.unsealed');
  }

  const gateStep = (
    done: boolean,
    active: boolean,
    label: string,
    sub: string,
    key: string,
  ) => (
    <div
      key={key}
      className={`gate ${done ? 'gate-done' : active ? 'gate-active' : 'gate-locked'}`}
    >
      <span className="gate-ic">{done ? '✓' : active ? '○' : '·'}</span>
      <div>
        <div className="gate-label">{label}</div>
        <div className="gate-sub">{sub}</div>
      </div>
    </div>
  );

  return (
    <>
      <Topbar
        user={me}
        start={
          <div className="crumb">
            <Link to={lp(locale, '/app/contracts')}>{t('portal.navContracts')}</Link>
            <span>/</span>
            <span className="crumb-now">{title}</span>
          </div>
        }
      />

      <div className="detail">
        <div className="detail-main">
          {pendingMode ? (
            <div className="pending-banner">
              <div className="pending-banner-body">
                {pendingMode === 'design' ? (
                  <p className="pending-lead">
                    {t('detail.pending.designBody', { count: pending!.designChanges.length })}
                  </p>
                ) : pendingMode === 'contract' ? (
                  <p className="pending-lead">
                    {t('detail.pending.contractBody', {
                      from: pending!.contractDiff!.fromVersion,
                      to: pending!.contractDiff!.toVersion,
                    })}
                  </p>
                ) : (
                  <p className="pending-lead">
                    {pending!.amendment!.approvedAt
                      ? t('detail.pending.amendmentBodySign', { title: pick(pending!.amendment!, 'title', locale) })
                      : t('detail.pending.amendmentBodyApprove', { title: pick(pending!.amendment!, 'title', locale) })}
                  </p>
                )}
                {pendingMode === 'design' && pending!.contractDiff ? (
                  <p className="pending-note">
                    {t('detail.pending.contractNote', { to: pending!.contractDiff.toVersion })}
                  </p>
                ) : null}
                {pendingMode === 'design' && pending!.amendment ? (
                  <p className="pending-note">{t('detail.pending.amendmentNote')}</p>
                ) : null}
              </div>
              <a
                className="btn btn-primary btn-sm"
                href={pendingMode === 'design' ? '#s1' : pendingMode === 'contract' ? '#s2' : '#amendment'}
              >
                {pendingMode === 'design'
                  ? t('detail.pending.designCta')
                  : pendingMode === 'contract'
                    ? t('detail.pending.contractCta')
                    : t('detail.pending.amendmentCta')}
              </a>
            </div>
          ) : null}

          <div className="detail-head">
            <div className="detail-head-row">
              <h1 className="t-h2">{title}</h1>
              {/* Only once there is a published revision — the printable view
                  renders that, and refuses to stand in for it when absent. */}
              {contract.revision ? (
                <Link
                  className="btn btn-secondary btn-sm"
                  to={lp(locale, `/app/contracts/${contract.id}/print`)}
                >
                  {t('detail.downloadPdf')}
                </Link>
              ) : null}
            </div>
            <p className="t-lead">
              {contract.customer.clientName ?? contract.customer.name} ·{' '}
              <span className="num-latin">{contract.ref}</span>
            </p>
          </div>

          {/* 1 · Design selection & approval ------------------------------ */}
          <section className="sec" id="s1">
            <div className="sec-head">
              <span className="sec-badge num-latin">1</span>
              <h2 className="t-h3">{t('detail.s1Title')}</h2>
            </div>
            <p className="sec-help">{t('detail.s1Help')}</p>

            <div className="concepts">
              {contract.concepts.map((c) => {
                const dim = chosen !== null && !c.chosen;
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={busy}
                    className={`concept${c.chosen ? ' concept-chosen' : ''}${dim ? ' concept-dim' : ''}`}
                    onClick={() =>
                      run(() =>
                        chooseConcept({
                          variables: { contractId: contract.id, conceptId: c.id },
                        }),
                      )
                    }
                  >
                    <div className="concept-prev">
                      {c.imageUrl ? (
                        <img className="concept-img" src={c.imageUrl} alt="" />
                      ) : (
                        <>
                          <div className="concept-bar">
                            <i />
                            <i />
                            <i />
                          </div>
                          <div className="concept-canvas">
                            <span className="concept-id">{c.key}</span>
                            <div className="skl" style={{ inlineSize: '54%' }} />
                            <div className="skl" style={{ inlineSize: '38%' }} />
                          </div>
                        </>
                      )}
                    </div>
                    <div className="concept-meta">
                      <span className="t-small concept-name">{pick(c, 'label', locale)}</span>
                      {c.chosen ? <span className="done-pill">✓ {t('detail.chosen')}</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>

            {chosen ? (
              <div className="design-block">
                <div className="pages-head">
                  <h3 className="pages-cap">{t('detail.pagesTitle')}</h3>
                  <div className="progress-note">
                    {gate.designComplete ? (
                      <span className="done-pill">✓ {t('detail.designComplete')}</span>
                    ) : (
                      <span className="muted">
                        {t('detail.progress', {
                          done: gate.approvedPageCount,
                          total: gate.totalPageCount,
                        })}
                      </span>
                    )}
                  </div>
                </div>

                <div className="pages">
                  {chosen.pages.map((p) => (
                    <div key={p.id} className={`pagerow${p.approved ? ' pagerow-done' : ''}`}>
                      {p.imageUrl ? (
                        <img className="pagethumb" src={p.imageUrl} alt="" />
                      ) : (
                        <span className="pagethumb" />
                      )}
                      <div>
                        <div className="pn">{pick(p, 'label', locale)}</div>
                        <div className="pc num-latin">{chosen.key}</div>
                      </div>
                      <div className="pagerow-actions">
                        <button
                          type="button"
                          className={`btn btn-sm ${p.approved ? 'btn-ghost' : 'btn-primary'}`}
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              setPageApproval({
                                variables: { pageDesignId: p.id, approved: !p.approved },
                              }),
                            )
                          }
                        >
                          {p.approved ? `✓ ${t('detail.approved')}` : t('detail.approve')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {/* 2 · Contract body -------------------------------------------- */}
          <section className="sec" id="s2">
            <div className="sec-head">
              <span className="sec-badge num-latin">2</span>
              <h2 className="t-h3">{t('detail.s2Title')}</h2>
            </div>
            <p className="sec-help">{t('detail.s2Help')}</p>

            <div className="articles">
              {contract.articles.map((a) => {
                const open = openArticle === a.number;
                const body = pick(a, 'body', locale);
                return (
                  <div className="art" key={a.id}>
                    <button
                      type="button"
                      className="art-head"
                      aria-expanded={open}
                      onClick={() => setOpenArticle(open ? null : a.number)}
                    >
                      <span className="art-n num-latin">{a.number}.</span>
                      <span className="art-t">{pick(a, 'title', locale)}</span>
                    </button>
                    {open ? (
                      <div className="art-body">{body || t('detail.articlePlaceholder')}</div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {gate.contractApproved ? (
              <span className="done-pill">{t('detail.contractApprovedLabel')}</span>
            ) : gate.designComplete ? (
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    run(() => approveContract({ variables: { contractId: contract.id } }))
                  }
                >
                  {t('detail.approveContract')}
                </button>
              </div>
            ) : (
              <div className="locknote">
                <Lock />
                <span>{t('detail.contractLockNote')}</span>
              </div>
            )}
          </section>

          {/* 3 · Scope checklist — never gated ---------------------------- */}
          <section className="sec">
            <div className="sec-head">
              <span className="sec-badge num-latin">3</span>
              <h2 className="t-h3">{t('detail.s3Title')}</h2>
            </div>
            <p className="sec-help">{t('detail.s3Help')}</p>

            <div>
              {contract.scopeItems.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="scope-item"
                  aria-pressed={s.checked}
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      setScopeItem({ variables: { scopeItemId: s.id, checked: !s.checked } }),
                    )
                  }
                >
                  <span className={`check${s.checked ? ' check-on' : ''}`} aria-hidden="true">
                    ✓
                  </span>
                  <span className="t-small">{pick(s, 'label', locale)}</span>
                </button>
              ))}
            </div>
          </section>

          {/* 4 · E-signature ---------------------------------------------- */}
          <section className="sec">
            <div className="sec-head">
              <span className="sec-badge num-latin">4</span>
              <h2 className="t-h3">{t('detail.s4Title')}</h2>
            </div>
            <p className="sec-help">{t('detail.s4Help')}</p>

            {contract.signature ? (
              <div className="sign-done">
                <span className="sign-name">{contract.signature.typedName}</span>
                <span className="t-caption">
                  {t('detail.signedAt')} · {relativeTime(contract.signature.signedAt, locale)}
                </span>
              </div>
            ) : gate.contractApproved ? (
              <form className="sign-row" onSubmit={onSign}>
                <div className="field sign-field">
                  <label className="label" htmlFor="signname">
                    {t('detail.signLabel')}
                  </label>
                  <input
                    id="signname"
                    className="input"
                    placeholder={t('detail.signPlaceholder')}
                    value={signName}
                    onChange={(e) => setSignName(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || signName.trim().length < MIN_SIGN_NAME}
                >
                  {t('detail.signCta')}
                </button>
              </form>
            ) : (
              <div className="locknote">
                <Lock />
                <span>{t('detail.signLockNote')}</span>
              </div>
            )}
          </section>

          {/* The amendment, if one has been published — its own approve/sign
              pair, never touching section 4's already-complete signature. */}
          {contract.revision?.amendments.map((a) =>
            a.publishedAt ? (
              <section className="sec" id={a.id === pending?.amendment?.id ? 'amendment' : undefined} key={a.id}>
                <div className="sec-head">
                  <h2 className="t-h3">
                    {t('detail.amendment.title', { label: `A${a.ordinal}` })}
                  </h2>
                </div>
                <p className="sec-help">{t('detail.amendment.help')}</p>

                <div className="art">
                  <div className="art-head">
                    <span className="art-t">{pick(a, 'title', locale)}</span>
                  </div>
                  <div className="art-body">{pick(a, 'body', locale)}</div>
                </div>

                {a.signature ? (
                  <div className="sign-done">
                    <span className="sign-name">{a.signature.typedName}</span>
                    <span className="t-caption">
                      {t('detail.amendment.signedAt')} · {relativeTime(a.signature.signedAt, locale)}
                    </span>
                  </div>
                ) : a.approvedAt ? (
                  <form className="sign-row" onSubmit={(e) => onSignAmendment(e, a.id)}>
                    <div className="field sign-field">
                      <label className="label" htmlFor="amendment-signname">
                        {t('detail.signLabel')}
                      </label>
                      <input
                        id="amendment-signname"
                        className="input"
                        placeholder={t('detail.signPlaceholder')}
                        value={amendmentSignName}
                        onChange={(e) => setAmendmentSignName(e.target.value)}
                      />
                    </div>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={busy || amendmentSignName.trim().length < MIN_SIGN_NAME}
                    >
                      {t('detail.amendment.signCta')}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => run(() => approveAmendment({ variables: { amendmentId: a.id } }))}
                  >
                    {t('detail.amendment.approveCta')}
                  </button>
                )}
              </section>
            ) : null,
          )}

          {/* 5 · Comments — never gated ----------------------------------- */}
          <section className="sec">
            <div className="sec-head">
              <span className="sec-badge num-latin">5</span>
              <h2 className="t-h3">{t('detail.s5Title')}</h2>
            </div>
            <p className="sec-help">{t('detail.s5Help')}</p>

            <div className="thread">
              {contract.comments.map((c) => {
                const mine = c.author.id === me.id;
                return (
                  <div className="comment" key={c.id}>
                    <span className={`avatar-sm ${mine ? 'av-you' : 'av-root'}`} aria-hidden="true">
                      {initialOf(c.author.name)}
                    </span>
                    <div className="comment-body">
                      <div className="comment-meta">
                        <span className="comment-who">
                          {mine ? t('detail.you') : c.author.name}
                        </span>
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

            <form className="comment-form" onSubmit={onComment}>
              <textarea
                className="textarea"
                placeholder={t('detail.commentPlaceholder')}
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={busy || !commentBody.trim()}
              >
                {t('detail.commentCta')}
              </button>
            </form>
          </section>
        </div>

        {/* Rail --------------------------------------------------------- */}
        <aside className="rail">
          <div className="rail-card">
            <p className="rail-cap">{t('detail.statusCap')}</p>
            <StatusBadge status={contract.status} />

            {gateStep(
              gate.designComplete,
              !gate.designComplete,
              t('detail.gate1'),
              t('detail.gate1sub'),
              'g1',
            )}
            {gateStep(
              gate.contractApproved,
              gate.designComplete && !gate.contractApproved,
              t('detail.gate2'),
              t('detail.gate2sub'),
              'g2',
            )}
            {gateStep(
              gate.signed,
              gate.contractApproved && !gate.signed,
              t('detail.gate3'),
              t('detail.gate3sub'),
              'g3',
            )}
          </div>

          {/* Two lineages, two columns — never interleaved, so it stays clear
              which one moved (V3.md §4.2). */}
          <div className="rail-card">
            <p className="rail-cap">{t('detail.versions.cap')}</p>
            <div className="lineage-columns">
              <div className="lineage-col">
                <p className="t-eyebrow">{t('detail.versions.contractLineage')}</p>
                {contract.contractRevisions.map((r) => (
                  <div key={r.id} className="lineage-row">
                    <span className="num-latin">v{r.version}</span>
                    <span className="t-small">{contractVersionLabel(r)}</span>
                  </div>
                ))}
              </div>
              <div className="lineage-col">
                <p className="t-eyebrow">{t('detail.versions.designLineage')}</p>
                {contract.designRevisions.map((r) => (
                  <div key={r.id} className="lineage-row">
                    <span className="num-latin">v{r.version}</span>
                    <span className="t-small">{designVersionLabel(r)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rail-card">
            <p className="rail-cap">{t('detail.historyCap')}</p>
            <div className="log">
              {contract.changeLog.map((e) => (
                <div className="logitem" key={e.id}>
                  <span className="lwho">
                    {e.actor.id === me.id ? t('detail.you') : t('detail.root')}
                  </span>
                  <span className="lwhat">{logText(e)}</span>
                  <span className="lwhen">
                    {relativeTime(e.createdAt, locale)} · {clockTime(e.createdAt, locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
