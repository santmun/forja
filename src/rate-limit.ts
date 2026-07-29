// Throttle simple por IP — defensa en profundidad para rutas expuestas sin
// sesión (webhooks, /kb/reindex) mientras se propaga la protección principal:
// una Cloudflare Rate Limiting Rule a nivel de cuenta (fuera de este repo, se
// configura en el dashboard de Cloudflare o en `wrangler.toml` con `[[rules]]`
// de tipo `ratelimit` — ver checklist de deploy). Esta capa cubre el caso en
// que esa regla no está configurada, y no depende de ningún binding nuevo:
// reusa el D1 (`DB`) que el bot ya tiene.
//
// Ventana fija (no sliding window): cada `bucket:ip` cuenta cuántos requests
// cayeron en el intervalo de windowMs actual; al cruzar a la siguiente
// ventana el contador se resetea solo. Suficiente para frenar ráfagas e
// intentos de fuerza bruta — no pretende ser exacto al request.
import { Db } from "./db/client";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 20;

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
}

/** true si `ip` ya superó el tope de requests en la ventana actual para `bucket`. */
export async function isRateLimited(
  db: Db,
  bucket: string,
  ip: string,
  opts: RateLimitOptions = {},
  now = Date.now(),
): Promise<boolean> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_MAX;
  const key = `${bucket}:${ip}`;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  // Upsert atómico: misma ventana → incrementa; ventana nueva → resetea a 1.
  await db.run(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start`,
    [key, windowStart],
  );

  const row = await db.first<{ count: number }>(
    `SELECT count FROM rate_limits WHERE key = ?`,
    [key],
  );
  return (row?.count ?? 0) > max;
}

/** IP del cliente tal como la ve Cloudflare — no falsificable por el request entrante. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
