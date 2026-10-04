import { describe, it, expect } from "vitest";
import { buildTools, type ToolContext } from "../../src/tools/index";

function makeCtx(tier: "free" | "pro", niche?: string, demoMode?: string): ToolContext {
  const env = {
    BOT_TIER: tier,
    BOT_NICHE: niche,
    DEMO_MODE: demoMode,
    DB: {} as any,
    AI: {} as any,
    BUSINESS_NAME: "Test",
    OWNER_EMAIL: "owner@test.com",
    DASHBOARD_BASE_URL: "https://example.com",
  } as any;
  return { env, getConversationId: () => "conv-1" };
}

describe("buildTools", () => {
  it("registers the free-tier tools (incluye captureLead, scheduleAppointment y pauseSuspectedBot)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "handoffHuman",
      "pauseBot",
      "pauseSuspectedBot",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
  });

  it("free tier captura leads y agenda citas, pero excluye las Pro-only (catálogo)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(tools.captureLead).toBeDefined();
    expect(tools.scheduleAppointment).toBeDefined();
    expect(tools.catalogQuery).toBeUndefined();
  });

  it("pro tier has the base tools plus catalogQuery (Pro)", () => {
    const tools = buildTools(makeCtx("pro"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "pauseSuspectedBot",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeDefined();
    expect(tools.catalogQuery).toBeDefined();
  });

  it("no registra pauseSuspectedBot cuando DEMO_MODE está on (el prospecto no es un bot)", () => {
    for (const mode of ["on", "ON", "On"]) {
      const tools = buildTools(makeCtx("pro", undefined, mode));
      expect(tools.pauseSuspectedBot, `DEMO_MODE=${mode}`).toBeUndefined();
      expect(tools.searchKb).toBeDefined();
      expect(tools.pauseBot).toBeDefined();
      expect(tools.snoozeUser).toBeDefined();
    }
  });

  it("registra pauseSuspectedBot en producción (DEMO_MODE apagado o ausente)", () => {
    expect(buildTools(makeCtx("free")).pauseSuspectedBot).toBeDefined();
    expect(buildTools(makeCtx("pro", undefined, "off")).pauseSuspectedBot).toBeDefined();
    expect(buildTools(makeCtx("pro", undefined, "")).pauseSuspectedBot).toBeDefined();
  });

  it("el Starter genérico no agrega tools de nicho (aunque BOT_NICHE traiga un giro)", () => {
    for (const niche of [undefined, "restaurante", "inmobiliaria", "hoteleria"]) {
      const tools = buildTools(makeCtx("pro", niche));
      expect(tools.crearReservacion).toBeUndefined();
      expect(tools.calificarComprador).toBeUndefined();
      expect(tools.agendarCita).toBeUndefined();
      expect(tools.registrarPedido).toBeUndefined();
      expect(tools.registrarProspecto).toBeUndefined();
      expect(tools.reservarHospedaje).toBeUndefined();
    }
  });
});
