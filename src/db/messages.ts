import { Db } from "./client";

export type MessageRole = "user" | "assistant" | "tool" | "owner";

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

/** Anthropic rejects empty text blocks; whitespace-only is equally poison. */
export function hasMessageText(content: string | null | undefined): boolean {
  return Boolean(content?.trim());
}

/** Drop blank rows before sending history to an LLM. */
export function usableHistory<T extends { content?: string | null }>(rows: T[]): T[] {
  return rows.filter((m) => hasMessageText(m.content));
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
