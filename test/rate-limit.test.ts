import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { isRateLimited, clientIp } from "../src/rate-limit";

let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  db = new Db((await mf.getD1Database("DB")) as any);
});

describe("isRateLimited", () => {
  it("allows up to `max` requests in the same window, blocks the next", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(await isRateLimited(db, "test", "1.2.3.4", { max: 3, windowMs: 60_000 }, now)).toBe(false);
    }
    expect(await isRateLimited(db, "test", "1.2.3.4", { max: 3, windowMs: 60_000 }, now)).toBe(true);
  });

  it("resets the counter once the window rolls over", async () => {
    const windowMs = 60_000;
    const windowStart = 120_000; // aligned to a window boundary
    for (let i = 0; i < 3; i++) {
      expect(await isRateLimited(db, "test", "1.2.3.4", { max: 3, windowMs }, windowStart)).toBe(false);
    }
    expect(await isRateLimited(db, "test", "1.2.3.4", { max: 3, windowMs }, windowStart)).toBe(true);
    // Next window: counter must have reset.
    expect(await isRateLimited(db, "test", "1.2.3.4", { max: 3, windowMs }, windowStart + windowMs)).toBe(false);
  });

  it("tracks each IP independently", async () => {
    const now = 5_000;
    for (let i = 0; i < 2; i++) await isRateLimited(db, "test", "1.1.1.1", { max: 2 }, now);
    expect(await isRateLimited(db, "test", "1.1.1.1", { max: 2 }, now)).toBe(true);
    expect(await isRateLimited(db, "test", "2.2.2.2", { max: 2 }, now)).toBe(false);
  });

  it("tracks each bucket independently for the same IP", async () => {
    const now = 5_000;
    for (let i = 0; i < 2; i++) await isRateLimited(db, "bucket-a", "1.1.1.1", { max: 2 }, now);
    expect(await isRateLimited(db, "bucket-a", "1.1.1.1", { max: 2 }, now)).toBe(true);
    expect(await isRateLimited(db, "bucket-b", "1.1.1.1", { max: 2 }, now)).toBe(false);
  });
});

describe("clientIp", () => {
  it("reads CF-Connecting-IP", () => {
    const req = new Request("https://x", { headers: { "CF-Connecting-IP": "9.9.9.9" } });
    expect(clientIp(req)).toBe("9.9.9.9");
  });

  it("falls back to 'unknown' when the header is absent", () => {
    expect(clientIp(new Request("https://x"))).toBe("unknown");
  });
});
