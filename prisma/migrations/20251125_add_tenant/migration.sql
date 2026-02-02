-- Add Tenant table
CREATE TABLE IF NOT EXISTS "Tenant" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT 'Legacy Tenant',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Ensure legacy tenant exists
INSERT INTO "Tenant" ("id", "name") VALUES ('legacy', 'Legacy Tenant')
ON CONFLICT ("id") DO NOTHING;

-- Add tenantId to Location (default legacy)
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'legacy';

-- Backfill nulls just in case
UPDATE "Location" SET "tenantId" = 'legacy' WHERE "tenantId" IS NULL;

-- Add FK
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'Location_tenantId_fkey'
    ) THEN
        ALTER TABLE "Location"
        ADD CONSTRAINT "Location_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Index on tenantId
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'Location_tenantId_idx'
    ) THEN
        CREATE INDEX "Location_tenantId_idx" ON "Location"("tenantId");
    END IF;
END $$;
