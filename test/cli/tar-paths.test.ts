import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  gnuTarTreatsAsRemote,
  tarLocalPath,
  buildTarArchiveArgv,
  execTarArchive,
  backupIsUsable,
  backupBeforeUpdate,
} from "../../cli/bin/cli.js";

// Rutas del reporte INH-11 (Adrián, Git Bash, v1.0.59 → v1.0.66).
const BOT = "C:\\Users\\leofl\\OneDrive\\Documentos\\CHATBOT\\starter";
const ARTIFACT = `${BOT}\\.artifact.tgz`;
const BACKUP = `${BOT}\\.forja-backups\\2026-08-24T20-57-49_v1.0.59.tgz`;
const LIST = `${BOT}\\.artifact-ls.tgz`;

function fileOperand(argv: string[]): string {
  const i = argv.findIndex((a) => a === "-xzf" || a === "-czf" || a === "-tzf");
  if (i < 0) throw new Error("missing tar -f op");
  return argv[i + 1];
}

describe("gnuTarTreatsAsRemote (INH-11 / Git Bash GNU tar)", () => {
  it("treats a Windows drive-letter archive as a remote host (the reported bug)", () => {
    expect(gnuTarTreatsAsRemote(ARTIFACT)).toBe(true);
    expect(gnuTarTreatsAsRemote(BACKUP)).toBe(true);
    expect(gnuTarTreatsAsRemote("C:/Users/leofl/foo.tgz")).toBe(true);
    expect(gnuTarTreatsAsRemote("C:not-a-host.tgz")).toBe(true);
  });

  it("does not treat names that start with / or . as remote (GNU tar rule)", () => {
    expect(gnuTarTreatsAsRemote("./.artifact.tgz")).toBe(false);
    expect(gnuTarTreatsAsRemote("./.forja-backups/x.tgz")).toBe(false);
    expect(gnuTarTreatsAsRemote("/c/Users/leofl/foo.tgz")).toBe(false);
    expect(gnuTarTreatsAsRemote("../foo.tgz")).toBe(false);
    expect(gnuTarTreatsAsRemote(".")).toBe(false);
  });

  it("does not treat a colon-free relative name as remote", () => {
    expect(gnuTarTreatsAsRemote(".artifact.tgz")).toBe(false);
    expect(gnuTarTreatsAsRemote("foo.tgz")).toBe(false);
  });
});

describe("tarLocalPath", () => {
  it("turns the reporter's absolute Windows paths into ./relative names", () => {
    expect(tarLocalPath(ARTIFACT, BOT)).toBe("./.artifact.tgz");
    expect(tarLocalPath(BACKUP, BOT)).toBe("./.forja-backups/2026-08-24T20-57-49_v1.0.59.tgz");
    expect(tarLocalPath(LIST, BOT)).toBe("./.artifact-ls.tgz");
  });

  it("accepts forward-slash Windows paths and is case-insensitive on the drive", () => {
    expect(tarLocalPath("C:/Users/leofl/OneDrive/Documentos/CHATBOT/starter/.artifact.tgz", BOT))
      .toBe("./.artifact.tgz");
    expect(tarLocalPath(
      "c:\\Users\\leofl\\OneDrive\\Documentos\\CHATBOT\\starter\\.artifact.tgz",
      BOT,
    )).toBe("./.artifact.tgz");
  });

  it("walks up with ../ when the archive is outside fromDir", () => {
    expect(tarLocalPath(`${BOT}\\.artifact.tgz`, `${BOT}\\member`)).toBe("../.artifact.tgz");
  });

  it("prefixes ./C:/... when drives differ (GNU tar then sees a leading dot)", () => {
    const other = tarLocalPath("D:\\other\\x.tgz", BOT);
    expect(other.startsWith(".")).toBe(true);
    expect(gnuTarTreatsAsRemote(other)).toBe(false);
  });

  it("normalized result is never a GNU-tar remote name", () => {
    for (const file of [ARTIFACT, BACKUP, LIST, "C:not-a-host.tgz"]) {
      expect(gnuTarTreatsAsRemote(tarLocalPath(file, BOT))).toBe(false);
    }
  });

  it("leaves POSIX relative names safe", () => {
    expect(gnuTarTreatsAsRemote(tarLocalPath(".artifact.tgz", "/tmp/bot"))).toBe(false);
    expect(tarLocalPath("/tmp/bot/.artifact.tgz", "/tmp/bot")).toBe("./.artifact.tgz");
  });
});

