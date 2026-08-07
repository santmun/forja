import { Db } from "./client";

export interface Lead {
  id: string;
  conversation_id: string | null;
  name: string | null;
  contact: string | null;
  channel_user_id: string | null;
  intent: string;
  notes: string | null;
  status: "new" | "contacted" | "sold" | "lost";
  exported_to: string | null;
  external_id: string | null;
  /** JSON con los campos propios del nicho (o null). Ver leadMetadata(). */
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateLeadInput {
  conversationId: string | null;
  channelUserId: string | null;
  name?: string;
  contact?: string;
  intent: string;
  notes?: string;
  /** Campos propios del nicho; se serializan a JSON en la columna metadata. */
  metadata?: Record<string, string | number | null>;
}

/** Parsea el JSON de metadata de un lead a un objeto plano (vacío si no hay/está roto). */
export function leadMetadata(lead: Pick<Lead, "metadata">): Record<string, string> {
  if (!lead.metadata) return {};
  try {
    const o = JSON.parse(lead.metadata);
    if (!o || typeof o !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

export class LeadsRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateLeadInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const metadata =
      input.metadata && Object.keys(input.metadata).length > 0
        ? JSON.stringify(input.metadata)
        : null;
    await this.db.run(
      `INSERT INTO leads (id, conversation_id, name, contact, channel_user_id, intent, notes, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.name ?? null,
        input.contact ?? null,
        input.channelUserId,
        input.intent,
        input.notes ?? null,
        metadata,
        now,
        now,
      ],
    );
    return id;
  }

  async list(limit: number, status?: string): Promise<Lead[]> {
    if (status) {
      return this.db.all<Lead>(
        "SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ?",
        [status, limit],
      );
    }
    return this.db.all<Lead>(
      "SELECT * FROM leads ORDER BY created_at DESC LIMIT ?",
      [limit],
    );
  }

  async setStatus(id: string, status: Lead["status"]): Promise<void> {
    await this.db.run(
      "UPDATE leads SET status = ?, updated_at = ? WHERE id = ?",
      [status, Date.now(), id],
    );
  }

  /**
   * Borra un lead para siempre.
   *
   * Distinto de marcarlo "perdido": ese estado conserva el contacto y sirve
   * para medir. Borrar lo saca de la base — es para leads de prueba, duplicados,
   * o cuando la persona pide que se eliminen sus datos.
   *
   * No arrastra nada más: la conversación de la que salió sigue existiendo, con
   * su historia intacta.
   */
  async delete(id: string): Promise<void> {
    await this.db.run("DELETE FROM leads WHERE id = ?", [id]);
  }

  async setExported(id: string, target: string, externalId: string): Promise<void> {
    await this.db.run(
      "UPDATE leads SET exported_to = ?, external_id = ?, updated_at = ? WHERE id = ?",
      [target, externalId, Date.now(), id],
    );
  }
}
