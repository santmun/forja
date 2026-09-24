/**
 * Respuesta cuando el LLM falló del todo (primario + retries + fallback).
 *
 * Antes era "Algo falló de mi lado, intenta de nuevo en un momento.": delataba
 * al bot y dejaba al cliente en seco, pidiéndole que él reintentara. Ahora
 * suena a persona y promete lo que sí pasa: el dueño recibe aviso en ese mismo
 * momento (agent.ts → notifyOwner) y contesta él.
 *
 * El watchdog cuenta los fallos por estos textos (y por el viejo, para que el
 * historial previo al cambio siga contando).
 */
export const LLM_FAILURE_REPLIES = {
  es: "Gracias por escribirnos. Te paso con una persona del equipo para ayudarte; te responde en breve por aquí.",
  en: "Thanks for reaching out. I'm passing you to someone on our team; they'll reply here shortly.",
} as const;

export const LLM_FAILURE_LEGACY_PREFIX = "Algo falló";

export function llmFailureReply(lang: string | undefined): string {
  return (lang ?? "").toLowerCase().startsWith("en") ? LLM_FAILURE_REPLIES.en : LLM_FAILURE_REPLIES.es;
}
