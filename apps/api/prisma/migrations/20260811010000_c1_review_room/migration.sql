-- CreateTable
CREATE TABLE "ReviewRound" (
    "id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "label" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT NOT NULL,

    CONSTRAINT "ReviewRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewDocument" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "ReviewDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewRound_publishedAt_idx" ON "ReviewRound"("publishedAt");

-- CreateIndex
CREATE INDEX "ReviewDocument_roundId_order_idx" ON "ReviewDocument"("roundId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewDocument_roundId_path_key" ON "ReviewDocument"("roundId", "path");

-- AddForeignKey
ALTER TABLE "ReviewRound" ADD CONSTRAINT "ReviewRound_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDocument" ADD CONSTRAINT "ReviewDocument_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "ReviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

