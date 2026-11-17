import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { moneyReadout } from '@/lib/format';

/**
 * The grouped readout under a desk money input (DX1, desk UX review 23): the
 * input stays plain digits — it is what is typed and what is sent — and this
 * says the same number the way it is read, «۱۵۰٬۰۰۰٬۰۰۰ تومان». One component
 * for every money field on the desk, so they cannot differ. Renders nothing for
 * an empty input.
 */
export default function MoneyReadout({ value, testId }: { value: string | null | undefined; testId?: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const text = moneyReadout(value, locale);
  if (text === null) return null;
  return (
    <p className="t-caption money-readout" data-testid={testId ?? 'money-readout'} aria-live="polite">
      {t('brief.amount', { amount: text })}
    </p>
  );
}
