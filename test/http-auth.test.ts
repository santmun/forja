import { describe, it, expect } from "vitest";
import { manychatWebhookAllowed, MANYCHAT_SECRET_HEADER } from "../src/http-auth";
import type { Env } from "../src/env";

const envWith = (secret?: string) =>
  ({ MANYCHAT_WEBHOOK_SECRET: secret }) as unknown as Env;

/** POST to the webhook, optionally carrying the X-Api-Key header. */
const post = (apiKey?: string) =>
  new Request("https://bot.example.workers.dev/webhooks/manychat", {
    method: "POST",
    headers: apiKey === undefined ? {} : { [MANYCHAT_SECRET_HEADER]: apiKey },
    body: "{}",
  });

describe("manychatWebhookAllowed", () => {
  it("accepts a request whose header matches the secret", () => {
    expect(manychatWebhookAllowed(post("s3cr3t"), envWith("s3cr3t"))).toBe(true);
  });

  it("rejects a different secret", () => {
    expect(manychatWebhookAllowed(post("nope"), envWith("s3cr3t"))).toBe(false);
  });

  it("rejects a request with no header at all", () => {
    expect(manychatWebhookAllowed(post(), envWith("s3cr3t"))).toBe(false);
  });

  it("rejects a correct prefix — guessing the start is not enough", () => {
    expect(manychatWebhookAllowed(post("s3c"), envWith("s3cr3t"))).toBe(false);
  });

  it("rejects trailing extra characters", () => {
    expect(manychatWebhookAllowed(post("s3cr3tX"), envWith("s3cr3t"))).toBe(false);
  });

  it("reads the header case-insensitively, as HTTP requires", () => {
    const req = new Request("https://bot.example.workers.dev/webhooks/manychat", {
      method: "POST",
      headers: { "x-api-key": "s3cr3t" },
      body: "{}",
    });
    expect(manychatWebhookAllowed(req, envWith("s3cr3t"))).toBe(true);
  });

  // Fail-open is deliberate: it lets the fix deploy before members have added
  // the header in ManyChat, instead of 401-ing their live inbound traffic.
  it("lets everything through while the secret was never set", () => {
    expect(manychatWebhookAllowed(post(), envWith(undefined))).toBe(true);
    expect(manychatWebhookAllowed(post("anything"), envWith(undefined))).toBe(true);
  });

  // But a secret that IS configured and blank means the owner thinks they are
  // protected. Silently opening up there would recreate the very bug this fixes.
  it("fails closed on a configured but blank secret", () => {
    expect(manychatWebhookAllowed(post("anything"), envWith(""))).toBe(false);
    expect(manychatWebhookAllowed(post(), envWith("   "))).toBe(false);
  });

  it("ignores surrounding whitespace, so a pasted newline does not break it", () => {
    expect(manychatWebhookAllowed(post(" s3cr3t "), envWith("s3cr3t\n"))).toBe(true);
  });

  it("expects the header the setup guide documents", () => {
    expect(MANYCHAT_SECRET_HEADER).toBe("X-Api-Key");
  });
});
