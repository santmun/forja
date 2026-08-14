import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../src/db/settings";
import { resolveAgentConfig } from "../src/settings-loader";

const TOOLS = ["searchKb", "handoffHuman"];

let env: any;
let repo: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = {
    DB: d1,
    BOT_NAME: "Asistente",
    BUSINESS_NAME: "Test Business",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "12",
  };
  repo = new SettingsRepo(new Db(d1 as any));
});

describe("resolveAgentConfig", () => {
  it("uses env/defaults when settings are empty", async () => {
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.bufferMs).toBe(12_000); // from BUFFER_SECONDS
    expect(cfg.maxChunks).toBe(3);
    expect(cfg.interChunkDelayMs).toBe(1000);
    expect(cfg.modelOverride).toBe("auto");
    expect(cfg.botPaused).toBe(false);
    expect(cfg.systemPrompt).toContain("Asistente"); // env BOT_NAME
    expect(cfg.systemPrompt).toContain("<role>");
    expect(cfg.systemPrompt).not.toContain("{{");
  });

  it("system_prompt_override wins over the generated prompt", async () => {
    await repo.set(SETTING_KEYS.systemPromptOverride, "MI PROMPT CUSTOM");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toBe("MI PROMPT CUSTOM");
  });

  it("applies bot_name, tone and escalation_keywords into the generated prompt", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    await repo.set(SETTING_KEYS.tone, "divertido y relajado");
    await repo.set(SETTING_KEYS.escalationKeywords, "reembolso, gerente");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("Pelusa");
    expect(cfg.systemPrompt).toContain("divertido y relajado");
    expect(cfg.systemPrompt).toContain("reembolso, gerente");
  });

  it("uses business_context override when present", async () => {
    await repo.set(SETTING_KEYS.businessContext, "MI CONTEXTO DE NEGOCIO");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("MI CONTEXTO DE NEGOCIO");
  });

  it("buffer_seconds overrides env and enforces a 1000ms floor", async () => {
    await repo.set(SETTING_KEYS.bufferSeconds, "5");
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.bufferMs).toBe(5000);

    await repo.set(SETTING_KEYS.bufferSeconds, "0");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.bufferMs).toBe(1000);
  });

  it("clamps max_chunks to 1..5", async () => {
    await repo.set(SETTING_KEYS.maxChunks, "99");
    expect((await resolveAgentConfig(env, TOOLS)).maxChunks).toBe(5);
    await repo.set(SETTING_KEYS.maxChunks, "0");
    expect((await resolveAgentConfig(env, TOOLS)).maxChunks).toBe(1);
    await repo.set(SETTING_KEYS.maxChunks, "2");
    expect((await resolveAgentConfig(env, TOOLS)).maxChunks).toBe(2);
  });

  it("clamps inter_chunk_delay_ms to 0..5000", async () => {
    await repo.set(SETTING_KEYS.interChunkDelayMs, "999999");
    expect((await resolveAgentConfig(env, TOOLS)).interChunkDelayMs).toBe(5000);
    await repo.set(SETTING_KEYS.interChunkDelayMs, "-50");
    expect((await resolveAgentConfig(env, TOOLS)).interChunkDelayMs).toBe(0);
  });

  it("parses model_override and falls back to auto for garbage", async () => {
    await repo.set(SETTING_KEYS.modelOverride, "haiku");
    expect((await resolveAgentConfig(env, TOOLS)).modelOverride).toBe("haiku");
    await repo.set(SETTING_KEYS.modelOverride, "sonnet");
    expect((await resolveAgentConfig(env, TOOLS)).modelOverride).toBe("sonnet");
    await repo.set(SETTING_KEYS.modelOverride, "nonsense");
    expect((await resolveAgentConfig(env, TOOLS)).modelOverride).toBe("auto");
  });

  it("reads bot_paused as a boolean (1 => true, anything else => false)", async () => {
    await repo.set(SETTING_KEYS.botPaused, "1");
    expect((await resolveAgentConfig(env, TOOLS)).botPaused).toBe(true);
    await repo.set(SETTING_KEYS.botPaused, "0");
    expect((await resolveAgentConfig(env, TOOLS)).botPaused).toBe(false);
  });
});

