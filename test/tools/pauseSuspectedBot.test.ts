import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import {
  pauseSuspectedBotTool,
  SUSPECTED_BOT_PAUSE_MS,
} from "../../src/tools/pauseSuspectedBot";

let env: any;
let convs: ConversationsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  convs = new ConversationsRepo(new Db(d1 as any));
  const conv = await convs.getOrCreate("web", "demo-session");
  convId = conv.id;
  env = { DB: d1 };
});

describe("pauseSuspectedBotTool", () => {
  it("pausa la conversación 24 h en producción", async () => {
    const tool = pauseSuspectedBotTool(env, () => convId);
    const before = Date.now();
    await tool.execute!({ reason: "eco + sin datos reales" }, {} as any);
    const conv = await convs.getById(convId);
    expect(conv?.paused_until).toBeGreaterThanOrEqual(before + SUSPECTED_BOT_PAUSE_MS - 50);
    expect(conv!.paused_until!).toBeLessThanOrEqual(Date.now() + SUSPECTED_BOT_PAUSE_MS + 50);
    expect(await convs.isPaused(convId)).toBe(true);
  });

  it("no pausa si no hay conversación", async () => {
    const tool = pauseSuspectedBotTool(env, () => null);
    const result = await tool.execute!({ reason: "bot" }, {} as any);
    expect(result).toEqual({ error: "no_conversation" });
  });

  it("queda inerte con DEMO_MODE=on aunque alguien la invoque", async () => {
    const tool = pauseSuspectedBotTool({ ...env, DEMO_MODE: "on" }, () => convId);
    const result = await tool.execute!({ reason: "preguntas cortas de demo" }, {} as any);
    expect(result).toEqual({ skipped: "demo_mode" });
    expect(await convs.isPaused(convId)).toBe(false);
  });
});
