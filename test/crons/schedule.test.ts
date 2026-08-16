import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DAILY_CRON, isNightlyTick } from "../../src/crons/schedule";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The `crons = [...]` entries declared under [triggers] in wrangler.toml. */
function configuredCrons(): string[] {
  const toml = readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  const block = /^\s*crons\s*=\s*\[([^\]]*)\]/m.exec(toml);
  if (!block) throw new Error("no crons array found in wrangler.toml");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("isNightlyTick", () => {
  it("runs the nightly jobs on the daily tick", () => {
    expect(isNightlyTick(DAILY_CRON)).toBe(true);
  });

  it("skips them on an extra, more frequent tick", () => {
    expect(isNightlyTick("*/15 * * * *")).toBe(false);
    expect(isNightlyTick("0 * * * *")).toBe(false);
  });

  it("tolerates sloppy whitespace instead of silently skipping forever", () => {
    expect(isNightlyTick("0  3 * * *")).toBe(true);
    expect(isNightlyTick(" 0 3 * * * ")).toBe(true);
  });

  it("treats a manual invocation (no cron) as the nightly tick", () => {
    expect(isNightlyTick(undefined)).toBe(true);
  });
});

describe("wrangler.toml", () => {
  // The guard rail. If someone edits [triggers] crons and drops the nightly
  // expression, purge / insights / flywheel / owner report stop running with no
  // error anywhere. Failing here is the only loud signal that exists.
  it("still schedules the cron the nightly jobs wait for", () => {
    const crons = configuredCrons();
    expect(crons.length).toBeGreaterThan(0);
    expect(crons.some((c) => isNightlyTick(c))).toBe(true);
  });
});
