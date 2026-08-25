-- Personal access tokens for calling the API without a browser.
--
-- The secret itself is never stored: `tokenHash` is the SHA-256 of a 32-byte
-- random token, and the plaintext exists exactly once, in the response to the
-- mutation that created it. `prefix` is the only part kept readable, so the
-- UI can name a token it can no longer show.

-- CreateEnum
CREATE TYPE "ApiTokenScope" AS ENUM ('READ', 'WRITE');

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scope" "ApiTokenScope" NOT NULL DEFAULT 'READ',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Unique because it is the authentication lookup: one indexed probe by digest,
-- which is the whole reason the digest is unsalted (see schema.prisma).
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
-- The list screen reads one owner's tokens, newest first.
CREATE INDEX "ApiToken_userId_createdAt_idx" ON "ApiToken"("userId", "createdAt");

-- A name that is blank, or whitespace pretending not to be, makes the list
-- unreadable and cannot be told apart from a mistake. Prisma cannot express
-- this, so it is written here — the same reason User.roles carries a CHECK.
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_name_not_blank" CHECK (btrim("name") <> '');

-- AddForeignKey
-- Cascade: a deleted account's credentials must not outlive it.
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
