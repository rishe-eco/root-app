# Deploying to the VPS

Two halves, deployed differently on purpose.

**The API** runs in Docker on the server — it plus Postgres, built there, because
that is where it runs. **The web app** is built on your machine and uploaded as
static files, which host Nginx serves off disk. `vite build` is the step most
likely to exhaust a small VPS's memory, and its output needs no runtime.

```
browser ──TLS──▶ host Nginx ──┬──▶ /srv/root/current   (static files)
                              └──▶ 127.0.0.1:4000      (api container) ──▶ db container
```

**Both paths in that diagram are settings, not facts.** `/srv/root` is
`release-web.sh`'s `REMOTE_ROOT` argument, and `4000` is `API_PORT` in `.env`.
Every path and port below is written out in full for a default install; if you
change either, see [Somewhere else on the box](#somewhere-else-on-the-box).

One origin, not two. The session is an httpOnly `SameSite=Lax` cookie: put the
API on `api.example.com` and the browser drops it on every request, and every
customer silently appears logged out with nothing in the console to explain it.
So Nginx serves both from one name and `VITE_GRAPHQL_URL` stays unset.

Host Nginx is also the only proxy in the chain, which is why
`TRUST_PROXY_HOPS=1`. That number decides what address `req.ip` reports, and
`req.ip` is written to `Signature.ip` on a legal signing record — so it is
load-bearing, not cosmetic.

---

## Server layout

```
/srv/root/                the app root — a default, not a requirement
  app/                    git clone — the API image and compose file build from here
    .env                  secrets, never committed. Compose reads this one and
                          only this one — NOT app/apps/api/.env
  releases/
    20260802T1200-a1b2c3/ an uploaded web build
    20260802T1600-d4e5f6/
  current -> releases/20260802T1600-d4e5f6
  storage/                uploaded files — STORAGE_DIR
    public/               served straight off disk by Nginx
    private/              only ever through the API, after an ownership check
    tmp/                  uploads in flight (streamed mockup bundles) — never served
```

`current` is a symlink and Nginx's document root. `release-web.sh` swaps it
with an atomic rename, so no request ever sees a half-uploaded build.

**`app/` has no `node_modules`, and should not.** Nothing on the server runs
this code from source: Docker's builder stage does its own `npm ci` inside the
image, and the web app is built on your machine. The clone is here to give
`docker compose build` a context and a compose file, nothing more. Running
`npm install` on the server installs a React toolchain the box never uses —
and `.dockerignore` excludes `node_modules` from the build context anyway, so
not one byte of it would reach the image.

The corollary is that any `/app/...` path in this file is **inside the
container**. `/app/node_modules` exists; `/srv/root/app/node_modules` does not.
To look at the real one:

```bash
docker compose -f docker-compose.prod.yml exec -T api ls /app/node_modules/.bin/
```

**`storage/` sits beside `current`, never inside it.** Releases are swapped and
eventually pruned; a storage directory under one would take every customer's
design files with it. The API refuses to boot in production without an explicit
`STORAGE_DIR` for exactly this reason — there is no default that is safe to
guess. It is also **not** in the Postgres volume, which means the database dump
below is *not* a complete backup on its own.

---

## First time

**1. The box.** Docker, Nginx, certbot:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
sudo usermod -aG docker "$USER"    # log out and back in for this to take effect
```

**2. The code and its secrets.**

```bash
sudo mkdir -p /srv/root && sudo chown "$USER" /srv/root
cd /srv/root
git clone git@github.com:rishe-eco/root-app.git app
cd app
cp .env.production.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET
```

Fill in `.env`: `POSTGRES_PASSWORD`, `JWT_SECRET`, and `APP_ORIGIN` (your real
public origin, scheme included, no trailing slash — invite and reset links are
built from it).

Also set `STORAGE_DIR=/srv/root/storage` and `PUBLIC_FILES_BASE` to your origin
plus `/public-files`. The API will not start in production without the first of
those, and the bind mount in `docker-compose.prod.yml` uses it on both sides.

`ANTHROPIC_API_KEY` is optional and blank is a real choice: without it the
Research Lab's "Ask the Lab" and "Ask this paper" panels are not rendered at
all, and nothing else changes. It is the only variable in that file that costs
money per request — read `docs/development/R4.md` §4–5 before setting it.

**3. Up.** The API's entrypoint runs `prisma migrate deploy` before starting, so
the schema is created on first boot. It creates `storage/public` (0755, so
`www-data` can traverse it) and `storage/private` (0700) itself.

```bash
docker compose -f docker-compose.prod.yml up -d --build
curl -s localhost:4000/health          # {"ok":true} — localhost:$API_PORT
```

If it does not come up, `docker compose -f docker-compose.prod.yml logs api` is
the whole answer: the API validates its environment at boot and names the
variable it is unhappy about. A container that keeps saying `Restarting` is
crashing on start, not failing a healthcheck — a failed healthcheck reads
`Up (unhealthy)` and stays up.

**4. Nginx.**

```bash
sudo cp deploy/nginx/security-headers.conf /etc/nginx/snippets/root-security-headers.conf
sudo cp deploy/nginx/root.conf /etc/nginx/sites-available/root
sudo sed -i 's/example\.com/yourdomain.com/g' /etc/nginx/sites-available/root
sudo ln -sf /etc/nginx/sites-available/root /etc/nginx/sites-enabled/root
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

`www-data` has to traverse to the files: `sudo chmod 755 /srv/root` (and keep
the release directories at 755).

The `location /public-files/` block has a path in it — `alias
/srv/root/storage/public/`. If `STORAGE_DIR` is anywhere else, change it to
match, and **keep the `/public/` on the end**: aliasing `STORAGE_DIR` itself
would put every private file behind a guessable URL, served by Nginx with no
check at all. Confirm after reloading:

```bash
curl -sI --path-as-is https://yourdomain.com/public-files/../private/   # want 400, 404, or 200 with the SPA's index.html
```

Nginx resolves the `..` before it picks a location, so a correct alias answers
with a refusal or with the SPA's own page. What must never come back is a file
from `storage/`. `deploy/checks.sh` makes this check after every deploy.

**5. The first release**, from your machine, in the repo root:

```bash
./deploy/release-web.sh you@your-vps
```

**6. TLS.**

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Once HTTPS is live and you are confident it stays, add HSTS to
`/etc/nginx/snippets/root-security-headers.conf` — the line is written out at
the bottom of the committed copy. It is left off until then because a browser
holds you to it for the full `max-age` and turning the header off does not
release anyone already carrying it.

**7. An admin account.** Do **not** run `npm run seed` — it creates two accounts
whose password is written in this repository. Create one real admin instead.
The password is read from stdin, so it stays out of shell history and `ps`:

```bash
docker compose -f docker-compose.prod.yml exec -T api /app/node_modules/.bin/tsx prisma/create-admin.ts you@example.com "Your Name"
# type the password, then ctrl-D
```

One line on purpose. A `\` continuation that loses its newline in a paste hands
Docker an argument beginning with a space, and the error it prints —
`exec: " tsx": executable file not found in $PATH` — reads like a missing
binary rather than a mangled one.

**Both paths in that command are inside the container.** `prisma/create-admin.ts`
resolves against the image's `WORKDIR /app/apps/api`; on the host the same file
is `apps/api/prisma/create-admin.ts`. There is no `/app` on the server and no
`node_modules` in the server's clone — see [Server layout](#server-layout).

The binary directly rather than `npx`, for the reason `docker-entrypoint.sh`
gives where it does the same with `prisma`: npx can decide to consult its cache
or the network when resolution surprises it, and nothing in a running container
should reach for a registry. `tsx` hoists to the workspace root, hence
`/app/node_modules/.bin`, not `/app/apps/api/node_modules/.bin`.

It refuses a password under 10 characters and refuses an email that already
exists — it will not quietly reset one. Only the trailing newline your shell
adds is stripped, so a password with a leading or trailing space keeps it.

Then sign in at `/fa/portal` — one sign-in for everyone; there is no separate
admin login — and the desk opens at `/fa/desk`, where invites are issued from
**Customers**.

---

## Somewhere else on the box

**Another tenant: IMNSTR.com.** This box also runs IMNSTR: `/srv/imnstr`, compose project `imnstr` on `127.0.0.1:4100`, `/etc/nginx/sites-available/imnstr`, limit zone `imnstr_auth`, cron `/etc/cron.d/imnstr-backup`. Its setup is in `deploy/README.md` of `rishe-eco/i-monster`.

Nothing above is load-bearing except the *agreement* between the pieces. Two
things move, and each has a short list of places that must move with it.

**The app root** — `/srv/root` throughout. It is `release-web.sh`'s second
argument, defaulting to `/srv/root`:

```bash
./deploy/release-web.sh you@your-vps /opt/stacks/root
```

That one argument moves `releases/` and `current`. The rest does not follow it
automatically: the `root` directive and the `location /public-files/` alias in
`/etc/nginx/sites-available/root`, `STORAGE_DIR` in `.env`, and wherever you
cloned the repo (the compose file builds from the clone, and `docker compose`
must be run from inside it — it is the only path here that has no setting at
all). `STORAGE_DIR` does not have to sit under the app root; it only has to sit
outside `current`, and outside any directory a release replaces.

**Root's own box uses `/opt/stacks/root`**, with its Nginx site at
`/etc/nginx/sites-available/m-root` and `API_PORT=4009` (another container
holds 4000, so `curl localhost:4009/health` there), and the CI deploy is
written for it. The deploy script reads its app root from the `ROOT=` line near the top of
`deploy/root-deploy.sh` and from nowhere else: `sudo` strips the environment,
so the line has to say it. *Routine deploys* and *Server setup for CI* below use
that path. If the app root ever moves, change that line, reinstall the script
(*Server setup for CI*, step 5), and change those two sections.

**The API port** — `4000` throughout, and there are two of them, which is the
part worth being careful about:

- `API_PORT` in `.env` is the **host** side. Change this one.
- `PORT: 4000` in `docker-compose.prod.yml` is the **container** side. Leave it.
  The container is a private network of one; nothing collides in there, and
  moving it only breaks the Dockerfile's healthcheck.

So `API_PORT=4009` gives `127.0.0.1:4009->4000/tcp` in `docker compose ps`, and
that asymmetry is correct. The four `proxy_pass` lines in
`deploy/nginx/root.conf` are the only other place to change.

Editing `apps/api/.env` does nothing on the server. That file is for running the
API on the host in development; the container never reads it, and Compose reads
the repo-root `.env` and only that one.

---

## Routine deploys

**A push to `main` deploys**, once *Server setup for CI* (below) is done.
`.github/workflows/deploy.yml` runs on every push to `main`:

1. **`check`** runs `npm ci`, `prisma generate`, shellcheck and the deploy
   script's own test harness (`deploy/test/root-deploy.test.sh`), `typecheck`,
   both unit suites, the integration suite against a Postgres service, and the
   web build. There is no Playwright: e2e stays on your machine.
2. If that is green, **`deploy`** builds the web app on the runner, packs it with
   the commit's id, and sends it as the input of one SSH connection to the box
   as `root-deploy`. That key can only run `/usr/local/sbin/root-deploy`, as root
   through `sudo`, with no arguments. The job runs only for `main`, and only
   while the repository variable `DEPLOY_ENABLED` is `true`; any other value
   switches automatic deploys off, and `check` still runs.
3. The script deploys **exactly that commit**, never a newer tip of `main`, so
   the API and the web always come from one commit. It fast-forwards
   `/opt/stacks/root/app` to it, dumps the database if the commit adds a migration,
   builds the API image on the box, runs `up -d --wait`, checks the container's
   health and `nginx -t`, makes the web build live with the same atomic swap
   `release-web.sh` uses, and runs `deploy/checks.sh` as `nobody`. A green run
   ends with `DEPLOYED <sha>`, and the job fails unless that is the pushed commit.

The web is built on the runner for the reason `release-web.sh` builds it on
your machine: `vite build` is the step most likely to exhaust this box's memory.
The API is still built on the box, because that is where it runs.

**The script never changes Nginx, the compose file, `.env` or itself.** If
anything under `deploy/nginx/`, `docker-compose.prod.yml` or
`.env.production.example` changed since the commit the box has, or
`deploy/root-deploy.sh` differs from the installed copy, it stops before it
changes anything and exits 2 (*What each exit code means*). It never reloads
Nginx, never prunes images and never rolls back. Any other one-off server step
(a new cron line, a certificate) is still yours, by hand, before the push that
needs it.

The repository is public, and so is the Actions log. Nothing in the workflow or
the script prints a secret or a line of `.env`.

### Deploying by hand

The fallback when CI is off or red, and the way through a stop (exit 2). The
two halves, as before CI:

**Web**, from your machine, in the repo root:

```bash
./deploy/release-web.sh you@your-vps /opt/stacks/root
```

It refuses to run on a dirty tree, because the release is named after the
commit and that name has to be true. `ALLOW_DIRTY=1` overrides.

**API**, on the server:

```bash
cd /opt/stacks/root/app && git pull --ff-only
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations apply on start. A failed migration means the container refuses to
boot, which is the intent: a server running against a schema it does not expect
is worse than one that is down. Check with `docker compose -f
docker-compose.prod.yml logs -f api`. A by-hand deploy takes no database dump;
take one first (*Backups*) when the commit adds a migration.

After a by-hand step, **Run workflow** on the repository's Actions page (the
`deploy` workflow, branch `main`). That deploys the tip of `main` through CI.
The checkout is already current, so the stop files no longer differ, the image
builds from cache, and the run ends with every check passed.