describe("buildTarArchiveArgv — path-normalization / force-local contract", () => {
  const extractExtra = [
    "--exclude=./member/*.local.ts", "--exclude=./member/kb", "--exclude=./wrangler.toml",
    "--exclude=./.dev.vars", "--exclude=./.dev.vars.*", "--exclude=./.env", "--exclude=./.env.*",
    "--exclude=./.bot-state.json", "--exclude=./.bot-setup.json", "--exclude=./.horizontes-bot.json",
  ];

  it("extractOver argv: --force-local + relative archive (Git Bash GNU tar)", () => {
    const argv = buildTarArchiveArgv({
      op: "-xzf",
      file: ARTIFACT,
      extra: extractExtra,
      forceLocal: true,
      fromDir: BOT,
    });
    expect(argv[0]).toBe("--force-local");
    expect(argv[1]).toBe("-xzf");
    expect(fileOperand(argv)).toBe("./.artifact.tgz");
    expect(gnuTarTreatsAsRemote(fileOperand(argv))).toBe(false);
    expect(argv.join("\0")).not.toMatch(/(^|\0)[A-Za-z]:/);
  });

  it("extractOver argv without --force-local stays safe (BSD tar / Windows bsdtar)", () => {
    const argv = buildTarArchiveArgv({
      op: "-xzf",
      file: ARTIFACT,
      extra: extractExtra,
      forceLocal: false,
      fromDir: BOT,
    });
    expect(argv[0]).toBe("-xzf");
    expect(argv).not.toContain("--force-local");
    expect(fileOperand(argv)).toBe("./.artifact.tgz");
    expect(gnuTarTreatsAsRemote(fileOperand(argv))).toBe(false);
  });

  it("backupBeforeUpdate argv uses a relative dest under .forja-backups/", () => {
    const argv = buildTarArchiveArgv({
      op: "-czf",
      file: BACKUP,
      extra: ["--exclude=./node_modules", "--exclude=./.forja-backups", "."],
      forceLocal: true,
      fromDir: BOT,
    });
    expect(fileOperand(argv)).toBe("./.forja-backups/2026-08-24T20-57-49_v1.0.59.tgz");
    expect(gnuTarTreatsAsRemote(fileOperand(argv))).toBe(false);
  });

  it("artifactEntries / writeManifest listing argv is local", () => {
    const argv = buildTarArchiveArgv({
      op: "-tzf",
      file: LIST,
      forceLocal: true,
      fromDir: BOT,
    });
    expect(fileOperand(argv)).toBe("./.artifact-ls.tgz");
    expect(gnuTarTreatsAsRemote(fileOperand(argv))).toBe(false);
  });

  it("never puts a raw C: archive name in argv (the Git Bash failure mode)", () => {
    for (const op of ["-xzf", "-czf", "-tzf"] as const) {
      const argv = buildTarArchiveArgv({ op, file: ARTIFACT, fromDir: BOT, forceLocal: true });
      expect(argv.some((a: string) => /^[A-Za-z]:/.test(a))).toBe(false);
      expect(gnuTarTreatsAsRemote(fileOperand(argv))).toBe(false);
    }
  });
});

describe("backupIsUsable (fail-closed before extractOver)", () => {
  it("rejects null/empty/missing so update must abort", () => {
    expect(backupIsUsable(null)).toBe(false);
    expect(backupIsUsable(undefined)).toBe(false);
    expect(backupIsUsable("")).toBe(false);
    expect(backupIsUsable("/definitely/not/a/backup.tgz")).toBe(false);
  });

  it("accepts a non-empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "forja-bak-"));
    const p = join(dir, "ok.tgz");
    writeFileSync(p, "not-empty");
    expect(backupIsUsable(p)).toBe(true);
    writeFileSync(p, "");
    expect(backupIsUsable(p)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

function tarIsGnu(): boolean {
  try {
    return /GNU tar/i.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

describe("execTarArchive + backupBeforeUpdate (real tar on this host)", () => {
  it.skipIf(!tarIsGnu())("reproduces GNU tar 'Cannot connect to C:' and shows the helper argv succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "forja-repro-"));
    try {
      writeFileSync(join(dir, "f.txt"), "x\n");
      try {
        execFileSync("tar", ["-czf", "C:not-a-host.tgz", "-C", dir, "f.txt"], { encoding: "utf8" });
        expect.fail("GNU tar should have treated C: as a remote host");
      } catch (err) {
        expect(String((err as { stderr?: Buffer }).stderr || err)).toMatch(/Cannot connect to C:/);
      }
      const argv = buildTarArchiveArgv({
        op: "-czf",
        file: join(dir, "ok.tgz"),
        extra: ["f.txt"],
        forceLocal: true,
        fromDir: dir,
      });
      execFileSync("tar", argv, { cwd: dir });
      expect(existsSync(join(dir, "ok.tgz"))).toBe(true);
      expect(statSync(join(dir, "ok.tgz")).size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates and lists an archive using only local names", () => {
    const dir = mkdtempSync(join(tmpdir(), "forja-tar-"));
    writeFileSync(join(dir, "hello.txt"), "hola\n");
    const dest = join(dir, "out.tgz");
    execTarArchive("-czf", dest, ["hello.txt"], { cwd: dir });
    expect(existsSync(dest)).toBe(true);
    expect(statSize(dest)).toBeGreaterThan(0);
    const listing = String(execTarArchive("-tzf", dest, [], { cwd: dir, encoding: "utf8" }));
    expect(listing).toContain("hello.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("backupBeforeUpdate writes a usable .tgz (so fail-closed would let extractOver proceed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forja-upd-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "agent.ts"), "export {}\n");
    const dest = backupBeforeUpdate(dir, "1.0.59");
    expect(dest).toBeTruthy();
    expect(backupIsUsable(dest)).toBe(true);
    const listing = execFileSync("tar", ["-tzf", dest as string], { encoding: "utf8" });
    expect(listing).toMatch(/src\/agent\.ts/);
    rmSync(dir, { recursive: true, force: true });
  });
});

function statSize(p: string): number {
  return statSync(p).size;
}
