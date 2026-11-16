-- AlterTable
ALTER TABLE "therapist_profiles" ADD COLUMN     "cv_file_name" TEXT,
ADD COLUMN     "cv_size_bytes" INTEGER,
ADD COLUMN     "cv_storage_key" TEXT,
ADD COLUMN     "cv_summary" TEXT;
