/**
 * Extrae lo útil de un error del AI SDK (APICallError / NoOutputGeneratedError)
 * para los logs del Worker. El `message` solo suele decir "Bad Request"; el
 * body de OpenAI (schema inválido, etc.) vive en responseBody / cause.
 */
export function formatLlmError(e: unknown): string {
  if (e == null) return String(e);
  const err = e as Record<string, any>;
  const cause =
    err.cause && typeof err.cause === "object"
      ? (err.cause as Record<string, any>)
      : undefined;
  const parts: string[] = [];
  const msg = typeof err.message === "string" ? err.message : String(e);
  parts.push(msg);
  const status = err.statusCode ?? cause?.statusCode;
  if (status != null) parts.push(`status=${status}`);
  const url = err.url ?? cause?.url;
  if (typeof url === "string" && url) parts.push(`url=${url}`);
  const body = err.responseBody ?? err.data ?? cause?.responseBody ?? cause?.data;
  if (body != null) {
    const s = typeof body === "string" ? body : safeJson(body);
    if (s) parts.push(`body=${s.slice(0, 800)}`);
  }
  if (cause?.message && cause.message !== msg) {
    parts.push(`cause=${cause.message}`);
  }
  return parts.join(" | ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 400 / "No output generated" — vale la pena reintentar el mismo modelo
 * sin SSE (generateText). Rate-limits y 5xx se dejan al failover de proveedor.
 */
export function isLikelyRequestOrStreamFailure(e: unknown): boolean {
  const err = e as Record<string, any> | undefined;
  if (!err) return false;
  const cause =
    err.cause && typeof err.cause === "object"
      ? (err.cause as Record<string, any>)
      : undefined;
  const status = err.statusCode ?? cause?.statusCode;
  if (status === 400) return true;
  const name = `${err.name ?? ""} ${cause?.name ?? ""}`;
  const msg = `${err.message ?? ""} ${cause?.message ?? ""}`;
  return /Bad Request|No output generated/i.test(`${name} ${msg}`);
}
