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
curl -sI https://yourdomain.com/public-files/../private/   # want 400 or 404
```

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

**Web** — from your machine, in the repo root:

```bash
./deploy/release-web.sh you@your-vps
```

It refuses to run on a dirty tree, because the release is named after the
commit and that name has to be true. `ALLOW_DIRTY=1` overrides.

**API** — on the server:

```bash
cd /srv/root/app && git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations apply on start. A failed migration means the container refuses to
boot, which is the intent: a server running against a schema it does not expect
is worse than one that is down. Check with `docker compose -f
docker-compose.prod.yml logs -f api`.

The P0-7 deploy (the `__Host-root_session` cookie rename) signs everyone out
once, on that one deploy only — free, since production has no real users yet.

**Rollback (web)** — the previous releases are still on disk:

```bash
ssh you@your-vps 'cd /srv/root && ls releases/'
ssh you@your-vps 'cd /srv/root && ln -sfn releases/<name> .current.tmp && mv -T .current.tmp current'
```

No Nginx reload needed; it resolves the root per request.

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
sudo certbot certonly --dns-<provider> -d '*.staging.m-root.com' -d '*.mockup.m-root.com'
```

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

**4. The mockup wildcard's Nginx** — **not configured yet.** PD-9 has the
mockup wildcard proxying to the API on loopback, the same way `/graphql` and
`/upload` do, so that a single Node route can stream each view straight out
of its stored zip. That server block arrives with stage **J9** and does not
exist on the VPS until then; do not create one ahead of it; there is nothing
here for the mockup wildcard to point at yet.

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
