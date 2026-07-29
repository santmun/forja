/**
 * Tests for the monthly AI budget guard: month-to-date cost aggregation and
 * the pure downgrade decision the agent applies.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { SettingsRepo, SETTING_KEYS } from "../src/db/settings";
import { monthIaCostUsd, monthStartMs, applyBudgetGuard, enforceBudgetGuard } from "../src/budget";
import type { Env } from "../src/env";

describe("applyBudgetGuard", () => {
  it("does nothing without a budget", () => {
    expect(applyBudgetGuard("smart", 999, undefined)).toEqual({ tier: "smart", downgraded: false });
  });

  it("keeps the tier below the budget", () => {
    expect(applyBudgetGuard("smart", 4.99, 5)).toEqual({ tier: "smart", downgraded: false });
  });

  it("downgrades to fast at/over the budget", () => {
    expect(applyBudgetGuard("smart", 5, 5)).toEqual({ tier: "fast", downgraded: true });
    expect(applyBudgetGuard("smart", 7.2, 5)).toEqual({ tier: "fast", downgraded: true });
  });

  it("fast tier is never 'downgraded'", () => {
    expect(applyBudgetGuard("fast", 99, 5)).toEqual({ tier: "fast", downgraded: false });
  });
});

describe("monthIaCostUsd", () => {
  let db: Db;
  let convs: ConversationsRepo;
  let msgs: MessagesRepo;

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    db = new Db((await mf.getD1Database("DB")) as any);
    convs = new ConversationsRepo(db);
    msgs = new MessagesRepo(db);
  });

  it("sums only messages from the current month", async () => {
    const conv = await convs.getOrCreate("telegram", "u1");
    const opts = {
      modelUsed: "claude-haiku-4-5-20251001",
      inputTokens: 100_000,
      outputTokens: 50_000,
      cachedInputTokens: 0,
    };
    await msgs.append(conv.id, "assistant", "in-month", opts);
    const inMonth = await monthIaCostUsd(db);
    expect(inMonth).toBeGreaterThan(0);

    // A message before the month start must not change the total.
    await msgs.append(conv.id, "assistant", "old", {
      ...opts,
      createdAt: monthStartMs() - 1000,
    });
    expect(await monthIaCostUsd(db)).toBeCloseTo(inMonth, 10);
  });

  it("returns 0 with no usage", async () => {
    expect(await monthIaCostUsd(db)).toBe(0);
  });
});

describe("enforceBudgetGuard", () => {
  let db: Db;
  let settings: SettingsRepo;
  // Sin ningún canal de aviso configurado, notifyOwner solo loguea y retorna
  // (ver src/tools/handoffHuman.ts) — no hace falta mockear fetch/Resend.
  const env = { DASHBOARD_BASE_URL: "https://test.workers.dev" } as unknown as Env;

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    db = new Db((await mf.getD1Database("DB")) as any);
    settings = new SettingsRepo(db);
  });

  it("downgrades but does NOT pause below the 1.5x hard-stop", async () => {
    const result = await enforceBudgetGuard(env, db, "smart", 6, 5); // 1.2x
    expect(result).toEqual({ tier: "fast", downgraded: true, paused: false });
    expect(await settings.get(SETTING_KEYS.botPaused)).toBeNull();
  });

  it("pauses the bot and flips bot_paused at/over 1.5x the budget", async () => {
    const result = await enforceBudgetGuard(env, db, "smart", 7.5, 5); // exactly 1.5x
    expect(result.paused).toBe(true);
    expect(await settings.get(SETTING_KEYS.botPaused)).toBe("1");
  });

  it("is idempotent — does not re-report paused once already paused", async () => {
    await enforceBudgetGuard(env, db, "smart", 10, 5);
    const second = await enforceBudgetGuard(env, db, "fast", 10, 5);
    expect(second.paused).toBe(false); // ya estaba pausado, no hay nada nuevo que hacer
    expect(await settings.get(SETTING_KEYS.botPaused)).toBe("1");
  });

  it("never pauses without a configured budget", async () => {
    const result = await enforceBudgetGuard(env, db, "smart", 9999, undefined);
    expect(result.paused).toBe(false);
    expect(await settings.get(SETTING_KEYS.botPaused)).toBeNull();
  });
});
