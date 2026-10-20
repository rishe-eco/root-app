# root-app — for Claude

Root Studio's website and application: a public site, a customer portal and a staff desk at `/desk`. Bilingual, **Persian first** (right to left), with English as the translation. Two npm workspaces: `apps/api` (Express, Apollo Server 4, Prisma, Postgres) and `apps/web` (Vite and React). The repo is **public**.

## Read first

1. `docs/development/README.md`: the **fourteen house rules** (binding), the working agreement, and "Things that are true of this codebase and easy to get wrong". This file doesn't repeat them.
2. The stage record for the area you're touching, in `docs/development/<stage>.md`.
3. Specs and plans live in `rishe-eco/root-sot`, under `ecosystem/working/` (`root-website-*.md`, `root-studio-*.md`). On *what*, the spec wins; on *what the code is now*, this repo wins.

Work is planned and reviewed by the lifecycle method in root-sot's `lifecycle/`. This project's paths, suites and lane slots are in `lifecycle/projects/root-app/config.md`.

## Commands

```bash
npm install && npx prisma generate --schema apps/api/prisma/schema.prisma
npm run typecheck            # both workspaces
npm test                     # unit, no database
npm run test:integration     # resolvers against Postgres, ≈8 min in full
npm run e2e                  # the browser, against the built app
npm run dev                  # web;  npm run dev:api for the API
```

Run test files **targeted** while working (`npm run test:integration -- <file>`, `npm run e2e -- <spec> -g <name> --workers=1`). The full integration and e2e suites run at milestones and before a deploy, one heavy suite at a time on a machine.

## Environment

- **Postgres runs in Docker** at `localhost:5432`, shared by every checkout. On Windows, **start Docker Desktop first.** The integration runner refuses any database not named `*_test`, because it truncates every table. Never stop the container, and never `prisma migrate reset` or `migrate dev` against a database that isn't your own.
- **Run `prisma generate` after every `npm install`.** If an install only strips `"dev": true` from `fsevents` in `package-lock.json`, revert it: `git checkout package-lock.json`.
- **Two checkouts at once** each need their own `ROOT_TEST_DB`, `E2E_API_PORT` and `E2E_WEB_PORT`. Export them in every Bash command that runs a suite: shell state doesn't persist between calls.
- **Browser:** Playwright drives an installed browser; its download is geo-blocked. On a machine with Edge and no Chrome, export `E2E_BROWSER_CHANNEL=msedge`.
- **Windows:** npm runs scripts through cmd.exe, so no `VAR=value cmd` prefixes inside `package.json` scripts. Background Bash commands ignore a leading `cd`: wrap them as `bash -c 'cd <dir> && …'`.
- **`apps/*/dist/` is stale build output.** Never read it to understand behaviour.

## Tests

- **No literal future dates in fixtures.** A fixture day meant to be still ahead goes through `onDay` in `apps/api/src/test/calendar.ts`, so it moves with today. Literal dates became a time bomb at M4. There's no fixed test clock yet; the lifecycle's build rules ask for one.
- **Never debug through the full e2e suite.** Reproduce with the smallest failing test, one hypothesis at a time. If the cause is environmental (a rate limit, the clock, a port, the shared database), fix the test setup instead of rerunning.
- Every hand-written CHECK is proven by a direct insert in the integration suite. A new outbound provider key is pinned empty in `test:integration` and e2e.

## Git

- **Never `git add -A` or `git add .`.** Add files by name. Agent worktrees under `.claude/worktrees/` would otherwise be committed as embedded repos.
- Check `git config user.email` before the first commit. No secrets, tokens, `.env` files or personal data: the repo is public.
- Read the SQL every migration generates, and never edit a migration that has been applied anywhere but your own machine.
- `.tmp/` is for lane reports and suite logs, and is never committed.
