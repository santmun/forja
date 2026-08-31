import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { Env } from "../env";
import type { Tier } from "../upgrade/modelSelector";

/**
 * LLM provider abstraction.
 *
 * The bot's chat brain can run on Anthropic (default) or OpenAI. Model selection
 * is decoupled into TIERS ("fast" = cheap default, "smart" = upgrade); each
 * provider maps a tier to a concrete model id (env-overridable). Embeddings and
 * voice transcription stay on Cloudflare Workers AI regardless of this setting.
 */
export type LlmProvider = "anthropic" | "openai" | "xai";

const ANTHROPIC_DEFAULTS: Record<Tier, string> = {
  fast: "claude-haiku-4-5-20251001",
  smart: "claude-sonnet-4-5-20250929",
};

const OPENAI_DEFAULTS: Record<Tier, string> = {
  fast: "gpt-4o-mini",
  smart: "gpt-4o",
};

const XAI_DEFAULTS: Record<Tier, string> = {
  fast: "grok-4-fast-non-reasoning",
  smart: "grok-4",
};

/**
 * Owner overrides from the dashboard (D1 `settings`): provider, BYO API key
 * and/or a concrete model id. Anything empty falls back to env behavior.
 * Load with `loadLlmOverrides()` (settings-loader) and pass to createModel.
 */
export interface LlmOverrides {
  provider?: string;
  apiKey?: string;
  model?: string;
}

/** Models offered in the dashboard picker. */
export const CURATED_MODELS: { id: string; label: string; provider: LlmProvider }[] = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 · rápido y barato", provider: "anthropic" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5 · equilibrado", provider: "anthropic" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 · el mejor equilibrio", provider: "anthropic" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 · máxima inteligencia", provider: "anthropic" },
  { id: "gpt-4o-mini", label: "GPT-4o mini · rápido y barato", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o · equilibrado", provider: "openai" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini · rápido", provider: "openai" },
  { id: "gpt-4.1", label: "GPT-4.1 · más capaz", provider: "openai" },
  { id: "grok-4-fast-non-reasoning", label: "Grok 4 Fast · rápido y barato", provider: "xai" },
  { id: "grok-3-mini", label: "Grok 3 mini · económico", provider: "xai" },
  { id: "grok-4", label: "Grok 4 · más capaz", provider: "xai" },
];

/**
 * Decide which provider to use. Explicit LLM_PROVIDER wins; otherwise, if only
 * an OpenAI key is set, use OpenAI; default to Anthropic.
 */
export function resolveProvider(env: Env): LlmProvider {
  const explicit = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "openai") return "openai";
  if (explicit === "anthropic") return "anthropic";
  // BUG FIX 2026-07-12: faltaba la rama xai — LLM_PROVIDER="xai" caía al
  // default (anthropic), dejando a Grok como mero fallback todo el tiempo.
  if (explicit === "xai") return "xai";
  if (!env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY) return "openai";
  return "anthropic";
}

/** Resolve the concrete model id for a provider + tier (env-overridable). */
export function modelIdFor(env: Env, provider: LlmProvider, tier: Tier): string {
  if (provider === "openai") {
    const smart = env.OPENAI_MODEL_SMART?.trim() || OPENAI_DEFAULTS.smart;
    const fast = env.OPENAI_MODEL_FAST?.trim() || OPENAI_DEFAULTS.fast;
    return tier === "smart" ? smart : fast;
  }
  if (provider === "xai") {
    return tier === "smart" ? XAI_DEFAULTS.smart : XAI_DEFAULTS.fast;
  }
  const smart = env.ANTHROPIC_MODEL_SMART?.trim() || ANTHROPIC_DEFAULTS.smart;
  const fast = env.ANTHROPIC_MODEL_FAST?.trim() || ANTHROPIC_DEFAULTS.fast;
  return tier === "smart" ? smart : fast;
}

