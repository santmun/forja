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
    expect(payload.strict).toBe(true);

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

describe("inbox — ventana de 24 h en WhatsApp", () => {
  it("no manda ni guarda el mensaje si la ventana está cerrada", async () => {
    const conv = await convs.getOrCreate("whatsapp", "5215500002222", "Cerrada");
    await msgs.append(conv.id, "user", "hola hace días", { createdAt: Date.now() - 26 * 3_600_000 });

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "seguimiento" }) },
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Sent")).toBeNull();
    expect(await res.text()).toContain("ventana de 24 h está cerrada");
    expect(sendReplyMock).not.toHaveBeenCalled();

    const history = await msgs.lastN(conv.id, 10);
    expect(history.every((m) => m.role !== "owner")).toBe(true);
    expect(await convs.isPaused(conv.id)).toBe(false);
  });

  it("un rechazo del canal no queda guardado como enviado", async () => {
    const conv = await convs.getOrCreate("whatsapp", "5215500003333", "Rechazo");
    await msgs.append(conv.id, "user", "acabo de escribir");
    sendReplyMock.mockRejectedValue(new Error("Fuera de la ventana de 24 h: WhatsApp rechazó el mensaje (131047)."));

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "no debe quedar" }) },
      env,
    );

    expect(await res.text()).toContain("No se pudo enviar");
    expect(res.headers.get("X-Sent")).toBeNull();
    const history = await msgs.lastN(conv.id, 10);
    expect(history.every((m) => m.content !== "no debe quedar")).toBe(true);
    const n = await db.first<{ n: number }>("SELECT COUNT(*) as n FROM message_deliveries");
    expect(n?.n).toBe(0);
  });

  it("con la ventana abierta manda en strict y guarda el wamid", async () => {
    const conv = await convs.getOrCreate("whatsapp", "5215500004444", "Abierta");
    await msgs.append(conv.id, "user", "hola", { createdAt: Date.now() - 3_600_000 });
    sendReplyMock.mockResolvedValue({ providerMessageId: "wamid.panel.1" });

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "te escribo yo" }) },
      env,
    );

    expect(res.headers.get("X-Sent")).toBe("1");
    const [payload] = sendReplyMock.mock.calls[0];
    expect(payload.strict).toBe(true);
    expect(payload.channel).toBe("whatsapp");

    const history = await msgs.lastN(conv.id, 10);
    const owner = history[history.length - 1];
    expect(owner.role).toBe("owner");
    const row = await db.first<{ message_id: string; status: string; conversation_id: string }>(
      "SELECT message_id, status, conversation_id FROM message_deliveries WHERE wamid = ?",
      ["wamid.panel.1"],
    );
    expect(row?.message_id).toBe(owner.id);
    expect(row?.status).toBe("sent");
    expect(row?.conversation_id).toBe(conv.id);
    expect(await res.text()).toContain("✓ Enviado");
  });

  it("Telegram sigue pudiendo responder aunque el cliente no escriba hace días", async () => {
    const conv = await convs.getOrCreate("telegram", "viejo", "Viejo");
    await msgs.append(conv.id, "user", "hola", { createdAt: Date.now() - 10 * 24 * 3_600_000 });

    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(conv.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "sigo aquí" }) },
      env,
    );

    expect(res.headers.get("X-Sent")).toBe("1");
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const history = await msgs.lastN(conv.id, 5);
    expect(history[history.length - 1].content).toBe("sigo aquí");
  });

  it("el panel muestra el candado, las horas y el estado de entrega", async () => {
    const closed = await convs.getOrCreate("whatsapp", "5215500005555", "Sin ventana");
    await msgs.append(closed.id, "user", "hace una semana", { createdAt: Date.now() - 7 * 24 * 3_600_000 });
    const ownerId = await msgs.append(closed.id, "owner", "esto no llegó");
    await db.run(
      `INSERT INTO message_deliveries
        (wamid, message_id, conversation_id, status, error_code, error_title, status_at, updated_at)
       VALUES (?, ?, ?, 'failed', 131047, 'Re-engagement message', ?, ?)`,
      ["wamid.closed", ownerId, closed.id, Date.now(), Date.now()],
    );

    const open = await convs.getOrCreate("whatsapp", "5215500006666", "Con ventana");
    // Un minuto de margen: si el render tarda, el piso de horas no baja de 19.
    await msgs.append(open.id, "user", "hoy", { createdAt: Date.now() - 5 * 3_600_000 + 60_000 });
    const seenId = await msgs.append(open.id, "owner", "ya lo vi");
    await db.run(
      `INSERT INTO message_deliveries
        (wamid, message_id, conversation_id, status, error_code, error_title, status_at, updated_at)
       VALUES (?, ?, ?, 'read', NULL, NULL, ?, ?)`,
      ["wamid.seen", seenId, open.id, Date.now(), Date.now()],
    );

    const page = await adminApp.request("/conversations", { headers: AUTH }, env);
    const html = await page.text();
    expect(html).toContain("Puedo escribirle · 1");
    expect(html).toContain("Ventana cerrada · 1");
    expect(html).toContain("✍ 19 h");
    expect(html).toContain("🔒");

    const closedPage = await adminApp.request(
      `/conversations?c=${encodeURIComponent(closed.id)}`,
      { headers: AUTH },
      env,
    );
    const closedHtml = await closedPage.text();
    expect(closedHtml).toContain("🔒 Ventana cerrada");
    expect(closedHtml).toContain("no acepta un mensaje libre");
    expect(closedHtml).toContain("No le llegó: fuera de la ventana de 24 h");
    expect(closedHtml).not.toContain("Responde como humano");

    const openPage = await adminApp.request(
      `/conversations?c=${encodeURIComponent(open.id)}`,
      { headers: AUTH },
      env,
    );
    const openHtml = await openPage.text();
    expect(openHtml).toContain("Puedes escribirle hasta");
    expect(openHtml).toContain("Responde como humano");
    expect(openHtml).toContain("✓✓ Visto");
    expect(openHtml).not.toContain("no acepta un mensaje libre");

    const onlyClosed = await adminApp.request(
      "/conversations?f=cerrada",
      { headers: AUTH },
      env,
    );
    const list = await onlyClosed.text();
    expect(list).toContain("Sin ventana");
    expect(list).not.toContain("Con ventana");

    const thread = await adminApp.request(
      `/conversations/thread/${encodeURIComponent(closed.id)}`,
      { headers: AUTH },
      env,
    );
    const threadHtml = await thread.text();
    expect(threadHtml).toContain('id="composer-gate"');
    expect(threadHtml).toContain("hx-swap-oob");
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
