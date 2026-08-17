import { Db } from "./client";

export interface Ticket {
  id: string;
  conversation_id: string | null;
  category: string;
  summary: string;
  transcript: string;
  status: "open" | "in_progress" | "resolved";
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
}

export interface CreateTicketInput {
  conversationId: string | null;
  category: string;
  summary: string;
  transcript: string;
}

export class TicketsRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateTicketInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO tickets (id, conversation_id, category, summary, transcript, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.conversationId, input.category, input.summary, input.transcript, Date.now()],
    );
    return id;
  }

  async getById(id: string): Promise<Ticket | null> {
    return this.db.first<Ticket>("SELECT * FROM tickets WHERE id = ?", [id]);
  }

  async listOpen(): Promise<Ticket[]> {
    return this.db.all<Ticket>(
      "SELECT * FROM tickets WHERE status != 'resolved' ORDER BY created_at DESC",
    );
  }

  async resolve(id: string, resolvedBy: string): Promise<void> {
    await this.db.run(
      "UPDATE tickets SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?",
      [Date.now(), resolvedBy, id],
    );
  }

  /**
   * Borra un ticket para siempre.
   *
   * Distinto de resolver: resolver deja el registro con su historia, borrar lo
   * saca. Es para tickets de prueba o abiertos por error, no para el flujo
   * normal — un ticket atendido se resuelve, no se borra.
   *
   * Si el ticket era el abierto de una conversación, se limpia esa referencia:
   * de lo contrario la conversación queda apuntando a algo que ya no existe y
   * el inbox la sigue mostrando con "ticket abierto".
   */
  async delete(id: string): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET open_ticket_id = NULL WHERE open_ticket_id = ?",
      [id],
    );
    await this.db.run("DELETE FROM tickets WHERE id = ?", [id]);
  }
}