The P0-7 deploy (the `__Host-root_session` cookie rename) signs everyone out
once, on that one deploy only — free, since production has no real users yet.

### What each exit code means

| Exit | Meaning | What to do |
|---|---|---|
| **0** | Deployed, and every check passed. The last line is `DEPLOYED <sha>`. | Nothing. |
| **2** | **Stopped, and nothing was changed.** The API and the live web release are as they were. The line says why, and the line after it says what to do by hand. | The list below, then **Run workflow**. |
| **1** | **Failed after something may have changed.** The line names the step: `checkout`, `dump`, `build`, `up`, `health`, `nginx`, `web` or `checks`. There is no automatic rollback, because migrations run at boot and old code against a migrated database is the riskier move. | Read the step's output, fix forward on `main`, or roll back by hand (below). A failed `dump` or `build` leaves the old container serving, and every failure before `web` leaves the old web release live. |

What to do for each exit 2. `git` runs as the account that owns
`/opt/stacks/root/app`, not with `sudo`:

- **Another deploy holds the lock.** Wait for it, then re-run.
- **No web build on stdin.** The script was run from a shell. It only takes
  input from CI: use **Run workflow**, or deploy by hand.
- **The stream is not a gzipped tar, or its `COMMIT` is wrong.** Re-run. If it
  repeats, read the job's *Package the web build* step.
