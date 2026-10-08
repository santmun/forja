import { describe, it, expect } from "vitest";
import { validateDeployConfig, unfilledPlaceholders, wranglerPlaceholderErrors } from "../../scripts/deploy-check";

describe("validateDeployConfig", () => {
  const full = {
    ANTHROPIC_API_KEY: "sk-x",
    BOT_NAME: "Testi",
    BOT_TIER: "pro",
    DASHBOARD_PASSWORD: "pw",
    TELEGRAM_BOT_TOKEN: "tok",
  };

  it("passes with a complete Pro config", () => {
    expect(validateDeployConfig(full)).toEqual({ ok: true, errors: [] });
  });

  it("passes a Free config without DASHBOARD_PASSWORD", () => {
    const { DASHBOARD_PASSWORD, ...rest } = full;
    expect(validateDeployConfig({ ...rest, BOT_TIER: "free" }).ok).toBe(true);
  });

  it("fails when ANTHROPIC_API_KEY is missing", () => {
    const { ANTHROPIC_API_KEY, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("ANTHROPIC_API_KEY");
  });

  it("fails when no channel is configured", () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("canal");
  });

  it("fails Pro without DASHBOARD_PASSWORD", () => {
    const { DASHBOARD_PASSWORD, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("DASHBOARD_PASSWORD");
  });
});

const UUID = "11111111-2222-4333-8444-555555555555";

describe("unfilledPlaceholders", () => {
  it("ignores a placeholder that only appears in a full-line comment", () => {
    const toml = `# El skill menciona {{D1_DATABASE_ID}} en este comentario\ndatabase_id = "${UUID}"\n`;
    expect(unfilledPlaceholders(toml)).toEqual([]);
    expect(wranglerPlaceholderErrors(toml)).toEqual([]);
  });

  it("ignores an indented comment and a trailing comment", () => {
    const toml = [
      `  # no reemplazar aquí {{D1_DATABASE_ID}}`,
      `database_id = "${UUID}"  # antes era {{D1_DATABASE_ID}}`,
      `BOT_NAME = "Tacos Ana"`,
    ].join("\n");
    expect(unfilledPlaceholders(toml)).toEqual([]);
  });

  it("still flags a real unfilled placeholder, including one with a trailing comment", () => {
    const toml = [
      `# comentario {{BOT_SLUG}}`,
      `database_id = "{{D1_DATABASE_ID}}"  # filled in by skill at deploy time`,
      `BOT_NAME = "{{BOT_NAME}}"`,
      `BOT_NAME = "{{BOT_NAME}}"`,
    ].join("\n");
    expect(unfilledPlaceholders(toml)).toEqual(["{{D1_DATABASE_ID}}", "{{BOT_NAME}}"]);
    const errors = wranglerPlaceholderErrors(toml);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("{{D1_DATABASE_ID}}");
    expect(errors[0]).toContain("{{BOT_NAME}}");
    expect(errors[0]).not.toContain("{{BOT_SLUG}}");
  });

  it("does not treat a # inside a quoted value as a comment", () => {
    const toml = `note = "mira {{BOT_NAME}} # esto sigue siendo el valor"\n`;
    expect(unfilledPlaceholders(toml)).toEqual(["{{BOT_NAME}}"]);
  });
});
