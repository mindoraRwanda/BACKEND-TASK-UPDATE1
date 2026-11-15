-- CreateTable
CREATE TABLE "crisis_deliveries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crisis_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crisis_deliveries_status_idx" ON "crisis_deliveries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "crisis_deliveries_eventId_channel_key" ON "crisis_deliveries"("eventId", "channel");
