import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { ConversationsRepo } from "../db/conversations";
import { isMediaFailurePlaceholder } from "../media/placeholders";

// Corta un loop bot-a-bot: el LLM concluye que del otro lado hay una cuenta
// AUTOMATIZADA (no una persona) y pausa la conversación para no quemar tokens
// respondiéndole a otro bot. Complementa snoozeUser (abuso/off-topic) y el
// filtro determinístico de src/spam.ts (texto repetido).
export const SUSPECTED_BOT_PAUSE_MS = 24 * 60 * 60_000; // 24 h

const LOOKBACK = 5;

/**
 * El último mensaje del cliente es un fallo nuestro (audio/foto que no se
 * pudo bajar). No es evidencia de bot: 3 notas de voz seguidas dejan el mismo
 * placeholder y el modelo lo confunde con un loop.
 */
export async function latestUserMessageIsMediaFailure(env: Env, conversationId: string): Promise<boolean> {
  const rows = await new Db(env.DB).all<{ content: string }>(
    `SELECT content FROM messages
     WHERE conversation_id = ? AND role = 'user'
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [conversationId, LOOKBACK],
  );
  const latest = rows[0]?.content;
  return !!latest && isMediaFailurePlaceholder(latest);
}

export function pauseSuspectedBotTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Pausa ESTA conversación 24h cuando concluyas que del otro lado hay un BOT o cuenta AUTOMATIZADA, no una persona real. Es para cortar un loop bot-a-bot que solo quema dinero. Úsala SOLO si ves VARIAS de estas señales JUNTAS: (1) responde al instante, siempre, sin las pausas naturales de un humano que lee y escribe; (2) sus mensajes son genéricos o hacen eco / repiten / reformulan lo que TÚ acabas de decir; (3) la conversación gira en círculos y no avanza a NADA concreto (no pregunta precios reales, no da datos suyos, no agenda, no dice qué necesita); (4) contesta a todo de forma afirmativa/robótica o con preguntas vacías que solo mantienen el ping-pong; (5) llevan muchos turnos sin la menor intención de compra ni información real. Después de llamarla NO mandes ningún mensaje (es un bot, no lo leería y solo alimenta el loop). " +
      "NO la uses si los mensajes del cliente son el aviso de que no se pudo oír un audio o ver una foto — el texto '(no pude entender el audio)' u otro placeholder de fallo de media. Eso es un fallo nuestro al descargar el archivo, no un bot, aunque se repita idéntico. " +
      "NO la uses con una persona real aunque: escriba mucho o muy seguido, esté emocionada, haga muchas preguntas, escriba con errores o raro, o sea insistente/necia. Los humanos reales preguntan cosas ESPECÍFICAS, dan datos propios (su nombre, qué venden, su caso, su ciudad), reaccionan con emoción y TARDAN en responder. Ante la MÍNIMA duda, NO la uses y sigue atendiendo normal: es mucho peor perder un cliente real que gastar unos mensajes de más. Para insultos/abuso o 'ChatGPT gratis' usa snoozeUser; para pasar a un humano usa handoffHuman.",
    inputSchema: z.object({
      reason: z
        .string()
        .describe(
          "Las señales de bot que observaste, en 1 frase (ej. 'respuestas instantáneas + hace eco de mis mensajes + 15 turnos sin dar ningún dato real')",
        ),
    }),
    execute: async ({ reason }) => {
      const convId = getConversationId();
      if (!convId) return { error: "no_conversation" as const };
      try {
        if (await latestUserMessageIsMediaFailure(env, convId)) {
          console.warn(
            `[pauseSuspectedBot] conv ${convId} no se pausa: el último mensaje es un fallo de audio/foto`,
          );
          return { skipped: "media_failure_placeholder" as const };
        }
      } catch (e) {
        console.warn("[pauseSuspectedBot] no pude leer el historial:", e);
        return { skipped: "history_unavailable" as const };
      }
      const convs = new ConversationsRepo(new Db(env.DB));
      const until = Date.now() + SUSPECTED_BOT_PAUSE_MS;
      await convs.setPausedUntil(convId, until);
      console.warn(`[pauseSuspectedBot] conv ${convId} pausada 24h — bot detectado: ${reason}`);
      return { pausedUntil: until, reason };
    },
  });
}
