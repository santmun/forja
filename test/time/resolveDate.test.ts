import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyResolvedDate,
  businessTimeZone,
  resolveDateInput,
  todayInTz,
  weekdayName,
} from "../../src/time/resolveDate";

const MADRID = "Europe/Madrid";
const MEXICO = "America/Mexico_City";
/** Jueves 27 ago 2026, 17:00 en Madrid / 09:00 en Ciudad de México. */
const THU_27_AUG = new Date("2026-08-27T15:00:00.000Z");

function resolve(input: string, timeZone = MADRID, now = THU_27_AUG) {
  return resolveDateInput(input, { timeZone, now, locale: "es" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveDateInput — Europe/Madrid, jueves 2026-08-27", () => {
  it("el próximo martes → 2026-09-01 martes (no el miércoles 2)", () => {
    const r = resolve("el próximo martes a las 10");
    expect(r).toEqual({
      ok: true,
      date: "2026-09-01",
      weekday: "martes",
      source: "weekday",
    });
    expect(weekdayName("2026-09-01")).toBe("martes");
    expect(weekdayName("2026-09-02")).toBe("miércoles");
  });

  it("el viernes → 2026-08-28 viernes", () => {
    const r = resolve("el viernes");
    expect(r).toMatchObject({ ok: true, date: "2026-08-28", weekday: "viernes", source: "weekday" });
  });

  it("un YYYY-MM-DD mal contado no gana si el texto trae el día de la semana", () => {
    const r = resolve("el próximo martes 2026-09-02");
    expect(r).toMatchObject({ ok: true, date: "2026-09-01", weekday: "martes", source: "weekday" });
  });

  it("martes 2 de septiembre (el 2 es miércoles) → gana el martes", () => {
    const r = resolve("martes 2 de septiembre");
    expect(r).toMatchObject({ ok: true, date: "2026-09-01", weekday: "martes", source: "weekday" });
  });

  it("hoy / mañana / pasado mañana", () => {
    expect(resolve("hoy")).toMatchObject({ ok: true, date: "2026-08-27", source: "relative" });
    expect(resolve("mañana")).toMatchObject({ ok: true, date: "2026-08-28", source: "relative" });
    expect(resolve("pasado mañana")).toMatchObject({ ok: true, date: "2026-08-29", source: "relative" });
  });

  it("por la mañana no se confunde con mañana (tomorrow)", () => {
    const r = resolve("el martes por la mañana");
    expect(r).toMatchObject({ ok: true, date: "2026-09-01", weekday: "martes", source: "weekday" });
  });

  it("ISO puro (sin palabras) se acepta tal cual", () => {
    const r = resolve("2026-09-02");
    expect(r).toMatchObject({ ok: true, date: "2026-09-02", weekday: "miércoles", source: "iso" });
  });

  it("el 2 de septiembre (sin día de semana) → 2026-09-02", () => {
    const r = resolve("el 2 de septiembre");
    expect(r).toMatchObject({ ok: true, date: "2026-09-02", source: "day_month" });
  });

  it("next Tuesday en inglés", () => {
    const r = resolve("next Tuesday at 10");
    expect(r).toMatchObject({ ok: true, date: "2026-09-01", weekday: "martes", source: "weekday" });
  });

  it("el martes (hoy no es martes) = el próximo que cae; el próximo X en X salta una semana", () => {
    const tuesday = new Date("2026-09-01T12:00:00.000Z");
    expect(resolve("el martes", MADRID, tuesday)).toMatchObject({ ok: true, date: "2026-09-01" });
    expect(resolve("el próximo martes", MADRID, tuesday)).toMatchObject({ ok: true, date: "2026-09-08" });
  });
});

describe("resolveDateInput — zona horaria", () => {
  it("hoy cerca de medianoche Madrid no usa el día de México", () => {
    // 00:30 del viernes 28 en Madrid; sigue siendo jueves 27 en México.
    const almostFriMadrid = new Date("2026-08-27T22:30:00.000Z");
    expect(todayInTz(MADRID, almostFriMadrid)).toBe("2026-08-28");
    expect(todayInTz(MEXICO, almostFriMadrid)).toBe("2026-08-27");
    expect(resolve("hoy", MADRID, almostFriMadrid)).toMatchObject({ ok: true, date: "2026-08-28" });
    expect(resolve("hoy", MEXICO, almostFriMadrid)).toMatchObject({ ok: true, date: "2026-08-27" });
  });

  it("businessTimeZone: CALCOM_TIMEZONE gana sobre member/config", () => {
    expect(businessTimeZone({ CALCOM_TIMEZONE: "Europe/Madrid" })).toBe("Europe/Madrid");
    expect(businessTimeZone({})).toBe("America/Mexico_City");
  });
});

describe("applyResolvedDate", () => {
  it("cambia solo la fecha civil y conserva hora/offset", () => {
    expect(applyResolvedDate("2026-09-02T10:00:00+02:00", "2026-09-01")).toBe(
      "2026-09-01T10:00:00+02:00",
    );
  });
});
