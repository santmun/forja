import { businessTimeZone } from "./resolveDate";

/**
 * Zona del reloj que ve el modelo.
 * BOT_TIMEZONE gana (negocios que agendan sin Cal.com); si no, la zona de
 * Cal.com o la de member/config.
 */
export function anchorTimeZone(env: {
  BOT_TIMEZONE?: string;
  CALCOM_TIMEZONE?: string;
}): string {
  const bot = (env.BOT_TIMEZONE || "").trim();
  if (bot) return bot;
  return businessTimeZone(env);
}

/** Hora local HH:MM (24 h) en la zona dada. */
export function formatLocalTime(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  let hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (hour === "24") hour = "00";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * Fecha legible + ISO y la hora local. La frase "La hora actual es HH:MM"
 * va aparte: el modelo usa esa hora para saludos y reglas de anticipación.
 */
export function currentDateAnchor(timeZone: string, now: Date = new Date()): string {
  const legible = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hhmm = formatLocalTime(timeZone, now);
  return `${legible} (fecha ISO: ${iso}, zona horaria: ${timeZone}).\nLa hora actual es ${hhmm}`;
}
