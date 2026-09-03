import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";

let repo: TicketsRepo;
let convs: ConversationsRepo;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  repo = new TicketsRepo(db);
  convs = new ConversationsRepo(db);
});

describe("TicketsRepo", () => {
  it("creates open ticket", async () => {
    const id = await repo.create({
      conversationId: null,
      category: "product",
      summary: "Pregunta sobre shampoo",
      transcript: "user: hola\nbot: ...",
    });
    const ticket = await repo.getById(id);
    expect(ticket?.status).toBe("open");
    expect(ticket?.summary).toBe("Pregunta sobre shampoo");
  });

  it("resolve sets status + resolved_at", async () => {
    const id = await repo.create({
      conversationId: null,
      category: "other",
      summary: "x",
      transcript: "",
    });
    await repo.resolve(id, "agente@ejemplo.com");
    const ticket = await repo.getById(id);
    expect(ticket?.status).toBe("resolved");
    expect(ticket?.resolved_at).toBeTruthy();
    expect(ticket?.resolved_by).toBe("agente@ejemplo.com");
  });

  it("listOpen returns only open tickets", async () => {
    await repo.create({ conversationId: null, category: "x", summary: "a", transcript: "" });
    const idResolved = await repo.create({ conversationId: null, category: "x", summary: "b", transcript: "" });
    await repo.resolve(idResolved, "agente@x.com");
    const list = await repo.listOpen();
    expect(list).toHaveLength(1);
    expect(list[0].summary).toBe("a");
  });

  it("resolve clears conversations.open_ticket_id for that ticket only", async () => {
    const locked = await convs.getOrCreate("telegram", "user_locked");
    const other = await convs.getOrCreate("telegram", "user_other");
    const ticketId = await repo.create({
      conversationId: locked.id,
      category: "other",
      summary: "escalado",
      transcript: "",
    });
    const otherTicketId = await repo.create({
      conversationId: other.id,
      category: "other",
      summary: "otro caso",
      transcript: "",
    });
    await convs.setOpenTicket(locked.id, ticketId);
    await convs.setOpenTicket(other.id, otherTicketId);

    await repo.resolve(ticketId, "agente@ejemplo.com");

    expect((await convs.getById(locked.id))?.open_ticket_id).toBeNull();
    expect((await convs.getById(other.id))?.open_ticket_id).toBe(otherTicketId);
  });

  it("cleanupStaleOpenTicketRefs drops resolved and orphan refs, keeps open ones", async () => {
    const resolvedConv = await convs.getOrCreate("telegram", "user_resolved");
    const orphanConv = await convs.getOrCreate("telegram", "user_orphan");
    const openConv = await convs.getOrCreate("telegram", "user_open");

    const resolvedId = await repo.create({
      conversationId: resolvedConv.id,
      category: "other",
      summary: "ya cerrado",
      transcript: "",
    });
    const openId = await repo.create({
      conversationId: openConv.id,
      category: "other",
      summary: "sigue abierto",
      transcript: "",
    });
    await convs.setOpenTicket(resolvedConv.id, resolvedId);
    await convs.setOpenTicket(openConv.id, openId);
    await convs.setOpenTicket(orphanConv.id, "ticket-fantasma");
    // Simulate a pre-fix resolve: ticket is resolved, conversation still locked.
    await db.run(
      "UPDATE tickets SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?",
      [Date.now(), "legacy", resolvedId],
    );

    await repo.cleanupStaleOpenTicketRefs();

    expect((await convs.getById(resolvedConv.id))?.open_ticket_id).toBeNull();
    expect((await convs.getById(orphanConv.id))?.open_ticket_id).toBeNull();
    expect((await convs.getById(openConv.id))?.open_ticket_id).toBe(openId);
  });
});
