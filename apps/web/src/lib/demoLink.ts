import { ApolloLink, Observable, type FetchResult } from '@apollo/client';
import type { Contract, User } from './queries';

/**
 * An in-memory stand-in for the API, enabled with VITE_DEMO=1.
 *
 * It exists so the portal can be reviewed before Postgres is running — the
 * same reason the design prototypes existed. It mirrors the seed data and the
 * gate rule, and it is never bundled into a real deployment: the flag is read
 * at build time, so a production build drops this module entirely.
 */

const now = () => new Date().toISOString();
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

const ME: User = {
  id: 'u-nahal',
  email: 'nahal@example.com',
  name: 'نهال رضایی',
  role: 'CUSTOMER',
  clientName: 'استودیو نهال',
  locale: 'fa',
};

const ROOT: User = {
  id: 'u-root',
  email: 'root@root.local',
  name: 'ریشه',
  role: 'ADMIN',
  clientName: null,
  locale: 'fa',
};

const PAGES: Array<[string, string, string]> = [
  ['home', 'صفحه‌ی فرود', 'Landing'],
  ['about', 'درباره‌ی ما', 'About Us'],
  ['contracts', 'قراردادها', 'Contracts'],
  ['portal', 'ورود به پرتال', 'Portal login'],
];

const SCOPE: Array<[string, string, string]> = [
  ['bilingual', 'دوزبانه (فارسی-اول) با چیدمانِ راست‌به‌چپ', 'Bilingual (Persian-first) with full RTL'],
  ['landing', 'صفحه‌ی فرود مطابق طرحِ مرجع', 'Landing page matching the reference design'],
  ['about', 'صفحه‌ی «درباره‌ی ما»', 'About Us page'],
  ['portal', 'ورود به پرتال (دعوت‌نامه و بازیابی رمز)', 'Portal login (invite + password reset)'],
  ['contracts', 'ماژول قراردادها: فهرست و صفحه‌ی تعاملی', 'Contracts module: list + interactive detail'],
  ['tracking', 'ثبتِ تغییرات با کاربر و زمان', 'Change tracking with actor and timestamp'],
];

const ARTICLES: Array<[number, string, string, string?, string?]> = [
  [1, 'طرفین', 'Parties',
    'این قرارداد میان استودیو نهال (کارفرما) و ریشه (مجری) بسته می‌شود.',
    'This contract is between Nahal Studio (the Client) and Root (the Provider).'],
  [2, 'موضوع و دامنه', 'Subject & Scope',
    'موضوع، طراحی و ساختِ وب‌سایت و پرتالِ مشتریِ نهال است، مطابق دامنه‌ی پیوست ۱.',
    'The subject is the design and build of the Nahal customer website and portal, per the scope in Appendix 1.'],
  [3, 'زمان‌بندی و مراحل', 'Timeline & Milestones',
    'کار در فازهای مشخص انجام می‌شود؛ هر فاز با تأییدِ کارفرما بسته می‌شود.',
    'Work proceeds in defined phases; each phase closes on the Client’s approval.'],
  [4, 'حق‌الزحمه', 'Fees'],
  [5, 'برنامه‌ی پرداخت', 'Payment Schedule'],
  [6, 'بازبینی و تأییدها', 'Revisions & Approvals'],
  [7, 'مالکیت فکری', 'Intellectual Property'],
  [8, 'محرمانگی', 'Confidentiality'],
  [9, 'تضمین‌ها', 'Warranties'],
  [10, 'محدودیت مسئولیت', 'Limitation of Liability'],
  [11, 'فسخ', 'Termination'],
  [12, 'فورس ماژور', 'Force Majeure'],
  [13, 'قانون حاکم', 'Governing Law'],
  [14, 'اطلاع‌رسانی', 'Notices'],
  [15, 'پیوست ۱ — فهرست ویژگی‌ها', 'Appendix 1 — Feature list'],
];

