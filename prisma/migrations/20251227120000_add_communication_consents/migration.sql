-- Add enum values for communication consent tracking.
ALTER TYPE "ConsentType" ADD VALUE IF NOT EXISTS 'COMMUNICATION';
ALTER TYPE "ConsentScope" ADD VALUE IF NOT EXISTS 'WHATSAPP';
