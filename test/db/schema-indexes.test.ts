import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = readFileSync(path.join(ROOT, "src", "db", "schema.sql"), "utf-8");

function planText(rows: { detail?: string }[]): string {
  return rows.map((r) => r.detail ?? "").join("\n").toLowerCase();
}

describe("D1 conversation_id indexes (inbox)", () => {
  let db: Db;

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    db = new Db((await mf.getD1Database("DB")) as any);
  });

  it("schema.sql declares idx_leads_conv and idx_tickets_conv", () => {
    expect(SCHEMA).toContain("CREATE INDEX IF NOT EXISTS idx_leads_conv ON leads(conversation_id)");
    expect(SCHEMA).toContain("CREATE INDEX IF NOT EXISTS idx_tickets_conv ON tickets(conversation_id)");
  });

  it("EXPLAIN QUERY PLAN uses SEARCH (not SCAN) for per-conversation counts", async () => {
    await db.run(
      "INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?, ?, ?, ?, ?)",
      ["c1", "telegram", "u1", 1, 1],
    );
    await db.run(
      "INSERT INTO leads (id, conversation_id, intent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["l1", "c1", "tour", 1, 1],
    );
    await db.run(
      "INSERT INTO tickets (id, conversation_id, summary, transcript, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["t1", "c1", "help", "x", "open", 1],
    );

    const leadsPlan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM leads l WHERE l.conversation_id = ?",
      ["c1"],
    );
    const ticketsPlan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM tickets t WHERE t.conversation_id = ? AND t.status != 'resolved'",
      ["c1"],
    );

    const leads = planText(leadsPlan);
    const tickets = planText(ticketsPlan);
    expect(leads).toMatch(/idx_leads_conv|using index/);
    expect(leads).not.toMatch(/scan l\b|scan leads/);
    expect(tickets).toMatch(/idx_tickets_conv|using index/);
    expect(tickets).not.toMatch(/scan t\b|scan tickets/);
  });
});
