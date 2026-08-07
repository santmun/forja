import { Hono } from "hono";
import type { Env } from "./env";
import type { ChannelAdapter } from "./channels/shared";
import { telegramAdapter } from "./channels/telegram";
import { manychatAdapter } from "./channels/manychat";
import { twilioAdapter } from "./channels/twilio";
import { parseMetaEvents, verifyMetaSignature } from "./channels/meta";
import { parseWhatsAppEvents, serveWhatsAppMedia } from "./channels/whatsapp";
import { adminApp } from "./admin/routes";
import { purgeOldMessages } from "./crons/purgeOldMessages";
import { reindexKb } from "./kb/reindex";
import { analyzeConversations } from "./insights/analyzer";
import { Db } from "./db/client";
import { SettingsRepo, SETTING_KEYS } from "./db/settings";
import { detectKind } from "./learn/fieldPath";
import { saveCapture, isLearnMode } from "./learn/mapping";
import { tokensMatch } from "./http-auth";
import { apiApp } from "./api";

export { SupportAgent } from "./agent";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok", 200));

// Parse the provider payload via the channel adapter, derive the per-user DO id
// (channel + ':' + channelUserId), and forward the normalized message to the
// SupportAgent's `/ingest` endpoint. The DO buffers + schedules the alarm.
async function routeToAgent(c: { req: { raw: Request }; env: Env; text: (t: string, s: number) => Response }, adapter: ChannelAdapter) {
  try {
    const env = c.env;
    const msg = await adapter.parseIncoming(c.req.raw, env);
    const doId = env.AGENT.idFromName(`${msg.channel}:${msg.channelUserId}`);
    const stub = env.AGENT.get(doId);
    // Call the agent directly via RPC. Do NOT use stub.fetch(): the `agents` SDK
    // intercepts the Durable Object fetch and expects partyserver namespace/room
    // headers, so an ad-hoc fetch to /ingest fails to connect. RPC invokes the
    // method directly — it buffers the message and schedules the alarm.
    await stub.ingest(msg);
    // Twilio treats the webhook's HTTP body as a reply to send. The real reply
    // is delivered asynchronously via the REST API, so ack with empty TwiML
    // (`<Response></Response>`) to tell Twilio to send nothing. Other channels
    // ignore the body, so a plain "ok" is fine for them.
    if (msg.channel === "twilio") {
      return new Response("<Response></Response>", {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }
    return c.text("ok", 200);
  } catch (e: any) {
    console.error("webhook error:", e);
    return c.text(`err: ${e?.message ?? e}`, 500);
  }
}

app.post("/webhooks/telegram", (c) => routeToAgent(c, telegramAdapter));
app.post("/webhooks/manychat", (c) => routeToAgent(c, manychatAdapter));
// WhatsApp (Twilio): rutea el mensaje entrante al bot de clientes (Claude). El
// body se lee UNA vez; ack con TwiML vacío para que Twilio no reenvíe el cuerpo
// como mensaje.
app.post("/webhooks/twilio", async (c) => {
  let msg;
  try {
    msg = await twilioAdapter.parseIncoming(c.req.raw, c.env);
  } catch (e) {
    console.error("twilio parse error:", e);
    return new Response("<Response></Response>", { status: 200, headers: { "Content-Type": "text/xml" } });
  }
  const doId = c.env.AGENT.idFromName(`${msg.channel}:${msg.channelUserId}`);
  await c.env.AGENT.get(doId).ingest(msg).catch((e) => console.error("ingest:", e));
  return new Response("<Response></Response>", { status: 200, headers: { "Content-Type": "text/xml" } });
});

// --- Meta oficial (Facebook Messenger + Instagram DMs, sin ManyChat) --------
// GET = handshake de verificación de Meta: devuelve hub.challenge si el
// hub.verify_token coincide con nuestro secreto. Se llama una vez al configurar
// el webhook en la app de Meta.
app.get("/webhooks/meta", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token && token === c.env.META_VERIFY_TOKEN) {
    return c.text(challenge ?? "", 200);
  }
  return c.text("forbidden", 403);
});

