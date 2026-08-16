import { Db } from "./client";

export type MessageRole = "user" | "assistant" | "tool" | "owner";

/**
 * NOTAS INTERNAS — lo que el equipo le cuenta AL BOT, y el cliente nunca ve.
 *
 * Al devolverle una conversación al bot se puede dejar una nota ("ya le
 * confirmé el pago por fuera"). Esa nota se guarda como mensaje del dueño, y
 * hasta ahora era indistinguible de un mensaje que SÍ se le envió al cliente:
 * el panel la dibujaba igual, con el mismo pie. Es muy fácil escribir algo ahí
 * y quedarse con la duda de si le llegó a la persona.
 *
 * Con la marca, la nota se puede tratar como lo que es en los CUATRO sitios
 * donde ese texto se reusa: el hilo, el bot, el co-pilot y el flywheel.
 *
 * Las notas viejas (sin marca) se siguen viendo como antes.
 */
export const MARCA_NOTA = "[[NOTA]]";

export function esNotaInterna(contenido: string): boolean {
  return contenido.startsWith(MARCA_NOTA);
}

export function sinMarcaNota(contenido: string): string {
  return esNotaInterna(contenido) ? contenido.slice(MARCA_NOTA.length).trim() : contenido;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_calls: string | null;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  audio_seconds: number | null;
  image_count: number | null;
  created_at: number;
}

export interface AppendOptions {
  toolCalls?: unknown[];
  modelUsed?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  audioSeconds?: number;
  imageCount?: number;
  createdAt?: number;
}

export class MessagesRepo {
  constructor(private readonly db: Db) {}

  async append(
    conversationId: string,
    role: MessageRole,
    content: string,
    opts: AppendOptions = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    const createdAt = opts.createdAt ?? Date.now();
    await this.db.run(
      `INSERT INTO messages (
        id, conversation_id, role, content, tool_calls, model_used,
        input_tokens, output_tokens, cached_input_tokens,
        audio_seconds, image_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        conversationId,
        role,
        content,
        opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
        opts.modelUsed ?? null,
        opts.inputTokens ?? null,
        opts.outputTokens ?? null,
        opts.cachedInputTokens ?? null,
        opts.audioSeconds ?? null,
        opts.imageCount ?? null,
        createdAt,
      ],
    );
    return id;
  }

  async lastN(conversationId: string, n: number): Promise<Message[]> {
    const rows = await this.db.all<Message>(
      `SELECT * FROM (
         SELECT * FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       ) ORDER BY created_at ASC`,
      [conversationId, n],
    );
    return rows;
  }

  async purgeOlderThan(cutoffMs: number): Promise<number> {
    const res = await this.db.run(
      "DELETE FROM messages WHERE created_at < ?",
      [cutoffMs],
    );
    return res.meta.changes ?? 0;
  }
}
