-- Add durable idempotency for externally delivered notifications.
ALTER TABLE "notification_logs" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "notification_logs_dedupeKey_key" ON "notification_logs"("dedupeKey");
