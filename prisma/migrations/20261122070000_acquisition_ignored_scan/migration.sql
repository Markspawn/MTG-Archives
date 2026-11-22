-- A retained physical scan can leave active review without changing its count.
ALTER TABLE "AcquisitionCandidate" ADD COLUMN "ignored" BOOLEAN NOT NULL DEFAULT false;
