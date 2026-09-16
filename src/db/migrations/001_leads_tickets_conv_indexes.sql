-- Existing remote DBs do not pick up new indexes from schema.sql until this
-- file (or `pnpm db:apply:remote`) is executed. CREATE INDEX IF NOT EXISTS
-- is safe on a live database: it does not rewrite rows.
CREATE INDEX IF NOT EXISTS idx_leads_conv ON leads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_conv ON tickets(conversation_id);