export interface ResolvedModel {
  provider: LlmProvider;
  modelId: string;
  /** AI SDK LanguageModel instance, ready to pass to streamText/generateText. */
  model: any;
  /** Only Anthropic supports the ephemeral prompt-cache breakpoint we use. */
  supportsPromptCache: boolean;
}

/** env API key for a provider. */
function envKeyFor(env: Env, provider: LlmProvider): string | undefined {
  if (provider === "openai") return env.OPENAI_API_KEY;
  if (provider === "xai") return env.XAI_API_KEY;
  return env.ANTHROPIC_API_KEY;
}

/**
 * Build the AI SDK model for the given tier. Dashboard overrides (BYO key /
 * provider / concrete model) win over env. Si el dueño eligió un proveedor
 * para el que no hay NINGUNA llave (ni suya ni del sistema), caemos al default
 * del env — el bot nunca se queda mudo por una config incompleta.
 */
export function createModel(env: Env, tier: Tier, ov?: LlmOverrides): ResolvedModel {
  const ovModel = (ov?.model ?? "").trim();
  const ovProviderRaw = (ov?.provider ?? "").trim().toLowerCase();

  let provider: LlmProvider | null =
    ovProviderRaw === "anthropic" || ovProviderRaw === "openai" || ovProviderRaw === "xai"
      ? ovProviderRaw
      : null;
  // Modelo elegido sin proveedor explícito → dedúcelo del id.
  if (!provider && ovModel) {
    provider = /^grok/i.test(ovModel)
      ? "xai"
      : /^(gpt|o\d)/i.test(ovModel)
        ? "openai"
        : "anthropic";
  }
  if (!provider) provider = resolveProvider(env);

  const ovKey = (ov?.apiKey ?? "").trim();
  let apiKey = ovKey || envKeyFor(env, provider);
  let useOvModel = ovModel;
  if (!apiKey) {
    console.warn(`[llm] no API key for provider "${provider}" — falling back to env default`);
    provider = resolveProvider(env);
    apiKey = envKeyFor(env, provider);
    useOvModel = ""; // el modelo elegido era del proveedor sin llave — no aplica
  }

  const modelId = useOvModel || modelIdFor(env, provider, tier);

  if (provider === "openai") {
    const openai = createOpenAI({ apiKey });
    // Chat Completions (`openai.chat`), NO la Responses API que es el default
    // de `openai(modelId)` desde AI SDK 5. Responses trata las function tools
    // como JSON Schema strict si `strict` se omite; nuestras tools (y las de
    // giros Forja+ como coach: agendarCita/cancelarCita) usan muchos
    // `.optional()` / `.default()` y OpenAI responde 400 Bad Request → el bot
    // contesta "Algo falló de mi lado...". El mismo payload por Chat Completions
    // (lo que se prueba con curl) acepta parámetros opcionales.
    // `.chat` existe en @ai-sdk/openai v3 y v4; el fallback cubre mocks viejos.
    const model =
      typeof (openai as any).chat === "function"
        ? (openai as any).chat(modelId)
        : openai(modelId);
    return { provider, modelId, model, supportsPromptCache: false };
  }

  if (provider === "xai") {
    const xai = createXai({ apiKey });
    return { provider, modelId, model: xai(modelId), supportsPromptCache: false };
  }

  const anthropic = createAnthropic({ apiKey });
  return { provider, modelId, model: anthropic(modelId), supportsPromptCache: true };
}

/**
 * Plan B ante fallo del proveedor primario (rate limit, 5xx, red): el primer
 * proveedor DISTINTO al que falló que tenga API key en el env, con sus modelos
 * default del tier. null = no hay respaldo configurado.
 */
export function fallbackModel(
  env: Env,
  tier: Tier,
  failedProvider: LlmProvider,
): ResolvedModel | null {
  const order: LlmProvider[] = ["anthropic", "openai", "xai"];
  for (const p of order) {
    if (p === failedProvider) continue;
    if (!envKeyFor(env, p)) continue;
    return createModel(env, tier, { provider: p });
  }
  return null;
}
