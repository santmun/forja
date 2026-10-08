import { describe, expect, it } from "vitest";
import { fmtDateTime, panelTimeZone } from "../../src/admin/format";

// 2026-10-08 18:00 UTC. México (sin horario de verano) es UTC−6 → 12:00.
const UTC_18 = Date.UTC(2026, 9, 8, 18, 0, 0);
const HOUR: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

describe("fechas del panel", () => {
  it("usa la zona del negocio cuando no hay BOT_TIMEZONE", () => {
    expect(panelTimeZone(null)).toBe("America/Mexico_City");
    expect(fmtDateTime(UTC_18, HOUR)).toContain("12:00");
    expect(fmtDateTime(UTC_18, HOUR)).not.toContain("18:00");
  });

  it("BOT_TIMEZONE gana sobre la zona compilada del member", () => {
    expect(panelTimeZone({ BOT_TIMEZONE: "UTC" })).toBe("UTC");
    expect(fmtDateTime(UTC_18, HOUR, { BOT_TIMEZONE: "UTC" })).toContain("18:00");
    expect(fmtDateTime(UTC_18, HOUR, { BOT_TIMEZONE: "America/Mexico_City" })).toContain("12:00");
  });

  it("una zona inválida no tira el panel: cae a la del negocio", () => {
    expect(panelTimeZone({ BOT_TIMEZONE: "No/Existe" })).toBe("America/Mexico_City");
    expect(fmtDateTime(UTC_18, HOUR, { BOT_TIMEZONE: "No/Existe" })).toContain("12:00");
  });
});
