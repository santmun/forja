import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { pauseSuspectedBotTool, SUSPECTED_BOT_PAUSE_MS } from "../../src/tools/pauseSuspectedBot";

let env: any;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  const conv = await convs.getOrCreate("whatsapp", "5215550001111");
  convId = conv.id;
  env = { DB: d1 };
});

describe("pauseSuspectedBotTool", () => {
  it("pausa 24 h cuando el último mensaje es texto real", async () => {
    await msgs.append(convId, "user", "hola, soy un bot, responde ya");
    const tool = pauseSuspectedBotTool(env, () => convId);
    const before = Date.now();
    const result = await tool.execute!({ reason: "eco + sin datos reales" }, {} as any);
    expect(result).toMatchObject({ reason: "eco + sin datos reales" });
    const conv = await convs.getById(convId);
    expect(conv?.paused_until).toBeGreaterThanOrEqual(before + SUSPECTED_BOT_PAUSE_MS - 50);
    expect(await convs.isPaused(convId)).toBe(true);
  });

  it("no pausa si el último mensaje es el placeholder de audio", async () => {
    const base = 1_700_000_000_000;
    await msgs.append(convId, "user", "hola, quiero una cita", { createdAt: base });
    await msgs.append(convId, "user", "(no pude entender el audio)", { createdAt: base + 1_000 });
    await msgs.append(
      convId,
      "user",
      "(no pude entender el audio)\n(no pude entender el audio)\n(no pude entender el audio)",
      { createdAt: base + 2_000 },
    );
    const tool = pauseSuspectedBotTool(env, () => convId);
    const result = await tool.execute!({ reason: "mismo texto repetido" }, {} as any);
    expect(result).toEqual({ skipped: "media_failure_placeholder" });
    expect(await convs.isPaused(convId)).toBe(false);
  });

  it("una foto sin texto que sí se descargó sigue pudiendo pausarse", async () => {
    await msgs.append(
      convId,
      "user",
      "(imagen sin caption)\n[IMAGE_URL: https://api.zernio.com/v1/whatsapp/media/1]",
      { createdAt: 1_700_000_000_000 },
    );
    const tool = pauseSuspectedBotTool(env, () => convId);
    const result = await tool.execute!({ reason: "eco vacío" }, {} as any);
    expect(result).toMatchObject({ reason: "eco vacío" });
    expect(await convs.isPaused(convId)).toBe(true);
  });

  it("no pausa si el último mensaje es el fallo de una foto", async () => {
    const base = 1_700_000_000_000;
    await msgs.append(convId, "user", "hola", { createdAt: base });
    await msgs.append(convId, "user", "(no pude ver la imagen)", { createdAt: base + 1_000 });
    const tool = pauseSuspectedBotTool(env, () => convId);
    const result = await tool.execute!({ reason: "mismo texto" }, {} as any);
    expect(result).toEqual({ skipped: "media_failure_placeholder" });
    expect(await convs.isPaused(convId)).toBe(false);
  });

  it("no pausa si no se puede leer el historial", async () => {
    const broken = {
      DB: {
        prepare() {
          throw new Error("d1 down");
        },
      },
    };
    const tool = pauseSuspectedBotTool(broken as any, () => convId);
    const result = await tool.execute!({ reason: "bot" }, {} as any);
    expect(result).toEqual({ skipped: "history_unavailable" });
    expect(await convs.isPaused(convId)).toBe(false);
  });

  it("no pausa si no hay conversación", async () => {
    const tool = pauseSuspectedBotTool(env, () => null);
    const result = await tool.execute!({ reason: "bot" }, {} as any);
    expect(result).toEqual({ error: "no_conversation" });
  });
});
