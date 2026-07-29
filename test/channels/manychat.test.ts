import { describe, it, expect, vi, afterEach } from "vitest";
import { manychatAdapter, verifyManychatSecret } from "../../src/channels/manychat";
import type { Env } from "../../src/env";

// Payloads mirror a typical ManyChat/n8n flow: ManyChat posts the subscriber in
// `id`, the text in `last_input_text`, and media in `attachments`.
const sampleText = {
  id: "abc123",
  first_name: "María",
  last_name: "G",
  last_input_text: "hola",
};

const sampleVoice = {
  id: "abc123",
  first_name: "María",
  last_input_text: "[audio]",
  attachments: [{ type: "audio", payload: { url: "https://manychat.cdn/audio.mp3" } }],
};

const sampleImage = {
  id: "abc123",
  first_name: "María",
  last_input_text: "ese corte",
  attachments: [{ type: "image", payload: { url: "https://manychat.cdn/img.jpg" } }],
};

function req(body: unknown): Request {
  return new Request("https://x", { method: "POST", body: JSON.stringify(body) });
}

afterEach(() => vi.restoreAllMocks());

describe("manychatAdapter.parseIncoming", () => {
  it("reads the subscriber from `id` (production contract)", async () => {
    const msg = await manychatAdapter.parseIncoming(req(sampleText), {} as Env);
    expect(msg.channel).toBe("manychat");
    expect(msg.channelUserId).toBe("abc123");
    expect(msg.displayName).toBe("María G");
    expect(msg.text).toBe("hola");
  });

  it("falls back to `subscriber_id` if `id` is absent", async () => {
    const msg = await manychatAdapter.parseIncoming(
      req({ subscriber_id: "legacy999", last_input_text: "hey" }),
      {} as Env,
    );
    expect(msg.channelUserId).toBe("legacy999");
  });

  it("parses audio attachment (and drops the [audio] placeholder text)", async () => {
    const msg = await manychatAdapter.parseIncoming(req(sampleVoice), {} as Env);
    expect(msg.audioUrl).toBe("https://manychat.cdn/audio.mp3");
    expect(msg.text).toBeUndefined();
  });

  it("parses image attachment + caption", async () => {
    const msg = await manychatAdapter.parseIncoming(req(sampleImage), {} as Env);
    expect(msg.imageUrl).toBe("https://manychat.cdn/img.jpg");
    expect(msg.text).toBe("ese corte");
  });

  // El contrato real de IG: cuando el usuario manda media, ManyChat pone el
  // link del CDN de Meta COMO last_input_text (sin attachments).
  it("routes a lookaside image URL in last_input_text to imageUrl (by extension)", async () => {
    const url = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x.jpg";
    const msg = await manychatAdapter.parseIncoming(
      req({ id: "abc123", last_input_text: url }),
      {} as Env,
    );
    expect(msg.imageUrl).toBe(url);
    expect(msg.text).toBeUndefined();
  });

  it("routes an mp4 URL in last_input_text to audioUrl (voice note by extension)", async () => {
    const url = "https://lookaside.fbsbx.com/ig_messaging_cdn/audio_clip.mp4?sig=y";
    const msg = await manychatAdapter.parseIncoming(
      req({ id: "abc123", last_input_text: url }),
      {} as Env,
    );
    expect(msg.audioUrl).toBe(url);
    expect(msg.text).toBeUndefined();
  });

  it("probes Content-Type when a Meta CDN URL has no extension", async () => {
    const url = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=99&signature=zz";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const msg = await manychatAdapter.parseIncoming(
      req({ id: "abc123", last_input_text: url }),
      {} as Env,
    );
    expect(msg.imageUrl).toBe(url);
    expect(msg.text).toBeUndefined();
  });

  it("keeps a normal shared link as plain text (not media)", async () => {
    const msg = await manychatAdapter.parseIncoming(
      req({ id: "abc123", last_input_text: "https://miempresa.com/precios" }),
      {} as Env,
    );
    expect(msg.text).toBe("https://miempresa.com/precios");
    expect(msg.imageUrl).toBeUndefined();
    expect(msg.audioUrl).toBeUndefined();
  });

  it("keeps text that merely contains a URL as text", async () => {
    const msg = await manychatAdapter.parseIncoming(
      req({ id: "abc123", last_input_text: "mira esto https://lookaside.fbsbx.com/x.jpg te late?" }),
      {} as Env,
    );
    expect(msg.text).toContain("mira esto");
    expect(msg.imageUrl).toBeUndefined();
  });
});

describe("manychatAdapter.sendReply", () => {
  it("sends via sendContent with content.type matching the channel (instagram default)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const env = { MANYCHAT_API_KEY: "key" } as unknown as Env;
    await manychatAdapter.sendReply(
      { channel: "manychat", channelUserId: "abc123", chunks: ["hola"] },
      env,
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.manychat.com/fb/sending/sendContent");
    const body = JSON.parse(String(init.body));
    expect(body.subscriber_id).toBe("abc123");
    expect(body.data.content.type).toBe("instagram"); // required by ManyChat
    expect(body.data.content.messages[0].text).toBe("hola");
  });

  it("honors MANYCHAT_CONTENT_TYPE override (e.g. whatsapp)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const env = {
      MANYCHAT_API_KEY: "key",
      MANYCHAT_CONTENT_TYPE: "whatsapp",
    } as unknown as Env;
    await manychatAdapter.sendReply(
      { channel: "manychat", channelUserId: "abc123", chunks: ["hi"] },
      env,
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.data.content.type).toBe("whatsapp");
  });
});

describe("verifyManychatSecret", () => {
  const withSecret = { MANYCHAT_WEBHOOK_SECRET: "mc-shh-456" } as Env;

  it("fails closed when MANYCHAT_WEBHOOK_SECRET is not configured", () => {
    expect(verifyManychatSecret("mc-shh-456", {} as Env)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyManychatSecret(undefined, withSecret)).toBe(false);
  });

  it("rejects a wrong header value", () => {
    expect(verifyManychatSecret("wrong", withSecret)).toBe(false);
  });

  it("accepts the exact configured secret", () => {
    expect(verifyManychatSecret("mc-shh-456", withSecret)).toBe(true);
  });
});