// POST = eventos de mensajes. Meta firma el cuerpo con el App Secret; validamos
// la firma (fail-closed) antes de procesar. Un POST puede traer varios mensajes
// (varias páginas/usuarios): rutea cada uno a su Durable Object. Responde 200
// rápido para que Meta no reintente.
app.post("/webhooks/meta", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-hub-signature-256");
  // Messenger (app de Facebook) e Instagram (IG Login) pueden firmar con App
  // Secrets DISTINTOS aunque sea la misma app de Meta. Aceptamos la firma si
  // cuadra con cualquiera de los dos secretos configurados (fail-closed si con
  // ninguno). Así un solo webhook /webhooks/meta sirve para ambos canales.
  const valid =
    (!!c.env.META_APP_SECRET && (await verifyMetaSignature(raw, sig, c.env.META_APP_SECRET))) ||
    (!!c.env.INSTAGRAM_APP_SECRET && (await verifyMetaSignature(raw, sig, c.env.INSTAGRAM_APP_SECRET)));
  if (!valid) return c.text("bad signature", 403);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.text("bad json", 400);
  }
  // Kill-switch del canal oficial de Instagram (IG_OFFICIAL="off"): se ignora
  // TODO lo de IG por esta vía (DMs) — el bot de IG vive únicamente en ManyChat
  // (decisión de diseño). Messenger (object === "page") no se ve
  // afectado. Para reactivar: quitar la var y redeploy.
  if ((body as { object?: string }).object === "instagram" && c.env.IG_OFFICIAL === "off") {
    return c.text("EVENT_RECEIVED", 200);
  }

  for (const msg of parseMetaEvents(body as any)) {
    // Anti-duplicado: cuando IG_DM_SOURCE="manychat", los DMs de Instagram
    // entran SOLO por el webhook de ManyChat — el canal oficial los ignora
    // (si no, cada DM se procesa DOBLE: 2x LLM, 2x respuestas al lead y
    // colisiones de rate limit en ráfagas de historias).
    if (msg.channel === "instagram" && c.env.IG_DM_SOURCE === "manychat") continue;
    const doId = c.env.AGENT.idFromName(`${msg.channel}:${msg.channelUserId}`);
    await c.env.AGENT.get(doId).ingest(msg);
  }
  return c.text("EVENT_RECEIVED", 200);
});

// --- WhatsApp OFICIAL (Cloud API de Meta, sin Twilio/BSP) -------------------
// GET = handshake de verificación (igual que Meta). Acepta el WHATSAPP_VERIFY_TOKEN
// propio o, si no se configuró, cae al META_VERIFY_TOKEN (misma app de Meta).
app.get("/webhooks/whatsapp", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expected = c.env.WHATSAPP_VERIFY_TOKEN || c.env.META_VERIFY_TOKEN;
  if (mode === "subscribe" && token && expected && token === expected) {
    return c.text(challenge ?? "", 200);
  }
  return c.text("forbidden", 403);
});

// POST = mensajes entrantes. Firma X-Hub-Signature-256 con el App Secret de
// WhatsApp (o el de Meta si comparten app). Un POST puede traer varios mensajes.
app.post("/webhooks/whatsapp", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-hub-signature-256");
  const secret = c.env.WHATSAPP_APP_SECRET || c.env.META_APP_SECRET;
  const valid = !!secret && (await verifyMetaSignature(raw, sig, secret));
  if (!valid) return c.text("bad signature", 403);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.text("bad json", 400);
  }
  const origin = c.env.DASHBOARD_BASE_URL || new URL(c.req.url).origin;
  for (const msg of await parseWhatsAppEvents(body as any, c.env, origin)) {
    const doId = c.env.AGENT.idFromName(`${msg.channel}:${msg.channelUserId}`);
    await c.env.AGENT.get(doId).ingest(msg);
  }
  return c.text("EVENT_RECEIVED", 200);
});

// Proxy FIRMADO del media entrante de WhatsApp Cloud (audio/imagen). Hace el
// media públicamente fetchable (para transcribe/vision) sin exponer el token.
app.get("/webhooks/whatsapp/media/:id", (c) =>
  serveWhatsAppMedia(c.req.param("id"), c.req.query("exp") ?? null, c.req.query("sig") ?? null, c.env),
);

// Universal webhook LEARN endpoint. When learn mode is ON for `:channel`, this
// captures a real payload (classified by media kind) so the bot can later infer
// where each field lives — instead of hardcoding one app's contract. It NEVER
// runs the LLM; it only observes. When learn mode is OFF it returns 409 so the
// caller knows nothing was captured.
app.post("/webhooks/learn/:channel", async (c) => {
  const channel = c.req.param("channel");
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid json" }, 400);
  }

  const repo = new SettingsRepo(new Db(c.env.DB));
  const kind = detectKind(payload);

  if (!(await isLearnMode(repo, channel))) {
    return c.json({ ok: false, error: "learn mode off" }, 409);
  }

  await saveCapture(repo, channel, kind, payload);
  return c.json({ ok: true, captured: kind, channel }, 200);
});

