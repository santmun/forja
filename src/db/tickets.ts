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

/** Idempotent. No semicolons inside — schema.sql splitter is `;`. */
export const CLEANUP_STALE_OPEN_TICKETS_SQL = `
UPDATE conversations SET open_ticket_id = NULL
WHERE open_ticket_id IS NOT NULL
  AND (open_ticket_id NOT IN (SELECT id FROM tickets)
       OR open_ticket_id IN (SELECT id FROM tickets WHERE status = 'resolved'))
`.trim();

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
    // Conversation ids are permanent (channel:user). open_ticket_id must drop
    // when the human case closes, or Pro follow-ups / surveys skip that lead forever.
    await this.db.run(
      "UPDATE conversations SET open_ticket_id = NULL WHERE open_ticket_id = ?",
      [id],
    );
  }

  /**
   * One-shot cleanup for rows still pointing at a resolved ticket or a missing
   * ticket id (orphans). Safe to re-run. Same statement lives in schema.sql
   * so `pnpm db:apply:remote` heals existing bots on update.
   */
  async cleanupStaleOpenTicketRefs(): Promise<void> {
    await this.db.run(CLEANUP_STALE_OPEN_TICKETS_SQL);
  }
}
