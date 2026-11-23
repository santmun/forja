import type { Env } from "../env";
import { egressFetch, sanitizeHeaderValue } from "../http/egress";

/**
 * Hosts a los que SÍ se les puede mandar ZERNIO_API_KEY.
 * Cualquier otro host (CDN de Telegram, Graph de Meta, un webhook ajeno)
 * recibe el fetch sin Authorization: la llave no sale de Zernio.
 */
const ZERNIO_SUFFIX = "zernio.com";

export type ZernioEnv = Pick<Env, "ZERNIO_API_KEY" | "ZERNIO_API_BASE">;

export function isZernioMediaUrl(rawUrl: string, env: ZernioEnv): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  // La llave solo viaja por HTTPS. Un http://zernio.com la filtraría en claro.
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === ZERNIO_SUFFIX || host.endsWith(`.${ZERNIO_SUFFIX}`)) return true;
  const base = env.ZERNIO_API_BASE?.trim();
  if (!base) return false;
  try {
    const baseUrl = new URL(base.includes("://") ? base : `https://${base}`);
    return baseUrl.protocol === "https:" && host === baseUrl.hostname.toLowerCase();
  } catch {
    return false;
  }
}

function authHeaders(url: string, env: ZernioEnv): Headers {
  const headers = new Headers();
  if (!isZernioMediaUrl(url, env)) return headers;
  const key = sanitizeHeaderValue(env.ZERNIO_API_KEY ?? "");
  if (!key) return headers;
  headers.set("Authorization", `Bearer ${key}`);
  return headers;
}

/**
 * GET de un adjunto entrante. El Bearer de Zernio se añade solo si el host
 * de ESTA url es Zernio. Un redirect a otro origen se sigue sin la llave
 * (el endpoint de media responde 200 con el binario; el corte es por si acaso).
 */
export async function fetchInboundMedia(url: string, env: ZernioEnv): Promise<Response> {
  const headers = authHeaders(url, env);
  const first = await egressFetch(url, { headers, redirect: "manual" });
  if (first.status < 300 || first.status >= 400) return first;
  const loc = first.headers.get("location");
  if (!loc) return first;
  let next: URL;
  try {
    next = new URL(loc, url);
  } catch {
    return first;
  }
  const sameOrigin = next.origin === new URL(url).origin;
  return egressFetch(next, {
    headers: sameOrigin ? headers : new Headers(),
    redirect: "follow",
  });
}
