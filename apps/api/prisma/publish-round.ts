/**
 * Publishes a Review Room round: freezes a root-sot commit sha plus its
 * allowlisted documents at that sha into Postgres, by calling
 * `publishReviewRound` over HTTP. This process is the only place in the
 * whole app that ever reads a git tree — the API itself never does, and
 * nothing here pulls anything back out of root-sot later (C1.md §0).
 *
 *   npm run publish-round --workspace=apps/api -- \
 *     --sot ../root-sot --sha <40-char sha> [--manifest review-manifest.json] [--label "…"]
 *
 * Needs, from the environment — never argv, which ends up in shell history
 * and `ps`:
 *   PUBLISH_ADMIN_EMAIL / PUBLISH_ADMIN_PASSWORD — an account holding
 *     review.admin, signed in the ordinary way to get the same session
 *     cookie a browser would. The mutation is the trust boundary, not this
 *     script (C1.md §3.1) — there is no separate API-token scheme to invent.
 *   PUBLISH_API_URL — defaults to http://localhost:4000.
 */
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { buildRoundDocuments, parseManifest, type RoundDocument } from '../src/lib/publishRound.js';
import { isFullCommitSha } from '../src/lib/reviewBlocks.js';

// Run directly, not by the Prisma CLI, so nothing else loads .env — same
// reasoning as create-admin.ts.
try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    'usage: publish-round --sot <path> --sha <40-char commit sha> [--manifest review-manifest.json] [--label "…"]',
  );
  process.exit(64);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`--${key} needs a value.`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function git(sot: string, args: string[]): string {
  return execFileSync('git', ['-C', sot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** `null` means the path does not exist at that sha. Any other failure (git
 *  missing, `sot` not a repository) is left to throw — those are not "one
 *  document is absent," they are "nothing read from here can be trusted." */
function showFileAt(sot: string, sha: string, path: string): string | null {
  try {
    return git(sot, ['show', `${sha}:${path}`]);
  } catch {
    return null;
  }
}

type GraphQLEnvelope<T> = { data?: T; errors?: Array<{ message: string }> };

async function graphql<T>(
  apiUrl: string,
  query: string,
  variables: Record<string, unknown>,
  cookie?: string,
): Promise<{ data: T; setCookie: string | null }> {
  const res = await fetch(`${apiUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as GraphQLEnvelope<T>;
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  if (!body.data) throw new Error('The API returned no data and no error.');
  return { data: body.data, setCookie: res.headers.get('set-cookie') };
}

/** Signs in the ordinary way — the same mutation a browser calls — and
 *  returns the `Cookie` header value the session sets. */
async function signIn(apiUrl: string, email: string, password: string): Promise<string> {
  const { setCookie } = await graphql<{ signIn: { user: { id: string } } }>(
    apiUrl,
    'mutation($email:String!,$password:String!){ signIn(email:$email,password:$password){ user { id } } }',
    { email, password },
  );
  if (!setCookie) throw new Error('Sign-in succeeded but returned no session cookie.');
  return setCookie.split(';')[0];
}

async function publishRound(
  apiUrl: string,
  cookie: string,
  vars: { sha: string; label: string | null; documents: RoundDocument[] },
): Promise<{ id: string }> {
  const { data } = await graphql<{ publishReviewRound: { id: string } }>(
    apiUrl,
    `mutation($sha:String!,$label:String,$documents:[ReviewDocumentInput!]!){
      publishReviewRound(sha:$sha,label:$label,documents:$documents){ id }
    }`,
    vars,
    cookie,
  );
  return data.publishReviewRound;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sot = args.sot;
  const sha = args.sha;
  const manifestPath = args.manifest ?? 'review-manifest.json';
  const label = args.label ?? null;

  if (!sot) usage('--sot is required: the path to a root-sot checkout.');
  if (!sha) usage('--sha is required: a full commit hash, not a branch or tag.');

  // C1.md §3: a round names an immutable commit, not "whatever main was" —
  // refuse a symbolic ref before touching git at all.
  if (!isFullCommitSha(sha)) {
    usage(
      `--sha must be a full 40-character commit hash — a branch name or "HEAD" is a symbolic ref, not a commit. Got: "${sha}".`,
    );
  }

  const dirty = git(sot, ['status', '--porcelain']).trim();
  if (dirty) {
    console.error(
      `${sot} has uncommitted changes. Commit or stash them first — a round should name what is actually reviewable there, not "plus whatever happens to be on disk right now".`,
    );
    process.exit(1);
  }

  try {
    git(sot, ['rev-parse', '--verify', `${sha}^{commit}`]);
  } catch {
    console.error(`${sha} does not resolve to a commit in ${sot}.`);
    process.exit(1);
  }

  const manifestRaw = showFileAt(sot, sha, manifestPath);
  if (manifestRaw === null) {
    console.error(`${manifestPath} does not exist at ${sha}.`);
    process.exit(1);
  }

  const manifest = parseManifest(manifestRaw);

  let documents: RoundDocument[];
  try {
    documents = buildRoundDocuments(manifest, (path) => showFileAt(sot, sha, path));
  } catch (err) {
    // A path the manifest names that is missing at this sha fails here,
    // loudly, before anything is sent — a partially published round is a
    // corpus with a hole a reviewer cannot see (C1.md §3.1).
    console.error((err as Error).message);
    process.exit(1);
  }

  const apiUrl = process.env.PUBLISH_API_URL ?? 'http://localhost:4000';
  const email = process.env.PUBLISH_ADMIN_EMAIL;
  const password = process.env.PUBLISH_ADMIN_PASSWORD;
  if (!email || !password) {
    usage('PUBLISH_ADMIN_EMAIL and PUBLISH_ADMIN_PASSWORD must be set — an account with review.admin.');
  }

  const cookie = await signIn(apiUrl, email, password);
  const round = await publishRound(apiUrl, cookie, { sha, label, documents });
  console.info(`Published round ${round.id} (sha ${sha}) with ${documents.length} document(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
