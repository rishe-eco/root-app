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
docker compose -f docker-compose.prod.yml exec -T api \
  npx tsx prisma/create-admin.ts you@example.com "Your Name"
# type the password, then ctrl-D
```

It refuses a password under 10 characters and refuses an email that already
exists. Then sign in at `/fa/portal` — one sign-in for everyone; there is no
separate admin login — and the desk opens at `/fa/desk`, where invites are
issued from **Customers**.

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

**Rollback (web)** — the previous releases are still on disk:

```bash
ssh you@your-vps 'cd /srv/root && ls releases/'
ssh you@your-vps 'cd /srv/root && ln -sfn releases/<name> .current.tmp && mv -T .current.tmp current'
```

No Nginx reload needed; it resolves the root per request.

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
