import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo, hasMessageText, usableHistory } from "../../src/db/messages";

let convRepo: ConversationsRepo;
let msgRepo: MessagesRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  convRepo = new ConversationsRepo(db);
  msgRepo = new MessagesRepo(db);
  const conv = await convRepo.getOrCreate("telegram", "user_999");
  convId = conv.id;
});

describe("MessagesRepo", () => {
  it("appends and retrieves messages in chronological order", async () => {
    await msgRepo.append(convId, "user", "hola");
    await msgRepo.append(convId, "assistant", "hola María, qué tal");
    const msgs = await msgRepo.lastN(convId, 20);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("hola");
    expect(msgs[1].content).toBe("hola María, qué tal");
  });

  it("lastN respects the limit", async () => {
    for (let i = 0; i < 25; i++) {
      await msgRepo.append(convId, "user", `msg ${i}`);
    }
    const msgs = await msgRepo.lastN(convId, 20);
    expect(msgs).toHaveLength(20);
    // last 20 means msgs 5-24
    expect(msgs[0].content).toBe("msg 5");
    expect(msgs[19].content).toBe("msg 24");
  });

  it("purgeOlderThan deletes messages past the cutoff", async () => {
    await msgRepo.append(convId, "user", "old", { createdAt: Date.now() - 100 * 86_400_000 });
    await msgRepo.append(convId, "user", "new");
    const deleted = await msgRepo.purgeOlderThan(Date.now() - 90 * 86_400_000);
    expect(deleted).toBe(1);
    const msgs = await msgRepo.lastN(convId, 20);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("new");
  });
});

describe("usableHistory", () => {
  it("drops empty and whitespace-only rows so they never reach the LLM", () => {
    const rows = [
      { role: "user", content: "hola" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "   " },
      { role: "user", content: "sigo aquí" },
    ];
    expect(usableHistory(rows)).toEqual([
      { role: "user", content: "hola" },
      { role: "user", content: "sigo aquí" },
    ]);
  });

  it("hasMessageText treats null, empty and whitespace as unusable", () => {
    expect(hasMessageText("hola")).toBe(true);
    expect(hasMessageText("")).toBe(false);
    expect(hasMessageText("  \n")).toBe(false);
    expect(hasMessageText(null)).toBe(false);
    expect(hasMessageText(undefined)).toBe(false);
  });
});
