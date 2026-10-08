/**
 * Blindaje anti-invento — verificador pre-envío (Pro).
 *
 * Antes de mandar una respuesta que afirma datos del negocio, se contrasta
 * contra las fuentes del turno: KB, contexto, custom_instructions y las tools
 * que se llamaron. Sin respaldo → frase de espera + ticket. FAIL-OPEN: si el
 * modelo del verificador truena o no llega, sale la respuesta original.
 *
 * Modo `negaciones` (BLINDAJE_MODE): solo entra cuando la respuesta niega que
 * el negocio ofrezca algo. Los datos positivos se aceptan si están en alguna
 * fuente — incluidas las instrucciones del dueño y las tools del turno. Un
 * dato positivo que no está en ninguna sigue bloqueado. Una negación sola
 * (sin dato positivo) la juzga el modelo: la ausencia no prueba que no se venda.
 */
import type { Env } from "../env";
import { isPro } from "../config";
import type { LlmOverrides } from "../llm/provider";
import type { SearchKbResult } from "../tools/searchKb";
import { Db } from "../db/client";
import { SettingsRepo, SETTING_KEYS } from "../db/settings";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { notifyOwner } from "../tools/handoffHuman";
import {
  DENIAL_CLAUSE,
  decideNegaciones,
  firstUngroundedFact,
  sourceCorpus,
  type ToolResultSource,
} from "./sources";

/** Tope duro del verificador: si el modelo no contesta a tiempo, fail-open. */
export const VERIFY_TIMEOUT_MS = 4000;

const CLAIM_PATTERN =
  /[0-9$€£%]|\bpesos?\b|\bd[oó]lares?\b|\bmxn\b|\busd\b|\bgratis\b|\bfree\b|\bcancel|\breagend|\brescheduled?\b/i;

export const DENIAL_PATTERN = DENIAL_CLAUSE;

export type BlindajeMode = "off" | "negaciones" | "full";

export function blindajeMode(env: Env): BlindajeMode {
  const v = (env.BLINDAJE_MODE ?? "").trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "negaciones" || v === "negations") return "negaciones";
  return "full";
}

export function shouldVerify(replyText: string, turnUsedKb: boolean): boolean {
  if (turnUsedKb) return true;
  return CLAIM_PATTERN.test(replyText) || DENIAL_PATTERN.test(replyText);
}

const SAFE_REPLY_BY_LANG: Record<string, string> = {
  "es-419":
    "Esa me la confirma el equipo — dame un momento y te digo bien, para no darte un dato equivocado.",
  "es-ES":
    "Eso me lo confirma el equipo — dame un momento y te digo seguro, para no darte un dato equivocado.",
  en: "Let me double-check that with the team so I don't give you the wrong info — I'll get back to you in a moment.",
  "pt-BR": "Deixa eu confirmar isso com a equipe para não te passar um dado errado — já te retorno.",
};

const SAFE_REPLY_WEB_BY_LANG: Record<string, string> = {
  "es-419":
    "Esa me la confirma el equipo. Para avisarte en cuanto la tenga, ¿me dejas tu correo o WhatsApp? Así no se te pierde la respuesta.",
  "es-ES":
    "Eso me lo confirma el equipo. Para avisarte en cuanto lo tenga, ¿me dejas tu correo o WhatsApp? Así no se te pierde la respuesta.",
  en: "Let me double-check that with the team. So I can get back to you, could you leave your email or WhatsApp? That way you won't miss the answer.",
  "pt-BR":
    "Deixa eu confirmar isso com a equipe. Para te avisar assim que tiver, você me deixa seu e-mail ou WhatsApp? Assim você não perde a resposta.",
};

/**
 * Frase de espera. `BLINDAJE_HOLDING_PHRASE` (var del worker) la reemplaza
 * entera si el dueño quiere otro tono — la de es-419 en web pide un contacto
 * que en WhatsApp ya se tiene.
 */