function build(): Contract {
  return {
    id: 'c-nahal',
    ref: 'RC-2026-014',
    titleFa: 'وب‌سایت و پرتال نهال',
    titleEn: 'Nahal website & portal',
    status: 'WAITING_ON_CUSTOMER',
    amount: '180000000',
    customer: { id: ME.id, name: ME.name, clientName: ME.clientName },
    updatedAt: ago(2),
    gate: {
      designComplete: false,
      contractApproved: false,
      signed: false,
      approvedPageCount: 0,
      totalPageCount: 0,
    },
    concepts: ['1a', '1b', '1c'].map((key, i) => ({
      id: `k-${key}`,
      key,
      labelFa: `طرح ۱${key[1]}`,
      labelEn: `Concept ${key}`,
      imageUrl: null,
      chosen: false,
      pages: PAGES.map(([pk, fa, en]) => ({
        id: `p-${key}-${pk}`,
        key: pk,
        labelFa: fa,
        labelEn: en,
        imageUrl: null,
        approved: false,
      })),
      position: i,
    })),
    scopeItems: SCOPE.map(([key, fa, en]) => ({
      id: `s-${key}`,
      key,
      labelFa: fa,
      labelEn: en,
      checked: false,
    })),
    articles: ARTICLES.map(([number, tFa, tEn, bFa, bEn]) => ({
      id: `a-${number}`,
      number,
      titleFa: tFa,
      titleEn: tEn,
      bodyFa: bFa ?? null,
      bodyEn: bEn ?? null,
    })),
    comments: [
      {
        id: 'cm-1',
        author: { id: ROOT.id, name: ROOT.name, role: 'ADMIN' },
        target: 'DESIGN',
        body: 'سه طرحِ کلی برایت آماده کردیم. هر کدام حالِ متفاوتی دارد — با خیال راحت نظر بده و یکی را انتخاب کن.',
        createdAt: ago(2),
      },
    ],
    changeLog: [
      { id: 'l-2', actor: { id: ROOT.id, name: ROOT.name, role: 'ADMIN' }, action: 'PUBLISHED', arg: null, createdAt: ago(2) },
      { id: 'l-1', actor: { id: ROOT.id, name: ROOT.name, role: 'ADMIN' }, action: 'CREATED', arg: null, createdAt: ago(3) },
    ],
    signature: null,
  } as Contract;
}

const state = { contract: build(), signedIn: true };

/** The same rule as the server's computeGate — kept in step deliberately. */
function refreshGate() {
  const c = state.contract;
  const chosen = c.concepts.find((k) => k.chosen) ?? null;
  const pages = chosen?.pages ?? [];
  const approved = pages.filter((p) => p.approved).length;
  c.gate = {
    designComplete: chosen !== null && pages.length > 0 && approved === pages.length,
    contractApproved: c.gate.contractApproved,
    signed: c.signature !== null,
    approvedPageCount: approved,
    totalPageCount: pages.length,
  };
  c.updatedAt = now();
}

let logSeq = 100;
function log(action: string, arg: string | null, actor: User = ME) {
  state.contract.changeLog.unshift({
    id: `l-${logSeq++}`,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    action: action as never,
    arg,
    createdAt: now(),
  });
}

/**
 * The queries select through fragments (`fragment UserFields on User`), and
 * Apollo matches those on __typename. Without it the cache silently drops
 * every field, so the demo data has to be stamped exactly like real results.
 */
const T = <O extends object>(typename: string, obj: O): O =>
  ({ ...obj, __typename: typename }) as O;

function stampUser<O extends object>(u: O) {
  return T('User', u);
}

function stampContract(c: Contract): Contract {
  return T('Contract', {
    ...c,
    customer: stampUser(c.customer),
    gate: T('Gate', c.gate),
    concepts: c.concepts.map((k) =>
      T('DesignConcept', { ...k, pages: k.pages.map((p) => T('PageDesign', p)) }),
    ),
    scopeItems: c.scopeItems.map((s) => T('ScopeItem', s)),
    articles: c.articles.map((a) => T('Article', a)),
    comments: c.comments.map((m) => T('Comment', { ...m, author: stampUser(m.author) })),
    changeLog: c.changeLog.map((e) => T('ChangeLogEntry', { ...e, actor: stampUser(e.actor) })),
    signature: c.signature ? T('Signature', c.signature) : null,
  });
}

