import type { Env } from "./env";

/** Constant-time-ish comparison to avoid leaking the token via timing. */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Fail-closed Bearer auth for the control-plane `/api/*` endpoints.
 *
 * Passes ONLY when CONTROL_PLANE_TOKEN is configured AND the request carries a
 * matching `Authorization: Bearer <token>` (constant-time compare via
 * tokensMatch). If the token is unset, the header is missing/malformed, or it
 * mismatches → returns false (the caller answers 401).
 */
export function requireControlPlane(req: Request, env: Env): boolean {
  const expected = env.CONTROL_PLANE_TOKEN?.trim();
  if (!expected) return false; // fail-closed: no token configured → nothing is allowed in
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return tokensMatch(match[1].trim(), expected);
}

/** Header ManyChat sends the shared secret in (see the ManyChat setup guide). */
export const MANYCHAT_SECRET_HEADER = "X-Api-Key";

/**
 * Fail-OPEN auth for the `/webhooks/manychat` ingress.
 *
 * Passes when MANYCHAT_WEBHOOK_SECRET was never configured (nothing changes for
 * bots that are already running) or when the request carries a matching
 * `X-Api-Key` header (constant-time compare via tokensMatch).
 *
 * Fail-open on an ABSENT secret is deliberate here, unlike requireControlPlane.
 * The setup guide has been telling members to add this header for a while, but
 * the route never read it — so a fail-closed default would 401 every bot whose
 * owner skipped that step, and inbound messages would silently stop. Opening up
 * lets the fix ship in a safe order:
 *   1. deploy (no behaviour change)
 *   2. add the header in the ManyChat External Request
 *   3. `wrangler secret put MANYCHAT_WEBHOOK_SECRET` → enforced from here on
 *
 * A secret that IS configured but blank is a different case: the owner believes
 * the webhook is protected. Treating that as "guard off" would leave them open
 * while thinking otherwise — the exact failure this function exists to remove —
 * so it fails closed and says why.
 */
export function manychatWebhookAllowed(req: Request, env: Env): boolean {
  const configured = env.MANYCHAT_WEBHOOK_SECRET;
  if (configured === undefined) return true; // never set → previous behaviour
  const expected = configured.trim();
  if (!expected) {
    console.error(
      "MANYCHAT_WEBHOOK_SECRET is set but blank — rejecting every ManyChat webhook. Set a real value, or unset it to turn the guard off.",
    );
    return false;
  }
  const received = req.headers.get(MANYCHAT_SECRET_HEADER)?.trim() ?? "";
  return tokensMatch(received, expected);
}
