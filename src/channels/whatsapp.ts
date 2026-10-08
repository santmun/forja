// Canal OFICIAL de WhatsApp (Cloud API de Meta — sin BSP/Twilio).
//
// Mismo ecosistema Graph que Meta (Messenger/IG), pero el formato del webhook y
// del envío son DISTINTOS:
//  • Entrante: object "whatsapp_business_account" → entry[].changes[].value.messages[]
//    Los recibos (sent/delivered/read/failed) vienen en value.statuses[] y los
//    devuelve parseWhatsAppStatuses — no son mensajes del cliente.
//  • Envío: POST graph.facebook.com/<PHONE_NUMBER_ID>/messages con el token del
//    system user/WABA y { messaging_product:"whatsapp", to, type:"text", text }.
//
// El media entrante NO es públicamente descargable: hay que hacer GET /<media_id>
// (Bearer) → url, y GET url (Bearer) → bytes. Para reusar transcribe/vision sin
// tocarlas, lo servimos por un proxy FIRMADO (/webhooks/whatsapp/media/:id): la
// URL es pública pero con HMAC + expiración, y el token queda del lado del server.
import type { ChannelAdapter, IncomingMessage, OutgoingReply, SendResult } from "./shared";
import type { Env } from "../env";
import { egressFetch } from "../http/egress";

const GRAPH_VERSION = "v21.0";
const MEDIA_TTL_MS = 10 * 60 * 1000; // la URL firmada del proxy vive 10 min

interface WaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  audio?: { id?: string; voice?: boolean; mime_type?: string };
}

interface WaStatusError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

interface WaStatus {
  id?: string;
  status?: string;
  timestamp?: string | number;
  recipient_id?: string;
  errors?: WaStatusError[];
}

interface WaChange {
  field?: string;
  value?: {
    messaging_product?: string;
    metadata?: { phone_number_id?: string; display_phone_number?: string };
    contacts?: { profile?: { name?: string }; wa_id?: string }[];
    messages?: WaMessage[];
    statuses?: WaStatus[];
  };
}

interface WaWebhookBody {
  object?: string;
  entry?: { id?: string; changes?: WaChange[] }[];
}

/** Secret para firmar el webhook y las URLs de media (Cloud usa el App Secret). */
function appSecret(env: Env): string {
  return env.WHATSAPP_APP_SECRET || env.META_APP_SECRET || "";
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Construye la URL firmada del proxy para un media_id (o null si no hay secret/base). */
async function signedMediaUrl(mediaId: string, env: Env, origin: string): Promise<string | null> {
  const secret = appSecret(env);
  const base = (origin || env.DASHBOARD_BASE_URL || "").replace(/\/$/, "");
  if (!secret || !base) return null;
  const exp = Date.now() + MEDIA_TTL_MS;
  const sig = await hmacHex(secret, `${mediaId}.${exp}`);
  return `${base}/webhooks/whatsapp/media/${encodeURIComponent(mediaId)}?exp=${exp}&sig=${sig}`;
}

/**
 * Convierte un webhook de WhatsApp Cloud en 0..N mensajes entrantes. Un POST
 * puede traer varias entradas y varios mensajes. Los `statuses` (recibos) no
 * son mensajes: se leen con parseWhatsAppStatuses. Los tipos no soportados
 * (ubicación, sticker, etc.) se ignoran. `origin` es la base pública del worker
 * (para firmar las URLs de media entrante).
 */
export async function parseWhatsAppEvents(
  body: WaWebhookBody,
  env: Env,
  origin: string,
): Promise<IncomingMessage[]> {
  const out: IncomingMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== "messages") continue;
      const value = change.value;
      if (!value?.messages?.length) continue; // solo recibos, o sin mensajes del cliente
      const nameByWaId = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id && c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }
      for (const m of value.messages ?? []) {
        const from = m.from;
        if (!from) continue;
        let text: string | undefined;
        let audioUrl: string | undefined;
        let imageUrl: string | undefined;
        if (m.type === "text") {
          text = m.text?.body || undefined;
        } else if (m.type === "image" && m.image?.id) {
          imageUrl = (await signedMediaUrl(m.image.id, env, origin)) ?? undefined;
          text = m.image.caption || undefined;
        } else if (m.type === "audio" && m.audio?.id) {
          // Las notas de voz llegan como type "audio" con voice:true.
          audioUrl = (await signedMediaUrl(m.audio.id, env, origin)) ?? undefined;
        }
        console.log(
          "whatsapp in:",
          JSON.stringify({ from, type: m.type, hasText: !!text, hasAudio: !!audioUrl, hasImage: !!imageUrl }),
        );
        if (!text && !audioUrl && !imageUrl) continue; // tipo no soportado / vacío
        out.push({
          channel: "whatsapp",
          channelUserId: String(from),
          displayName: nameByWaId.get(from),
          text,
          audioUrl,
          imageUrl,
          isOwnerMessage: false,
          receivedAt: Date.now(),
          rawPayload: m,
        });
      }
    }
  }
  return out;
}

export interface WhatsAppStatusEvent {
  wamid: string;
  status: string;
  /** Unix en milisegundos. */
  timestamp: number;
  recipientId?: string;
  errorCode?: number;
  errorTitle?: string;
}

