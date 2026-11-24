-- Add AUDIO without removing legacy session types or changing existing appointments.
ALTER TYPE "SessionType" ADD VALUE IF NOT EXISTS 'AUDIO';
