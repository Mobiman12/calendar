DROP INDEX IF EXISTS "Location_stundenlisteBranchId_key";
CREATE UNIQUE INDEX "Location_tenantId_stundenlisteBranchId_key" ON "Location"("tenantId", "stundenlisteBranchId");
