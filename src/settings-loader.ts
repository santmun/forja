import type { Env } from "./env";
import { Db } from "./db/client";
import { SettingsRepo, SETTING_KEYS } from "./db/settings";
import { systemPromptFromEnv } from "./system-prompt";
import { renderBusinessContext } from "./businessContext";
import { getBufferMs } from "./config";
import { getNiche } from "./niches";
import type { LlmOverrides } from "./llm/provider";

export type ModelOverride = "auto" | "haiku" | "sonnet";

export interface AgentConfig {
  systemPrompt: string;
  bufferMs: number;
  maxChunks: number;
  interChunkDelayMs: number;
  modelOverride: ModelOverride;
  botPaused: boolean;
  /** Tool names still enabled after applying the dashboard's disabled_tools. */
  enabledToolNames: string[];
  /** Sampling temperature (0-1). undefined = use the provider default. */
  temperature?: number;
  /** Monthly AI budget (USD). undefined = no cap. */
  monthlyBudgetUsd?: number;
  /** BYO-LLM del dashboard (proveedor / API key / modelo). */
  llm: LlmOverrides;
}

/** Extract the BYO-LLM overrides from a settings snapshot. */
export function llmOverridesFrom(settings: Record<string, string>): LlmOverrides {
  const pick = (key: string): string | undefined => {
    const v = settings[key];
    return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
  };
  return {
    provider: pick(SETTING_KEYS.llmProvider),
    apiKey: pick(SETTING_KEYS.llmApiKey),
    model: pick(SETTING_KEYS.llmModel),
  };
}

/** Load just the BYO-LLM overrides (para analyzer/flywheel/admin, fuera del agente).
 *  Nunca truena: si settings no está disponible, se usan los defaults del env. */
export async function loadLlmOverrides(env: Env): Promise<LlmOverrides> {
  try {
    const settings = await new SettingsRepo(new Db(env.DB)).all();
    return llmOverridesFrom(settings);
  } catch {
    return {};
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function normalizeModelOverride(value: string | undefined): ModelOverride {
  if (value === "haiku" || value === "sonnet" || value === "auto") return value;
  return "auto";
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the effective agent config by overlaying D1 `settings` on top of env
 * defaults. Anything empty/absent in settings falls back to the env/default.
 */
export async function resolveAgentConfig(env: Env, toolNames: string[]): Promise<AgentConfig> {
  const repo = new SettingsRepo(new Db(env.DB));
  const settings = await repo.all();

  const get = (key: string): string | undefined => {
    const v = settings[key];
    return v !== undefined && v.trim() !== "" ? v : undefined;
  };

  // Niche pack activo (BOT_NICHE). Aporta el playbook del giro y un tono por
  // defecto; ambos se pueden sobreescribir desde el panel.
  const niche = getNiche(env);

  const systemPromptOverride = get(SETTING_KEYS.systemPromptOverride);
  // Reglas del dueño que se SUMAN al prompt GENERADO (mismo trato que las
  // lecciones): con un override manual activo no aplican — el override es
  // "úsalo tal cual", y el panel lo advierte junto al campo.
  const customInstructions = get(SETTING_KEYS.customInstructions);
  const businessContext = get(SETTING_KEYS.businessContext) ?? renderBusinessContext();
  const botName = get(SETTING_KEYS.botName) ?? env.BOT_NAME;
  // Tono elegido en el panel gana; si no hay, el tono por defecto del nicho.
  const tone = get(SETTING_KEYS.tone) ?? (niche.defaultTone || undefined);
  const escalationKeywords = parseCsvList(get(SETTING_KEYS.escalationKeywords));

  // Flywheel lessons (JSON array). Only injected into the GENERATED prompt —
  // a manual override replaces the whole prompt, lessons included.
  let lessons: string[] = [];
  try {
    const parsed = JSON.parse(get(SETTING_KEYS.learnedLessons) ?? "[]");
    if (Array.isArray(parsed)) lessons = parsed.filter((l) => typeof l === "string");
  } catch { /* malformed setting — ignore */ }

  // Dashboard tool toggles: the prompt only advertises the enabled tools, so
  // the model never tries to call something that was turned off.
  const disabledTools = parseCsvList(get(SETTING_KEYS.disabledTools));
  const enabledToolNames = toolNames.filter((n) => !disabledTools.includes(n));

  const systemPrompt =
    systemPromptOverride ??
    systemPromptFromEnv(env, enabledToolNames, businessContext, niche.playbook || undefined, {
      tone,
      extraEscalationKeywords: escalationKeywords,
      botName,
      lessons,
      customInstructions,
    });

  const bufferSecondsRaw = get(SETTING_KEYS.bufferSeconds);
  const bufferMs =
    bufferSecondsRaw !== undefined
      ? Math.max(1000, parseIntOr(bufferSecondsRaw, 1) * 1000)
      : getBufferMs(env);

  const maxChunks = clamp(parseIntOr(get(SETTING_KEYS.maxChunks), 3), 1, 5);
  const interChunkDelayMs = clamp(parseIntOr(get(SETTING_KEYS.interChunkDelayMs), 1000), 0, 5000);
  const modelOverride = normalizeModelOverride(get(SETTING_KEYS.modelOverride));
  const botPaused = get(SETTING_KEYS.botPaused) === "1";

  const tempRaw = get(SETTING_KEYS.temperature);
  let temperature: number | undefined;
  if (tempRaw !== undefined) {
    const t = Number.parseFloat(tempRaw);
    if (!Number.isNaN(t)) temperature = clamp(t, 0, 1);
  }

  const budgetRaw = get(SETTING_KEYS.monthlyBudget);
  let monthlyBudgetUsd: number | undefined;
  if (budgetRaw !== undefined) {
    const b = Number.parseFloat(budgetRaw);
    if (!Number.isNaN(b) && b > 0) monthlyBudgetUsd = b;
  }

  return {
    systemPrompt,
    bufferMs,
    maxChunks,
    interChunkDelayMs,
    modelOverride,
    botPaused,
    enabledToolNames,
    temperature,
    monthlyBudgetUsd,
    llm: llmOverridesFrom(settings),
  };
}
