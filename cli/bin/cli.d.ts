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