export function safeConfirmReply(lang: string | undefined, channel?: string, override?: string): string {
  const custom = override?.trim();
  if (custom) return custom;
  const table = channel === "web" ? SAFE_REPLY_WEB_BY_LANG : SAFE_REPLY_BY_LANG;
  const v = (lang ?? "").trim().toLowerCase();
  if (v === "es-es" || v === "es_es") return table["es-ES"];
  if (v.startsWith("pt")) return table["pt-BR"];
  if (v.startsWith("en")) return table.en;
  return table["es-419"];
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[blindaje] verify timeout tras ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifyVerdict {
  supported: boolean;
  unsupported_claim?: string;
}

export interface VerifyOptions {
  llm?: LlmOverrides;
  timeoutMs?: number;
  systemPrompt?: string;
  customInstructions?: string;
  toolResults?: ToolResultSource[];
  /** En modo negaciones el modelo solo ve negaciones puras (sin dato positivo). */
  negationsOnly?: boolean;
}

export async function verifyReply(
  env: Env,
  replyText: string,
  kbPassages: SearchKbResult[],
  businessContext: string,
  opts: VerifyOptions = {},
): Promise<VerifyVerdict> {
  const { createModel } = await import("../llm/provider");
  const { generateText } = await import("ai");
  const { model } = createModel(env, "fast", opts.llm ?? {});

  const passagesBlock =
    kbPassages.length > 0
      ? kbPassages
          .map((p, i) => `[${i + 1}] ${p.title ? `${p.title} — ` : ""}${p.content.slice(0, 1500)}`)
          .join("\n")
      : "(no se consultó la base de conocimiento este turno)";

  const toolResultsBlock =
    (opts.toolResults?.length ?? 0) > 0
      ? opts.toolResults!.map((t, i) => `[T${i + 1}] tool ${t.tool}: ${t.output.slice(0, 8000)}`).join("\n")
      : "(no se llamaron otras herramientas este turno)";

  const custom = (opts.customInstructions ?? "").trim();
  const scopeRule = opts.negationsOnly
    ? `\nEsta respuesta NIEGA que el negocio ofrezca algo y no trae otro dato positivo. supported=false si ninguna fuente dice EXPLÍCITAMENTE que no se ofrece. Que las fuentes no lo mencionen NO respalda la negación.\n`
    : "";

  const result = await withTimeout(
    generateText({
      model,
      prompt: `Eres un verificador de datos para el bot de atención de ${env.BUSINESS_NAME}.
Tu ÚNICO trabajo: decidir si lo que la respuesta dice sobre el negocio está respaldado por las fuentes. Juzgas la VERDAD de los datos, no el estilo.
${scopeRule}
Reglas:
- Saludos, cortesía y preguntas al cliente no son afirmaciones.
- Un dato positivo (precio, horario, promo, regalo, política) está respaldado si APARECE en cualquiera de las fuentes, aunque sea parafraseado. Cambiar un número no está respaldado.
- <custom_instructions> son hechos que escribió el dueño. Cuentan IGUAL que la KB y que las tools. No son "solo estilo": si ahí dice que la promoción incluye un regalo, esa promo está respaldada aunque la KB no la mencione.
- Los RESULTADOS DE HERRAMIENTAS de este turno son fuente oficial. Un dato que devolvió una tool no es invención.
- Una NEGACIÓN ("no vendemos X", "no ofrecemos eso") solo está respaldada si una fuente lo dice explícitamente. La ausencia no alcanza.
- Si no hay ningún dato ni ninguna negación, supported=true.

FUENTES (todas cuentan igual):
<contexto_negocio>
${businessContext || "(vacío)"}
</contexto_negocio>
<custom_instructions>
${custom || "(sin instrucciones del dueño)"}
</custom_instructions>
<instrucciones_oficiales_del_bot>
${(opts.systemPrompt ?? "").slice(0, 24000) || "(sin instrucciones)"}
</instrucciones_oficiales_del_bot>
<pasajes_kb>
${passagesBlock}
</pasajes_kb>
<resultados_de_herramientas>
${toolResultsBlock}
</resultados_de_herramientas>

RESPUESTA DEL BOT A VERIFICAR:
<respuesta>
${replyText}
</respuesta>

Responde SOLO con JSON válido, sin markdown ni explicación:
{"supported": true|false, "unsupported_claim": "la afirmación exacta sin respaldo (solo si supported=false)"}`,
    }),
    opts.timeoutMs ?? VERIFY_TIMEOUT_MS,
  );

  const raw = (result.text ?? "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`[blindaje] el verificador no devolvió JSON: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  if (typeof parsed.supported !== "boolean") {
    throw new Error("[blindaje] veredicto sin campo booleano 'supported'");
  }
  return {
    supported: parsed.supported,
    unsupported_claim:
      typeof parsed.unsupported_claim === "string" && parsed.unsupported_claim.trim() !== ""
        ? parsed.unsupported_claim
        : undefined,
  };
}

async function bumpCounter(env: Env, key: string): Promise<void> {
  try {
    const repo = new SettingsRepo(new Db(env.DB));
    const current = parseInt((await repo.get(key)) ?? "0", 10) || 0;
    await repo.set(key, String(current + 1));
  } catch {
    /* contador es cosmético */
  }
}

export type GuardAction =
  | "skipped-free"
  | "skipped-mode-off"
  | "skipped-no-claims"
  | "sent-original"
  | "replaced"
  | "fail-open";

export interface GuardOptions {
  replyText: string;
  turnUsedKb: boolean;
  kbPassages: SearchKbResult[];
  toolResults?: ToolResultSource[];
  businessContext?: string;
  systemPrompt?: string;
  /** Setting custom_instructions, aparte del system prompt (sobrevive al override manual y al corte de 24k). */
  customInstructions?: string;
  mode?: BlindajeMode;
  conversationId: string | null;
  channel?: string;
  llm?: LlmOverrides;
  timeoutMs?: number;
}

export interface GuardResult {
  finalText: string;
  action: GuardAction;
  unsupportedClaim?: string;
}

async function replaceWithTicket(
  env: Env,
  opts: GuardOptions,
  claim: string,
): Promise<GuardResult> {
  try {
    const db = new Db(env.DB);
    const ticketId = await new TicketsRepo(db).create({
      conversationId: opts.conversationId,
      category: "other",
      summary: `[dato sin respaldo] El bot iba a decirle al cliente algo que tu información no respalda: "${claim.slice(0, 200)}". Se le dijo que lo confirmas tú.`,
      transcript: "",
    });
    if (opts.conversationId) {
      await new ConversationsRepo(db).setOpenTicket(opts.conversationId, ticketId);
    }
    await notifyOwner(env, {
      reason: "dato sin respaldo",
      summary: claim.slice(0, 200),
      ticketId,
    });
  } catch (e) {
    console.error("[blindaje] no se pudo crear el ticket/aviso:", e);
  }
  await bumpCounter(env, SETTING_KEYS.blindajeBlocked);
  const holding = safeConfirmReply(env.BOT_LANGUAGE, opts.channel, env.BLINDAJE_HOLDING_PHRASE);
  return { finalText: holding, action: "replaced", unsupportedClaim: claim.slice(0, 200) };
}

export async function guardReply(env: Env, opts: GuardOptions): Promise<GuardResult> {
  const original = opts.replyText;
  if (!isPro(env)) return { finalText: original, action: "skipped-free" };

  const mode = opts.mode ?? blindajeMode(env);
  if (mode === "off") return { finalText: original, action: "skipped-mode-off" };

  const corpus = sourceCorpus({
    kbPassages: opts.kbPassages,
    businessContext: opts.businessContext,
    customInstructions: opts.customInstructions,
    systemPrompt: opts.systemPrompt,
    toolResults: opts.toolResults,
  });

  let negationsOnly = false;
  if (mode === "negaciones") {
    if (!DENIAL_PATTERN.test(original)) {
      return { finalText: original, action: "skipped-no-claims" };
    }
    const decision = decideNegaciones(original, corpus);
    if (decision === "deliver") {
      return { finalText: original, action: "sent-original" };
    }
    if (decision === "block") {
      await bumpCounter(env, SETTING_KEYS.blindajeChecks);
      const claim = firstUngroundedFact(original, corpus) ?? original;
      return replaceWithTicket(env, opts, claim);
    }
    negationsOnly = true;
  } else if (!shouldVerify(original, opts.turnUsedKb)) {
    return { finalText: original, action: "skipped-no-claims" };
  }

  let verdict: VerifyVerdict;
  try {
    verdict = await verifyReply(env, original, opts.kbPassages, opts.businessContext ?? "", {
      llm: opts.llm,
      timeoutMs: opts.timeoutMs,
      systemPrompt: opts.systemPrompt,
      customInstructions: opts.customInstructions,
      toolResults: opts.toolResults,
      negationsOnly,
    });
  } catch (e) {
    console.warn("[blindaje] verificador falló — fail-open, va la respuesta original:", e);
    return { finalText: original, action: "fail-open" };
  }

  await bumpCounter(env, SETTING_KEYS.blindajeChecks);
  if (verdict.supported) return { finalText: original, action: "sent-original" };

  // El modelo marcó la respuesta, pero cada dato positivo sí está en las
  // fuentes. No se tira la respuesta por un hecho que el dueño escribió o que
  // una tool devolvió. Una negación sola (sin dato positivo) no se rescata.
  if (decideNegaciones(original, corpus) === "deliver") {
    return { finalText: original, action: "sent-original" };
  }

  const claim = verdict.unsupported_claim ?? original;
  return replaceWithTicket(env, opts, claim);
}
