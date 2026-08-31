import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo, OWNER_TAKEOVER_MS } from "../../src/db/conversations";

let repo: ConversationsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  repo = new ConversationsRepo(new Db(d1 as any));
});

describe("ConversationsRepo", () => {
  it("getOrCreate inserts a row on first call and returns existing on repeat", async () => {
    const conv1 = await repo.getOrCreate("telegram", "user_123", "María");
    const conv2 = await repo.getOrCreate("telegram", "user_123", "María");
    expect(conv1.id).toBe(conv2.id);
    expect(conv1.channel).toBe("telegram");
    expect(conv1.display_name).toBe("María");
  });

  it("setPausedUntil updates the column", async () => {
    const conv = await repo.getOrCreate("telegram", "user_456");
    const until = Date.now() + 3_600_000;
    await repo.setPausedUntil(conv.id, until);
    const fresh = await repo.getById(conv.id);
    expect(fresh?.paused_until).toBe(until);
  });

  it("isPaused returns true when paused_until is in the future", async () => {
    const conv = await repo.getOrCreate("telegram", "user_789");
    await repo.setPausedUntil(conv.id, Date.now() + 60_000);
    expect(await repo.isPaused(conv.id)).toBe(true);
  });

  it("isPaused returns false when paused_until is past", async () => {
    const conv = await repo.getOrCreate("telegram", "user_999");
    await repo.setPausedUntil(conv.id, Date.now() - 60_000);
    expect(await repo.isPaused(conv.id)).toBe(false);
  });

  it("OWNER_TAKEOVER_MS is a 20-minute hard cap, not an hour", () => {
    expect(OWNER_TAKEOVER_MS).toBe(20 * 60 * 1000);
    expect(OWNER_TAKEOVER_MS).toBeLessThan(60 * 60 * 1000);
  });
});
