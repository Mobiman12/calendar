-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "categoryId" TEXT;

-- CreateTable
CREATE TABLE "CustomerCategory" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerCategory_locationId_idx" ON "CustomerCategory"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCategory_locationId_slug_key" ON "CustomerCategory"("locationId", "slug");

-- CreateIndex
CREATE INDEX "Customer_categoryId_idx" ON "Customer"("categoryId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CustomerCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCategory" ADD CONSTRAINT "CustomerCategory_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: ServiceCategory gets its locationId foreign key in a later migration (20251103120000_add_service_categories).
-- The FK here referenced a table that is not yet created in this sequence, so it is intentionally omitted to avoid install errors.
