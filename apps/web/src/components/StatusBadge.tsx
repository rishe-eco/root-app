import { useTranslation } from 'react-i18next';
import { STATUS_CLASS } from '@/lib/format';
import type { ContractStatus } from '@/lib/queries';

export default function StatusBadge({ status }: { status: ContractStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`st-badge ${STATUS_CLASS[status]}`}>
      <span className="sdot" />
      {t(`status.${status}`)}
    </span>
  );
}
