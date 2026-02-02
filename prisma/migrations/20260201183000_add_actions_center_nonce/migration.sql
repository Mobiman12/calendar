-- CreateTable
CREATE TABLE "ActionCenterNonce" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionCenterNonce_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActionCenterNonce_nonce_key" ON "ActionCenterNonce"("nonce");

-- CreateIndex
CREATE INDEX "ActionCenterNonce_expiresAt_idx" ON "ActionCenterNonce"("expiresAt");
