import type { Env } from "./env";

/**
 * DEMO_MODE = "on" marca la instancia desechable donde un prospecto prueba el
 * bot. Apagado por defecto. "on" sin importar mayúsculas: la misma regla con
 * la que el motor enciende el chat público /demo.
 */
export function isDemoMode(env: Pick<Env, "DEMO_MODE">): boolean {
  return (env.DEMO_MODE ?? "").toLowerCase() === "on";
}
