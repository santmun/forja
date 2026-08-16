import { describe, it, expect } from "vitest";
import { buildTools, type ToolContext } from "../../src/tools/index";

function makeCtx(tier: "free" | "pro", niche?: string): ToolContext {
  const env = {
    BOT_TIER: tier,
    BOT_NICHE: niche,
    DB: {} as any,
    AI: {} as any,
    BUSINESS_NAME: "Test",
    OWNER_EMAIL: "owner@test.com",
    DASHBOARD_BASE_URL: "https://example.com",
  } as any;
  return { env, getConversationId: () => "conv-1" };
}

describe("buildTools", () => {
  it("registers the 6 free-tier tools (incluye captureLead y scheduleAppointment)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "handoffHuman",
      "pauseBot",
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

  it("pro tier has the 6 base tools plus catalogQuery (Pro)", () => {
    const tools = buildTools(makeCtx("pro"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
    expect(tools.scheduleAppointment).toBeDefined();
    expect(tools.catalogQuery).toBeDefined();
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
