CREATE TABLE "ScanConnectorGrant" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "scopes" TEXT[] NOT NULL, "securityKey" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
 CONSTRAINT "ScanConnectorGrant_scopes_check" CHECK ("scopes" <@ ARRAY['scans:read','scans:confirm','scans:all-users']::text[] AND 'scans:read'=ANY("scopes"))
);
CREATE INDEX "ScanConnectorGrant_userId_createdAt_idx" ON "ScanConnectorGrant"("userId","createdAt");
CREATE TABLE "ScanConnectorCode" (
 "hash" TEXT PRIMARY KEY, "grantId" TEXT NOT NULL REFERENCES "ScanConnectorGrant"("id") ON DELETE CASCADE,
 "redirectUri" TEXT NOT NULL, "challenge" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3)
);
CREATE INDEX "ScanConnectorCode_grantId_idx" ON "ScanConnectorCode"("grantId");
CREATE TABLE "ScanConnectorToken" (
 "hash" TEXT PRIMARY KEY, "refreshHash" TEXT NOT NULL UNIQUE, "scopes" TEXT[] NOT NULL,
 "grantId" TEXT NOT NULL REFERENCES "ScanConnectorGrant"("id") ON DELETE CASCADE,
 "expiresAt" TIMESTAMP(3) NOT NULL, "rotatedAt" TIMESTAMP(3)
);
CREATE INDEX "ScanConnectorToken_grantId_idx" ON "ScanConnectorToken"("grantId");
