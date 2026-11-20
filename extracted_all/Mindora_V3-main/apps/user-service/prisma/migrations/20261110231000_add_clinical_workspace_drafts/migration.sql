CREATE TYPE "PrescriptionDraftStatus" AS ENUM ('DRAFT', 'ARCHIVED');
CREATE TYPE "MedicationUpdateStatus" AS ENUM ('PENDING', 'REVIEWED', 'FOLLOW_UP_REQUIRED');

CREATE TABLE "therapist_prescription_drafts" (
    "id" UUID NOT NULL,
    "therapist_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "status" "PrescriptionDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "therapist_prescription_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "therapist_prescription_drafts_therapist_id_status_updated_at_idx"
    ON "therapist_prescription_drafts"("therapist_id", "status", "updated_at");
CREATE INDEX "therapist_prescription_drafts_patient_id_status_idx"
    ON "therapist_prescription_drafts"("patient_id", "status");

CREATE TABLE "medication_update_requests" (
    "id" UUID NOT NULL,
    "therapist_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "status" "MedicationUpdateStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "medication_update_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "medication_update_requests_therapist_id_status_created_at_idx"
    ON "medication_update_requests"("therapist_id", "status", "created_at");
CREATE INDEX "medication_update_requests_patient_id_created_at_idx"
    ON "medication_update_requests"("patient_id", "created_at");

CREATE TABLE "clinical_workspace_audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "record_type" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "clinical_workspace_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "clinical_workspace_audit_logs_actor_id_created_at_idx"
    ON "clinical_workspace_audit_logs"("actor_id", "created_at");
CREATE INDEX "clinical_workspace_audit_logs_record_type_record_id_idx"
    ON "clinical_workspace_audit_logs"("record_type", "record_id");
