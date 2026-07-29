import type { D1Database, DurableObjectNamespace, R2Bucket, VectorizeIndex, Ai } from "@cloudflare/workers-types";
import type { SupportAgent } from "./agent";

export interface Env {
  // Bindings
  // Typed namespace so we can call the agent's methods via RPC (stub.ingest()).
  AGENT: DurableObjectNamespace<SupportAgent>;
  DB: D1Database;
  KB: VectorizeIndex;
  CATALOG: R2Bucket;
  AI: Ai;

  // Vars (member-set)
  BOT_NAME: string;
  PEER_BOTS?: string; // JSON [{name,url}] — otras instancias para el selector de proyectos
  WA_DAILY_TEMPLATE_CAP?: string; // tope diario de plantillas HSM (default 250 — tier 1 de Meta)
  BUSINESS_NAME: string;
  BOT_LANGUAGE: string;
  BOT_TIER: "free" | "pro";
  // Nicho del bot (restaurante, inmobiliaria…). Selecciona el "niche pack" que
  // re-etiqueta el dashboard, aporta el playbook del giro y sus columnas.
  // Ausente/desconocido → pack genérico (comportamiento actual). Ver src/niches/.
  BOT_NICHE?: string;
  // LLM provider for the chat brain: "anthropic" (default) | "openai".
  // If unset and only OPENAI_API_KEY is present, auto-selects "openai".
  // (Voice transcription + embeddings always run on Cloudflare Workers AI.)
  LLM_PROVIDER?: "anthropic" | "openai";
  // Optional per-tier model id overrides (fast = cheap default, smart = upgrade).
  ANTHROPIC_MODEL_FAST?: string;
  ANTHROPIC_MODEL_SMART?: string;
  OPENAI_MODEL_FAST?: string;
  OPENAI_MODEL_SMART?: string;
  BUFFER_SECONDS: string;
  DASHBOARD_BASE_URL: string;

  // Secrets (member-set via wrangler secret put)
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;  // alternative LLM provider (see LLM_PROVIDER)
  RESEND_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  // secret_token puesto al registrar el webhook (setWebhook); valida el
  // header X-Telegram-Bot-Api-Secret-Token en cada POST entrante (fail-closed
  // si falta — ver src/channels/telegram.ts verifyTelegramSecret).
  TELEGRAM_WEBHOOK_SECRET?: string;
  MANYCHAT_API_KEY?: string;
  // shared secret que el miembro configura como header custom
  // (X-Manychat-Secret) en el External Request de su flow de ManyChat; valida
  // el origen del webhook (fail-closed si falta — ver
  // src/channels/manychat.ts verifyManychatSecret). ManyChat no firma sus
  // webhooks nativamente, así que esto es lo único que evita que cualquiera
  // mande un POST falso a /webhooks/manychat.
  MANYCHAT_WEBHOOK_SECRET?: string;
  MANYCHAT_CONTENT_TYPE?: "instagram" | "whatsapp" | "telegram" | "messenger"; // ManyChat channel for sendContent; defaults to "instagram"
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WA_FROM?: string;
  TWILIO_HANDOFF_CONTENT_SID?: string;  // approved WhatsApp template for owner handoff DM
  // Meta oficial (Facebook Messenger + Instagram DMs, sin ManyChat).
  META_PAGE_ACCESS_TOKEN?: string;  // Messenger / IG ligado a Página (graph.facebook.com)
  INSTAGRAM_ACCESS_TOKEN?: string;  // Instagram API con Instagram Login, token IGAA… (graph.instagram.com)
  META_VERIFY_TOKEN?: string;       // string que tú eliges; valida el handshake GET del webhook
  META_APP_SECRET?: string;
  // "manychat" = los DMs de Instagram entran SOLO por ManyChat (el webhook
  // oficial de Meta los ignora para no procesarlos doble).
  IG_DM_SOURCE?: string;
  // "off" = canal oficial de IG apagado por completo (DMs). El bot de IG vive
  // solo en ManyChat.
  IG_OFFICIAL?: string;         // App Secret de Facebook; firma los webhooks de Messenger
  INSTAGRAM_APP_SECRET?: string;    // App Secret del producto Instagram (IG Login); firma los webhooks de IG
  // WhatsApp OFICIAL (Cloud API de Meta, sin BSP/Twilio). Mismo ecosistema Graph
  // que Meta; el número corre en la cuenta del miembro con SU token. El envío es
  // a graph.facebook.com/<phone_number_id>/messages; el media entrante se sirve
  // por el proxy firmado /webhooks/whatsapp/media/:id (Cloud API exige el token
  // para descargarlo, así queda del lado del server).
  WHATSAPP_PHONE_NUMBER_ID?: string;  // el Phone Number ID del número (no el número)
  WHATSAPP_ACCESS_TOKEN?: string;     // token del system user / WABA (Bearer)
  WHATSAPP_VERIFY_TOKEN?: string;     // handshake GET del webhook (si falta, usa META_VERIFY_TOKEN)
  WHATSAPP_APP_SECRET?: string;       // firma X-Hub-Signature-256 (si falta, usa META_APP_SECRET)
  XAI_API_KEY?: string;             // xAI (Grok) — proveedor LLM alterno (ver src/llm/provider.ts)

  // ── Cal.com (agenda real para scheduleAppointment) ───────────────────────
  // Con estas vars, el bot consulta disponibilidad real y reserva en Cal.com.
  // Sin ellas, scheduleAppointment solo registra la cita para que el dueño la confirme.
  CALCOM_API_KEY?: string;                 // secret: API key de Cal.com (cal_...)
  CALCOM_EVENT_TYPE_ID?: string;           // event type por defecto (numérico, como string)
  CALCOM_EVENT_TYPES?: string;             // opcional: JSON {"corte":123,"barba":456} servicio→eventTypeId
  CALCOM_TIMEZONE?: string;                // zona horaria (default America/Mexico_City)
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;  // base64-encoded JSON
  OWNER_EMAIL: string;  // for handoff notifications (email)
  OWNER_TELEGRAM_CHAT_ID?: string;  // for handoff notifications (default channel)
  OWNER_WA_NUMBER?: string;  // for Pro handoff WhatsApp DM (requires template)

  // HTTP Basic Auth password for the admin dashboard (secret).
  // Username is always "admin". Set via `wrangler secret put DASHBOARD_PASSWORD`.
  DASHBOARD_PASSWORD: string;

  // "1" = panel admin PÚBLICO (sin Basic Auth). Solo cuando el dueño lo decide
  // explícitamente (var en wrangler.toml); sin la var, el guard queda activo.
  DASHBOARD_PUBLIC?: string;

  // Token guarding POST /kb/reindex (header: X-Reindex-Token). Secret.
  // Set via `wrangler secret put KB_REINDEX_TOKEN`.
  KB_REINDEX_TOKEN: string;

  // Control plane (hosted): glue para que un plano de control externo lea este
  // bot self-hosted vía los endpoints /api/*. Ambos opcionales; sin el token,
  // /api/* queda cerrado (fail-closed).
  CONTROL_PLANE_TOKEN?: string;  // secret; Bearer que el control plane presenta para llamar /api/*
  CONTROL_PLANE_URL?: string;    // base URL del control plane (para reportes / license check futuros)
}
