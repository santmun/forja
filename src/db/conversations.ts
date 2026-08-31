import { Db } from "./client";

export interface Conversation {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  started_at: number;
  last_message_at: number;
  paused_until: number | null;
  open_ticket_id: string | null;
  metadata: string | null;
}

function makeConvId(channel: string, channelUserId: string): string {
  return `${channel}:${channelUserId}`;
}

/**
 * Owner-takeover window: 20 minutes from the last owner message.
 * Later owner messages slide the window forward; silence past the cap
 * lets the bot resume. Not unbounded — echoes cannot stack hours of pause.
 */
export const OWNER_TAKEOVER_MS = 20 * 60 * 1000;

export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  async getOrCreate(
    channel: string,
    channelUserId: string,
    displayName?: string,
  ): Promise<Conversation> {
    const id = makeConvId(channel, channelUserId);
    const existing = await this.db.first<Conversation>(
      "SELECT * FROM conversations WHERE id = ?",
      [id],
    );
    if (existing) return existing;

    const now = Date.now();
    await this.db.run(
      `INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, channel, channelUserId, displayName ?? null, now, now],
    );
    return (await this.db.first<Conversation>(
      "SELECT * FROM conversations WHERE id = ?",
      [id],
    ))!;
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.db.first<Conversation>(
      "SELECT * FROM conversations WHERE id = ?",
      [id],
    );
  }

  async setPausedUntil(id: string, until: number | null): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET paused_until = ? WHERE id = ?",
      [until, id],
    );
  }

  async isPaused(id: string): Promise<boolean> {
    const conv = await this.getById(id);
    if (!conv?.paused_until) return false;
    return conv.paused_until > Date.now();
  }

  async touchLastMessage(id: string, when: number = Date.now()): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET last_message_at = ? WHERE id = ?",
      [when, id],
    );
  }

  async setOpenTicket(id: string, ticketId: string | null): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET open_ticket_id = ? WHERE id = ?",
      [ticketId, id],
    );
  }
}
