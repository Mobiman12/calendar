-- CreateTable
CREATE TABLE "CustomerDeviceVerification" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerDeviceVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerStaffBookingPermission" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "isAllowed" BOOLEAN NOT NULL DEFAULT true,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "CustomerStaffBookingPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPermissionToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "CustomerPermissionToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerDeviceVerification_deviceId_idx" ON "CustomerDeviceVerification"("deviceId");

-- CreateIndex
CREATE INDEX "CustomerDeviceVerification_customerId_idx" ON "CustomerDeviceVerification"("customerId");

-- CreateIndex
CREATE INDEX "CustomerDeviceVerification_locationId_idx" ON "CustomerDeviceVerification"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerDeviceVerification_customerId_locationId_deviceId_key" ON "CustomerDeviceVerification"("customerId", "locationId", "deviceId");

-- CreateIndex
CREATE INDEX "CustomerStaffBookingPermission_customerId_idx" ON "CustomerStaffBookingPermission"("customerId");

-- CreateIndex
CREATE INDEX "CustomerStaffBookingPermission_locationId_idx" ON "CustomerStaffBookingPermission"("locationId");

-- CreateIndex
CREATE INDEX "CustomerStaffBookingPermission_staffId_idx" ON "CustomerStaffBookingPermission"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerStaffBookingPermission_customerId_locationId_staffI_key" ON "CustomerStaffBookingPermission"("customerId", "locationId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPermissionToken_tokenHash_key" ON "CustomerPermissionToken"("tokenHash");

-- CreateIndex
CREATE INDEX "CustomerPermissionToken_customerId_idx" ON "CustomerPermissionToken"("customerId");

-- CreateIndex
CREATE INDEX "CustomerPermissionToken_locationId_idx" ON "CustomerPermissionToken"("locationId");

-- AddForeignKey
ALTER TABLE "CustomerDeviceVerification" ADD CONSTRAINT "CustomerDeviceVerification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerDeviceVerification" ADD CONSTRAINT "CustomerDeviceVerification_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerStaffBookingPermission" ADD CONSTRAINT "CustomerStaffBookingPermission_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerStaffBookingPermission" ADD CONSTRAINT "CustomerStaffBookingPermission_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerStaffBookingPermission" ADD CONSTRAINT "CustomerStaffBookingPermission_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerStaffBookingPermission" ADD CONSTRAINT "CustomerStaffBookingPermission_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerStaffBookingPermission" ADD CONSTRAINT "CustomerStaffBookingPermission_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPermissionToken" ADD CONSTRAINT "CustomerPermissionToken_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPermissionToken" ADD CONSTRAINT "CustomerPermissionToken_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPermissionToken" ADD CONSTRAINT "CustomerPermissionToken_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
