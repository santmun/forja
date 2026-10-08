import type { Env } from "./env";

export function getBufferMs(env: Env): number {
  return Math.max(1000, parseInt(env.BUFFER_SECONDS, 10) * 1000);
}

export function isPro(env: Env): boolean {
  return env.BOT_TIER === "pro";
}

// Tools reservadas al tier Pro. captureLead NO está aquí a propósito: el bot
// Starter (free) captura leads — es su valor central. Lo Pro son las tools más
// avanzadas por nicho (agendar citas, consultar catálogo/inventario).
export const PRO_ONLY_TOOLS = [
  "scheduleAppointment",
  "catalogQuery",
] as const;

// Tabs del dashboard reservadas al tier Pro (Análisis + growth). El tier free
// ve un panel funcional (Resumen, Conversaciones, Leads, Tickets, Flujo, KB,
// Conexiones, Config) pero sin el Analista IA, métricas, costos, mejoras ni
// campañas — esos desbloquean con la comunidad.
export const PRO_ONLY_TABS = ["insights", "stats", "costs", "mejoras", "campanas"] as const;

// Pestañas que una agencia puede quitar del panel del cliente (env HIDDEN_TABS).
// Resumen queda siempre: es la página a la que redirige una ruta oculta.
export const HIDEABLE_TABS = ["insights", "stats", "costs", "mejoras", "campanas"] as const;

/** Ids validados de HIDDEN_TABS. Un id desconocido se ignora. */
export function hiddenTabs(env?: { HIDDEN_TABS?: string } | null): string[] {
  const raw = env?.HIDDEN_TABS;
  if (!raw) return [];
  const allowed = HIDEABLE_TABS as readonly string[];
  return [...new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => allowed.includes(s)),
  )];
}

export function isToolAvailable(env: Env, toolName: string): boolean {
  if (!PRO_ONLY_TOOLS.includes(toolName as (typeof PRO_ONLY_TOOLS)[number])) return true;
  return isPro(env);
}
