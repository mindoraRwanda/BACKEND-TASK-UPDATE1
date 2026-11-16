-- CreateTable
CREATE TABLE "screening_results" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "scoring_version" TEXT NOT NULL,
    "answers_encrypted" TEXT NOT NULL,
    "raw_score" INTEGER NOT NULL,
    "display_score" TEXT NOT NULL,
    "max_score" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "interpretation" TEXT NOT NULL,
    "extras" JSONB,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screening_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "screening_results_user_id_completed_at_idx" ON "screening_results"("user_id", "completed_at");
