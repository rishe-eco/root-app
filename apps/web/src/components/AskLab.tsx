import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { askLab, type AskCitation, type AskErrorCode } from '@/lib/ask';

type Status = 'idle' | 'asking' | 'streaming' | 'done' | 'refused' | 'error' | 'noCandidates';

/**
 * "Ask the Lab" and "Ask this paper" are one component, one code path (R4.md
 * T1) — `entrySlug` is the only thing that tells the two apart, and it does
 * so by narrowing the server's candidate set (routes/ask.ts), never by a
 * second implementation here.
 */
export default function AskLab({ entrySlug }: { entrySlug?: string }) {
  const { t } = useTranslation();
  const locale = useLocale();

  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<AskCitation[]>([]);
  const [errorCode, setErrorCode] = useState<AskErrorCode | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || status === 'asking' || status === 'streaming') return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('asking');
    setAnswer('');
    setCitations([]);
    setErrorCode(null);

    await askLab(
      { question: trimmed, locale, entrySlug },
      {
        onDelta: (text) => {
          setStatus('streaming');
          setAnswer((prev) => prev + text);
        },
        onDone: (event) => {
          if (event.stopReason === 'no_candidates') {
            setStatus('noCandidates');
            return;
          }
          setAnswer(event.text);
          // A citation can repeat within one answer; the reader wants the
          // distinct sources, not one link per sentence that used it.
          const seen = new Set<string>();
          setCitations(event.citations.filter((c) => (seen.has(c.entrySlug) ? false : seen.add(c.entrySlug))));
          setStatus('done');
        },
        onRefused: () => setStatus('refused'),
        onError: (code) => {
          setErrorCode(code);
          setStatus('error');
        },
      },
      controller.signal,
    );
  }

  const busy = status === 'asking' || status === 'streaming';

  return (
    <section className="ask-lab" lang={locale} dir={locale === 'fa' ? 'rtl' : 'ltr'}>
      <p className="t-eyebrow">{t(entrySlug ? 'library.ask.paperEyebrow' : 'library.ask.eyebrow')}</p>
      <h2 className="t-h3">{t(entrySlug ? 'library.ask.paperTitle' : 'library.ask.title')}</h2>

      <form className="ask-lab-form" onSubmit={onSubmit}>
        <textarea
          className="textarea ask-lab-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t('library.ask.placeholder')}
          maxLength={2000}
          rows={2}
        />
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !question.trim()}>
          {busy ? t('library.ask.asking') : t('library.ask.submit')}
        </button>
      </form>

      {status === 'asking' ? <p className="t-small ask-lab-status">{t('library.ask.thinking')}</p> : null}

      {status === 'noCandidates' ? <p className="t-small ask-lab-status">{t('library.ask.noCandidates')}</p> : null}

      {status === 'refused' ? <p className="t-small ask-lab-status">{t('library.ask.refused')}</p> : null}

      {status === 'error' && errorCode ? (
        <p className="t-small ask-lab-status">{t(`library.ask.error.${errorCode}`, { defaultValue: t('library.ask.error.INTERNAL') })}</p>
      ) : null}

      {(status === 'streaming' || status === 'done') && answer ? (
        <div className="ask-lab-answer">
          <p className="t-body">{answer}</p>
          {status === 'done' && citations.length > 0 ? (
            <ul className="ask-lab-citations">
              {citations.map((c) => (
                <li key={c.entrySlug}>
                  <Link className="link" to={lp(locale, c.entryUrl)}>
                    {c.entryTitle}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
