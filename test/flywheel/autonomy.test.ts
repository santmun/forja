/**
 * Tests del modo COPILOTO + watchdog: autoApplyPending solo aplica lo seguro
 * (lecciones y kb_entry SIN "[COMPLETA"), marca la evidencia, y el watchdog
 * alerta al dueño con umbral de 3 fallos/30min y throttle de 6h. notifyOwner
 * mockeado; D1 real via miniflare.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyOwnerMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../../src/tools/handoffHuman", () => ({
  notifyOwner: (...args: unknown[]) => notifyOwnerMock(...args),
  handoffNotifyStatus: () => ({ ok: true, channels: ["Telegram"] }),
  handoffHumanTool: () => ({}),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { SuggestionsRepo } from "../../src/db/suggestions";
import { KbDocsRepo } from "../../src/kb/docs";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { autoApplyPending } from "../../src/flywheel/apply";
import { getLessons } from "../../src/flywheel/detect";
import { checkBotHealth, ALERT_THRESHOLD } from "../../src/watchdog";
import { LLM_FAILURE_REPLIES } from "../../src/failureReply";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`,
};
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };

let env: Env;
let db: Db;
let suggestions: SuggestionsRepo;
let settings: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    KB: { upsert: vi.fn(async () => ({})), deleteByIds: vi.fn(async () => ({})) },
    AI: {
      run: vi.fn(async (_m: string, input: { text: string[] }) => ({
        data: input.text.map(() => [0.1, 0.2]),
      })),
    },
    ANTHROPIC_API_KEY: "sk-test",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "Negocio de Prueba",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    DASHBOARD_PASSWORD: PASSWORD,
  } as unknown as Env;
  db = new Db(d1);
  suggestions = new SuggestionsRepo(db);
  settings = new SettingsRepo(db);
  notifyOwnerMock.mockClear();
});

describe("autoApplyPending (copiloto)", () => {
  it("aplica kb_entry completa y lección, salta kb_entry con hueco, y marca la evidencia", async () => {
    const cleanId = (await suggestions.createIfNew({
      kind: "kb_entry",
      fingerprint: "gap:envios",
      title: "Envíos a Guadalajara",
      payload: { title: "Envíos a Guadalajara", content: "Sí hacemos envíos, tardan 3 días." },
      evidence: "2 clientes preguntaron",
    }))!;
    const holeyId = (await suggestions.createIfNew({
      kind: "kb_entry",
      fingerprint: "gap:precio",
      title: "Precio del plan anual",
      payload: { title: "Precio del plan anual", content: "El plan anual cuesta [COMPLETA AQUÍ]." },
      evidence: "1 cliente preguntó",
    }))!;
    const lessonId = (await suggestions.createIfNew({
      kind: "leccion",
      fingerprint: "conv:abc",
      title: "Verificar el pago antes de prometer acceso",
      payload: { lesson: "Verificar el pago antes de prometer acceso" },
      evidence: "aprendida de tu takeover",
    }))!;

    const r = await autoApplyPending(env);
    expect(r.applied).toBe(2);
    expect(r.left).toBe(1);

    // La kb_entry limpia quedó aplicada, indexada y con evidencia marcada.
    const clean = (await suggestions.getById(cleanId))!;
    expect(clean.status).toBe("applied");
    expect(clean.evidence).toContain("aplicada en automático (copiloto)");
    const docs = await new KbDocsRepo(db).list();
    expect(docs.some((d) => d.title === "Envíos a Guadalajara")).toBe(true);

    // La lección entró al prompt.
    expect((await suggestions.getById(lessonId))!.status).toBe("applied");
    expect(await getLessons(env)).toContain("Verificar el pago antes de prometer acceso");

    // La que tiene hueco sigue esperando al dueño, sin marca de automático.
    const holey = (await suggestions.getById(holeyId))!;
    expect(holey.status).toBe("proposed");
    expect(holey.evidence ?? "").not.toContain("automático");
  });

  it("no hace nada cuando no hay pendientes", async () => {
    const r = await autoApplyPending(env);
    expect(r).toEqual({ applied: 0, left: 0 });
  });
});

describe("watchdog (checkBotHealth)", () => {
  async function seedFailures(n: number, at: number, text = "Algo falló de mi lado, ¿me repites tu mensaje?") {
    const convs = new ConversationsRepo(db);
    const msgs = new MessagesRepo(db);
    const conv = await convs.getOrCreate("twilio", "wd-user");
    for (let i = 0; i < n; i++) {
      await msgs.append(conv.id, "assistant", text);
    }
    // Fuerza el created_at dentro/fuera de la ventana según el test.
    await db.run("UPDATE messages SET created_at = ? WHERE role = 'assistant'", [at]);
  }

  it("alerta al dueño con 3+ fallos en 30 min", async () => {
    const now = 1_800_000_000_000;
    await seedFailures(ALERT_THRESHOLD, now - 5 * 60_000);

    const r = await checkBotHealth(env, now);
    expect(r).toEqual({ failures: 3, alerted: true });
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
    const [, notice] = notifyOwnerMock.mock.calls[0] as unknown[] as [Env, { reason: string; summary: string }];
    expect(notice.reason).toBe("salud del bot");
    expect(notice.summary).toContain("3 respuestas fallidas");
  });

  it("cuenta también la respuesta de falla nueva (tono humano, es y en)", async () => {
    const now = 1_800_000_000_000;
    await seedFailures(2, now - 5 * 60_000, LLM_FAILURE_REPLIES.es);
    await seedFailures(1, now - 5 * 60_000, LLM_FAILURE_REPLIES.en);
    const r = await checkBotHealth(env, now);
    expect(r).toEqual({ failures: 3, alerted: true });
  });

  it("no alerta bajo el umbral ni con fallos viejos", async () => {
    const now = 1_800_000_000_000;
    await seedFailures(2, now - 5 * 60_000);
    expect((await checkBotHealth(env, now)).alerted).toBe(false);

    // 5 fallos pero de hace 2 horas → fuera de la ventana de 30 min.
    await seedFailures(5, now - 2 * 60 * 60_000);
    expect((await checkBotHealth(env, now)).alerted).toBe(false);
    expect(notifyOwnerMock).not.toHaveBeenCalled();
  });

  it("throttle: no repite la alerta dentro de las 6 horas", async () => {
    const now = 1_800_000_000_000;
    await seedFailures(4, now - 5 * 60_000);

    expect((await checkBotHealth(env, now)).alerted).toBe(true);
    expect((await checkBotHealth(env, now + 60_000)).alerted).toBe(false);
    // Pasadas las 6h (fallos aún dentro de ventana simulada) vuelve a alertar.
    await db.run("UPDATE messages SET created_at = ?", [now + 7 * 60 * 60_000 - 5 * 60_000]);
    expect((await checkBotHealth(env, now + 7 * 60 * 60_000)).alerted).toBe(true);
    expect(notifyOwnerMock).toHaveBeenCalledTimes(2);
  });
});

describe("ruta /mejoras/autonomy + UI", () => {
  it("activa copiloto, se refleja en la vista, y regresa a manual", async () => {
    const res = await adminApp.request(
      "/mejoras/autonomy",
      { method: "POST", headers: FORM, body: new URLSearchParams({ level: "copilot" }) },
      env,
    );
    expect(res.status).toBe(302);
    expect(await settings.get(SETTING_KEYS.autonomyLevel)).toBe("copilot");

    const page = await adminApp.request("/mejoras", { headers: AUTH }, env);
    const html = await page.text();
    expect(html).toContain("COPILOTO ACTIVO");
    expect(html).toContain("Volver a manual");

    await adminApp.request(
      "/mejoras/autonomy",
      { method: "POST", headers: FORM, body: new URLSearchParams({ level: "manual" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.autonomyLevel)).toBe("manual");
  });

  it("un valor raro cae a manual", async () => {
    await adminApp.request(
      "/mejoras/autonomy",
      { method: "POST", headers: FORM, body: new URLSearchParams({ level: "hackerman" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.autonomyLevel)).toBe("manual");
  });
});
