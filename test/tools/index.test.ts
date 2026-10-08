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

function withCalcom(ctx: ToolContext, key = "cal_test"): ToolContext {
  ctx.env.CALCOM_API_KEY = key;
  ctx.env.CALCOM_EVENT_TYPE_ID = "12";
  return ctx;
}

describe("buildTools", () => {
  it("sin CALCOM_API_KEY no registra scheduleAppointment (no pide correo de Cal.com)", () => {
    for (const tier of ["free", "pro"] as const) {
      const tools = buildTools(makeCtx(tier));
      expect(tools.scheduleAppointment).toBeUndefined();
      expect(Object.keys(tools)).not.toContain("scheduleAppointment");
    }
  });

  it("una llave en blanco tampoco registra la tool", () => {
    const tools = buildTools(withCalcom(makeCtx("pro"), "   "));
    expect(tools.scheduleAppointment).toBeUndefined();
  });

  it("con CALCOM_API_KEY registra scheduleAppointment igual que antes (free y pro)", () => {
    const free = buildTools(withCalcom(makeCtx("free")));
    expect(Object.keys(free).sort()).toEqual([
      "captureLead",
      "handoffHuman",
      "pauseBot",
      "scheduleAppointment",
      "searchKb",
      "snoozeUser",
    ]);
    expect(free.scheduleAppointment.description).toContain("Cal.com");
    expect(free.scheduleAppointment.description).toContain("attendeeEmail");
    expect(free.catalogQuery).toBeUndefined();

    const pro = buildTools(withCalcom(makeCtx("pro")));
    expect(pro.scheduleAppointment).toBeDefined();
    expect(pro.catalogQuery).toBeDefined();
    expect(pro.scheduleAppointment.description).toContain("attendeeEmail");
  });

  it("free tier captura leads, pero excluye las Pro-only (catálogo)", () => {
    const tools = buildTools(makeCtx("free"));
    expect(tools.captureLead).toBeDefined();
    expect(tools.catalogQuery).toBeUndefined();
  });

  it("pro tier has the base tools plus catalogQuery (Pro)", () => {
    const tools = buildTools(makeCtx("pro"));
    expect(Object.keys(tools).sort()).toEqual([
      "captureLead",
      "catalogQuery",
      "handoffHuman",
      "pauseBot",
      "searchKb",
      "snoozeUser",
    ]);
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
