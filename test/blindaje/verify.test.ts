/**
 * Blindaje, modo negaciones (ticket #8AF60E):
 *  • un dato que solo está en custom_instructions se entrega
 *  • un dato que devolvió una tool en este turno se entrega
 *  • un dato que no está en ninguna fuente, junto con una negación, se frena
 *  • una negación sola (sin dato positivo) sigue yendo al verificador
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  tool: (def: unknown) => def,
}));

vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({
    provider: "anthropic",
    modelId: "modelo-test",
    model: {},
    supportsPromptCache: true,
  }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { TicketsRepo } from "../../src/db/tickets";
import { guardReply, safeConfirmReply } from "../../src/blindaje/verify";
import { decideNegaciones, clauseGrounded } from "../../src/blindaje/sources";
import type { Env } from "../../src/env";
import type { SearchKbResult } from "../../src/tools/searchKb";

const KB: SearchKbResult[] = [
  { title: "Horarios", content: "Abrimos de lunes a viernes de 10 a 19.", score: 0.86 },
];

const PROMO = "la promoción incluye X de regalo";
const MIXED = `No ofrecemos servicio a domicilio; ${PROMO}`;

let env: Env;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  const conv = await new ConversationsRepo(new Db(d1)).getOrCreate("whatsapp", "u1", "Cliente");
  convId = conv.id;
  env = {
    DB: d1,
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Tienda",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BLINDAJE_MODE: "negaciones",
    BUFFER_SECONDS: "8",
    DASHBOARD_BASE_URL: "https://dash.test",
  } as unknown as Env;
  generateTextMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("fuentes del turno", () => {
  it("un dato que solo está en custom_instructions pasa, aunque la KB no lo tenga", async () => {
    const r = await guardReply(env, {
      replyText: MIXED,
      turnUsedKb: true,
      kbPassages: KB,
      businessContext: "Vendemos café.",
      customInstructions: PROMO,
      mode: "negaciones",
      conversationId: convId,
      channel: "whatsapp",
    });

    expect(r.action).toBe("sent-original");
    expect(r.finalText).toBe(MIXED);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(await new TicketsRepo(new Db(env.DB)).listOpen()).toHaveLength(0);
  });

  it("también lo acepta si el dato vive dentro del bloque del system prompt", async () => {
    const r = await guardReply(env, {
      replyText: `No damos servicio a domicilio; ${PROMO}`,
      turnUsedKb: true,
      kbPassages: KB,
      systemPrompt: `<custom_instructions>\n${PROMO}\n</custom_instructions>`,
      mode: "negaciones",
      conversationId: convId,
      channel: "whatsapp",
    });
    expect(r.action).toBe("sent-original");
    expect(r.finalText).toContain("X de regalo");
  });

  it("un dato que devolvió una tool en este turno pasa", async () => {
    const reply = "No ofrecemos servicio a domicilio; el combo incluye envío gratis";
    const r = await guardReply(env, {
      replyText: reply,
      turnUsedKb: true,
      kbPassages: KB,
      toolResults: [{ tool: "catalogQuery", output: "el combo incluye envío gratis a todo el país" }],
      mode: "negaciones",
      conversationId: convId,
      channel: "whatsapp",
    });
    expect(r.action).toBe("sent-original");
    expect(r.finalText).toBe(reply);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("un dato sin respaldo, junto con una negación, sigue frenándose y abre ticket", async () => {
    const reply = "No ofrecemos servicio a domicilio; la promoción incluye un yate de regalo";
    const r = await guardReply(env, {
      replyText: reply,
      turnUsedKb: true,
      kbPassages: KB,
      customInstructions: PROMO,
      mode: "negaciones",
      conversationId: convId,
      channel: "whatsapp",
    });

    expect(r.action).toBe("replaced");
    expect(r.finalText).toBe(safeConfirmReply("es", "whatsapp"));
    expect(r.finalText).not.toContain("yate");
    expect(r.unsupportedClaim).toMatch(/yate/i);

    const tickets = await new TicketsRepo(new Db(env.DB)).listOpen();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].summary).toContain("dato sin respaldo");
    expect(tickets[0].summary).toMatch(/yate/i);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("una negación sola, sin dato positivo, sigue yendo al verificador", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ supported: false, unsupported_claim: "no vendemos repuestos" }),
    });
    const reply = "No, no vendemos repuestos.";
    const r = await guardReply(env, {
      replyText: reply,
      turnUsedKb: false,
      kbPassages: [],
      customInstructions: PROMO,
      mode: "negaciones",
      conversationId: convId,
      channel: "whatsapp",
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const prompt = generateTextMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("<custom_instructions>");
    expect(prompt).toContain(PROMO);
    expect(r.action).toBe("replaced");
    expect(r.finalText).not.toBe(reply);
  });

  it("en modo full el modelo no puede tumbar un dato que sí está en las instrucciones", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ supported: false, unsupported_claim: PROMO }),
    });
    const r = await guardReply(env, {
      replyText: MIXED,
      turnUsedKb: true,
      kbPassages: KB,
      customInstructions: PROMO,
      mode: "full",
      conversationId: convId,
      channel: "whatsapp",
    });
    expect(r.action).toBe("sent-original");
    expect(r.finalText).toBe(MIXED);
    expect(await new TicketsRepo(new Db(env.DB)).listOpen()).toHaveLength(0);
  });

  it("BLINDAJE_HOLDING_PHRASE reemplaza la frase de espera", async () => {
    const custom = "Te lo confirmo en un momento.";
    const r = await guardReply(
      { ...env, BLINDAJE_HOLDING_PHRASE: custom } as Env,
      {
        replyText: "No ofrecemos servicio a domicilio; la promoción incluye un yate de regalo",
        turnUsedKb: false,
        kbPassages: [],
        mode: "negaciones",
        conversationId: convId,
        channel: "whatsapp",
      },
    );
    expect(r.action).toBe("replaced");
    expect(r.finalText).toBe(custom);
  });
});

describe("decideNegaciones", () => {
  it("entrega si el dato positivo está en el corpus y frena si no", () => {
    const corpus = `Horarios: 10 a 19.\n${PROMO}`;
    expect(decideNegaciones(MIXED, corpus)).toBe("deliver");
    expect(decideNegaciones("No ofrecemos servicio a domicilio; la promoción incluye un yate de regalo", corpus)).toBe("block");
    expect(decideNegaciones("No, no vendemos repuestos.", corpus)).toBe("ask");
    expect(clauseGrounded("el corte cuesta $80", "Corte de cabello: $150")).toBe(false);
    expect(clauseGrounded("Corte de cabello: $150", "Corte de cabello: $150")).toBe(true);
  });
});
