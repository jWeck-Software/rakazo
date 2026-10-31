-- Additive: the previous release never reads this table.
CREATE TABLE "cursor_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cursor_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cursor_sessions_userId_key" ON "cursor_sessions"("userId");

ALTER TABLE "cursor_sessions" ADD CONSTRAINT "cursor_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as payment_wallets.
ALTER TABLE "cursor_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY cursor_sessions_tenant ON "cursor_sessions"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY cursor_sessions_system ON "cursor_sessions"
  USING (current_setting('app.rls_bypass', true) = 'on');
