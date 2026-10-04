import { describe, it, expect } from "vitest";
import { isDemoMode } from "../src/demoMode";

describe("isDemoMode", () => {
  it("está apagado si la var falta, está vacía o es off", () => {
    expect(isDemoMode({})).toBe(false);
    expect(isDemoMode({ DEMO_MODE: "" })).toBe(false);
    expect(isDemoMode({ DEMO_MODE: "off" })).toBe(false);
  });

  it("se enciende con on, sin importar mayúsculas", () => {
    expect(isDemoMode({ DEMO_MODE: "on" })).toBe(true);
    expect(isDemoMode({ DEMO_MODE: "ON" })).toBe(true);
  });
});
