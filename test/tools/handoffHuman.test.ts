import { describe, it, expect, beforeEach, vi } from "vitest";
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
    const convs = new ConversationsRepo(new Db(env.DB));
    expect((await convs.getById(convId))?.open_ticket_id).toBe(list[0].id);
  });
});
