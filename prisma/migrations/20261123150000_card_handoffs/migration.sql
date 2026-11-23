CREATE TABLE "CardHandoff" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "fromPlayerId" TEXT NOT NULL,
    "toPlayerId" TEXT,
    "senderName" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "cardName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sourceInventoryItemId" TEXT NOT NULL,
    "receivedInventoryItemId" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CardHandoff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CardHandoff_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "CardHandoff_kind_check" CHECK ("kind" IN ('GIFT','TRADE')),
    CONSTRAINT "CardHandoff_parties_check" CHECK ("toPlayerId" IS NULL OR "fromPlayerId" <> "toPlayerId"),
    CONSTRAINT "CardHandoff_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CardHandoff_fromPlayerId_fkey" FOREIGN KEY ("fromPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CardHandoff_toPlayerId_fkey" FOREIGN KEY ("toPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CardHandoff_actorUserId_requestId_key" ON "CardHandoff"("actorUserId", "requestId");
CREATE INDEX "CardHandoff_fromPlayerId_createdAt_id_idx" ON "CardHandoff"("fromPlayerId", "createdAt", "id");
CREATE INDEX "CardHandoff_toPlayerId_createdAt_id_idx" ON "CardHandoff"("toPlayerId", "createdAt", "id");
CREATE INDEX "CardHandoff_fromPlayerId_cardId_createdAt_idx" ON "CardHandoff"("fromPlayerId", "cardId", "createdAt");
