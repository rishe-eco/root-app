import { Navigate, useOutletContext } from 'react-router-dom';
import { useLocale, lp } from '@/lib/locale';
import type { User } from '@/lib/queries';
import { visibleSections } from './sections';

/**
 * Not a hardcoded `/desk/overview`: a person who only holds `review.participate`
 * would be bounced off it. Safe to index `[0]` here — `DeskLayout` has already
 * refused anyone with zero capabilities, so this list is never empty.
 */
export default function DeskHome() {
  const locale = useLocale();
  const me = useOutletContext<User>();
  const first = visibleSections(me)[0];
  return <Navigate to={lp(locale, `/desk/${first.key}`)} replace />;
}
