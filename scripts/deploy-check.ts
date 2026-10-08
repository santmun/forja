/**
 * Pre-deploy config check (LOCAL — no network, no Skool/tier API).
 *
 * The Free vs Pro distinction lives in separate repos, so there is nothing to
 * validate against a remote service: we just make sure the secrets and vars
 * this bot needs are present before `wrangler deploy` runs. Run via
 * `pnpm exec tsx scripts/deploy-check.ts` (or wire it as a predeploy step).
 */

export interface DeployConfig {
  ANTHROPIC_API_KEY?: string;
  BOT_NAME?: string;
  BOT_TIER?: string;
  DASHBOARD_PASSWORD?: string;
  // at least one customer channel:
  TELEGRAM_BOT_TOKEN?: string;
  MANYCHAT_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  [k: string]: string | undefined;
}

export interface DeployCheckResult {
  ok: boolean;
  errors: string[];
}

/** Pure validator — easy to unit test, no process/network access. */
export function validateDeployConfig(cfg: DeployConfig): DeployCheckResult {
  const errors: string[] = [];

  if (!cfg.ANTHROPIC_API_KEY) errors.push("Falta ANTHROPIC_API_KEY (Claude API).");
  if (!cfg.BOT_NAME) errors.push("Falta BOT_NAME.");
  if (!cfg.BOT_TIER) errors.push("Falta BOT_TIER ('free' | 'pro').");

  const hasChannel = Boolean(
    cfg.TELEGRAM_BOT_TOKEN || cfg.MANYCHAT_API_KEY || cfg.TWILIO_ACCOUNT_SID,
  );
  if (!hasChannel) {
    errors.push(
      "No hay ningún canal configurado: define al menos TELEGRAM_BOT_TOKEN, MANYCHAT_API_KEY o TWILIO_ACCOUNT_SID.",
    );
  }

  if (cfg.BOT_TIER === "pro" && !cfg.DASHBOARD_PASSWORD) {
    errors.push("BOT_TIER=pro requiere DASHBOARD_PASSWORD (Basic Auth del dashboard).");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Quita comentarios TOML: la línea entera si (tras espacios) empieza con `#`,
 * y el `# ...` final cuando el `#` no está dentro de comillas. Un placeholder
 * que solo vive en un comentario no es config sin llenar.
 */
export function tomlWithoutComments(toml: string): string {
  return toml
    .split(/\r?\n/)
    .map((line) => {
      if (line.trimStart().startsWith("#")) return "";
      let inSingle = false;
      let inDouble = false;
      let escaped = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\" && inDouble) {
          escaped = true;
          continue;
        }
        if (ch === '"' && !inSingle) {
          inDouble = !inDouble;
          continue;
        }
        if (ch === "'" && !inDouble) {
          inSingle = !inSingle;
          continue;
        }
        if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Placeholders `{{NAME}}` que siguen en valores, no solo en comentarios. */
export function unfilledPlaceholders(toml: string): string[] {
  const code = tomlWithoutComments(toml);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of code.matchAll(/\{\{[A-Za-z0-9_]+\}\}/g)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
  }
  return out;
}

export function wranglerPlaceholderErrors(toml: string): string[] {
  const found = unfilledPlaceholders(toml);
  if (found.length === 0) return [];
  return [
    `Quedan placeholders sin llenar en wrangler.toml: ${found.join(", ")}. Reemplázalos por el valor real — un comentario que los mencione no cuenta.`,
  ];
}

// Run as a script: read from process.env and exit non-zero on failure.
// Guarded so importing this module in tests does not call process.exit.
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };
const isMain =
  typeof process !== "undefined" &&
  typeof (process as any).argv !== "undefined" &&
  /deploy-check\.ts$/.test(String((process as any).argv?.[1] ?? ""));

if (isMain) {
  // El check corre en la MÁQUINA DEL MIEMBRO, donde process.env está vacío: la
  // verdad vive en wrangler.toml ([vars] estampadas por el CLI) y en los SECRETS
  // remotos de Cloudflare. Además, el flujo documentado conecta canales DESPUÉS
  // del primer deploy (FASE 3) y la llave de IA puede ponerse desde el panel —
  // así que canal/llave son AVISOS, no errores que bloqueen.
  const cfg: DeployConfig = { ...process.env };
  let placeholderErrors: string[] = [];

  try {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync("wrangler.toml", "utf8");
    for (const k of ["BOT_NAME", "BOT_TIER"] as const) {
      if (!cfg[k]) cfg[k] = toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
    }
    // Busca {{...}} solo fuera de comentarios. Una línea `# ... {{D1_DATABASE_ID}}`
    // (o un `#` final) no bloquea el deploy si el valor real ya está puesto.
    placeholderErrors = wranglerPlaceholderErrors(toml);
  } catch { /* sin wrangler.toml: lo reportará el error de BOT_TIER */ }

  try {
    const { execFileSync } = await import("node:child_process");
    const raw = execFileSync("npx", ["wrangler", "secret", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const s of JSON.parse(raw.slice(raw.indexOf("["))) as { name: string }[]) {
      if (!cfg[s.name]) cfg[s.name] = "(remote)";
    }
  } catch { /* sin red o sin login: seguimos solo con lo local */ }

  const errors: string[] = [...placeholderErrors];
  const warnings: string[] = [];
  if (!cfg.BOT_NAME) errors.push("Falta BOT_NAME en wrangler.toml.");
  if (!cfg.BOT_TIER) errors.push("Falta BOT_TIER ('free' | 'pro') en wrangler.toml.");
  if (!cfg.DASHBOARD_PASSWORD) errors.push("Falta el secret DASHBOARD_PASSWORD (créalo: pnpm exec wrangler secret put DASHBOARD_PASSWORD).");
  if (!cfg.ANTHROPIC_API_KEY && !cfg.OPENAI_API_KEY && !cfg.XAI_API_KEY) {
    warnings.push("Aún no hay llave de IA como secret — el bot desplegará pero no contestará. Ponla con `wrangler secret put ANTHROPIC_API_KEY` (o desde el panel: Configuración → Modelo de IA).");
  }
  if (!cfg.TELEGRAM_BOT_TOKEN && !cfg.MANYCHAT_API_KEY && !cfg.TWILIO_ACCOUNT_SID && !cfg.META_PAGE_ACCESS_TOKEN) {
    warnings.push("Aún no hay canales conectados — normal antes de la FASE 3 (se conectan con el panel abierto en /admin/conexiones).");
  }

  if (warnings.length) console.warn("⚠️  Avisos:\n - " + warnings.join("\n - "));
  if (errors.length) {
    console.error("❌ Config incompleta para deploy:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("✅ Config de deploy OK." + (warnings.length ? " (con avisos)" : ""));
}
