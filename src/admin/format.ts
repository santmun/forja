import { memberConfig } from "../../member/config.local";

// El Worker corre con reloj de sistema en UTC, así que `toLocaleString` /
// `toLocaleDateString` SIN `timeZone` explícito renderizan cada fecha del panel
// en UTC — en México (UTC−6) las horas salen 6 h adelantadas.
// La zona sale de BOT_TIMEZONE (wrangler) y, si no está, de member/config.local.ts.

const FALLBACK_TZ = "America/Mexico_City";

function isIanaTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Zona IANA del panel. BOT_TIMEZONE gana; si falta o es inválida, la del negocio. */
export function panelTimeZone(env?: { BOT_TIMEZONE?: string } | null): string {
  const fromEnv = (env?.BOT_TIMEZONE ?? "").trim();
  if (fromEnv && isIanaTimeZone(fromEnv)) return fromEnv;
  const fromMember = (memberConfig.timezone ?? "").trim();
  if (fromMember && isIanaTimeZone(fromMember)) return fromMember;
  return FALLBACK_TZ;
}

/** Fecha + hora en la zona del negocio (reemplaza `new Date(x).toLocaleString("es-MX")`). */
export function fmtDateTime(
  ts: number | string | Date,
  opts: Intl.DateTimeFormatOptions = {},
  env?: { BOT_TIMEZONE?: string } | null,
): string {
  const { timeZone: override, ...rest } = opts;
  const timeZone = (typeof override === "string" && override) || panelTimeZone(env);
  return new Date(ts).toLocaleString("es-MX", { ...rest, timeZone });
}

/** Solo fecha en la zona del negocio (reemplaza `new Date(x).toLocaleDateString("es-MX")`). */
export function fmtDate(
  ts: number | string | Date,
  opts: Intl.DateTimeFormatOptions = {},
  env?: { BOT_TIMEZONE?: string } | null,
): string {
  const { timeZone: override, ...rest } = opts;
  const timeZone = (typeof override === "string" && override) || panelTimeZone(env);
  return new Date(ts).toLocaleDateString("es-MX", { ...rest, timeZone });
}
