import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorTimeZone, currentDateAnchor, formatLocalTime } from "../../src/time/dateAnchor";

afterEach(() => vi.useRealTimers());

describe("formatLocalTime", () => {
  it("da la hora en 24 h de la zona pedida", () => {
    const afternoon = new Date("2026-08-27T22:30:00.000Z");
    expect(formatLocalTime("America/Mexico_City", afternoon)).toBe("16:30");
    expect(formatLocalTime("America/Bogota", afternoon)).toBe("17:30");
    expect(formatLocalTime("Europe/Madrid", new Date("2026-08-27T15:00:00.000Z"))).toBe("17:00");
  });
});

describe("currentDateAnchor", () => {
  it("pone la fecha y la frase de la hora juntas", () => {
    const line = currentDateAnchor("America/Mexico_City", new Date("2026-08-27T22:30:00.000Z"));
    expect(line).toContain("2026-08-27");
    expect(line.toLowerCase()).toContain("jueves");
    expect(line).toContain("La hora actual es 16:30");
    expect(line).toContain("America/Mexico_City");
  });
});

describe("anchorTimeZone", () => {
  it("BOT_TIMEZONE gana sobre CALCOM_TIMEZONE", () => {
    expect(
      anchorTimeZone({ BOT_TIMEZONE: "America/Bogota", CALCOM_TIMEZONE: "Europe/Madrid" }),
    ).toBe("America/Bogota");
  });

  it("sin BOT_TIMEZONE usa la zona del negocio", () => {
    expect(anchorTimeZone({ CALCOM_TIMEZONE: "Europe/Madrid" })).toBe("Europe/Madrid");
    expect(anchorTimeZone({})).toBe("America/Mexico_City");
  });

  it("ignora BOT_TIMEZONE vacío", () => {
    expect(anchorTimeZone({ BOT_TIMEZONE: "  ", CALCOM_TIMEZONE: "Europe/Madrid" })).toBe(
      "Europe/Madrid",
    );
  });
});