function handle(name: string, vars: Record<string, unknown>): Record<string, unknown> {
  const c = state.contract;

  switch (name) {
    case 'Me':
      return { me: state.signedIn ? ME : null };
    case 'MyContracts':
      return { myContracts: [c] };
    case 'Contract':
      return { contract: c };
    case 'SignIn':
      state.signedIn = true;
      return { signIn: { user: ME } };
    case 'SignOut':
      state.signedIn = false;
      return { signOut: true };

    case 'ChooseConcept': {
      for (const k of c.concepts) {
        k.chosen = k.id === vars.conceptId;
        // Abandoning a concept discards approvals made against it.
        if (!k.chosen) k.pages.forEach((p) => (p.approved = false));
      }
      const chosen = c.concepts.find((k) => k.chosen)!;
      chosen.pages.forEach((p) => (p.approved = false));
      log('CHOSE_CONCEPT', chosen.key);
      refreshGate();
      return { chooseConcept: c };
    }

    case 'SetPageApproval': {
      const before = c.gate.designComplete;
      for (const k of c.concepts) {
        const page = k.pages.find((p) => p.id === vars.pageDesignId);
        if (page) {
          page.approved = Boolean(vars.approved);
          log(page.approved ? 'APPROVED_PAGE' : 'UNAPPROVED_PAGE', page.key);
        }
      }
      refreshGate();
      if (!before && c.gate.designComplete) log('DESIGN_COMPLETE', null);
      return { setPageApproval: c };
    }

    case 'ApproveContract':
      c.gate = { ...c.gate, contractApproved: true };
      log('APPROVED_CONTRACT', null);
      c.updatedAt = now();
      return { approveContract: c };

    case 'SetScopeItem': {
      const item = c.scopeItems.find((s) => s.id === vars.scopeItemId);
      if (item) {
        item.checked = Boolean(vars.checked);
        log(item.checked ? 'SCOPE_ON' : 'SCOPE_OFF', item.key);
      }
      c.updatedAt = now();
      return { setScopeItem: c };
    }

    case 'SignContract':
      c.signature = { id: 'sig-1', typedName: String(vars.typedName), signedAt: now() };
      c.status = 'IN_PROGRESS';
      log('SIGNED', null);
      refreshGate();
      return { signContract: c };

    case 'AddComment':
      c.comments.push({
        id: `cm-${logSeq++}`,
        author: { id: ME.id, name: ME.name, role: 'CUSTOMER' },
        target: 'CONTRACT',
        body: String(vars.body),
        createdAt: now(),
      });
      log('COMMENTED', null);
      c.status = 'WAITING_ON_ROOT';
      c.updatedAt = now();
      return { addComment: c };

    default:
      return {};
  }
}

/** Applies the right typename to each root field of a result. */
function stampResult(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || typeof value !== 'object') {
      out[key] = value;
    } else if (key === 'me') {
      out[key] = stampUser(value as object);
    } else if (key === 'signIn') {
      out[key] = T('AuthPayload', { user: stampUser((value as { user: User }).user) });
    } else if (Array.isArray(value)) {
      out[key] = value.map((row) => stampContract(row as Contract));
    } else {
      out[key] = stampContract(value as Contract);
    }
  }
  return out;
}

export const demoLink = new ApolloLink(
  (operation) =>
    new Observable<FetchResult>((observer) => {
      const name = operation.operationName ?? '';
      const data = stampResult(handle(name, operation.variables ?? {}));
      // A tick of latency, so loading states are exercised rather than skipped.
      const timer = setTimeout(() => {
        observer.next({ data });
        observer.complete();
      }, 60);
      return () => clearTimeout(timer);
    }),
);
