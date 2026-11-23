// Guardrail anti-spam determinístico — corre ANTES del LLM, así el spam no
// cuesta ni un token. Si el mensaje entrante es idéntico (normalizado) a 2+ de
// los últimos 5 mensajes del usuario (es decir, va por la 3ª vez), la
// conversación se manda "a descansar": paused_until = ahora + 1 hora y el bot
// la ignora por completo. El caso abusivo-pero-variado (insultos, bots que
// varían el texto) lo cubre la tool snoozeUser, que decide el LLM.
import { Db } from "./db/client";
import { isMediaFailurePlaceholder } from "./media/placeholders";

export const SPAM_SNOOZE_MS = 60 * 60_000;

const SPAM_LOOKBACK = 5;
// El entrante + 2 iguales previos = 3ª repetición → cooldown.
const SPAM_REPEATS = 2;

/** "  ¡HOLA!! " → "¡hola!!" no — quita acentos/espacios extra y baja a minúsculas. */
export function normalizeForSpam(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function isRepeatSpam(
  db: Db,
  conversationId: string,
  text: string,
): Promise<boolean> {
  // Un audio que no se pudo transcribir deja el mismo placeholder cada vez.
  // No es spam ni un bot: es nuestro fallo de descarga.
  if (isMediaFailurePlaceholder(text)) return false;
  const norm = normalizeForSpam(text);
  if (norm.length < 2) return false; // "ok"/"sí" sueltos no cuentan como spam
  const rows = await db.all<{ content: string }>(
    `SELECT content FROM messages
     WHERE conversation_id = ? AND role = 'user'
     ORDER BY created_at DESC LIMIT ?`,
    [conversationId, SPAM_LOOKBACK],
  );
  const same = rows.filter((r) => normalizeForSpam(r.content) === norm).length;
  return same >= SPAM_REPEATS;
}

// ── Tope diario de turnos (backstop anti "ChatGPT gratis") ──────────────────
// El caso fino (preguntas fuera de tema) lo decide el LLM con snoozeUser; este
// tope es el respaldo determinístico de costos: nadie legítimo cruza 50 turnos
// de usuario en 24h (cada turno ya viene agrupado por el buffer). Al cruzarlo,
// UNA despedida amable y la conversación descansa 12 horas.

export const DAILY_TURN_CAP = 50;
export const DAILY_CAP_SNOOZE_MS = 12 * 3600_000;
export const DAILY_CAP_MESSAGE =
  "¡Gracias por escribir tanto! Por hoy ya te acompañé un buen rato; si necesitas algo más, con gusto seguimos mañana. 🙌";

export async function isOverDailyCap(
  db: Db,
  conversationId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) as n FROM messages
     WHERE conversation_id = ? AND role = 'user' AND created_at > ?`,
    [conversationId, now - 24 * 3600_000],
  );
  return (row?.n ?? 0) >= DAILY_TURN_CAP;
}
