import { useState, type FormEvent } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import {
  ADD_COMMENT,
  APPROVE_CONTRACT,
  CHOOSE_CONCEPT,
  CONTRACT,
  SET_PAGE_APPROVAL,
  SET_SCOPE_ITEM,
  SIGN_CONTRACT,
  type ChangeLogEntry,
  type Contract,
  type User,
} from '@/lib/queries';
import { clockTime, initialOf, pick, relativeTime } from '@/lib/format';
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

  const [openArticle, setOpenArticle] = useState<number | null>(null);
  const [signName, setSignName] = useState('');
  const [commentBody, setCommentBody] = useState('');
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
  const title = pick(contract, 'title', locale);

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

  async function onComment(e: FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    await run(() =>
      addComment({ variables: { contractId: contract!.id, body: commentBody } }).then(() =>
        setCommentBody(''),
      ),
    );
  }

  const logText = (e: ChangeLogEntry) => {
    const key = {
      CREATED: 'created',
      PUBLISHED: 'published',
      CHOSE_CONCEPT: 'chose',
      APPROVED_PAGE: 'approvedPage',
      UNAPPROVED_PAGE: 'unapprovedPage',
      DESIGN_COMPLETE: 'designComplete',
      APPROVED_CONTRACT: 'approvedContract',
      SIGNED: 'signed',
      COMMENTED: 'comment',
      SCOPE_ON: 'scopeOn',
      SCOPE_OFF: 'scopeOff',
      STATUS_CHANGED: 'statusChanged',
    }[e.action];

    // The one variable part of the sentence is localized here, not stored.
    const arg =
      e.action === 'STATUS_CHANGED' && e.arg
        ? t(`status.${e.arg}`)
        : e.action === 'APPROVED_PAGE' || e.action === 'UNAPPROVED_PAGE'
          ? (labelForPage(e.arg) ?? e.arg ?? '')
          : e.action === 'SCOPE_ON' || e.action === 'SCOPE_OFF'
            ? (labelForScope(e.arg) ?? e.arg ?? '')
            : (e.arg ?? '');

    return t(`log.${key}`, { arg });
  };

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
          <div className="detail-head">
            <h1 className="t-h2">{title}</h1>
            <p className="t-lead">
              {contract.customer.clientName ?? contract.customer.name} ·{' '}
              <span className="num-latin">{contract.ref}</span>
            </p>
          </div>

          {/* 1 · Design selection & approval ------------------------------ */}
          <section className="sec">
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
                    disabled={busy || gate.contractApproved}
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
                          disabled={busy || gate.contractApproved}
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
          <section className="sec">
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
