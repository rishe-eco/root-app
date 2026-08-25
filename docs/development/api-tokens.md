# API tokens — a second way in

**Built 2026-08-25.** Not a track from the build plan; asked for directly.
Modelled on the personal-access-token feature in the sibling `tracker`
project (`api/src/services/apiTokens.ts`), which is where the shape — a random
opaque secret, an SHA-256 digest in the table, read/write scope enforced in an
Apollo plugin — comes from.

> **On the name.** This was asked for as "the SSH key feature in tracker".
> Tracker has no SSH key feature and never did; what it has is bearer tokens,
> and that is what was built here. Recorded because the next person to read
> the request will otherwise go looking for public-key code that does not
> exist. If real SSH-key request signing is ever wanted, it is a different
> feature and a much larger one — see §5.

---

## 1 · Why this exists

Until now the API had exactly one credential: the session cookie, minted by
`signIn` and read by `buildContext`. That is the right thing for a browser and
the wrong thing for everything else, because obtaining it means holding a
password and completing a login. A script, a cron job, or an operator with
curl had no way in that did not involve impersonating a person.

## 2 · The shape

| | |
|---|---|
| Secret | `root_` + 32 random bytes, base64url. Returned once, by `createApiToken`, and never again. |
| Stored | SHA-256 of the whole token, unsalted, unique-indexed. The `prefix` (13 chars) is the only plaintext kept. |
| Transport | `Authorization: Bearer root_…`, on `/graphql` and `/upload` alike. |
| Who may hold one | `apiTokens.manage` — ADMIN only today. |
| Scope | `READ` (queries) or `WRITE` (queries and mutations). |
| Revocation | A `revokedAt` tombstone. The row is kept; it is the record that the credential existed. |

**Why unsalted.** A password hash is slow because a password is low-entropy
and guessable. These are 32 bytes of CSPRNG output — nothing to grind — so a
KDF would buy no security while costing a comparison against every row instead
of one indexed lookup. The same reasoning `auth/tokens.ts` already applies to
invite links.

**Why a table and not a JWT.** A credential that lives for months has to be
revocable, and revoking a JWT means keeping a list of the revoked ones — which
is the table you were avoiding, only now it is the unhappy path.

## 3 · The three rules that carry it

1. **The secret is never stored.** A database leak yields digests, not
   credentials. `apiTokens.test.ts` asserts the serialized row does not
   contain the secret.

2. **Authority is re-read on every request, never remembered.**
   `authenticateApiToken` re-checks `state` and `apiTokens.manage` from the
   owner's live row. Disabling or demoting an account therefore kills its
   tokens in the same instant, with nobody having to remember they existed.
   This is the same principle that made `SessionClaims` drop its `role` claim:
   permissions are read from the user, never carried in the credential. It is
   also why scope is the *only* thing the token itself decides.

3. **A token cannot manage tokens.** `requireSessionCapability` gates all
   three operations on a cookie session as well as the capability. Without it,
   one leaked token stops being an incident with an end and becomes standing
   access — it can issue successors faster than anyone revokes them.

Two smaller ones worth not re-litigating:

- **A presented bearer is never downgraded to the cookie beside it.**
  `buildContext` reads the header first, and a bad token means anonymous
  rather than falling back to a session that happens to be in the same jar.
  Otherwise a scripted client with a stale cookie would silently get session
  privileges from a credential it meant to restrict.
- **Ownership is scoped to self.** There is no `allApiTokens` and no
  `revokeApiToken(userId:)`. An admin who needs someone else's access gone
  disables the account or removes the role, and rule 2 makes both instant.

## 4 · Where the code is

| File | |
|---|---|
| `apps/api/src/lib/apiTokens.ts` | generation, digest, constant-time compare, `authenticateApiToken` |
| `apps/api/src/lib/tokenScope.ts` | the Apollo plugin that enforces scope on the parsed operation |
| `apps/api/src/context.ts` | the bearer path, `Auth`, `requireSessionCapability` |
| `apps/api/src/graphql/resolvers/apiTokens.ts` | create / list / revoke |
| `apps/api/src/routes/files.ts` | the one scope check the plugin cannot make |
| `apps/web/src/desk/ApiTokens.tsx` | the desk screen |

**Scope is enforced in a plugin, not in resolvers**, and that is the decision
most worth keeping. An operation's type is known only after parsing, which is
where `didResolveOperation` runs — and it runs before any resolver, so a
refused write never touches the database. Spread across resolvers, the rule
would be restated fifty times and the failure mode would be silent: the
fifty-first mutation, written next month by someone who did not know the rule
existed, would quietly be writable from a read-only token.

**`/upload` is the exception, and it is deliberate.** That route does not go
through Apollo, so the plugin never sees it. Without the explicit check in
`files.ts`, a read-only token would be refused every mutation and still be
able to put a file in storage. `/files` (download) and `/ask` need nothing:
one is a read, and the other never authenticated at all — it is public and
IP-rate-limited (R4.md §4), so a token neither opens it nor should bypass its
bucket.

## 5 · What was not built

- **SSH-key request signing.** See the note at the top. It would need a
  signing client, canonicalization rules for what gets signed, and a
  replay/nonce store — a different feature, not a variation on this one.
- **Per-token capabilities.** Scope is two values on purpose. A token carrying
  its own capability list would be a snapshot of someone's permissions taken
  at creation, outliving every change to them — precisely what rule 2 exists
  to prevent.
- **Rate limiting per token.** `/graphql` has none today for anyone, cookie or
  token, so adding it here would be the first instance of a rule the rest of
  the API does not follow. Revisit when the API is exposed to something that
  is not Root's own scripts.
- **`lastUsedAt` is best-effort.** A failed bookkeeping write does not deny an
  otherwise valid request. It is there so an unused token is visibly safe to
  revoke, not as an audit log.

## 6 · Using one

```bash
# In the desk: Tokens → New token. The secret is shown once.
curl -X POST http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ROOT_API_TOKEN" \
  -d '{"query":"query { me { email capabilities } }"}'
```

A read-only token given a mutation gets `TOKEN_READ_ONLY`. A token given
`myApiTokens` gets `SESSION_REQUIRED`. A token whose owner was disabled,
demoted, expired or revoked gets exactly what an unknown token gets — the
caller is anonymous, and the four cases are one answer on purpose.
