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

  /** Añade contexto a un ticket que sigue abierto (mismo hilo, sin crear otro). */
  async appendSummary(id: string, extra: string): Promise<void> {
    const ticket = await this.getById(id);
    if (!ticket) return;
    // Conserva el contexto más reciente si el hilo se alarga.
    const summary = `${ticket.summary}\n${extra}`.slice(-4000);
    await this.db.run("UPDATE tickets SET summary = ? WHERE id = ?", [summary, id]);
  }

  async resolve(id: string, resolvedBy: string): Promise<void> {
    await this.db.run(
      "UPDATE tickets SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?",
      [Date.now(), resolvedBy, id],
    );
  }
}
