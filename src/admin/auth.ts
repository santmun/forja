/**
 * Admin dashboard authentication — HTTP Basic Auth.
 *
 * The dashboard is guarded by a single password (username is always "admin").
 * The password lives in the `DASHBOARD_PASSWORD` secret. There is no login
 * form, no cookie, no magic link and no email-based flow: the browser's native
 * Basic Auth dialog handles credential entry.
 */
import { basicAuth } from "hono/basic-auth";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

/** Fixed username for the admin dashboard. */
export const ADMIN_USERNAME = "admin";

/**
 * Hono middleware factory enforcing HTTP Basic Auth on admin routes.
 * Mount it on the `/admin/*` group, e.g. `app.use("/admin/*", adminAuth(env))`.
 */
export function adminAuth(env: Env): MiddlewareHandler {
  // Fail CERRADO si no hay password configurado. `basicAuth` de Hono compara
  // contra sha256(String(password)); con DASHBOARD_PASSWORD ausente eso es
  // String(undefined) === "undefined", así que un atacante que mande
  // literalmente `admin:undefined` entra al panel. Esta plantilla es MIT y la
  // instala gente que puede olvidar el secret, así que preferimos un 503
  // explicable antes que un panel abierto.
  if (!env.DASHBOARD_PASSWORD) {
    return async (c) =>
      c.text("Panel admin no configurado: falta el secret DASHBOARD_PASSWORD.", 503);
  }
  return basicAuth({
    username: ADMIN_USERNAME,
    password: env.DASHBOARD_PASSWORD,
  });
}

/**
 * Constant-time string comparison to avoid leaking length/content via timing.
 * Returns true only when both strings are byte-for-byte identical.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Fold the length mismatch into the result while still iterating over the
  // longer of the two to keep timing stable.
  let diff = ab.length ^ bb.length;
  const max = Math.max(ab.length, bb.length);
  for (let i = 0; i < max; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** Decode a base64 string in both Worker (atob) and Node/test (Buffer) runtimes. */
function decodeBase64(input: string): string | null {
  try {
    if (typeof atob === "function") {
      return atob(input);
    }
    return Buffer.from(input, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Pure credential check for an HTTP `Authorization` header value.
 *
 * Accepts a value like `Basic YWRtaW46c2VjcmV0MTIz` and returns true only when
 * it decodes to `admin:<DASHBOARD_PASSWORD>`. Has no Hono dependency so it can
 * be unit-tested directly.
 *
 * @param headerValue the raw `Authorization` header value (may be undefined/null)
 * @param env         environment carrying `DASHBOARD_PASSWORD`
 */
export function checkBasicCredentials(
  headerValue: string | null | undefined,
  env: Env,
): boolean {
  if (!headerValue) return false;

  const match = /^Basic\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return false;

  const decoded = decodeBase64(match[1].trim());
  if (decoded === null) return false;

  // Split only on the FIRST colon: passwords may legitimately contain colons.
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;

  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);

  // Sin password configurado no hay credencial válida posible: con el `?? ""`
  // anterior, `admin:` (password vacío) autenticaba.
  const expected = env.DASHBOARD_PASSWORD;
  if (!expected) return false;

  const userOk = timingSafeEqual(username, ADMIN_USERNAME);
  const passOk = timingSafeEqual(password, expected);
  return userOk && passOk;
}