describe("resolveAgentConfig — disabled_tools", () => {
  it("filters enabledToolNames and the prompt's tool list", async () => {
    await repo.set(SETTING_KEYS.disabledTools, "handoffHuman");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(["searchKb"]);
    expect(cfg.systemPrompt).toContain("- searchKb");
    expect(cfg.systemPrompt).not.toContain("- handoffHuman");
  });

  it("keeps everything enabled when the setting is absent or empty", async () => {
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(TOOLS);

    await repo.set(SETTING_KEYS.disabledTools, "  ");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(TOOLS);
  });

  it("ignores unknown names in the setting", async () => {
    await repo.set(SETTING_KEYS.disabledTools, "noExiste, searchKb");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.enabledToolNames).toEqual(["handoffHuman"]);
  });
});

describe("resolveAgentConfig — temperature", () => {
  it("is undefined when unset (provider default)", async () => {
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.temperature).toBeUndefined();
  });

  it("parses and clamps the stored value to [0, 1]", async () => {
    await repo.set(SETTING_KEYS.temperature, "0.3");
    expect((await resolveAgentConfig(env, TOOLS)).temperature).toBe(0.3);

    await repo.set(SETTING_KEYS.temperature, "7");
    expect((await resolveAgentConfig(env, TOOLS)).temperature).toBe(1);
  });

  it("ignores garbage values", async () => {
    await repo.set(SETTING_KEYS.temperature, "caliente");
    expect((await resolveAgentConfig(env, TOOLS)).temperature).toBeUndefined();
  });
});

describe("resolveAgentConfig — custom_instructions", () => {
  it("suma las instrucciones al prompt generado sin congelarlo", async () => {
    await repo.set(SETTING_KEYS.customInstructions, "Siempre ofrece agendar una cita al final.");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("<instrucciones_del_negocio>");
    expect(cfg.systemPrompt).toContain("Siempre ofrece agendar una cita al final.");
    // El resto del cerebro sigue ahí — sumar, no reemplazar:
    expect(cfg.systemPrompt).toContain("<role>");
    expect(cfg.systemPrompt).toContain("<business_context>");
    expect(cfg.systemPrompt).toContain("<anti_patterns>");
  });

  it("omite el bloque cuando no hay instrucciones (o son espacios)", async () => {
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<instrucciones_del_negocio>");

    await repo.set(SETTING_KEYS.customInstructions, "   ");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<instrucciones_del_negocio>");
  });

  it("con un prompt manual activo NO aplican (el override es 'tal cual')", async () => {
    await repo.set(SETTING_KEYS.customInstructions, "Siempre ofrece agendar una cita.");
    await repo.set(SETTING_KEYS.systemPromptOverride, "MI PROMPT CUSTOM");
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toBe("MI PROMPT CUSTOM");
  });
});

describe("resolveAgentConfig — learned lessons (flywheel)", () => {
  it("injects lessons into the generated prompt", async () => {
    await repo.set(SETTING_KEYS.learnedLessons, JSON.stringify(["Confirma el pago antes de prometer acceso."]));
    const cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).toContain("<lecciones_aprendidas>");
    expect(cfg.systemPrompt).toContain("Confirma el pago antes de prometer acceso.");
  });

  it("omits the block without lessons and tolerates malformed JSON", async () => {
    let cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<lecciones_aprendidas>");

    await repo.set(SETTING_KEYS.learnedLessons, "{no es json");
    cfg = await resolveAgentConfig(env, TOOLS);
    expect(cfg.systemPrompt).not.toContain("<lecciones_aprendidas>");
  });
});
