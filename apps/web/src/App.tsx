import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { guessLocale, isLocale } from '@/i18n';
import LocaleLayout from '@/components/LocaleLayout';
import Landing from '@/pages/Landing';
import About from '@/pages/About';
import Reserved from '@/pages/Reserved';
import NotFound from '@/pages/NotFound';
import LibraryHome from '@/pages/library/LibraryHome';
import LibraryList from '@/pages/library/LibraryList';
import LibraryReader from '@/pages/library/LibraryReader';
import { useLocale, lp } from '@/lib/locale';
import SignIn from '@/portal/SignIn';
import SignInFactor from '@/portal/SignInFactor';
import AcceptInvite from '@/portal/AcceptInvite';
import ForgotPassword from '@/portal/ForgotPassword';
import ResetPassword from '@/portal/ResetPassword';
import SetNewPassword from '@/portal/SetNewPassword';
import PortalLayout from '@/portal/PortalLayout';
import Contracts from '@/portal/Contracts';
import ContractDetail from '@/portal/ContractDetail';
import ContractPrint from '@/portal/ContractPrint';
import Support from '@/portal/Support';
import PortalBilling from '@/portal/Billing';
import PortalTools from '@/portal/Tools';
import DeskLayout from '@/desk/DeskLayout';
import DeskHome from '@/desk/DeskHome';
import Overview from '@/desk/Overview';
import DeskContracts from '@/desk/Contracts';
import DeskRequests, { DeskRequestDetail } from '@/desk/Requests';
import Customers from '@/desk/Customers';
import CustomerDetail from '@/desk/CustomerDetail';
import Users from '@/desk/Users';
import Library from '@/desk/Library';
import LibraryEntry from '@/desk/LibraryEntry';
import LibraryConcepts from '@/desk/LibraryConcepts';
import Review from '@/desk/Review';
import ReviewDocumentScreen from '@/desk/ReviewDocumentScreen';
import ReviewAdmin from '@/desk/ReviewAdmin';
import Builds from '@/desk/Builds';
import Tickets from '@/desk/Tickets';
import DeskBilling from '@/desk/Billing';
import DeskServices from '@/desk/Services';
import ApiTokens from '@/desk/ApiTokens';
import Templates, { TemplatesIndex } from '@/desk/templates/Templates';
import TemplateTypesTab from '@/desk/templates/TypesTab';
import TemplateScopeTab from '@/desk/templates/ScopeTab';
import ContractWorkspace, { WorkspaceIndex } from '@/desk/workspace/ContractWorkspace';
import WorkspaceStepsTab from '@/desk/workspace/StepsTab';
import WorkspaceNotesTab from '@/desk/workspace/NotesTab';
import WorkspaceContractTab from '@/desk/workspace/ContractTab';
import WorkspaceDesignTab from '@/desk/workspace/DesignTab';
import WorkspaceScopeTab from '@/desk/workspace/ScopeTab';
import WorkspacePhasesTab from '@/desk/workspace/PhasesTab';
import WorkspaceDependenciesTab from '@/desk/workspace/DependenciesTab';
import WorkspaceActivityTab from '@/desk/workspace/ActivityTab';

/** `/` and any unprefixed path get sent to the visitor's best-guess locale. */
function LocaleRedirect() {
  const { pathname, search, hash } = useLocation();
  const first = pathname.split('/')[1];
  const rest = isLocale(first) ? '' : pathname;
  return <Navigate to={`/${guessLocale()}${rest === '/' ? '' : rest}${search}${hash}`} replace />;
}

/** `/cast` and `/blog` have both been reserved routes since launch, and a
 *  public URL that has ever existed is not free to 404 (R2.md §3) — both
 *  fold into Root Cast, which now lives at /library/cast. */
