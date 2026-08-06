import { memberConfig } from "../../member/config.local";

// El Worker corre con reloj de sistema en UTC, así que `toLocaleString` /
// `toLocaleDateString` SIN `timeZone` explícito renderizan cada fecha del panel
// en UTC — un miembro en America/Costa_Rica vería las horas 6h adelantadas.
// Este helper ancla TODAS las fechas del panel a la zona horaria del negocio,
// declarada en member/config.local.ts (el dato ya existía; el panel no lo usaba).
const BUSINESS_TZ = memberConfig.timezone || "America/Mexico_City";

/** Fecha + hora en la zona del negocio (reemplaza `new Date(x).toLocaleString("es-MX")`). */
export function fmtDateTime(
  ts: number | string | Date,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  return new Date(ts).toLocaleString("es-MX", { timeZone: BUSINESS_TZ, ...opts });
}

/** Solo fecha en la zona del negocio (reemplaza `new Date(x).toLocaleDateString("es-MX")`). */
export function fmtDate(
  ts: number | string | Date,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  return new Date(ts).toLocaleDateString("es-MX", { timeZone: BUSINESS_TZ, ...opts });
}
