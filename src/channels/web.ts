import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import type { Env } from "../env";

/**
 * Canal WEB — el chat de /demo.
 *
 * No hay proveedor al que empujar la respuesta: el agente la deja en D1 y el
 * navegador la recoge con GET /demo/poll. sendReply es un no-op a propósito,
 * para que este canal reutilice el mismo pipeline (buffer, tools, KB) sin
 * ramas especiales.
 */
export const webAdapter: ChannelAdapter = {
  async parseIncoming(request: Request, _env: Env): Promise<IncomingMessage> {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      text?: string;
      name?: string;
    };

    const sessionId = (body.sessionId ?? "").trim();
    const text = (body.text ?? "").trim();
    if (!sessionId || !text) {
      throw new Error("web: falta sessionId o text");
    }

    return {
      channel: "web",
      // El sessionId lo genera el navegador. Acotado para que no ensucie el
      // nombre del Durable Object.
      channelUserId: sessionId.slice(0, 64),
      displayName: (body.name ?? "").trim().slice(0, 60) || undefined,
      text: text.slice(0, 2000),
      receivedAt: Date.now(),
      rawPayload: body,
    };
  },

  async sendReply(_reply: OutgoingReply, _env: Env): Promise<void> {},
};
