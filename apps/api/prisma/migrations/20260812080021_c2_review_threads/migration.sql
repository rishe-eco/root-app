-- C2: the Review Room's comments. A thread anchors to a character range in
-- one block's *rendered* plain text (C2.md §1) — the quote column is that
-- anchor's own witness, checked against the render on every read, never
-- re-found on a mismatch.

-- CreateTable
CREATE TABLE "ReviewThread" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "quote" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewComment" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewThread_documentId_authorId_idx" ON "ReviewThread"("documentId", "authorId");

-- CreateIndex
CREATE INDEX "ReviewComment_threadId_createdAt_idx" ON "ReviewComment"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReviewThread" ADD CONSTRAINT "ReviewThread_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReviewDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewThread" ADD CONSTRAINT "ReviewThread_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewThread" ADD CONSTRAINT "ReviewThread_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ReviewThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewComment" ADD CONSTRAINT "ReviewComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express a CHECK): a zero-width or inverted
-- range is not a passage, and without this it would otherwise be produced by
-- an off-by-one in the selection code and rendered as an invisible
-- highlight nobody can find (C2.md §2).
ALTER TABLE "ReviewThread" ADD CONSTRAINT "ReviewThread_offsets_valid" CHECK ("startOffset" >= 0 AND "endOffset" > "startOffset");