- **The checkout has uncommitted changes.** `cd /opt/stacks/root/app && git status`
  shows them. Commit, stash or discard them, then re-run.
- **The commit is not on `main`.** Only `main` deploys.
- **The commit is older than the checkout.** An old run was re-run, or the
  checkout was moved by hand. Use **Run workflow**. To go back on purpose, see
  *Rolling back by hand*.
- **Not a fast-forward** (history was rewritten). The script never resets the
  checkout. Compare `git log` in `/opt/stacks/root/app` with `main` and decide there.
- **`deploy/nginx/` changed.** The live files can't be compared with the
  repository's, because certbot rewrote the site and your domain was put in by
  hand, so carry the change across yourself. See it with
  `cd /opt/stacks/root/app && git fetch && git diff HEAD origin/main -- deploy/nginx`.
  Apply it to `/etc/nginx/sites-available/m-root` (this box's name for the site),
  `/etc/nginx/snippets/root-security-headers.conf` or
  `/etc/nginx/sites-available/root-mockup`, keeping a copy of the old file. Then
  `sudo nginx -t && sudo systemctl reload nginx`, then `git pull --ff-only`,
  then **Run workflow**.
- **`docker-compose.prod.yml` changed.** Read the diff the same way, deploy the
  API by hand (above), then **Run workflow**.
- **`.env.production.example` changed.** Read the diff the same way, add what
  the new lines need to `/opt/stacks/root/app/.env`, then `git pull --ff-only`, then
  **Run workflow**.
- **The installed script differs from the commit's.** `git pull --ff-only`,
  reinstall it (*Server setup for CI*, step 5), then **Run workflow**.

Each of these names everything it found in one run, so fix all of them before
re-running.

### Rolling back by hand

**Web**: the previous releases are still on disk (five, plus the live one):

```bash
ssh you@your-vps 'cd /opt/stacks/root && ls releases/'
ssh you@your-vps 'cd /opt/stacks/root && ln -sfn releases/<name> .current.tmp && mv -T .current.tmp current'
```

No Nginx reload is needed, because Nginx resolves the root per request.

**API**: roll it back only when the bad commit added no migration
(`git diff --stat <good>..HEAD -- apps/api/prisma/migrations` prints nothing),
because a migrated database under old code is worse than the bug. If it did add
one, fix forward. The dump taken before that migration is in
`/opt/stacks/root/backups/pre-migrate-<stamp>-<sha>.sql.gz` (root only; the newest
five are kept).

1. In GitHub, **Settings, Secrets and variables, Actions, Variables**: set
   `DEPLOY_ENABLED` to `false`, so a push can't redeploy the bad commit while
   you work.
2. On the box, check out the last good commit and rebuild:
   ```bash
   cd /opt/stacks/root/app && git checkout --detach <good sha>
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   Roll the web back to that commit's release too (above).
3. Revert the bad commit on `main`. On the box, run `git checkout main` in
   `/opt/stacks/root/app`, then set `DEPLOY_ENABLED` back to `true`. The next push
   deploys the revert.

### Checks after every deploy

`deploy/checks.sh` is the one list. The deploy script runs it as `nobody` from
the new checkout, so a change that adds a check edits that file in its own diff,
and nobody reinstalls the root script. By hand, on the box:

```bash
bash /opt/stacks/root/app/deploy/checks.sh /opt/stacks/root/current
```

An optional second argument is the origin (default `https://m-root.com`). It
stops at the first failure and prints `FAILED <check name>: <why>`. It never
reads `.env`. It checks that:

- `/` serves the live release's `index.html` byte for byte, with the CSP from
  the **committed** `security-headers.conf`. A snippet that was edited in the
  repository but never copied to the box fails here;
- `X-Frame-Options`, `nosniff`, `Referrer-Policy` and `no-cache` are set, and
  no cookie is set;
- a client-side route (`/fa/portal`) falls back to the same page;
- the script `index.html` names is served from the release, `immutable`;
- `/graphql` answers an anonymous `{ __typename }` through Nginx;
- a climb out of `/public-files/` reaches nothing private;
- `http://` redirects to `https://` with a 301.

The two checks that need root stay in the script: the API container's `healthy`
and `nginx -t`. The mockup wildcard's headers (*Staging and mockup domains*)
are not checked here yet, because that block is not live until its DNS and
certificate exist.

**After any deploy that touches Nginx** — a new release, an edited
`security-headers.conf`, a certbot run — confirm the header a browser will
actually see, not just what the committed conf says. `nginx -t` only checks
syntax; it does not tell you a stale worker is still serving the old snippet,
or that `deploy/nginx/security-headers.conf` was edited on your machine but
never copied to `/etc/nginx/snippets/root-security-headers.conf` on the box:

```bash
curl -sI https://yourdomain.com/ | grep -i content-security-policy
```

The line must show a `frame-src` naming both `https://*.staging.m-root.com`
and `https://*.mockup.m-root.com` (P0-2, defect D-1) — no test in this
repository can see an Nginx header, so this `curl` is the only check that
exists for it.

---

## Server setup for CI

Once, by you, as your sudo user. **Before you start**, deploy the commit that
carries these files by hand (*Deploying by hand*: web and API), and bring the
live Nginx files and `.env` up to that commit. The first CI run then starts
from a checkout that is current, and `/opt/stacks/root/app/deploy/root-deploy.sh`
exists. The checkout must be on `main`, cloned by your own account (*First
time*, step 2). One command per line, with `sudo` on each.

**`root-deploy` is a separate account from your own sudo user and from IMNSTR's
`imnstr-deploy`. Never give CI's key to either.**

1. **The key pair, on your own machine, never on the box and never in the
   repository.** It has no passphrase, because CI cannot type one:
   ```bash
   ssh-keygen -t ed25519 -N '' -C root-ci -f ./root-ci-key
   ```
   `root-ci-key.pub` is the public half, one line. `root-ci-key` is the private
   half. Both are deleted at step 8.

2. **The user**: no password, `/bin/sh` as its shell (`sshd` runs the forced
   command through the user's shell, so `nologin` would block it), and no group
   but its own:
   ```bash
   sudo adduser --disabled-password --gecos '' --shell /bin/sh root-deploy
   ```
   If a login later says the account is locked, `sudo usermod -p '*'
   root-deploy` makes the password unusable without locking the account.

3. **The key's line**, with the forced command. Paste the public key where
   `<public key>` is, keeping the single quotes. The directory and the file
   belong to root, so the user cannot rewrite its own line:
   ```bash
   sudo install -d -m 0755 -o root -g root /home/root-deploy/.ssh
   printf '%s\n' 'restrict,command="sudo -n /usr/local/sbin/root-deploy" <public key>' | sudo tee /home/root-deploy/.ssh/authorized_keys
   sudo chmod 0644 /home/root-deploy/.ssh/authorized_keys
   ```
   The line must read `restrict,command="sudo -n /usr/local/sbin/root-deploy"
   ssh-ed25519 AAAA… root-ci`. `restrict` gives no pty, no forwarding and no
   agent. Any command the client sends runs the script and nothing else.

4. **The sudoers line.** A broken file in `/etc/sudoers.d/` breaks `sudo` for
   everyone on the box, so write it to a temporary file, check it with
   `visudo -cf`, and only then install it. The name has no dot, because `sudo`
   skips names with one. The empty `""` forbids arguments:
   ```bash
   F=$(mktemp /tmp/root-deploy.XXXXXX)
   printf 'root-deploy ALL=(root) NOPASSWD: /usr/local/sbin/root-deploy ""\n' > "$F"
   sudo visudo -cf "$F"
   ```
   Only if the last command printed `parsed OK`:
   ```bash
   sudo install -m 0440 -o root -g root "$F" /etc/sudoers.d/root-deploy
   rm "$F"
   sudo -n true
   ```
   The last line proves your own `sudo` still works.

5. **The script**, from the checkout:
   ```bash
   sudo install -o root -g root -m 0755 /opt/stacks/root/app/deploy/root-deploy.sh /usr/local/sbin/root-deploy
   ```

6. **Prove the account.** `id` shows no `docker` group, `sudo -l` lists the one
   command with `""`, the third command is refused, and `nobody` can run the
   checks:
   ```bash
   id root-deploy
   sudo -l -U root-deploy
   sudo -u root-deploy docker ps
   sudo runuser -u nobody -- bash /opt/stacks/root/app/deploy/checks.sh /opt/stacks/root/current
   ```

7. **On GitHub (web)**, in `rishe-eco/root-app`. Settings, **Environments**,
   `production` (deployment branches: `main` only; no reviewers and no wait
   timer, since either would make every deploy wait for a click). Add four
   **environment secrets**:
   - `DEPLOY_HOST`: the box's hostname or address;
   - `DEPLOY_PORT`: `22`;
   - `DEPLOY_KEY`: the whole private key file, including its `-----BEGIN` and
     `-----END` lines;
   - `DEPLOY_KNOWN_HOSTS`: one line, the box's own host key. Make it on the box,
     with the same name or address as `DEPLOY_HOST` in place of `<host>`:
     ```bash
     echo "<host> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
     ```

   Then, under Settings, **Secrets and variables, Actions, Variables**, add
   the variable `DEPLOY_ENABLED` = `true` under *Repository variables*. **Set
   it last.** Anything but `true` switches automatic deploys off. **Don't make
   it an environment variable of `production`:** GitHub decides whether to run a
   job before it loads the job's environment, so the `deploy` job's `if` can't
   see one there, and every run shows `deploy` as skipped (found on IMNSTR).

8. **Delete the private half** once it is pasted into `DEPLOY_KEY`, on your own
   machine:
   ```bash
   rm root-ci-key root-ci-key.pub
   ```
   (`Remove-Item` in PowerShell.) GitHub keeps the secret, and nobody can read
   it back.

9. **Run workflow** (Actions, `deploy`, branch `main`). The checkout is
   current, so the image builds from cache, the web build goes live as a new
   release, and the checks run. The run is green with `DEPLOYED <sha>` equal to
   the pushed commit.

If a run cannot connect, either the provider's firewall limits SSH by address
(hosted runners come from a wide, changing range) or the key line is wrong.
`sudo journalctl -u ssh --since '10 minutes ago'` on the box says which. If
`AllowUsers` or `AllowGroups` is ever added to `sshd_config`, add `root-deploy`
to it, then `sudo sshd -t && sudo systemctl reload ssh`.

The script is tested without a box by `deploy/test/root-deploy.test.sh`
(stubbed Docker and Nginx, a scratch origin and checkout). It needs Linux. On
Windows, run it in a container:

```bash
docker run --rm -v "$PWD:/src:ro" -w /src buildpack-deps:bookworm-scm bash deploy/test/root-deploy.test.sh
```

---

## Staging and mockup domains

**Warning, read before doing anything in this section:** until **P0-7**
(same-site hardening — the `__Host-` session cookie and the `Origin` check on
`/graphql`, `/upload` and `/ask`) is merged *and deployed*, **no staging site
and no mockup may be served under `m-root.com`**, even if the DNS and
certificates below are ready. The reason is D-8: a subdomain of the portal's
own registrable domain is *same-site* with it, and same-site code — a
customer's WordPress theme, an uploaded mockup, anything Root did not audit
line by line — can plant a cookie for the parent domain or ride the session
cookie on a same-site request that `SameSite=Lax` alone does not stop. P0-7 is
the price of PD-8's choice (subdomains of `m-root.com`, rather than a separate
registrable domain per project); it must be in place first, not after the
first real site is live.

This section is P0-5: the DNS and TLS lead time for the two wildcards PD-8
and PD-9 put every staging site and mockup view under. It has no code in it —
put it in motion the day this plan is accepted, because certificate issuance
and DNS propagation are the slowest things in the whole plan.

**1. Wildcard DNS.** Two records, both pointed at the VPS's address:

```
*.staging.m-root.com.   A   <vps-ip>
*.mockup.m-root.com.    A   <vps-ip>
```

(or `AAAA`, if the VPS is reached over IPv6 — match whatever `A`/`AAAA` record
`m-root.com` itself already uses.)

**2. Wildcard certificates.** Let's Encrypt issues a wildcard certificate only
through the **DNS-01** challenge — it proves you control the domain by asking
you to publish a TXT record, not by fetching a file over HTTP, because a
wildcard has no single host to serve one from. That means renewal needs API
access to whatever DNS provider hosts `m-root.com`: **confirm the provider has
a certbot DNS plugin before counting on this** (`certbot plugins` after
installing lists what is available; most major providers — Cloudflare, Route
53, DigitalOcean and the rest — have one). Without one, the wildcard still
issues once by hand but cannot renew unattended, and a wildcard cert is not
something to renew by hand every 90 days.

```bash
sudo certbot certonly --dns-<provider> --cert-name m-root-wildcards   -d '*.staging.m-root.com' -d '*.mockup.m-root.com'
```

`--cert-name` matters: without it certbot names the certificate after the first
`-d` (`staging.m-root.com`), and `deploy/nginx/mockup.conf` points at
`/etc/letsencrypt/live/m-root-wildcards/`.

Then prove renewal actually works before relying on it:

```bash
sudo certbot renew --dry-run
```

**3. The staging wildcard's Nginx.** Staging sites are **deployed by the
developer directly on Root's VPS**, outside root-app's own release process —
this is Root building and hosting a customer's site, not a feature of the
portal. Each one gets its **own Nginx server block** under the wildcard,
named by its slug (`<project-slug>.staging.m-root.com`), sitting beside
`/etc/nginx/sites-available/root` rather than inside it. Whatever that site
is (WordPress, a static export, anything else Root can host there), its
server block must:

- send `Content-Security-Policy: frame-ancestors <APP_ORIGIN>` — naming only
  the portal's own origin, so a page framing the staging site from anywhere
  else fails to load rather than loading and silently listening to the
  reporter snippet's `postMessage` broadcasts; and
- **must not** send `X-Frame-Options: DENY` — that header cannot name an
  origin the way `frame-ancestors` can, and if both are present a browser
  that honours `X-Frame-Options` at all would refuse the one frame this whole
  arrangement exists to allow: the portal's own L2 demo viewport.

These are the third guard the reporter snippet's own README documents
(`snippets/demo-reporter/README.md`, "The third guard: `frame-ancestors`") —
read that file for why the header exists and what it is defending against;
this section only says where it has to be set for each new site, not why.

**The API needs `STAGING_BASE_DOMAIN=staging.m-root.com`** in `.env` (J10) —
the default in production, so it can be left unset; it must match the wildcard
above. `createDemo` and `updateDemo` refuse (`STAGING_HOST_NOT_ALLOWED`) any
staging URL whose host is not **exactly one label** under it, and in production
any that is not `https` with no explicit port — so a demo can only ever frame a
site Root deployed itself. **Two more things a new staging site needs before its
demo can be published** (J10): the reporter snippet installed in its theme with
`data-enabled="true"` and `data-root-origin` set to the portal's origin, and a
staff member (the phase's developer, or sales) to open the demo once in the
desk's viewport — the snippet's first report from the site's own origin is what
records the staging site as *ready* (`DEMO_NOT_READY` until then). Demo
credentials written into the review frame's *how to test* line are staging-only;
production credentials are never entered in the portal.

**4. The mockup wildcard's Nginx** (J9, PD-9). Uploaded mockups are served by
the API, out of the stored zip, one subdomain per view grant
(`<32-hex-id>.mockup.m-root.com`). The server block is
[`nginx/mockup.conf`](nginx/mockup.conf):

```bash
sudo cp deploy/nginx/mockup.conf /etc/nginx/sites-available/root-mockup
sudo ln -s /etc/nginx/sites-available/root-mockup /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Three things about that file are load-bearing, and `securityHeaders.test.ts`
reads it as text to hold the first two:

- **It has one `location`, `/`, and it proxies only to the API on loopback,
  passing `Host`.** No `/graphql`, `/upload`, `/files/`, `/ask`, no SPA, no
  static root — a mockup is code Root did not write, running on a sibling
  subdomain of the portal's registrable domain, and this origin must offer
  nothing but the mockup router. The API refuses everything but mockups on that
  host too (the fence at the top of `index.ts`); this block is the second fence,
  not the only one. **Never add a portal location to it**, and never point
  `server_name` at anything but the wildcard.
- **It adds no headers and includes no portal snippet.** The API sends the
  mockup origin's `Content-Security-Policy` (which names `APP_ORIGIN` as the
  only frame ancestor), `Referrer-Policy: no-referrer` and `nosniff` itself; a
  second copy here would double the CSP, and the portal's own policy would break
  every mockup it touched.
- **It strips cookies both ways and blanks `X-Forwarded-Host`.** A mockup origin
  never carries the session cookie and never sets one.

**The API needs `MOCKUP_BASE_DOMAIN=mockup.m-root.com`** in `.env` — the default
in production, so it can be left unset; it must match the wildcard above. Every
mockup URL the portal hands out is built from it.

**`/upload`'s body limit is 51m, not 26m, since J9** (`nginx/root.conf`): a
mockup bundle is capped at 50 MB and Nginx must not turn a 30 MB one into a bare
413 the desk cannot translate. The API still enforces the real per-class limit
(`FILE_TOO_LARGE`), and it now *streams* a bundle to `STORAGE_DIR/tmp/` rather
than holding it in memory — so a container restart during an upload can leave a
`*.part` file there. They are safe to delete when no upload is in flight:

```bash
find /srv/root/storage/tmp -name '*.part' -mmin +60 -delete
```

**Check it after every deploy that touches Nginx** — like the portal's headers,
no test in this repository can see them. Any request to the wildcard for a
grant that does not exist is a plain 404 *with the mockup headers*, so:

```bash
curl -sI https://00000000000000000000000000000000.mockup.m-root.com/
# 404, content-security-policy: frame-ancestors https://<APP_ORIGIN>; …,
# referrer-policy: no-referrer, x-content-type-options: nosniff, and NO set-cookie.
curl -sI https://00000000000000000000000000000000.mockup.m-root.com/graphql
# 404 as well: the API's fence, and nothing of the portal is reachable here.
```

**Storage growth.** Every iteration's bundle is kept — it is the record of what
the customer was shown and approved, and `Build.bundleFileId` is `Restrict`, so
the database will not let a bundle be deleted while a build points at it. At up
to 50 MB per iteration and a few iterations per custom-path contract this is
small, but it only grows. Retention for superseded bundles after a contract is
delivered is a later decision; until it is made, `storage/private/` is part of
the backup (below) and part of the disk-space watch.

---

## Backups

Nothing does this yet, and it is the largest remaining gap. The minimum:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U root root_website | gzip > "root-$(date -u +%F).sql.gz"
```

Put it in cron, send it somewhere that is not this VPS, and restore it once to
prove the dump is real. A backup nobody has restored is a hypothesis.

**The database is only half of it now.** `StoredFile` rows point at bytes in
`STORAGE_DIR`, and restoring one without the other gives you a portal full of
broken images with no way to tell which ones are missing:

```bash
tar -C /srv/root -czf "root-files-$(date -u +%F).tar.gz" storage
```

The API logs `[files] row … points at a missing key` when it meets a row whose
bytes are gone — that line means a restore missed this directory.

---

## Known gaps

- **No mail.** Invite links are shown once in the admin UI; password reset links
  are written to the API log. In production that makes `docker compose logs`
  a file containing live reset tokens — treat it accordingly until a provider
  is wired in (`TODO(email)` marks both spots).
- **A password reset does not end existing sessions.** Sessions are stateless
  JWTs good for 14 days, so a reset does not evict someone already in.
- **Nothing sweeps unreferenced files.** An upload that is never attached to a
  concept or page stays on disk and in the table forever. Harmless at this
  scale, and worth a job once the admin workspace makes uploading routine.
