/**
 * Tests for the F1 inbox: two-pane view, live thread fragment, and the
 * owner-reply flow (send via channel adapter + persist as role=owner + pause
 * the bot). The channel adapter layer is mocked; D1 is real via miniflare.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendReplyMock = vi.fn();
const pickAdapterMock = vi.fn((_channel: unknown) => ({ sendReply: sendReplyMock }));

vi.mock("../../src/replies/sender", () => ({
  pickAdapter: (channel: unknown) => pickAdapterMock(channel),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";

function basicAuthHeader(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const b64 =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${b64}`;
}

const AUTH = { Authorization: basicAuthHeader("admin", PASSWORD) };
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "Negocio de Prueba",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    DASHBOARD_PASSWORD: PASSWORD,
  } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  sendReplyMock.mockReset().mockResolvedValue(undefined);
  pickAdapterMock.mockClear();
  pickAdapterMock.mockImplementation(() => ({ sendReply: sendReplyMock }));
});

describe("inbox — page and fragments", () => {
  it("renders the two-pane inbox with conversations in the list", async () => {
    const conv = await convs.getOrCreate("telegram", "u1", "María");
    await msgs.append(conv.id, "user", "Hola, ¿tienen citas mañana?");

    const res = await adminApp.request("/conversations", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("María");
    expect(html).toContain("Selecciona una conversación");
  });

  it("old detail URLs redirect into the inbox selection", async () => {
    const res = await adminApp.request("/conversations/telegram%3Au1", { headers: AUTH }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/conversations?c=telegram%3Au1");
  });

  it("thread fragment shows tool chips, model and turn cost", async () => {
    const conv = await convs.getOrCreate("telegram", "u2", "Carlos");
    await msgs.append(conv.id, "user", "¿Cuánto cuesta el corte?");
    await msgs.append(conv.id, "assistant", "El corte cuesta $150.", {
      modelUsed: "claude-haiku-4-5-20251001",
      inputTokens: 800,
      outputTokens: 50,
      cachedInputTokens: 0,
      toolCalls: [{ toolName: "searchKb", input: { query: "precio corte" } }],
    });

    const res = await adminApp.request(
      `/conversations/thread/${encodeURIComponent(conv.id)}`,
      { headers: AUTH },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("searchKb");
    expect(html).toContain("precio corte");
    expect(html).toContain("haiku");
    expect(html).toContain("$0.00"); // turn cost, 4-decimal format
    expect(html).toContain("🟢 bot activo");
  });
});

describe("inbox — owner reply (takeover)", () => {
  it("sends via the channel adapter, persists as owner, and pauses the bot", async () => {
    const conv = await convs.getOrCreate("telegram", "u3", "Lucía");
    await msgs.append(conv.id, "user", "Quiero hablar con una persona");

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "Hola, soy Ana 👋" }) },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Sent")).toBe("1");
    const html = await res.text();
    expect(html).toContain("✓ Enviado");
    expect(html).toContain('hx-swap-oob="innerHTML"'); // instant thread refresh

    // Sent through the right adapter with the raw text as a single chunk.
    expect(pickAdapterMock).toHaveBeenCalledWith("telegram");
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const [payload] = sendReplyMock.mock.calls[0];
    expect(payload.channelUserId).toBe("u3");
    expect(payload.chunks).toEqual(["Hola, soy Ana 👋"]);

    // Persisted as owner + bot paused (takeover).
    const history = await msgs.lastN(conv.id, 10);
    expect(history[history.length - 1].role).toBe("owner");
    expect(history[history.length - 1].content).toBe("Hola, soy Ana 👋");
    expect(await convs.isPaused(conv.id)).toBe(true);
  });

  it("persists nothing when the adapter fails", async () => {
    const conv = await convs.getOrCreate("telegram", "u4");
    await msgs.append(conv.id, "user", "Hola");
    sendReplyMock.mockRejectedValue(new Error("Twilio 401"));

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "no debería llegar" }) },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Sent")).toBeNull();
    expect(await res.text()).toContain("No se pudo enviar");

    const history = await msgs.lastN(conv.id, 10);
    expect(history.every((m) => m.role !== "owner")).toBe(true);
    expect(await convs.isPaused(conv.id)).toBe(false);
  });

  it("rejects an empty message without calling the adapter", async () => {
    const conv = await convs.getOrCreate("telegram", "u5");
    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "   " }) },
      env,
    );
    expect(await res.text()).toContain("Escribe un mensaje");
    expect(sendReplyMock).not.toHaveBeenCalled();
  });
});

describe("inbox — pause / resume", () => {
  it("pause route pauses the bot and returns the paused thread fragment", async () => {
    const conv = await convs.getOrCreate("telegram", "u6", "Pedro");
    await msgs.append(conv.id, "user", "Hola");

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/pause`,
      { method: "POST", headers: AUTH },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bot pausado");
    expect(await convs.isPaused(conv.id)).toBe(true);
    const fresh = await convs.getById(conv.id);
    const remaining = (fresh?.paused_until ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(19 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(20 * 60 * 1000);
  });

  it("resume clears the pause and redirects back into the inbox", async () => {
    const conv = await convs.getOrCreate("telegram", "u7");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/resume`,
      {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ summary: "Ya lo resolví por teléfono." }),
      },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/admin/conversations?c=${encodeURIComponent(conv.id)}`,
    );
    expect(await convs.isPaused(conv.id)).toBe(false);

    const history = await msgs.lastN(conv.id, 5);
    expect(history[history.length - 1].role).toBe("owner");
    expect(history[history.length - 1].content).toContain("teléfono");
  });
});

describe("inbox — filtros por sentimiento del Analista", () => {
  it("filtra molestos y contentos según conversation_insights", async () => {
    const { InsightsRepo } = await import("../../src/db/insights");
    const insights = new InsightsRepo(db);
    const enojado = await convs.getOrCreate("manychat", "angry1", "Enojado");
    await msgs.append(enojado.id, "user", "pésimo servicio");
    const feliz = await convs.getOrCreate("manychat", "happy1", "Feliz");
    await msgs.append(feliz.id, "user", "todo excelente");
    const base = {
      resolution: "resolved" as const, botScore: 4, topics: [], summary: "x",
      missedKb: null, saleOpportunity: false,
    };
    await insights.upsert({ ...base, conversationId: enojado.id, sentiment: "angry" });
    await insights.upsert({ ...base, conversationId: feliz.id, sentiment: "positive" });

    const molestos = await adminApp.request("/conversations?f=molestos", { headers: AUTH }, env);
    const hm = await molestos.text();
    expect(hm).toContain("Enojado");
    expect(hm).not.toContain("Feliz");

    const contentos = await adminApp.request("/conversations?f=contentos", { headers: AUTH }, env);
    const hc = await contentos.text();
    expect(hc).toContain("Feliz");
    expect(hc).not.toContain("Enojado");
  });
});
