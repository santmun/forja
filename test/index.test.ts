import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";

// `src/index.ts` re-exports `SupportAgent` from `./agent`, which imports the
// `agents` SDK. `agents` (via `partyserver`) imports the virtual
// `cloudflare:workers` module at load time, which Node's ESM loader can't
// resolve outside workerd. Mock the `agents` package so the import graph stays
// in Node-land — we only exercise the Hono router here. Tests that need real
// agent/runtime behavior use Miniflare instead.
vi.mock("agents", () => ({ Agent: class {} }));

import worker from "../src/index";

const env = {
  BOT_NAME: "Testi",
  BUSINESS_NAME: "Test",
  BOT_LANGUAGE: "es",
  BOT_TIER: "pro",
  BUFFER_SECONDS: "15",
  DASHBOARD_BASE_URL: "https://test.workers.dev",
} as any;

describe("Worker entry", () => {
  it("returns 200 on /health", async () => {
    const res = await worker.fetch(new Request("https://test/health"), env, {} as any);
    expect(res.status).toBe(200);
  });

  it("returns 404 on unknown route", async () => {
    const res = await worker.fetch(new Request("https://test/nope"), env, {} as any);
    expect(res.status).toBe(404);
  });
});

// Los webhooks de Telegram/Manychat/Twilio deben rechazar (403) cualquier POST
// que no traiga la firma/secret correcta, ANTES de tocar el agente — así se
// evita que cualquiera que adivine la URL del Worker mande mensajes falsos.
// (El caso "firma válida" no se asserta como 200 aquí porque routeToAgent
// llama al Durable Object AGENT vía RPC, que este entorno de test no monta;
// alcanza con confirmar que la verificación deja de bloquear con 403.)
// Las rutas ahora también consultan D1 para el throttle por IP (rate-limit.ts),
// así que estos tests necesitan un binding DB real — viene de Miniflare, igual
// que test/learn/endpoint.test.ts.
describe("Webhook signature/secret guards (fail-closed)", () => {
  let dbEnv: any;

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = await mf.getD1Database("DB");
    dbEnv = { ...env, DB: d1 };
  });

  it("POST /webhooks/telegram: 403 without TELEGRAM_WEBHOOK_SECRET configured", async () => {
    const res = await worker.fetch(
      new Request("https://test/webhooks/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "whatever" },
        body: JSON.stringify({ update_id: 1 }),
      }),
      dbEnv,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("POST /webhooks/telegram: 403 with the wrong secret header", async () => {
    const res = await worker.fetch(
      new Request("https://test/webhooks/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong" },
        body: JSON.stringify({ update_id: 1 }),
      }),
      { ...dbEnv, TELEGRAM_WEBHOOK_SECRET: "correct-secret" },
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("POST /webhooks/telegram: NOT 403 with the correct secret header", async () => {
    const res = await worker.fetch(
      new Request("https://test/webhooks/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "correct-secret" },
        body: JSON.stringify({ update_id: 1 }),
      }),
      { ...dbEnv, TELEGRAM_WEBHOOK_SECRET: "correct-secret" },
      {} as any,
    );
    expect(res.status).not.toBe(403);
  });

  it("POST /webhooks/manychat: 403 without MANYCHAT_WEBHOOK_SECRET configured", async () => {
    const res = await worker.fetch(
      new Request("https://test/webhooks/manychat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "1" }),
      }),
      dbEnv,
      {} as any,
    );
    expect(res.status).toBe(403);
  });

  it("POST /webhooks/manychat: NOT 403 with the correct secret header", async () => {
    const res = await worker.fetch(
      new Request("https://test/webhooks/manychat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Manychat-Secret": "mc-correct" },
        body: JSON.stringify({ id: "1" }),
      }),
      { ...dbEnv, MANYCHAT_WEBHOOK_SECRET: "mc-correct" },
      {} as any,
    );
    expect(res.status).not.toBe(403);
  });

  it("POST /webhooks/twilio: 403 without a valid X-Twilio-Signature", async () => {
    const body = new URLSearchParams({ From: "whatsapp:+1", To: "whatsapp:+2", Body: "hola", NumMedia: "0" });
    const res = await worker.fetch(
      new Request("https://test/webhooks/twilio", { method: "POST", body }),
      { ...dbEnv, TWILIO_AUTH_TOKEN: "tok" },
      {} as any,
    );
    expect(res.status).toBe(403);
  });
});

// Throttle por IP: N+1º request en la misma ventana → 429, ANTES incluso de
// mirar la firma/token (así una ráfaga no le cuesta ni un HMAC al Worker).
describe("Rate limiting (defense in depth)", () => {
  let dbEnv: any;

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    const d1 = await mf.getD1Database("DB");
    dbEnv = { ...env, DB: d1, TELEGRAM_WEBHOOK_SECRET: "s", KB_REINDEX_TOKEN: "kbtok" };
  });

  function telegramReq() {
    return new Request("https://test/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong", // el throttle debe disparar ANTES del 403 por firma
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
  }

  it("429s after 20 requests/min from the same IP", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) {
      last = await worker.fetch(telegramReq(), dbEnv, {} as any);
    }
    expect(last?.status).toBe(429);
  });

  it("a different IP is not affected by another IP's flood", async () => {
    for (let i = 0; i < 21; i++) await worker.fetch(telegramReq(), dbEnv, {} as any);
    const freshIp = new Request("https://test/webhooks/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong",
        "CF-Connecting-IP": "198.51.100.7",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    const res = await worker.fetch(freshIp, dbEnv, {} as any);
    expect(res.status).toBe(403); // rechazado por firma, no por rate limit
  });

  it("/kb/reindex throttles at a stricter 5/min", async () => {
    const req = () =>
      new Request("https://test/kb/reindex", {
        method: "POST",
        headers: { "X-Reindex-Token": "wrong", "CF-Connecting-IP": "203.0.113.50" },
      });
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) last = await worker.fetch(req(), dbEnv, {} as any);
    expect(last?.status).toBe(429);
  });
});