// Admin dashboard — Basic Auth guarded sub-app mounted at /admin/*.
app.route("/admin", adminApp);

// Control-plane API — Bearer-guarded (CONTROL_PLANE_TOKEN) read-only sub-app
// mounted at /api/* for a future hosted control plane (health + metrics).
app.route("/api", apiApp);

// KB reindex — embeds scripts/kb-fixtures.json into Vectorize. Guarded by the
// KB_REINDEX_TOKEN secret via the X-Reindex-Token header.
//
// El orden importa, y no es el intuitivo:
//   1. pnpm kb:reindex        (regenera el manifiesto)
//   2. pnpm deploy
//   3. wrangler secret put KB_REINDEX_TOKEN     <- DESPUÉS del deploy
//   4. curl -X POST https://<worker>/kb/reindex -H "X-Reindex-Token: <token>"
//
// El secret va después del deploy porque un deploy posterior lo puede dejar sin
// efecto. Y aun haciéndolo en este orden, el paso 4 puede devolver
// `unauthorized` en el primer intento: el secret tarda unos segundos en
// propagarse por el edge. Esperar y reintentar resuelve — el token no está mal.
app.post("/kb/reindex", async (c) => {
  const provided = c.req.header("X-Reindex-Token") ?? "";
  const expected = c.env.KB_REINDEX_TOKEN ?? "";
  if (!expected) {
    // Distinto de "token equivocado", pero la respuesta es la misma a propósito:
    // decirle a quien llama que el Worker no tiene secret es regalarle
    // información. El aviso va al log, donde lo ve el dueño con `wrangler tail`
    // y nadie más. Sin esto, un secret que no propagó y un token mal copiado se
    // ven idénticos desde afuera.
    console.warn(
      "kb/reindex: KB_REINDEX_TOKEN no está configurado en este Worker (o todavía no propagó); toda llamada va a devolver unauthorized",
    );
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!tokensMatch(provided, expected)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const r = await reindexKb(c.env);
  return c.json({ ok: true, indexed: r.indexed }, 200);
});

app.notFound((c) => c.text("not found", 404));

export default {
  // Bind so Hono keeps its `this` when invoked as `worker.fetch(req, env, ctx)`
  // (both by the Cloudflare runtime and by tests). Passing `app.fetch` unbound
  // loses the receiver and throws "Cannot read properties of undefined".
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // Follow-up bot: UN mensaje breve de seguimiento a leads que lo ameritan
    // (venta abierta / 4+ preguntas), dentro de la ventana de 24h y máximo una
    // vez por conversación. Acotado por caps internos.
    const { runFollowups } = await import("./followup/run");
    await runFollowups(env).catch((e) => console.error("followups:", e));

    // Watchdog: si el bot está fallando en cadena (3+ "Algo falló" en 30 min),
    // avisa al dueño por su canal de handoff. Throttle 6h. Lo ÚNICO que debe
    // despertarlo en la noche.
    const { checkBotHealth } = await import("./watchdog");
    await checkBotHealth(env).catch((e) => console.error("watchdog:", e));

    // Los trabajos nocturnos SOLO corren en el tick diario (3am UTC) — un tick
    // más frecuente (si el miembro lo configura) no debe purgar/analizar de más.
    if (event.cron && event.cron !== "0 3 * * *") return;

    // Daily cron (wrangler.toml: "0 3 * * *") — purge messages older than 90 days.
    await purgeOldMessages(env);
    // Corrida nocturna del Analista de insights (F2). No debe tumbar la purga.
    await analyzeConversations(env, { limit: 50 }).catch((e) => console.error("insights:", e));
    // Flywheel (F5): detecta huecos de KB y lecciones de takeovers → propone
    // mejoras en /admin/mejoras. Corre DESPUÉS del analizador (usa su output).
    const { runFlywheel } = await import("./flywheel/detect");
    await runFlywheel(env).catch((e) => console.error("flywheel:", e));
    // Modo COPILOTO (autonomy_level="copilot"): auto-aplica las mejoras seguras
    // detectadas (lecciones + KB sin huecos). Lo delicado espera al dueño.
    try {
      const level = await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.autonomyLevel);
      if (level === "copilot") {
        const { autoApplyPending } = await import("./flywheel/apply");
        await autoApplyPending(env);
      }
    } catch (e) {
      console.error("copiloto:", e);
    }
  },
} satisfies ExportedHandler<Env>;
