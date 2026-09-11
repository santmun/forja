/**
 * Follow-up bot — un solo mensaje breve de seguimiento, SOLO a quien lo amerita.
 *
 * Selección (determinista, conservadora):
 *  • Su último mensaje fue hace entre 3 h (darle aire) y 20 h (la ventana de
 *    24 h de Meta/WhatsApp se mide desde el último mensaje del CLIENTE — se
 *    envía con margen antes de que cierre).
 *  • La conversación terminó con respuesta del bot (si terminó con el cliente
 *    hablando, eso es un pendiente del agente, no un follow-up).
 *  • Y es un lead que VALE el toque: venta abierta detectada por el Analista
 *    (sale_opportunity) o 4+ mensajes del cliente (engagement alto).
 *  • Nunca a conversaciones pausadas (takeover del dueño), nunca con un ticket
 *    humano abierto (open_ticket_id), nunca por el canal instagram oficial
 *    (apagado), y UNA sola vez por conversación de por vida (followup_sends
 *    es el claim). Cap por corrida y cap diario.
 *
 * El mensaje lo redacta el modelo rápido en la voz del bot (breve, no pushy),
 * se persiste como mensaje del asistente (visible en la Bandeja) y sale por el
 * adapter del canal. Corre en el cron frecuente de scheduled().
 */
import { generateText } from "ai";
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { ConversationsRepo } from "../db/conversations";
import { resolveAgentConfig, loadLlmOverrides } from "../settings-loader";
import { createModel } from "../llm/provider";
import { pickAdapter } from "../replies/sender";
import type { ChannelId } from "../channels/shared";

/** Ventana de elegibilidad medida desde el último mensaje del cliente. */
export const MIN_IDLE_MS = 3 * 60 * 60 * 1000; // 3 h
export const MAX_IDLE_MS = 20 * 60 * 60 * 1000; // 20 h (margen vs. las 24 h)

export type FollowupReason = "hot" | "active";

export interface FollowupCandidate {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  reason: FollowupReason;
}

interface CandidateRow {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  sale_opportunity: number | null;
  user_msgs: number;
}

/** Conversaciones que ameritan follow-up ahora mismo. */
export async function pickFollowupCandidates(
  env: Env,
  now: number,
  limit: number,
): Promise<FollowupCandidate[]> {
  const db = new Db(env.DB);
  const rows = await db.all<CandidateRow>(
    `SELECT * FROM (
       SELECT c.id, c.channel, c.channel_user_id, c.display_name,
         i.sale_opportunity,
         (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS last_user_at,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS user_msgs,
         (SELECT role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_role
       FROM conversations c
       LEFT JOIN conversation_insights i ON i.conversation_id = c.id
       LEFT JOIN followup_sends f ON f.conversation_id = c.id
       WHERE f.conversation_id IS NULL
         AND c.channel != 'instagram'
         AND c.open_ticket_id IS NULL
         AND (c.paused_until IS NULL OR c.paused_until < ?)
     )
     WHERE last_user_at IS NOT NULL
       AND last_user_at <= ? AND last_user_at >= ?
       AND last_role = 'assistant'
       AND (COALESCE(sale_opportunity, 0) = 1 OR user_msgs >= 4)
     ORDER BY COALESCE(sale_opportunity, 0) DESC, user_msgs DESC
     LIMIT ?`,
    [now, now - MIN_IDLE_MS, now - MAX_IDLE_MS, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    channel_user_id: r.channel_user_id,
    display_name: r.display_name,
    reason: (r.sale_opportunity ?? 0) === 1 ? "hot" : "active",
  }));
}

const REASON_HINT: Record<FollowupReason, string> = {
  hot: "El Analista detectó que quedó una venta o interés abierto sin cerrar.",
  active: "Hizo varias preguntas (interés alto) y luego dejó de responder.",
};

export interface RunFollowupsResult {
  sent: number;
  skipped: number;
  errors: number;
}

export async function runFollowups(
  env: Env,
  opts: { now?: number; limit?: number; dailyCap?: number } = {},
): Promise<RunFollowupsResult> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 6;
  const dailyCap = opts.dailyCap ?? 30;
  const db = new Db(env.DB);

  // Respeta la pausa global del bot (el dueño lo apagó a propósito).
  const cfg = await resolveAgentConfig(env, []);
  if (cfg.botPaused) return { sent: 0, skipped: 0, errors: 0 };

  // Cap diario global — el follow-up es un toque fino, no una campaña.
  const sentToday =
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) as n FROM followup_sends WHERE sent_at > ?",
        [now - 24 * 60 * 60 * 1000],
      )
    )?.n ?? 0;
  if (sentToday >= dailyCap) return { sent: 0, skipped: 0, errors: 0 };

  const candidates = await pickFollowupCandidates(
    env,
    now,
    Math.min(limit, dailyCap - sentToday),
  );
  if (candidates.length === 0) return { sent: 0, skipped: 0, errors: 0 };

  const msgs = new MessagesRepo(db);
  const convs = new ConversationsRepo(db);
  const { model, modelId } = createModel(env, "fast", await loadLlmOverrides(env));

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const cand of candidates) {
    // Claim ANTES de enviar: si otra corrida (o un tick concurrente) ya lo
    // tomó, INSERT OR IGNORE no escribe y saltamos — imposible duplicar.
    const claim = await db.run(
      "INSERT OR IGNORE INTO followup_sends (conversation_id, reason, sent_at) VALUES (?, ?, ?)",
      [cand.id, cand.reason, now],
    );
    if ((claim.meta.changes ?? 0) === 0) {
      skipped++;
      continue;
    }

    try {
      const history = await msgs.lastN(cand.id, 6);
      const transcript = history
        .map((m) => `${m.role === "user" ? "Cliente" : "Tú"}: ${m.content.slice(0, 300)}`)
        .join("\n");

      const result = await generateText({
        model,
        prompt: `Eres ${env.BOT_NAME}, respondiendo chats de ${env.BUSINESS_NAME} en primera persona: humano, breve, español mexicano casual, sin emojis, nunca pushy.

Este cliente mostró interés y luego dejó de responder. ${REASON_HINT[cand.reason]}
${cand.display_name ? `Se llama ${cand.display_name}.` : ""}

Últimos mensajes:
${transcript}

Escribe UN solo mensaje de seguimiento MUY breve (máximo 2 líneas): retoma con naturalidad lo último que hablaron y pregúntale si necesita ayuda o le quedó alguna duda. NO repitas links que ya le mandaste salvo que sea natural. Responde SOLO con el mensaje, sin comillas ni explicación.`,
      });

      const text = result.text.trim();
      if (!text) throw new Error("empty followup text");

      await msgs.append(cand.id, "assistant", text, { modelUsed: modelId });
      await convs.touchLastMessage(cand.id, now);

      const adapter = pickAdapter(cand.channel as ChannelId);
      await adapter.sendReply(
        {
          channel: cand.channel as ChannelId,
          channelUserId: cand.channel_user_id,
          chunks: [text],
          interChunkDelayMs: 0,
        },
        env,
      );
      sent++;
    } catch (e) {
      // El claim se queda (no reintentamos a este cliente): mejor un follow-up
      // perdido que un cliente recibiendo dos toques por errores transitorios.
      errors++;
      console.error(`[followup] failed for ${cand.id}:`, e);
    }
  }

  if (sent > 0) console.log(`[followup] sent=${sent} skipped=${skipped} errors=${errors}`);
  return { sent, skipped, errors };
}
