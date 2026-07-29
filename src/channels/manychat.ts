import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import type { Env } from "../env";
import { tokensMatch } from "../http-auth";

const MANYCHAT_API = "https://api.manychat.com/fb";

/**
 * ManyChat no firma sus webhooks salientes (External Request), así que la
 * protección es un shared secret que el propio miembro configura como header
 * custom (`X-Manychat-Secret`) en el flow de ManyChat, comparado contra
 * MANYCHAT_WEBHOOK_SECRET. Fail-closed: sin secret configurado, sin header, o
 * si no coincide → false.
 */
export function verifyManychatSecret(
  headerValue: string | null | undefined,
  env: Env,
): boolean {
  const expected = env.MANYCHAT_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  return tokensMatch((headerValue ?? "").trim(), expected);
}

// Aligned with a typical ManyChat/n8n production flow:
// - ManyChat posts the subscriber in `id` (NOT `subscriber_id`).
// - The text arrives in `last_input_text`.
// - sendContent REQUIRES `content.type` to match the channel (instagram /
//   whatsapp / etc.) — without it the message is rejected for IG.
// The original message timestamp (e.g. `ig_last_interaction`) is intentionally
// ignored; we stamp `receivedAt` with the bot's own clock to avoid the
// per-channel timestamp-format transformations ManyChat would otherwise need.
interface ManychatPayload {
  id: string | number;
  // fallback for setups that send subscriber_id instead of id
  subscriber_id?: string | number;
  first_name?: string;
  last_name?: string;
  last_input_text?: string;
  attachments?: { type: string; payload: { url: string } }[] | string;
  custom_fields?: Record<string, string>;
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|heic)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|mp4|m4a|ogg|oga|wav|aac|webm|amr)(\?|#|$)/i;
// CDNs de Meta desde donde ManyChat entrega el media de IG (el contrato real:
// cuando el usuario manda foto/audio, ManyChat pone ese link COMO last_input_text).
const MEDIA_HOSTS = /(lookaside\.fbsbx\.com|fbsbx\.com|cdninstagram\.com|fbcdn\.net|manychat)/i;

/** Si el texto completo es un solo URL, lo devuelve; si trae más palabras, null. */
function soleUrl(text: string | undefined): string | null {
  const t = (text ?? "").trim();
  return /^https?:\/\/\S+$/.test(t) ? t : null;
}

/** Clasifica un URL de media: por extensión y, si no alcanza, sondeando el
 * Content-Type (el "patch" del flujo n8n típico). mp4/video cuenta
 * como audio: las notas de voz de IG llegan como mp4 y Whisper las transcribe. */
async function classifyMediaUrl(url: string): Promise<"image" | "audio" | null> {
  if (IMG_EXT.test(url)) return "image";
  if (AUDIO_EXT.test(url)) return "audio";
  if (!MEDIA_HOSTS.test(url)) return null;
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!res.ok || !res.headers.get("content-type")) {
      res = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.startsWith("image/")) return "image";
    if (ct.startsWith("audio/") || ct.startsWith("video/")) return "audio";
  } catch {
    // la sonda es best-effort: si falla, se trata como texto normal
  }
  return null;
}

/** ManyChat a veces manda attachments como JSON-string (mapeo de texto en el
 * External Request) y con tipos variados (image/file/story_mention). Se
 * normaliza todo a una lista { type, url }. */
function normalizeAttachments(raw: ManychatPayload["attachments"]): { type: string; url: string }[] {
  let list: unknown = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      // Un solo URL pegado como texto también cuenta.
      return IMG_EXT.test(list as string) ? [{ type: "image", url: list as string }] : [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: { type: string; url: string }[] = [];
  for (const a of list) {
    const url: string = a?.payload?.url ?? a?.url ?? "";
    if (!url) continue;
    let type: string = a?.type ?? "";
    // story_mention / share / file con extensión de imagen → tratarlo como imagen.
    if (type !== "image" && type !== "audio" && (IMG_EXT.test(url) || type === "story_mention")) type = "image";
    out.push({ type, url });
  }
  return out;
}

export const manychatAdapter: ChannelAdapter = {
  async parseIncoming(request: Request, _env: Env): Promise<IncomingMessage> {
    const body = (await request.json()) as ManychatPayload;
    const subscriber = body.id ?? body.subscriber_id;
    const displayName =
      [body.first_name, body.last_name].filter(Boolean).join(" ").trim() || undefined;
    const atts = normalizeAttachments(body.attachments);
    let audioUrl = atts.find((a) => a.type === "audio")?.url;
    let imageUrl = atts.find((a) => a.type === "image")?.url;
    let text =
      body.last_input_text && body.last_input_text !== "[audio]"
        ? body.last_input_text
        : undefined;
    // El contrato real de IG vía ManyChat: cuando el usuario manda foto o nota
    // de voz, el "texto" del mensaje ES el link del CDN de Meta. Se detecta y
    // se rutea a visión/transcripción en vez de dárselo al modelo como texto.
    if (text && !audioUrl && !imageUrl) {
      const u = soleUrl(text);
      if (u) {
        const kind = await classifyMediaUrl(u);
        if (kind === "image") { imageUrl = u; text = undefined; }
        else if (kind === "audio") { audioUrl = u; text = undefined; }
      }
    }
    // Diagnóstico: qué llegó realmente. Si no hay ni texto ni media (el caso
    // "mandó una imagen y no pasó nada"), se loguea el body completo para ver
    // qué campos está mapeando el flow de ManyChat.
    console.log(
      "[manychat]",
      JSON.stringify({ sub: `…${String(subscriber).slice(-4)}`, hasText: !!text, img: !!imageUrl, aud: !!audioUrl, atts: atts.map((a) => a.type) }),
    );
    // Diagnóstico sin PII: solo QUÉ campos llegaron, nunca sus valores (el
    // payload de ManyChat trae nombre, teléfono y correo del suscriptor).
    if (!text && !audioUrl && !imageUrl) {
      console.log("[manychat] payload sin texto/media, campos:", JSON.stringify(Object.keys(body ?? {})));
    }
    return {
      channel: "manychat",
      channelUserId: String(subscriber),
      displayName,
      text,
      audioUrl,
      imageUrl,
      isOwnerMessage: false, // ManyChat outbound owner msgs do not hit this webhook
      receivedAt: Date.now(),
      rawPayload: body,
    };
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const apiKey = env.MANYCHAT_API_KEY;
    if (!apiKey) throw new Error("MANYCHAT_API_KEY not set");
    // ManyChat needs the content type to match the channel (instagram is the
    // default since that's the primary IG flow).
    const contentType = env.MANYCHAT_CONTENT_TYPE ?? "instagram";
    for (let i = 0; i < reply.chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await fetch(`${MANYCHAT_API}/sending/sendContent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subscriber_id: reply.channelUserId,
          data: {
            version: "v2",
            content: {
              type: contentType,
              messages: [{ type: "text", text: reply.chunks[i] }],
            },
          },
        }),
      });
    }
  },
};
