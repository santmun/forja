import { memberConfig } from "../../member/config.local";

export const DEFAULT_TZ = "America/Mexico_City";

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  domingo: 0,
  monday: 1,
  lunes: 1,
  tuesday: 2,
  martes: 2,
  wednesday: 3,
  miercoles: 3,
  thursday: 4,
  jueves: 4,
  friday: 5,
  viernes: 5,
  saturday: 6,
  sabado: 6,
};

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  enero: 1,
  february: 2,
  febrero: 2,
  march: 3,
  marzo: 3,
  april: 4,
  abril: 4,
  may: 5,
  mayo: 5,
  june: 6,
  junio: 6,
  july: 7,
  julio: 7,
  august: 8,
  agosto: 8,
  september: 9,
  septiembre: 9,
  setiembre: 9,
  october: 10,
  octubre: 10,
  november: 11,
  noviembre: 11,
  december: 12,
  diciembre: 12,
};

const WEEKDAY_RE = new RegExp(`\\b(${Object.keys(WEEKDAY_INDEX).join("|")})\\b`, "g");
const MONTH_RE = Object.keys(MONTH_INDEX).join("|");

export type ResolvedDateSource = "relative" | "weekday" | "day_month" | "iso";

export type ResolveDateResult =
  | { ok: true; date: string; weekday: string; source: ResolvedDateSource }
  | { ok: false; error: "unresolved_date" | "invalid_date" };

/**
 * Zona del negocio para "hoy" / citas.
 * CALCOM_TIMEZONE gana (el calendario); si no, member/config.local.ts.
 */
export function businessTimeZone(env: { CALCOM_TIMEZONE?: string }): string {
  return (env.CALCOM_TIMEZONE || "").trim() || memberConfig.timezone || DEFAULT_TZ;
}

/** YYYY-MM-DD de `now` en la zona dada (en-CA formatea ISO). */
export function todayInTz(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isValidIsoDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function weekdayName(iso: string, locale = "es"): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .toLowerCase();
}

/** Suma días a una fecha civil YYYY-MM-DD (sin pasar por zona horaria local). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOfIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nextWeekday(todayIso: string, targetDow: number, skipToday: boolean): string {
  const delta0 = (targetDow - weekdayOfIso(todayIso) + 7) % 7;
  const delta = delta0 === 0 && skipToday ? 7 : delta0;
  return addDays(todayIso, delta);
}

function fold(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Quita hora y "por la mañana" para no confundir "mañana" (tomorrow) con daypart. */
function stripClockAndDaypart(s: string): string {
  return s
    .replace(/\b(esta|este) (manana|tarde|noche)\b/g, " ")
    .replace(/\bthis (morning|afternoon|evening|night)\b/g, " ")
    .replace(/\b(por|en|a) la (manana|tarde|noche)\b/g, " ")
    .replace(/\b(in the|at) (morning|afternoon|evening|night)\b/g, " ")
    .replace(/\ba las \d{1,2}(?::\d{2})?\b/g, " ")
    .replace(/\bat \d{1,2}(?::\d{2})?\s*(am|pm)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findWeekday(s: string): number | null {
  WEEKDAY_RE.lastIndex = 0;
  const m = WEEKDAY_RE.exec(s);
  return m ? WEEKDAY_INDEX[m[1]] : null;
}

function isProximo(s: string): boolean {
  return /\b(proxim[oa]s?|siguiente|next)\b/.test(s);
}

function findRelativeOffset(s: string): number | null {
  if (/\bpasado manana\b/.test(s) || /\bday after tomorrow\b/.test(s)) return 2;
  if (/\bmanana\b/.test(s) || /\btomorrow\b/.test(s)) return 1;
  if (/\bhoy\b/.test(s) || /\btoday\b/.test(s)) return 0;
  return null;
}

function findDayMonth(s: string, todayIso: string): string | null {
  const dayMonth = s.match(new RegExp(`\\b(?:el )?(?:dia )?(\\d{1,2}) de (${MONTH_RE})(?: de (\\d{4}))?\\b`));
  if (dayMonth) {
    return civilFromDayMonth(todayIso, Number(dayMonth[1]), MONTH_INDEX[dayMonth[2]], dayMonth[3] ? Number(dayMonth[3]) : undefined);
  }
  const monthDay = s.match(new RegExp(`\\b(${MONTH_RE}) (\\d{1,2})(?: ,)? (\\d{4})?\\b`));
  if (monthDay) {
    return civilFromDayMonth(todayIso, Number(monthDay[2]), MONTH_INDEX[monthDay[1]], monthDay[3] ? Number(monthDay[3]) : undefined);
  }
  return null;
}

function civilFromDayMonth(todayIso: string, day: number, month: number, year?: number): string | null {
  const [ty] = todayIso.split("-").map(Number);
  const y = year ?? ty;
  const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isValidIsoDate(iso)) return null;
  if (year == null && iso < todayIso) {
    const next = `${y + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return isValidIsoDate(next) ? next : null;
  }
  return iso;
}

function findIso(s: string): string | null {
  const m = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m?.[1] ?? null;
}

function ok(date: string, source: ResolvedDateSource, locale: string): ResolveDateResult {
  if (!isValidIsoDate(date)) return { ok: false, error: "invalid_date" };
  return { ok: true, date, weekday: weekdayName(date, locale), source };
}

/**
 * Resuelve una fecha que dijo el cliente (palabras o YYYY-MM-DD) contra "hoy"
 * en `timeZone`. Si el texto trae un día de la semana (o "próximo martes")
 * junto a un YYYY-MM-DD, gana el día de la semana: un ISO mal contado por el
 * modelo no pisa el resolvedor.
 */
export function resolveDateInput(
  input: string,
  opts: { timeZone: string; now?: Date; locale?: string },
): ResolveDateResult {
  const locale = opts.locale ?? "es";
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "unresolved_date" };

  const today = todayInTz(opts.timeZone, opts.now ?? new Date());
  const folded = fold(raw);
  const stripped = stripClockAndDaypart(folded);

  const weekday = findWeekday(stripped);
  const relative = findRelativeOffset(stripped);
  const dayMonth = findDayMonth(stripped, today);
  const iso = findIso(stripped);

  if (weekday != null) {
    const fromWeekday = nextWeekday(today, weekday, isProximo(stripped));
    const numeric = dayMonth ?? (iso && isValidIsoDate(iso) ? iso : null);
    if (numeric && weekdayOfIso(numeric) !== weekday) {
      return ok(fromWeekday, "weekday", locale);
    }
    if (numeric) return ok(numeric, dayMonth ? "day_month" : "iso", locale);
    return ok(fromWeekday, "weekday", locale);
  }

  if (relative != null) return ok(addDays(today, relative), "relative", locale);
  if (dayMonth) return ok(dayMonth, "day_month", locale);

  if (iso) return isValidIsoDate(iso) ? ok(iso, "iso", locale) : { ok: false, error: "invalid_date" };

  return { ok: false, error: "unresolved_date" };
}

/** Si `start` es ISO datetime, sustituye solo la fecha civil (conserva hora/offset). */
export function applyResolvedDate(start: string, resolvedDate: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(start)) return resolvedDate + start.slice(10);
  return start;
}
