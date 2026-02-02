-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "stundenlisteBranchId" INTEGER;

-- CreateTable
CREATE TABLE "StaffLocationMembership" (
    "staffId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "role" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffLocationMembership_pkey" PRIMARY KEY ("staffId", "locationId"),
    CONSTRAINT "StaffLocationMembership_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StaffLocationMembership_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CustomerLocationMembership" (
    "customerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerLocationMembership_pkey" PRIMARY KEY ("customerId", "locationId"),
    CONSTRAINT "CustomerLocationMembership_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CustomerLocationMembership_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Location_stundenlisteBranchId_key" ON "Location"("stundenlisteBranchId");

-- CreateIndex
CREATE INDEX "StaffLocationMembership_locationId_idx" ON "StaffLocationMembership"("locationId");

-- CreateIndex
CREATE INDEX "CustomerLocationMembership_locationId_idx" ON "CustomerLocationMembership"("locationId");

-- Seed existing records into memberships
INSERT INTO "StaffLocationMembership" ("staffId", "locationId", "createdAt", "updatedAt")
SELECT "id", "locationId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Staff";

INSERT INTO "CustomerLocationMembership" ("customerId", "locationId", "createdAt", "updatedAt")
SELECT "id", "locationId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Customer";
