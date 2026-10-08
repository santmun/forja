export type ChannelId = "manychat" | "telegram" | "twilio" | "messenger" | "instagram" | "whatsapp";

export interface IncomingMessage {
  channel: ChannelId;
  channelUserId: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
  receivedAt: number;
  rawPayload: unknown;
}

export interface OutgoingReply {
  channel: ChannelId;
  channelUserId: string;
  chunks: string[];
  interChunkDelayMs?: number;
  /**
   * Si es true, un rechazo del proveedor lanza en vez de solo loguearse.
   * El panel lo prende para no guardar como enviado un mensaje que no salió.
   * El bot y las campañas no lo prenden: un fallo ahí no debe tumbar el turno.
   */
  strict?: boolean;
}

/** Lo que el canal devuelve cuando el proveedor acepta el envío. */
export interface SendResult {
  /** Id del proveedor. En WhatsApp Cloud es el wamid. */
  providerMessageId?: string;
}

export interface ChannelAdapter {
  parseIncoming(request: Request, env: any): Promise<IncomingMessage>;
  sendReply(reply: OutgoingReply, env: any): Promise<SendResult | void>;
  showTyping?(channelUserId: string, env: any): Promise<void>;
}
