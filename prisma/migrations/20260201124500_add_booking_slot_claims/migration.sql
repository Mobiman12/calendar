-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN "idempotencyKey" TEXT;

-- CreateTable
CREATE TABLE "BookingSlotClaim" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingSlotClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_locationId_idempotencyKey_key" ON "Appointment"("locationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BookingSlotClaim_locationId_slotKey_key" ON "BookingSlotClaim"("locationId", "slotKey");

-- CreateIndex
CREATE INDEX "BookingSlotClaim_expiresAt_idx" ON "BookingSlotClaim"("expiresAt");

-- CreateIndex
CREATE INDEX "BookingSlotClaim_locationId_idx" ON "BookingSlotClaim"("locationId");
