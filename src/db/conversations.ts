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

  /**
   * Borra una conversación y todo lo que le pertenece.
   *
   * Se borra tabla por tabla en vez de confiar en el ON DELETE CASCADE del
   * esquema: la aplicación de llaves foráneas depende del motor, y si no está
   * activa quedan filas huérfanas que nadie vuelve a ver pero siguen contando
   * en las estadísticas. Además `leads` y `tickets` son ON DELETE SET NULL, así
   * que la cascada no los limpiaría de todos modos.
   *
   * QUÉ SE VA: los mensajes, los insights, los hechos del cliente, los envíos
   * de seguimiento y los TICKETS de esa conversación (son artefactos suyos, no
   * tienen sentido sin ella).
   *
   * QUÉ SE QUEDA: los LEADS. Un lead es un contacto capturado, un activo del
   * negocio — borrar una conversación no debería hacerlo desaparecer de la
   * lista de Leads sin avisar. Se les deja el vínculo en NULL.
   */
  async delete(id: string): Promise<void> {
    // Primero lo que cuelga, después la conversación.
    for (const sql of [
      "DELETE FROM messages WHERE conversation_id = ?",
      "DELETE FROM conversation_insights WHERE conversation_id = ?",
      "DELETE FROM customer_facts WHERE conversation_id = ?",
      "DELETE FROM followup_sends WHERE conversation_id = ?",
      "DELETE FROM tickets WHERE conversation_id = ?",
      "UPDATE leads SET conversation_id = NULL WHERE conversation_id = ?",
      "DELETE FROM conversations WHERE id = ?",
    ]) {
      // Una tabla que no exista en una instalación vieja no debe frenar el
      // borrado de las demás.
      await this.db.run(sql, [id]).catch(() => {});
    }
  }

  async setOpenTicket(id: string, ticketId: string | null): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET open_ticket_id = ? WHERE id = ?",
      [ticketId, id],
    );
  }
}
