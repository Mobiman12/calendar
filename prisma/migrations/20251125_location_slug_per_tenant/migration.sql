-- Make slug unique per tenant instead of globally
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'Location_slug_key'
  ) THEN
    DROP INDEX "Location_slug_key";
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

-- Add composite unique index
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'Location_tenantId_slug_key'
  ) THEN
    CREATE UNIQUE INDEX "Location_tenantId_slug_key" ON "Location" ("tenantId", "slug");
  END IF;
END $$;
