-- Bound rolling collection-addition reads by their history window.
CREATE INDEX "InventoryAuditLog_createdAt_changeType_idx" ON "InventoryAuditLog"("createdAt", "changeType");
