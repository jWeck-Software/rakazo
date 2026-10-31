-- A vault can read logins from one password manager (Vaultwarden). Additive: a new table only.

-- CreateTable
CREATE TABLE "credential_sources" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spaceId" TEXT,
    "provider" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "secretId" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credential_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credential_sources_secretId_key" ON "credential_sources"("secretId");

-- CreateIndex
CREATE INDEX "credential_sources_spaceId_idx" ON "credential_sources"("spaceId");

-- AddForeignKey
ALTER TABLE "credential_sources" ADD CONSTRAINT "credential_sources_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_sources" ADD CONSTRAINT "credential_sources_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_sources" ADD CONSTRAINT "credential_sources_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One source per vault: the account's (no Space) or a Space's own.
CREATE UNIQUE INDEX "credential_sources_userId_spaceId_key"
  ON "credential_sources"("userId", "spaceId")
  NULLS NOT DISTINCT;

ALTER TABLE "credential_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY credential_sources_tenant ON "credential_sources"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
    AND ("spaceId" IS NULL OR "spaceId" = NULLIF(current_setting('app.space_id', true), '')));
CREATE POLICY credential_sources_system ON "credential_sources"
  USING (current_setting('app.rls_bypass', true) = 'on');
