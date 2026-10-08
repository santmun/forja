import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { handoffHumanTool } from "../../src/tools/handoffHuman";

let env: any;
let tickets: TicketsRepo;
let convs: ConversationsRepo;
let convId: string;

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  tickets = new TicketsRepo(db);
  convs = new ConversationsRepo(db);
  // The tickets table FKs conversation_id -> conversations(id), so we need a
  // real conversation row before the tool can attach a ticket to it.
  const conv = await convs.getOrCreate("telegram", "u1");
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

  it("reuses the open ticket and notifies the owner only once when the customer repeats the request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const envTelegram = {
      ...env,
      RESEND_API_KEY: undefined,
      TELEGRAM_BOT_TOKEN: "123:abc",
      OWNER_TELEGRAM_CHAT_ID: "99",
    };
    const tool = handoffHumanTool(envTelegram, () => convId);
    const args = {
      reason: "humano",
      summary: "quiere hablar con una persona",
      category: "product" as const,
    };

    const first = await tool.execute!(args, {} as any);
    const second = await tool.execute!(args, {} as any);
    const third = await tool.execute!(
      { ...args, summary: "insiste, que lo comuniquen ya" },
      {} as any,
    );

    const ticketId = (first as { ticketId: string }).ticketId;
    expect((second as { ticketId: string }).ticketId).toBe(ticketId);
    expect((third as { ticketId: string }).ticketId).toBe(ticketId);

    const list = await tickets.listOpen();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(ticketId);

    const conv = await convs.getById(convId);
    expect(conv?.open_ticket_id).toBe(ticketId);

    const telegramCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes("api.telegram.org"),
    );
    expect(telegramCalls).toHaveLength(1);
  });

  it("reuses a ticket that is already in progress", async () => {
    const envNoResend = { ...env, RESEND_API_KEY: undefined };
    const tool = handoffHumanTool(envNoResend, () => convId);
    const first = await tool.execute!(
      { reason: "humano", summary: "primera", category: "other" },
      {} as any,
    );
    const ticketId = (first as { ticketId: string }).ticketId;
    await env.DB.prepare("UPDATE tickets SET status = 'in_progress' WHERE id = ?").bind(ticketId).run();

    const second = await tool.execute!(
      { reason: "humano", summary: "sigue pidiendo una persona", category: "other" },
      {} as any,
    );
    expect((second as { ticketId: string }).ticketId).toBe(ticketId);
    const open = await tickets.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(ticketId);
    expect((await convs.getById(convId))?.open_ticket_id).toBe(ticketId);
  });

  it("opens a new ticket after the previous one was resolved", async () => {
    const envNoResend = { ...env, RESEND_API_KEY: undefined };
    const tool = handoffHumanTool(envNoResend, () => convId);
    const args = {
      reason: "humano",
      summary: "primera vez",
      category: "product" as const,
    };
    const first = await tool.execute!(args, {} as any);
    const firstId = (first as { ticketId: string }).ticketId;
    await tickets.resolve(firstId, "owner@test.com");

    const second = await tool.execute!(
      { ...args, summary: "volvió a pedir una persona" },
      {} as any,
    );
    const secondId = (second as { ticketId: string }).ticketId;
    expect(secondId).not.toBe(firstId);

    const open = await tickets.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(secondId);
    expect((await convs.getById(convId))?.open_ticket_id).toBe(secondId);
  });
});
