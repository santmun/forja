/**
 * Tests for the "Mi Agente" tab: n8n-style canvas, node panels, and the tool
 * on/off toggle (settings.disabled_tools). Real D1 via miniflare; no LLM calls
 * happen in these routes (tool construction is side-effect free).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { ConversationsRepo } from "../../src/db/conversations";
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

let env: Env;
let settings: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    ANTHROPIC_API_KEY: "sk-test",
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "Negocio de Prueba",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    DASHBOARD_PASSWORD: PASSWORD,
  } as unknown as Env;
  settings = new SettingsRepo(new Db(d1));
});

describe("Mi Agente — page and canvas", () => {
  it("renders the canvas with the core nodes and the pro tools", async () => {
    const res = await adminApp.request("/agente", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Mi Agente");
    expect(html).toContain("Buffer");
    expect(html).toContain("Respuesta");
    expect(html).toContain("Modelo");
    expect(html).toContain("Memoria");
    // Pro tier: tools de producción, incluida la pausa anti-bot.
    for (const tool of ["searchKb", "handoffHuman", "pauseBot", "pauseSuspectedBot", "captureLead", "scheduleAppointment", "catalogQuery"]) {
      expect(html).toContain(tool);
    }
    // Buffer shows the effective seconds from env
    expect(html).toContain("8 s");
  });

  it("oculta pauseSuspectedBot en el canvas cuando DEMO_MODE=on", async () => {
    const res = await adminApp.request(
      "/agente",
      { headers: AUTH },
      { ...env, DEMO_MODE: "on" } as Env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("pauseSuspectedBot");
    expect(html).toContain("pauseBot");
    expect(html).toContain("searchKb");
  });

  it("shows real channels from the conversations table", async () => {
    const convs = new ConversationsRepo(new Db(env.DB));
    await convs.getOrCreate("telegram", "u1");
    const res = await adminApp.request("/agente/canvas", { headers: AUTH }, env);
    const html = await res.text();
    expect(html).toContain("Telegram");
    expect(html).toContain("1 conversación");
  });

  it("requires auth", async () => {
    const res = await adminApp.request("/agente", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("Mi Agente — node panels", () => {
  it("brain panel shows the effective system prompt", async () => {
    const res = await adminApp.request("/agente/node/brain", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("prompt efectivo");
    // The rendered prompt itself is embedded (escaped) — role tag included:
    expect(html).toContain("&lt;role&gt;");
    expect(html).toContain("TestBot");
  });

  it("tool panel shows usage and the toggle button", async () => {
    const res = await adminApp.request("/agente/node/tool%3AcaptureLead", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Capturar lead");
    expect(html).toContain("Apagar tool");
  });
});

describe("Mi Agente — tool toggle", () => {
  it("disables and re-enables a tool via settings.disabled_tools", async () => {
    // Toggle off
    let res = await adminApp.request(
      "/agente/tools/catalogQuery/toggle",
      { method: "POST", headers: AUTH },
      env,
    );
    expect(res.status).toBe(200);
    expect(await settings.get(SETTING_KEYS.disabledTools)).toBe("catalogQuery");
    expect(await res.text()).toContain("Encender tool");

    // Toggle back on
    res = await adminApp.request(
      "/agente/tools/catalogQuery/toggle",
      { method: "POST", headers: AUTH },
      env,
    );
    expect(await settings.get(SETTING_KEYS.disabledTools)).toBe("");
    expect(await res.text()).toContain("Apagar tool");
  });

  it("rejects unknown tool names", async () => {
    const res = await adminApp.request(
      "/agente/tools/noExiste/toggle",
      { method: "POST", headers: AUTH },
      env,
    );
    expect(res.status).toBe(404);
    expect(await settings.get(SETTING_KEYS.disabledTools)).toBeNull();
  });

  it("disabled tools render as OFF in the canvas", async () => {
    await settings.set(SETTING_KEYS.disabledTools, "scheduleAppointment");
    const res = await adminApp.request("/agente/canvas", { headers: AUTH }, env);
    const html = await res.text();
    expect(html).toContain("apagada");
    expect(html).toContain("OFF");
  });
});

describe("Mi Agente — node save (modals)", () => {
  it("saves the buffer seconds with clamping", async () => {
    const res = await adminApp.request(
      "/agente/node/buffer/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ buffer_seconds: "12" }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("HX-Trigger")).toBe("canvas-refresh");
    expect(await settings.get(SETTING_KEYS.bufferSeconds)).toBe("12");
    expect(await res.text()).toContain("Guardado");

    // Out of range clamps to the max.
    await adminApp.request(
      "/agente/node/buffer/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ buffer_seconds: "999" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.bufferSeconds)).toBe("60");
  });

  it("saves reply chunks and converts the delay from seconds to ms", async () => {
    await adminApp.request(
      "/agente/node/reply/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ max_chunks: "4", inter_chunk_delay_s: "1.5" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.maxChunks)).toBe("4");
    expect(await settings.get(SETTING_KEYS.interChunkDelayMs)).toBe("1500");
  });

  it("saves model override and temperature", async () => {
    await adminApp.request(
      "/agente/node/model/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ model_override: "haiku", temperature: "0.3" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.modelOverride)).toBe("haiku");
    expect(await settings.get(SETTING_KEYS.temperature)).toBe("0.3");
  });

  it("rejects an invalid model override value", async () => {
    await adminApp.request(
      "/agente/node/model/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ model_override: "gpt-5" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.modelOverride)).toBeNull();
  });

  it("brain: saves a manual prompt, then resets back to automatic", async () => {
    await adminApp.request(
      "/agente/node/brain/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ system_prompt_override: "MI PROMPT MANUAL" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.systemPromptOverride)).toBe("MI PROMPT MANUAL");

    // The modal now reflects manual mode.
    const modal = await adminApp.request("/agente/node/brain", { headers: AUTH }, env);
    expect(await modal.text()).toContain("manual");

    // Reset wins over the textarea content.
    await adminApp.request(
      "/agente/node/brain/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "reset", system_prompt_override: "lo que sea" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.systemPromptOverride)).toBe("");
  });

  it("brain: toggles the global pause", async () => {
    await adminApp.request(
      "/agente/node/brain/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ bot_paused: "1" }) },
      env,
    );
    expect(await settings.get(SETTING_KEYS.botPaused)).toBe("1");
    const modal = await adminApp.request("/agente/node/brain", { headers: AUTH }, env);
    expect(await modal.text()).toContain("Reactivar el bot");
  });

  it("unknown node id returns 404", async () => {
    const res = await adminApp.request(
      "/agente/node/bogus/save",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ x: "1" }) },
      env,
    );
    expect(res.status).toBe(404);
  });
});
