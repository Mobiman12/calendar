DROP INDEX IF EXISTS "Staff_code_key";
CREATE UNIQUE INDEX "Staff_locationId_code_key" ON "Staff"("locationId", "code");
