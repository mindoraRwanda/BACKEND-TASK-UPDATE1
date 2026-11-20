CREATE TYPE "TherapistCarePlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TABLE "therapist_care_plans" (
    "id" UUID NOT NULL,
    "therapist_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "status" "TherapistCarePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "patient_acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "therapist_care_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "therapist_care_plans_therapist_id_status_updated_at_idx"
    ON "therapist_care_plans"("therapist_id", "status", "updated_at");

CREATE INDEX "therapist_care_plans_patient_id_status_idx"
    ON "therapist_care_plans"("patient_id", "status");
