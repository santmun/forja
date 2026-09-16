import { addDays, todayInTz, weekdayName } from "./resolveDate";

const DEFAULT_DAYS = 14;

/**
 * Compact calendar of the next N civil days in `timeZone`.
 * The model reads weekday labels from this list instead of counting them.
 */
export function upcomingDaysCalendar(
  timeZone: string,
  opts?: { days?: number; now?: Date; locale?: string },
): string {
  const days = opts?.days ?? DEFAULT_DAYS;
  const locale = opts?.locale ?? "es";
  const today = todayInTz(timeZone, opts?.now ?? new Date());
  const items: string[] = [];
  for (let i = 0; i < days; i++) {
    const iso = addDays(today, i);
    const [, month, day] = iso.split("-");
    const weekday = shortWeekday(weekdayName(iso, locale), locale);
    const mon = shortMonth(Number(month), locale);
    items.push(`${weekday} ${Number(day)} ${mon}`);
  }
  const header =
    locale.startsWith("en")
      ? `Next ${days} days (read the weekday from this list, do not calculate it)`
      : `Próximos ${days} días (usa este calendario para el día de la semana, no lo calcules)`;
  return `${header}: ${items.join(" | ")}`;
}

function shortWeekday(name: string, locale: string): string {
  const folded = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (locale.startsWith("en")) {
    const en: Record<string, string> = {
      sunday: "sun",
      monday: "mon",
      tuesday: "tue",
      wednesday: "wed",
      thursday: "thu",
      friday: "fri",
      saturday: "sat",
    };
    return en[folded] ?? folded.slice(0, 3);
  }
  const es: Record<string, string> = {
    domingo: "dom",
    lunes: "lun",
    martes: "mar",
    miercoles: "mié",
    jueves: "jue",
    viernes: "vie",
    sabado: "sáb",
  };
  return es[folded] ?? folded.slice(0, 3);
}

function shortMonth(month: number, locale: string): string {
  const es = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
  const en = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const list = locale.startsWith("en") ? en : es;
  return list[month - 1] ?? String(month);
}
