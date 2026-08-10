import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { guessLocale, isLocale } from '@/i18n';
import LocaleLayout from '@/components/LocaleLayout';
import Landing from '@/pages/Landing';
import About from '@/pages/About';
import Reserved from '@/pages/Reserved';
import NotFound from '@/pages/NotFound';
import SignIn from '@/portal/SignIn';
import AcceptInvite from '@/portal/AcceptInvite';
import RequestReset from '@/portal/RequestReset';
import ResetPassword from '@/portal/ResetPassword';
import PortalLayout from '@/portal/PortalLayout';
import Contracts from '@/portal/Contracts';
import ContractDetail from '@/portal/ContractDetail';
import ContractPrint from '@/portal/ContractPrint';
import Stub from '@/portal/Stub';
import DeskLayout from '@/desk/DeskLayout';
import DeskHome from '@/desk/DeskHome';
import Overview from '@/desk/Overview';
import DeskContracts from '@/desk/Contracts';
import Customers from '@/desk/Customers';
import ContractWorkspace from '@/desk/workspace/ContractWorkspace';
import WorkspaceContractTab from '@/desk/workspace/ContractTab';
import WorkspaceDesignTab from '@/desk/workspace/DesignTab';
import WorkspaceScopeTab from '@/desk/workspace/ScopeTab';
import WorkspaceActivityTab from '@/desk/workspace/ActivityTab';

/** `/` and any unprefixed path get sent to the visitor's best-guess locale. */
function LocaleRedirect() {
  const { pathname, search, hash } = useLocation();
  const first = pathname.split('/')[1];
  const rest = isLocale(first) ? '' : pathname;
  return <Navigate to={`/${guessLocale()}${rest === '/' ? '' : rest}${search}${hash}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LocaleRedirect />} />

      <Route path="/:lang" element={<LocaleLayout />}>
        {/* Public */}
        <Route index element={<Landing />} />
        <Route path="about" element={<About />} />

        {/* Reserved slots — the rooms exist, they are simply not furnished. */}
        <Route path="studio" element={<Reserved section="studio" />} />
        <Route path="cast" element={<Reserved section="cast" />} />
        <Route path="journey" element={<Reserved section="journey" />} />
        <Route path="blog" element={<Reserved section="blog" />} />

        {/* Auth — standalone pages, not modals */}
        <Route path="portal" element={<SignIn />} />
        <Route path="portal/invite/:token" element={<AcceptInvite />} />
        <Route path="portal/reset" element={<RequestReset />} />
        <Route path="portal/reset/:token" element={<ResetPassword />} />

        {/* Authenticated customer area */}
        <Route path="app" element={<PortalLayout />}>
          <Route index element={<Navigate to="contracts" replace />} />
          <Route path="contracts" element={<Contracts />} />
          <Route path="contracts/:id" element={<ContractDetail />} />
          {/* Inside the portal, so it inherits the same session check — a
              printable contract is no less private than the screen it came
              from. The chrome around it is hidden at print time, not here. */}
          <Route path="contracts/:id/print" element={<ContractPrint />} />
          <Route path="services" element={<Stub section="services" />} />
          <Route path="billing" element={<Stub section="billing" />} />
          <Route path="support" element={<Stub section="support" />} />
        </Route>

        {/* Staff shell — /admin never redirected here; that route was never
            public, so the rename is free (F2 §1). */}
        <Route path="desk" element={<DeskLayout />}>
          <Route index element={<DeskHome />} />
          <Route path="overview" element={<Overview />} />
          <Route path="contracts" element={<DeskContracts />} />
          <Route path="contracts/:id" element={<ContractWorkspace />}>
            <Route index element={<Navigate to="contract" replace />} />
            <Route path="contract" element={<WorkspaceContractTab />} />
            <Route path="design" element={<WorkspaceDesignTab />} />
            <Route path="scope" element={<WorkspaceScopeTab />} />
            <Route path="activity" element={<WorkspaceActivityTab />} />
          </Route>
          <Route path="customers" element={<Customers />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>

      <Route path="*" element={<LocaleRedirect />} />
    </Routes>
  );
}
