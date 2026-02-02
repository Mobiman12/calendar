CREATE TABLE IF NOT EXISTS "AppointmentAccessToken" (
    "id" TEXT PRIMARY KEY,
    "appointmentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppointmentAccessToken_tokenHash_key" ON "AppointmentAccessToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "AppointmentAccessToken_appointmentId_idx" ON "AppointmentAccessToken"("appointmentId");
CREATE INDEX IF NOT EXISTS "AppointmentAccessToken_expiresAt_idx" ON "AppointmentAccessToken"("expiresAt");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'AppointmentAccessToken_appointmentId_fkey'
    ) THEN
        ALTER TABLE "AppointmentAccessToken"
        ADD CONSTRAINT "AppointmentAccessToken_appointmentId_fkey"
        FOREIGN KEY ("appointmentId")
        REFERENCES "Appointment"("id")
        ON DELETE CASCADE
        ON UPDATE CASCADE;
    END IF;
END $$;
