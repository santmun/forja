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

  /**
   * Ticket aún abierto (open o in_progress) de esta conversación, el más reciente.
   * Sirve para no abrir otro cuando el cliente repite el pedido de humano.
   */
  async findOpenByConversation(conversationId: string): Promise<Ticket | null> {
    return this.db.first<Ticket>(
      `SELECT * FROM tickets
       WHERE conversation_id = ? AND status != 'resolved'
       ORDER BY created_at DESC
       LIMIT 1`,
      [conversationId],
    );
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
}
