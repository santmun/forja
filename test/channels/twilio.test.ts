import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { twilioAdapter, verifyTwilioSignature } from "../../src/channels/twilio";

describe("twilioAdapter.parseIncoming", () => {
  it("parses text WA", async () => {
    const body = new URLSearchParams({
      From: "whatsapp:+5215512345",
      To: "whatsapp:+5215587654",
      Body: "hola",
      ProfileName: "María",
      NumMedia: "0",
    });
    const req = new Request("https://x", { method: "POST", body });
    const msg = await twilioAdapter.parseIncoming(req, {} as any);
    expect(msg.channel).toBe("twilio");
    expect(msg.channelUserId).toBe("+5215512345");
    expect(msg.text).toBe("hola");
    expect(msg.displayName).toBe("María");
  });

  it("parses image attachment", async () => {
    const body = new URLSearchParams({
      From: "whatsapp:+5215512345",
      To: "whatsapp:+5215587654",
      Body: "ese corte",
      NumMedia: "1",
      MediaUrl0: "https://media.twilio/img.jpg",
      MediaContentType0: "image/jpeg",
    });
    const req = new Request("https://x", { method: "POST", body });
    const msg = await twilioAdapter.parseIncoming(req, {} as any);
    expect(msg.imageUrl).toBe("https://media.twilio/img.jpg");
    expect(msg.text).toBe("ese corte");
  });

  it("parses audio attachment", async () => {
    const body = new URLSearchParams({
      From: "whatsapp:+5215512345",
      To: "whatsapp:+5215587654",
      NumMedia: "1",
      MediaUrl0: "https://media.twilio/voice.ogg",
      MediaContentType0: "audio/ogg",
    });
    const req = new Request("https://x", { method: "POST", body });
    const msg = await twilioAdapter.parseIncoming(req, {} as any);
    expect(msg.audioUrl).toBe("https://media.twilio/voice.ogg");
  });
});

/**
 * Reference implementation of Twilio's signing algorithm (see
 * https://www.twilio.com/docs/usage/security#validating-requests), computed
 * independently via Node's `crypto` (HMAC-SHA1 + base64) rather than the Web
 * Crypto path `verifyTwilioSignature` uses — a genuine cross-check that the
 * production code implements the spec correctly, not a tautology.
 */
function referenceTwilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac("sha1", authToken).update(data).digest("base64");
}

describe("verifyTwilioSignature", () => {
  const AUTH_TOKEN = "test-auth-token-abc";
  const URL = "https://bot.test/webhooks/twilio";
  const PARAMS = {
    From: "whatsapp:+5215512345",
    To: "whatsapp:+5215587654",
    Body: "hola",
    NumMedia: "0",
  };

  it("accepts a correctly computed signature", async () => {
    const sig = referenceTwilioSignature(URL, PARAMS, AUTH_TOKEN);
    expect(await verifyTwilioSignature(URL, PARAMS, sig, AUTH_TOKEN)).toBe(true);
  });

  it("rejects a tampered param (signature no longer matches)", async () => {
    const sig = referenceTwilioSignature(URL, PARAMS, AUTH_TOKEN);
    const tampered = { ...PARAMS, Body: "algo distinto" };
    expect(await verifyTwilioSignature(URL, tampered, sig, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a signature computed with the wrong auth token", async () => {
    const sig = referenceTwilioSignature(URL, PARAMS, "otro-token");
    expect(await verifyTwilioSignature(URL, PARAMS, sig, AUTH_TOKEN)).toBe(false);
  });

  it("fails closed when the signature header is missing", async () => {
    expect(await verifyTwilioSignature(URL, PARAMS, undefined, AUTH_TOKEN)).toBe(false);
  });

  it("fails closed when TWILIO_AUTH_TOKEN is not configured", async () => {
    const sig = referenceTwilioSignature(URL, PARAMS, AUTH_TOKEN);
    expect(await verifyTwilioSignature(URL, PARAMS, sig, undefined)).toBe(false);
  });
});
