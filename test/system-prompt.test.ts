import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentDateLine,
  renderSystemPrompt,
  systemPromptFromEnv,
  type SystemPromptInput,
} from "../src/system-prompt";

const input: SystemPromptInput = {
  botName: "Asistente",
  businessName: "Barbería Centro",
  language: "es",
  businessContext: "Horarios: Lun-Sáb 10am-8pm\nUbicación: Monterrey",
  toolList: ["searchKb", "handoffHuman", "pauseBot"],
};

describe("renderSystemPrompt", () => {
  it("contains all 10 sections", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("<output_language>");
    expect(prompt).toContain("<role>");
    expect(prompt).toContain("<business_context>");
    expect(prompt).toContain("<identity_and_voice>");
    expect(prompt).toContain("<core_principles>");
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("<escalation_rules>");
    expect(prompt).toContain("<style_guide>");
    expect(prompt).toContain("<anti_patterns>");
  });

  it("replaces every placeholder (none left)", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("}}");
  });

  it("interpolates language, bot name and business name", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("es");
    expect(prompt).toContain("Asistente");
    expect(prompt).toContain("Barbería Centro");
  });

  it("renders tool list as bullet lines", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("- handoffHuman");
    expect(prompt).toContain("- pauseBot");
  });

  it("injects business context", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("Horarios: Lun-Sáb 10am-8pm");
  });

  it("renders customInstructions as an additive block and omits it when absent", () => {
    const withInstructions = renderSystemPrompt({
      ...input,
      customInstructions: "Siempre ofrece agendar una cita al final.",
    });
    expect(withInstructions).toContain("<instrucciones_del_negocio>");
    expect(withInstructions).toContain("Siempre ofrece agendar una cita al final.");

    const without = renderSystemPrompt(input);
    expect(without).not.toContain("<instrucciones_del_negocio>");
    expect(without).not.toContain("{{INSTRUCCIONES}}");

    // Espacios en blanco cuentan como "sin instrucciones":
    const blank = renderSystemPrompt({ ...input, customInstructions: "   " });
    expect(blank).not.toContain("<instrucciones_del_negocio>");
  });

  it("inserts nichoPlaybook when provided and empty string when omitted", () => {
    const withPlaybook = renderSystemPrompt({
      ...input,
      nichoPlaybook: "<diagnostic_playbooks>X</diagnostic_playbooks>",
    });
    expect(withPlaybook).toContain("<diagnostic_playbooks>X</diagnostic_playbooks>");
    // omitted -> the placeholder is gone, replaced by ""
    const withoutPlaybook = renderSystemPrompt(input);
    expect(withoutPlaybook).not.toContain("{{NICHO_PLAYBOOK}}");
  });
});

describe("currentDateLine", () => {
  afterEach(() => vi.useRealTimers());

  it("ancla jueves 2026-08-27 en Europe/Madrid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T15:00:00.000Z"));
    const line = currentDateLine("Europe/Madrid");
    expect(line).toContain("2026-08-27");
    expect(line.toLowerCase()).toContain("jueves");
    expect(line).toContain("Europe/Madrid");
  });
});

describe("systemPromptFromEnv", () => {
  it("asks the model to pass relative date words, not a self-computed YYYY-MM-DD", () => {
    const env = {
      BOT_NAME: "Bot",
      BUSINESS_NAME: "Acme",
      BOT_LANGUAGE: "es",
      CALCOM_TIMEZONE: "Europe/Madrid",
    } as any;
    const prompt = systemPromptFromEnv(env, ["scheduleAppointment"], "ctx");
    expect(prompt).toContain("<contexto_temporal>");
    expect(prompt).toContain("PALABRAS del cliente");
    expect(prompt).not.toContain("y para toda fecha que pases a las tools");
  });

  it("pulls botName/businessName/language from env", () => {
    const env = {
      BOT_NAME: "Bot",
      BUSINESS_NAME: "Acme",
      BOT_LANGUAGE: "en",
    } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb"], "ctx here");
    expect(prompt).toContain("Bot");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("en");
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("ctx here");
  });
});
