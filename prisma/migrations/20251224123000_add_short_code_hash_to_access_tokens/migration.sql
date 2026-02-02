ALTER TABLE "AppointmentAccessToken" ADD COLUMN "shortCodeHash" TEXT;

CREATE UNIQUE INDEX "AppointmentAccessToken_shortCodeHash_key" ON "AppointmentAccessToken"("shortCodeHash");
