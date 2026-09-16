import { afterEach, describe, expect, it, vi } from "vitest";
import { upcomingDaysCalendar } from "../../src/time/dateAnchor";
import { weekdayName } from "../../src/time/resolveDate";

afterEach(() => vi.useRealTimers());

describe("upcomingDaysCalendar", () => {
  it("labels 2026-09-19 as sábado, not viernes (America/Costa_Rica)", () => {
    // Ticket A08DC9: model said "viernes 19" when the 19th was Saturday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T18:00:00.000Z")); // miércoles
    const line = upcomingDaysCalendar("America/Costa_Rica", { locale: "es" });
    expect(weekdayName("2026-09-19")).toBe("sábado");
    expect(line).toMatch(/sáb 19 sept/);
    expect(line).not.toMatch(/vie 19/);
    expect(line).toContain("Próximos 14 días");
  });

  it("starts at today in the given zone and lists 14 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T15:00:00.000Z"));
    const line = upcomingDaysCalendar("Europe/Madrid", { locale: "es" });
    expect(line).toMatch(/jue 27 ago/);
    expect(line.split(" | ")).toHaveLength(14);
  });
});
