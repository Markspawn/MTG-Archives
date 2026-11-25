CREATE TABLE "CardHuntAction" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "ownerPlayerId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CardHuntAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CardHuntAction_action_check" CHECK ("action" IN ('COMMIT', 'GIVE')),
  CONSTRAINT "CardHuntAction_status_check" CHECK ("resultJson"->>'status' IS NOT NULL AND "resultJson"->>'status' IN ('APPLIED', 'REJECTED')),
  CONSTRAINT "CardHuntAction_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CardHuntAction_actorUserId_requestId_key" ON "CardHuntAction"("actorUserId", "requestId");
CREATE INDEX "CardHuntAction_actorUserId_createdAt_idx" ON "CardHuntAction"("actorUserId", "createdAt");
