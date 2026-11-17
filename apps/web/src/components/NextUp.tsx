import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { lp, useLocale } from '@/lib/locale';
import type { Contract } from '@/lib/queries';
import { attentionText, nextUp, stepLabel, stepLink } from '@/lib/wizard';

/**
 * "What's next" (DX1, desk UX review 28): one line at the top of a new-road
 * contract on the desk — whose turn it is, what to do, and a button that opens
 * that step. It is **built from what the API already answers** (`statusSummary`
 * for the step and whose move it is, `attention` for what to do) through
 * `nextUp`, which only picks; no rule lives here.
 */
export default function NextUp({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const summary = contract.statusSummary;
  const n = summary ? nextUp(summary, contract.attention ?? []) : null;
  if (!n) return null;

  const step = stepLabel(t, locale, { step: n.step, phaseNumber: n.phaseNumber });
  return (
    <div className={`nextup nextup-${(n.who ?? 'none').toLowerCase()}`} data-testid="next-up" data-who={n.who ?? ''} data-step={n.step}>
      <div className="nextup-text">
        <span className="t-eyebrow">{t(`nextUp.title.${n.who ?? 'NONE'}`)}</span>
        <span className="nextup-line">
          {n.attention ? attentionText(t, locale, n.attention, 'staff') : t(`nextUp.line.${n.who ?? 'NONE'}`, { step })}
        </span>
      </div>
      <Link className="btn btn-primary btn-sm" to={lp(locale, stepLink(contract.id, n))} data-testid="next-up-open">
        {t('nextUp.open', { step })}
      </Link>
    </div>
  );
}
