import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import type { Env } from "../env";
import { toTelegramHtml, hasBalancedTags } from "../replies/format";

const TG_API = "https://api.telegram.org/bot";

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name?: string; is_bot: boolean };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    caption?: string;
    voice?: { file_id: string; duration: number };
    photo?: { file_id: string; width: number; height: number }[];
  };
}

export async function resolveTelegramFileUrl(
  fileId: string,
  token: string,
): Promise<string | null> {
  // Telegram files are NOT directly addressable by file_id. You must call
  // getFile to obtain a file_path, then download from
  // https://api.telegram.org/file/bot<token>/<file_path> (per Bot API docs).
  const res = await fetch(`${TG_API}${token}/getFile?file_id=${fileId}`);
  if (!res.ok) return null;
  const json: any = await res.json();
  if (!json?.ok) return null;
  return `https://api.telegram.org/file/bot${token}/${json.result.file_path}`;
}

export const telegramAdapter: ChannelAdapter = {
  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage> {
    const update = (await request.json()) as TgUpdate;
    const msg = update.message;
    if (!msg) throw new Error("not a message update");
    const channelUserId = String(msg.from.id);
    const displayName = msg.from.first_name;
    let text = msg.text;
    let audioUrl: string | undefined;
    let imageUrl: string | undefined;
    const token = env.TELEGRAM_BOT_TOKEN ?? "";
    if (msg.voice) {
      // Resolve to a real, fetchable HTTPS URL via getFile (see docs above).
      audioUrl = (await resolveTelegramFileUrl(msg.voice.file_id, token)) ?? undefined;
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      imageUrl = (await resolveTelegramFileUrl(largest.file_id, token)) ?? undefined;
      text = msg.caption;
    }
    return {
      channel: "telegram",
      channelUserId,
      displayName,
      text,
      audioUrl,
      imageUrl,
      // The owner intervenes from their own Telegram account: detect by matching
      // the sender against OWNER_TELEGRAM_CHAT_ID (the same id used for handoff DMs).
      isOwnerMessage:
        env.OWNER_TELEGRAM_CHAT_ID != null &&
        channelUserId === String(env.OWNER_TELEGRAM_CHAT_ID),
      receivedAt: Date.now(),
      rawPayload: update,
    };
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    for (let i = 0; i < reply.chunks.length; i++) {
      // typing indicator (best effort)
      await fetch(`${TG_API}${token}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: reply.channelUserId, action: "typing" }),
      }).catch(() => {});
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      // Sin parse_mode, Telegram muestra "**negrita**" literal en vez de
      // renderizarla — el modelo escribe markdown, pero nadie lo traduce.
      // Ojo: un parse_mode:"HTML" inválido no lanza, solo devuelve 400 — si
      // no se revisa `res.ok`, el mensaje se pierde en silencio. Por eso:
      // (1) valida el balanceo de tags ANTES de mandar (hasBalancedTags),
      // (2) si Telegram igual lo rechaza, reintenta UNA vez en texto plano.
      // El alumno/cliente nunca se queda sin respuesta por un HTML raro.
      const html = toTelegramHtml(reply.chunks[i]);
      const sendOnce = (body: Record<string, unknown>) =>
        fetch(`${TG_API}${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      let res: Response;
      if (hasBalancedTags(html)) {
        res = await sendOnce({ chat_id: reply.channelUserId, text: html, parse_mode: "HTML" });
      } else {
        console.error("[telegram] HTML sin balancear, se manda como texto plano", {
          preview: html.slice(0, 120),
        });
        res = await sendOnce({ chat_id: reply.channelUserId, text: reply.chunks[i] });
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(
          `[telegram] sendMessage falló (status ${res.status}) con HTML, reintentando en texto plano`,
          errBody,
        );
        const retry = await sendOnce({ chat_id: reply.channelUserId, text: reply.chunks[i] });
        if (!retry.ok) {
          const retryErrBody = await retry.text().catch(() => "");
          console.error(
            `[telegram] sendMessage falló otra vez en texto plano (status ${retry.status})`,
            retryErrBody,
          );
        }
      }
    }
  },

  async showTyping(channelUserId: string, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    await fetch(`${TG_API}${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelUserId, action: "typing" }),
    }).catch(() => {});
  },
};
