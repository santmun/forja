import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { handoffHumanTool } from "../../src/tools/handoffHuman";

let env: any;
let tickets: TicketsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  tickets = new TicketsRepo(db);
  // The tickets table FKs conversation_id -> conversations(id), so we need a
  // real conversation row before the tool can attach a ticket to it.
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  env = {
    DB: d1,
    OWNER_EMAIL: "hugo@hugohair.com",
    RESEND_API_KEY: "fake_key",
    BUSINESS_NAME: "Hugo Hair",
    DASHBOARD_BASE_URL: "https://dash.test",
    BOT_TIER: "free",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handoffHumanTool", () => {
  it("creates a ticket row in D1 even without Resend key", async () => {
    const envNoResend = { ...env, RESEND_API_KEY: undefined };
    const tool = handoffHumanTool(envNoResend, () => convId);
    const result = await tool.execute!(
      {
        reason: "complejo",
        summary: "María pregunta sobre shampoo sin sulfatos",
        category: "product",
      },
      {} as any,
    );
    expect((result as { ticketId: string }).ticketId).toBeTruthy();
    const list = await tickets.listOpen();
    expect(list).toHaveLength(1);
    expect(list[0].summary).toContain("María");
  });

  it("reuses the open ticket on later handoffs and notifies the owner only once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const envNotify = {
      ...env,
      RESEND_API_KEY: undefined,
      TELEGRAM_BOT_TOKEN: "123:abc",
      OWNER_TELEGRAM_CHAT_ID: "999",
    };
    const tool = handoffHumanTool(envNotify, () => convId);
    const first = await tool.execute!(
      { reason: "humano", summary: "quiere que lo llamen", category: "product" },
      {} as any,
    );
    const second = await tool.execute!(
      { reason: "humano", summary: "pregunta otra vez cuándo lo llaman", category: "product" },
      {} as any,
    );
    const third = await tool.execute!(
      { reason: "humano", summary: "insiste con la misma llamada", category: "product" },
      {} as any,
    );

    const ticketId = (first as { ticketId: string }).ticketId;
    expect((second as { ticketId: string }).ticketId).toBe(ticketId);
    expect((third as { ticketId: string }).ticketId).toBe(ticketId);

    const list = await tickets.listOpen();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ticketId);
    expect(list[0].summary).toContain("quiere que lo llamen");
    expect(list[0].summary).toContain("pregunta otra vez cuándo lo llaman");
    expect(list[0].summary).toContain("insiste con la misma llamada");

    const conv = await new ConversationsRepo(new Db(env.DB)).getById(convId);
    expect(conv?.open_ticket_id).toBe(ticketId);

    const telegramCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes("api.telegram.org"),
    );
    expect(telegramCalls).toHaveLength(1);
  });

  it("opens a fresh ticket after the previous one was resolved", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const envNotify = {
      ...env,
      RESEND_API_KEY: undefined,
      TELEGRAM_BOT_TOKEN: "123:abc",
      OWNER_TELEGRAM_CHAT_ID: "999",
    };
    const tool = handoffHumanTool(envNotify, () => convId);
    const first = await tool.execute!(
      { reason: "humano", summary: "primera solicitud", category: "other" },
      {} as any,
    );
    const firstId = (first as { ticketId: string }).ticketId;
    await tickets.resolve(firstId, "dueno@negocio.com");

    const second = await tool.execute!(
      { reason: "humano", summary: "otra solicitud ya resuelta la anterior", category: "other" },
      {} as any,
    );
    const secondId = (second as { ticketId: string }).ticketId;
    expect(secondId).not.toBe(firstId);

    const open = await tickets.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(secondId);
    expect(open[0].summary).toContain("otra solicitud");

    const conv = await new ConversationsRepo(new Db(env.DB)).getById(convId);
    expect(conv?.open_ticket_id).toBe(secondId);

    const telegramCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes("api.telegram.org"),
    );
    expect(telegramCalls).toHaveLength(2);
  });
});
