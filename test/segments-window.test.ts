import { describe, it, expect } from "vitest";
import { WINDOW_MS, WINDOW_SAFE_MS, serviceWindowFrom, windowHoursLabel } from "../src/segments";

const NOW = 1_800_000_000_000;

describe("serviceWindowFrom", () => {
  it("está abierta si el cliente escribió hace menos de 24 h", () => {
    const last = NOW - 5 * 3_600_000;
    const win = serviceWindowFrom(last, NOW);
    expect(win.open).toBe(true);
    expect(win.closesAt).toBe(last + WINDOW_MS);
    expect(windowHoursLabel(last, NOW)).toBe("✍ 19 h");
  });

  it("cierra exactamente a las 24 h", () => {
    const last = NOW - WINDOW_MS;
    expect(serviceWindowFrom(last, NOW).open).toBe(false);
    expect(windowHoursLabel(last, NOW)).toBe("🔒");
  });

  it("sin mensaje del cliente la ventana está cerrada", () => {
    expect(serviceWindowFrom(null, NOW).open).toBe(false);
    expect(serviceWindowFrom(undefined, NOW).closesAt).toBeNull();
  });

  it("bajo una hora muestra minutos", () => {
    const last = NOW - (WINDOW_MS - 30 * 60_000);
    expect(windowHoursLabel(last, NOW)).toBe("✍ 30 min");
  });

  it("las campañas pueden pedir el margen de 23 h sin duplicar la cuenta", () => {
    const last = NOW - 23 * 3_600_000;
    expect(serviceWindowFrom(last, NOW).open).toBe(true);
    expect(serviceWindowFrom(last, NOW, WINDOW_SAFE_MS).open).toBe(false);
  });
});
