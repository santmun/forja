-- Conversations: one row per (channel, channel_user_id) customer
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  display_name TEXT,
  started_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  paused_until INTEGER,
  open_ticket_id TEXT,
  metadata TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_unique ON conversations(channel, channel_user_id);
CREATE INDEX IF NOT EXISTS idx_conv_last_msg ON conversations(last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  model_used TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  audio_seconds REAL,
  image_count INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  name TEXT,
  contact TEXT,
  channel_user_id TEXT,
  intent TEXT NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'new',
  exported_to TEXT,
  external_id TEXT,
  -- JSON con campos propios del nicho (reservacion con fecha/hora/personas, o
  -- comprador con presupuesto/zona/operacion). El dashboard del nicho lee de aqui.
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  category TEXT,
  summary TEXT NOT NULL,
  transcript TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  resolved_at INTEGER,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

CREATE TABLE IF NOT EXISTS admin_emails (
  email TEXT PRIMARY KEY,
  role TEXT DEFAULT 'owner',
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_expires ON magic_links(expires_at);

-- Settings: key/value overlay edited from the dashboard. Empty/absent => default.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AI-generated quality analysis: one row per conversation, written by the
-- insights analyzer (Haiku) once the conversation goes idle. Re-analyzed if
-- the customer comes back (analyzed_at < last_message_at).
-- sentiment: positive | neutral | frustrated | angry
-- resolution: resolved | unresolved | escalated | abandoned
-- bot_score: 1-5 quality of the bot's replies · topics: JSON array (es)
-- summary: 1-2 sentences (es) · missed_kb: question the KB couldn't answer
-- sale_opportunity: 1 = open sale left on the table
CREATE TABLE IF NOT EXISTS conversation_insights (
  conversation_id TEXT PRIMARY KEY,
  analyzed_at INTEGER NOT NULL,
  sentiment TEXT,
  resolution TEXT,
  bot_score INTEGER,
  topics TEXT,
  summary TEXT,
  missed_kb TEXT,
  sale_opportunity INTEGER DEFAULT 0,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_insights_analyzed ON conversation_insights(analyzed_at);

-- Knowledge-base documents editable from the dashboard. Indexed into Vectorize
-- on save (chunked). The repo kb-fixtures.json remains a separate source.
-- NOTE: never put semicolons inside schema comments (the test helper splits on them).
CREATE TABLE IF NOT EXISTS kb_docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Flywheel (F5) - every proposed self-improvement is a reviewable row.
-- kind: kb_entry | leccion. fingerprint dedupes across any status so a
-- dismissed suggestion is never re-proposed.
CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  evidence TEXT,
  status TEXT DEFAULT 'proposed',
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sugg_status ON improvement_suggestions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sugg_fp ON improvement_suggestions(kind, fingerprint);

-- Follow-up bot - one row per conversation that ever received a follow-up.
-- The PRIMARY KEY doubles as the send claim (INSERT OR IGNORE) so a
-- conversation can never get more than one follow-up, ever.
CREATE TABLE IF NOT EXISTS followup_sends (
  conversation_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);

-- Per-customer memory extracted by the insights analyzer. Injected into the
-- system context when the same customer writes again.
CREATE TABLE IF NOT EXISTS customer_facts (
  conversation_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  learned_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, fact)
);

-- Links de trackeo por conversación (código destino, con contador de clicks).
-- Un código por conversación y destino, alimenta la segmentación de campañas.
CREATE TABLE IF NOT EXISTS tracked_links (
  code TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  target TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  last_click_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tracked_links_conv ON tracked_links(conversation_id);

-- Hits de keywords (QUIERO / RECURSOS) — alimenta la segmentación de campañas
CREATE TABLE IF NOT EXISTS keyword_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyword_hits_kw ON keyword_hits(keyword);

-- Etiquetas por conversación (interés + objeción) para la segmentación de campañas.
-- La tabla se conserva para el módulo de campañas/segmentos.
CREATE TABLE IF NOT EXISTS conv_labels (
  conversation_id TEXT PRIMARY KEY,
  variant TEXT,
  interest TEXT,
  objection TEXT,
  summary TEXT,
  labeled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_labels_interest ON conv_labels(interest);

-- Envíos de campañas (free-form dentro de ventana / plantilla HSM fuera)
-- El UNIQUE es el candado anti-doble-envío por campaña
CREATE TABLE IF NOT EXISTS template_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  template_sid TEXT,
  sent_at INTEGER NOT NULL,
  UNIQUE (campaign_key, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_template_sends_time ON template_sends(sent_at);

-- Throttle por IP (defensa en profundidad) para rutas expuestas sin sesión:
-- webhooks y /kb/reindex. Un contador por ventana fija (bucket:ip), reseteado
-- cuando cambia window_start. Ver src/rate-limit.ts. La capa principal es una
-- Cloudflare Rate Limiting Rule (fuera de este repo, dashboard de Cloudflare)
-- -- esto cubre el caso sin esa regla configurada.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
