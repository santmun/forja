// Tipos del CLI JS para tsc (el repo no usa allowJs). Consumido por test/cli/*.
export function detectLocalMods(dir: string): string[] | null;
export function writeManifest(buf: Uint8Array, dir: string, version: string): void;
export function preservedByUpdate(rel: string): boolean;
export function engineOverwriteRisk(mods: string[] | null): boolean;
export function riskyUpdateGate(
  flags?: { yes?: boolean },
  assumeYes?: boolean,
  isInteractive?: boolean,
): "proceed" | "confirm" | "abort-agent";
export function gnuTarTreatsAsRemote(name: string): boolean;
export function tarLocalPath(p: string, fromDir?: string): string;
export function buildTarArchiveArgv(opts: {
  op: string;
  file: string;
  extra?: string[];
  forceLocal?: boolean;
  fromDir?: string;
}): string[];
export function execTarArchive(
  op: string,
  archivePath: string,
  extra?: string[],
  execOpts?: { cwd?: string; encoding?: string },
): string | Buffer;
export function backupIsUsable(backupPath: string): boolean;
export function backupBeforeUpdate(dir: string, fromVer: string): string | null;