function unixToMs(ts: string | number | undefined, fallback: number): number {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Recibos de entrega de un webhook de WhatsApp Cloud.
 * Meta manda sent, delivered, read y failed (con errors[].code, p.ej. 131047)
 * en value.statuses[], a veces solos y a veces junto a messages[].
 */
export function parseWhatsAppStatuses(body: WaWebhookBody, now = Date.now()): WhatsAppStatusEvent[] {
  const out: WhatsAppStatusEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== "messages") continue;
      const statuses = change.value?.statuses;
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        const wamid = s?.id ? String(s.id) : "";
        const status = s?.status ? String(s.status).toLowerCase() : "";
        if (!wamid || !status) continue;
        const err = Array.isArray(s.errors) ? s.errors[0] : undefined;
        out.push({
          wamid,
          status,
          timestamp: unixToMs(s.timestamp, now),
          recipientId: s.recipient_id ? String(s.recipient_id) : undefined,
          errorCode: typeof err?.code === "number" ? err.code : undefined,
          errorTitle: err?.title || err?.message || undefined,
        });
      }
    }
  }
  return out;
}

interface GraphErrorBody {
  error?: { code?: number; message?: string; error_data?: { details?: string } };
}

interface GraphSendBody {
  messages?: { id?: string }[];
}

/** Error de envío de WhatsApp Cloud. `code` es el de Meta (131047 = ventana cerrada). */
export class WhatsAppSendError extends Error {
  readonly httpStatus: number;
  readonly code?: number;
  constructor(message: string, httpStatus: number, code?: number) {
    super(message);
    this.name = "WhatsAppSendError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function describeWaFailure(httpStatus: number, raw: string): { message: string; code?: number } {
  let code: number | undefined;
  let details = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as GraphErrorBody;
    code = parsed.error?.code;
    details = parsed.error?.error_data?.details || parsed.error?.message || details;
  } catch {
    /* el cuerpo no es JSON */
  }
  if (code === 131047) {
    return { code, message: "Fuera de la ventana de 24 h: WhatsApp rechazó el mensaje (131047)." };
  }
  const suffix = details ? `: ${details}` : "";
  return { code, message: `WhatsApp rechazó el mensaje${code ? ` (${code})` : ""}${suffix}` };
}

function readWamid(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as GraphSendBody;
    const id = parsed.messages?.[0]?.id;
    return id ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sirve el media entrante de WhatsApp Cloud: valida la firma HMAC + expiración,
 * resuelve el media_id contra Graph (Bearer) y devuelve los bytes. Público pero
 * firmado — el token nunca sale del server. Lo usa la ruta GET
 * /webhooks/whatsapp/media/:id (ver index.ts).
 */
export async function serveWhatsAppMedia(
  mediaId: string,
  exp: string | null,
  sig: string | null,
  env: Env,
): Promise<Response> {
  const secret = appSecret(env);
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!secret || !token) return new Response("not configured", { status: 404 });
  const expNum = Number(exp);
  if (!exp || !sig || !Number.isFinite(expNum)) return new Response("bad request", { status: 400 });
  if (Date.now() > expNum) return new Response("expired", { status: 410 });
  const expected = await hmacHex(secret, `${mediaId}.${exp}`);
  if (!timingSafeEqual(expected, sig)) return new Response("bad signature", { status: 403 });

  // 1) media_id → URL temporal de descarga
  const metaRes = await egressFetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) return new Response("media lookup failed", { status: 502 });
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) return new Response("media url missing", { status: 502 });

  // 2) descarga real (también requiere el Bearer)
  const fileRes = await egressFetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) return new Response("media download failed", { status: 502 });
  const contentType = meta.mime_type || fileRes.headers.get("content-type") || "application/octet-stream";
  return new Response(fileRes.body, { status: 200, headers: { "Content-Type": contentType } });
}

export const whatsappAdapter: ChannelAdapter = {
  // Existe por la interfaz ChannelAdapter; el webhook /webhooks/whatsapp usa
  // parseWhatsAppEvents directamente (un POST puede traer varios mensajes).
  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage> {
    const body = (await request.json()) as WaWebhookBody;
    const origin = new URL(request.url).origin;
    const [first] = await parseWhatsAppEvents(body, env, origin);
    if (!first) throw new Error("whatsapp webhook sin mensaje procesable");
    return first;
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<SendResult> {
    const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
    const token = env.WHATSAPP_ACCESS_TOKEN;
    if (!phoneId || !token) {
      throw new Error("WhatsApp Cloud: falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN.");
    }
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
    let providerMessageId: string | undefined;
    for (let i = 0; i < reply.chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await egressFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: reply.channelUserId,
          type: "text",
          text: { preview_url: false, body: reply.chunks[i] },
        }),
      });
      const raw = await res.text().catch(() => "");
      // Fuera de la ventana de 24h Meta rechaza texto libre (131047).
      // Sin strict solo se loguea (el bot no debe tumbar el turno). Con strict
      // —el panel— se lanza para no guardar el mensaje como enviado.
      if (!res.ok) {
        const failure = describeWaFailure(res.status, raw);
        if (reply.strict) throw new WhatsAppSendError(failure.message, res.status, failure.code);
        console.error(`whatsapp sendReply ${res.status}: ${raw}`);
        continue;
      }
      const id = readWamid(raw);
      if (id && !providerMessageId) providerMessageId = id;
    }
    return providerMessageId ? { providerMessageId } : {};
  },
};
