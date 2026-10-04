import { Navigate } from 'react-router-dom';
import { useLocale, lp } from '@/lib/locale';

/**
 * The desk's index (journeys build plan J12): **My work**, for any staff
 * capability set. It used to be the first section the person could see, which
 * was Overview for everyone — and so, for a reviewer, a page that was not theirs.
 * `DeskLayout` has already refused anyone who is not staff, and My work is the
 * one section every staff member holds (`capability: null` in `DESK_SECTIONS`),
 * so there is nothing to compute here.
 */
export default function DeskHome() {
  const locale = useLocale();
  return <Navigate to={lp(locale, '/desk/work')} replace />;
}
