import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  detectLocalMods,
  writeManifest,
  preservedByUpdate,
  engineOverwriteRisk,
  riskyUpdateGate,
} from "../../cli/bin/cli.js";

const CLI_SRC = fileURLToPath(new URL("../../cli/bin/cli.js", import.meta.url));

function sha(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

describe("engineOverwriteRisk (INH-10)", () => {
  it("trata 'no pude verificar' (null) como riesgo — no seguir en silencio", () => {
    expect(engineOverwriteRisk(null)).toBe(true);
  });

  it("trata ediciones detectadas como riesgo", () => {
    expect(engineOverwriteRisk(["src/agent.ts"])).toBe(true);
  });

  it("sin ediciones y con manifest: no hay riesgo", () => {
    expect(engineOverwriteRisk([])).toBe(false);
  });
});

describe("riskyUpdateGate — no colgar agente/CI", () => {
  it("--yes sigue aunque no se haya podido verificar", () => {
    expect(riskyUpdateGate({ yes: true }, false, false)).toBe("proceed");
  });

  it("FORJA_YES / assumeYes sigue igual que --yes", () => {
    expect(riskyUpdateGate({}, true, false)).toBe("proceed");
  });

  it("humano en TTY sin --yes: pregunta y/N (default N)", () => {
    expect(riskyUpdateGate({}, false, true)).toBe("confirm");
  });

  it("agente/CI sin --yes: aborta con briefing, no se cuelga", () => {
    expect(riskyUpdateGate({}, false, false)).toBe("abort-agent");
  });
});

describe("detectLocalMods", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `forja-upd-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sin .forja-manifest.json → null (instalación vieja / restore de backup)", () => {
    expect(detectLocalMods(dir)).toBeNull();
  });

  it("manifest ilegible → null", () => {
    writeFileSync(join(dir, ".forja-manifest.json"), "no-json");
    expect(detectLocalMods(dir)).toBeNull();
  });

  it("hashes iguales → lista vacía", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/agent.ts"), "oficial\n");
    writeFileSync(
      join(dir, ".forja-manifest.json"),
      JSON.stringify({ version: "1.0.59", files: { "src/agent.ts": sha("oficial\n") } }),
    );
    expect(detectLocalMods(dir)).toEqual([]);
  });

  it("archivo del motor editado → aparece en la lista", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/agent.ts"), "oficial\n");
    writeFileSync(
      join(dir, ".forja-manifest.json"),
      JSON.stringify({ version: "1.0.59", files: { "src/agent.ts": sha("oficial\n") } }),
    );
    writeFileSync(join(dir, "src/agent.ts"), "maybePrintConfirmedOrder()\n");
    expect(detectLocalMods(dir)).toEqual(["src/agent.ts"]);
  });
});

describe("writeManifest + detectLocalMods (roundtrip)", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `forja-upd-man-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "member"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("tras writeManifest, detectLocalMods ya no es null y no marca limpio como editado", () => {
    writeFileSync(join(dir, "src/agent.ts"), "motor\n");
    writeFileSync(join(dir, "wrangler.toml"), "name = 'x'\n");
    writeFileSync(join(dir, "member/config.local.ts"), "export default {}\n");
    const tgz = join(dir, "artifact.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", dir, "src/agent.ts", "wrangler.toml", "member/config.local.ts"]);
    const buf = readFileSync(tgz);
    writeManifest(buf, dir, "1.0.66");
    expect(existsSync(join(dir, ".forja-manifest.json"))).toBe(true);
    expect(detectLocalMods(dir)).toEqual([]);
    writeFileSync(join(dir, "src/agent.ts"), "editado\n");
    expect(detectLocalMods(dir)).toEqual(["src/agent.ts"]);
  });
});

describe("preservedByUpdate", () => {
  it("no hashea lo que extractOver no pisa, incluido el manifest", () => {
    expect(preservedByUpdate("member/config.local.ts")).toBe(true);
    expect(preservedByUpdate("member/kb/faq.md")).toBe(true);
    expect(preservedByUpdate("wrangler.toml")).toBe(true);
    expect(preservedByUpdate(".horizontes-bot.json")).toBe(true);
    expect(preservedByUpdate(".forja-manifest.json")).toBe(true);
    expect(preservedByUpdate("src/agent.ts")).toBe(false);
  });
});

describe("contrato cmdUpdate (INH-10)", () => {
  const src = readFileSync(CLI_SRC, "utf8");

  it("el caso unverified entra al mismo gate que las ediciones detectadas", () => {
    expect(src).toContain("if (engineOverwriteRisk(mods))");
    expect(src).toContain("const unverified = mods === null");
    expect(src).toMatch(/backupBeforeUpdate[\s\S]*extractOver/);
    const riskIdx = src.indexOf("if (engineOverwriteRisk(mods))");
    const extractIdx = src.indexOf("extractOver(buf, dir, bot.slug, version)");
    expect(riskIdx).toBeGreaterThan(0);
    expect(extractIdx).toBeGreaterThan(riskIdx);
  });

  it("ES y EN tienen las mismas claves nuevas del guard", () => {
    for (const key of [
      "updModsUnverified:",
      "updModsUnverifiedExplain:",
      "updModsUnverifiedAgentAsk:",
    ]) {
      const hits = src.split(key).length - 1;
      expect(hits, key).toBe(2);
    }
    expect(src).not.toContain("updModsFirstTime");
  });
});
