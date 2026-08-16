/**
 * Flywheel detectors (F5) — turn evidence into reviewable suggestions.
 *
 * Two v1 loops, both cheap (fast tier / Haiku) and idempotent (fingerprint
 * dedupe across any status, so a dismissed idea never comes back):
 *
 *  • KB gaps → `kb_entry`: questions the bot couldn't answer (insights
 *    missed_kb) become a DRAFTED knowledge-base entry ready to apply.
 *  • Owner takeovers → `leccion`: when the owner replied by hand, distill the
 *    operating rule the bot should follow next time.
 *
 * The system only PROPOSES — applying is the owner's click (see apply.ts).
 * Runs nightly from scheduled() and on demand from the Mejoras tab.
 */
import { generateText } from "ai";
import type { Env } from "../env";
import { Db } from "../db/client";
import { InsightsRepo } from "../db/insights";
import { esNotaInterna, sinMarcaNota, MessagesRepo } from "../db/messages";
import { SuggestionsRepo } from "../db/suggestions";
import { SettingsRepo, SETTING_KEYS } from "../db/settings";
import { createModel } from "../llm/provider";
import { loadLlmOverrides } from "../settings-loader";
import { renderBusinessContext } from "../businessContext";

export interface FlywheelResult {
  created: number;
  errors: number;
}

function extractJson<T>(raw: string): T | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** KB gaps → drafted kb_entry suggestions. */
export async function detectKbGaps(env: Env, limit = 3): Promise<FlywheelResult> {
  const db = new Db(env.DB);
  const insights = new InsightsRepo(db);
  const suggestions = new SuggestionsRepo(db);
  const thirtyDays = Date.now() - 30 * 86_400_000;

  const gaps = await insights.missedKb(thirtyDays, 10);
  const { model } = createModel(env, "fast", await loadLlmOverrides(env));
  let created = 0;
  let errors = 0;

  for (const gap of gaps) {
    if (created >= limit) break;
    if (await suggestions.exists("kb_entry", gap.question)) continue;

    try {
      const result = await generateText({
        model,
        prompt: `Eres el redactor de la base de conocimiento del negocio "${env.BUSINESS_NAME}".
Contexto del negocio:
${renderBusinessContext()}

Los clientes preguntaron esto y el bot NO supo responder:
"${gap.question}"

Redacta una entrada de base de conocimiento que la responda. Si el contexto del negocio no tiene el dato, escribe la entrada con el marcador [COMPLETA AQUÍ] donde falte información real.
Responde SOLO con JSON: {"title": "...", "content": "..."} (content: 2-6 frases en español, directas).`,
      });
      const draft = extractJson<{ title?: string; content?: string }>(result.text);
      if (!draft?.content) {
        errors++;
        continue;
      }
      const id = await suggestions.createIfNew({
        kind: "kb_entry",
        fingerprint: gap.question,
        title: draft.title?.trim() || gap.question,
        payload: { question: gap.question, title: draft.title ?? gap.question, content: draft.content },
        evidence: `${gap.n} ${gap.n === 1 ? "cliente preguntó" : "clientes preguntaron"} esto y el bot no supo responder.`,
      });
      if (id) created++;
    } catch (e) {
      errors++;
      console.error(`[flywheel] kb gap draft failed for "${gap.question}":`, e);
    }
  }
  return { created, errors };
}

/** Owner takeovers → leccion suggestions (one per conversation). */
export async function detectLessons(env: Env, limit = 3): Promise<FlywheelResult> {
  const db = new Db(env.DB);
  const msgs = new MessagesRepo(db);
  const suggestions = new SuggestionsRepo(db);
  const sevenDays = Date.now() - 7 * 86_400_000;

  const convs = await db.all<{ conversation_id: string; display_name: string | null }>(
    `SELECT DISTINCT m.conversation_id, c.display_name
     FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
     WHERE m.role = 'owner' AND m.created_at > ?
     ORDER BY m.created_at DESC LIMIT 10`,
    [sevenDays],
  );

  const { model } = createModel(env, "fast", await loadLlmOverrides(env));
  let created = 0;
  let errors = 0;

  for (const conv of convs) {
    if (created >= limit) break;
    // One lesson per conversation, ever (fingerprint = conversation id).
    if (await suggestions.exists("leccion", conv.conversation_id)) continue;

    try {
      const history = await msgs.lastN(conv.conversation_id, 30);
      const transcript = history
        .map((m) =>
          m.role === "owner" && esNotaInterna(m.content)
            ? `Nota interna (el cliente NO la vio): ${sinMarcaNota(m.content).slice(0, 400)}`
            : `${m.role === "user" ? "Cliente" : m.role === "owner" ? "Dueño" : "Bot"}: ${m.content.slice(0, 400)}`,
        )
        .join("\n");

      const result = await generateText({
        model,
        prompt: `En esta conversación el DUEÑO del negocio tuvo que intervenir a mano.
Compara cómo respondía el bot vs. cómo respondió el dueño.

${transcript}

¿Qué regla operativa CORTA (máx 140 caracteres, en español, imperativa) debería seguir el bot la próxima vez para que el dueño no tenga que intervenir? Debe ser una regla general, no específica de este cliente.
Si no hay una lección clara y generalizable, responde {"lesson": null}.
Responde SOLO con JSON: {"lesson": "..." | null}`,
      });
      const parsed = extractJson<{ lesson?: string | null }>(result.text);
      const lesson = parsed?.lesson?.trim();
      if (!lesson) continue;

      const id = await suggestions.createIfNew({
        kind: "leccion",
        fingerprint: conv.conversation_id,
        title: lesson.slice(0, 140),
        payload: { lesson: lesson.slice(0, 140), conversationId: conv.conversation_id },
        evidence: `De tu intervención en la conversación con ${conv.display_name ?? conv.conversation_id}.`,
      });
      if (id) created++;
    } catch (e) {
      errors++;
      console.error(`[flywheel] lesson distill failed for ${conv.conversation_id}:`, e);
    }
  }
  return { created, errors };
}

/** Run all detectors. Safe to call repeatedly (dedupe) and from cron. */
export async function runFlywheel(env: Env): Promise<FlywheelResult> {
  const kb = await detectKbGaps(env).catch((e): FlywheelResult => {
    console.error("[flywheel] detectKbGaps crashed:", e);
    return { created: 0, errors: 1 };
  });
  const lessons = await detectLessons(env).catch((e): FlywheelResult => {
    console.error("[flywheel] detectLessons crashed:", e);
    return { created: 0, errors: 1 };
  });
  return { created: kb.created + lessons.created, errors: kb.errors + lessons.errors };
}

// --- Lessons setting helpers (shared with apply.ts and the view) ---------------

export const MAX_LESSONS = 15;

export async function getLessons(env: Env): Promise<string[]> {
  try {
    const raw = (await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.learnedLessons)) ?? "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l === "string") : [];
  } catch {
    return [];
  }
}

export async function saveLessons(env: Env, lessons: string[]): Promise<void> {
  await new SettingsRepo(new Db(env.DB)).set(
    SETTING_KEYS.learnedLessons,
    JSON.stringify(lessons.slice(-MAX_LESSONS)),
  );
}