function ToLibraryCast() {
  const locale = useLocale();
  return <Navigate to={lp(locale, '/library/cast')} replace />;
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
        <Route path="journey" element={<Reserved section="journey" />} />

        {/* The Library (R2) — the content lock opens here. Two strands: the
            Research Lab is real; Root Cast is still Reserved, now reachable
            at its permanent address rather than the top level. */}
        <Route path="library" element={<LibraryHome />} />
        <Route path="library/research" element={<LibraryList />} />
        <Route path="library/research/:slug" element={<LibraryReader />} />
        <Route path="library/cast" element={<Reserved section="cast" />} />
        <Route path="cast" element={<ToLibraryCast />} />
        <Route path="blog" element={<ToLibraryCast />} />

        {/* Auth — standalone pages, not modals */}
        <Route path="portal" element={<SignIn />} />
        {/* PD-20: reached only from SignIn, with the challenge id it got back — not a bookmarkable step of its own. */}
        <Route path="portal/factor" element={<SignInFactor />} />
        <Route path="portal/invite/:token" element={<AcceptInvite />} />
        {/* Journeys build plan J1: one identifier field dispatches to the emailed-link path or the phone-code path. */}
        <Route path="portal/reset" element={<ForgotPassword />} />
        <Route path="portal/reset/:token" element={<ResetPassword />} />
        {/* PD-10 — the forced route whenever me.passwordChangeRequired, and the phone-code flow's own destination. */}
        <Route path="portal/set-password" element={<SetNewPassword />} />

        {/* Authenticated customer area */}
        <Route path="app" element={<PortalLayout />}>
          <Route index element={<Navigate to="contracts" replace />} />
          <Route path="contracts" element={<Contracts />} />
          <Route path="contracts/:id" element={<ContractDetail />} />
          {/* Inside the portal, so it inherits the same session check — a
              printable contract is no less private than the screen it came
              from. The chrome around it is hidden at print time, not here. */}
          <Route path="contracts/:id/print" element={<ContractPrint />} />
          {/* Build plan L7: the services rail goes live — see portal/Tools.tsx (S3 renamed it). */}
          <Route path="tools" element={<PortalTools />} />
          {/* S3: Services became Tools; old links and bookmarks keep working. */}
          <Route path="services" element={<Navigate to="../tools" replace />} />
          {/* Build plan L4: the support rail goes live — see Support.tsx. */}
          <Route path="support" element={<Support />} />
          {/* Build plan L6: the billing rail goes live — see portal/Billing.tsx. */}
          <Route path="billing" element={<PortalBilling />} />
        </Route>

        {/* Staff shell — /admin never redirected here; that route was never
            public, so the rename is free (F2 §1). */}
        <Route path="desk" element={<DeskLayout />}>
          <Route index element={<DeskHome />} />
          <Route path="overview" element={<Overview />} />
          <Route path="contracts" element={<DeskContracts />} />
          <Route path="contracts/:id" element={<ContractWorkspace />}>
            <Route index element={<WorkspaceIndex />} />
            <Route path="steps" element={<WorkspaceStepsTab />} />
            <Route path="contract" element={<WorkspaceContractTab />} />
            <Route path="design" element={<WorkspaceDesignTab />} />
            <Route path="scope" element={<WorkspaceScopeTab />} />
            <Route path="phases" element={<WorkspacePhasesTab />} />
            <Route path="dependencies" element={<WorkspaceDependenciesTab />} />
            <Route path="activity" element={<WorkspaceActivityTab />} />
            <Route path="notes" element={<WorkspaceNotesTab />} />
          </Route>
          {/* Journeys build plan J3, view as customer: the portal's own screen,
              answered by the API as the customer would be, read-only. */}
          <Route path="contracts/:id/as-customer" element={<ContractDetail asCustomer />} />
          <Route path="requests" element={<DeskRequests />} />
          <Route path="requests/:id" element={<DeskRequestDetail />} />
          <Route path="customers" element={<Customers />} />
          <Route path="customers/:id" element={<CustomerDetail />} />
          <Route path="users" element={<Users />} />
          <Route path="library" element={<Library />} />
          <Route path="library/concepts" element={<LibraryConcepts />} />
          <Route path="library/new" element={<LibraryEntry />} />
          <Route path="library/:id" element={<LibraryEntry />} />
          <Route path="review" element={<Review />} />
          <Route path="review/:roundId/:documentId" element={<ReviewDocumentScreen />} />
          <Route path="reviewAdmin" element={<ReviewAdmin />} />
          <Route path="builds" element={<Builds />} />
          <Route path="tickets" element={<Tickets />} />
          <Route path="billing" element={<DeskBilling />} />
          <Route path="services" element={<DeskServices />} />
          <Route path="templates" element={<Templates />}>
            <Route index element={<TemplatesIndex />} />
            <Route path="types" element={<TemplateTypesTab />} />
            <Route path="scope" element={<TemplateScopeTab />} />
          </Route>
          <Route path="apiTokens" element={<ApiTokens />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>

      <Route path="*" element={<LocaleRedirect />} />
    </Routes>
  );
}
