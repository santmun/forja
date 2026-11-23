import { describe, it, expect, vi, afterEach } from "vitest";
import { buildMultimodalUserMessage, describeImage } from "../../src/media/vision";

describe("buildMultimodalUserMessage", () => {
  it("returns a plain text user message when there is no image", () => {
    const msg = buildMultimodalUserMessage("hola, ¿agendan hoy?", undefined);
    expect(msg).toEqual({ role: "user", content: "hola, ¿agendan hoy?" });
  });

  it("returns an empty-string user message when there is neither text nor image", () => {
    const msg = buildMultimodalUserMessage(undefined, undefined);
    expect(msg).toEqual({ role: "user", content: "" });
  });

  it("builds a multimodal message with image + text caption", () => {
    const msg = buildMultimodalUserMessage(
      "¿qué es esto?",
      "https://x/photo.jpg",
    );
    expect(msg.role).toBe("user");
    const content = msg.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);

    const imagePart = content[0];
    expect(imagePart.type).toBe("image");
    expect(imagePart.image).toBeInstanceOf(URL);
    expect((imagePart.image as URL).href).toBe("https://x/photo.jpg");

    const textPart = content[1];
    expect(textPart).toEqual({ type: "text", text: "¿qué es esto?" });
  });

  it("builds an image-only message when there is no caption", () => {
    const msg = buildMultimodalUserMessage(undefined, "https://x/photo.jpg");
    const content = msg.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("image");
    expect((content[0].image as URL).href).toBe("https://x/photo.jpg");
  });

  it("does not perform any network call (pure message builder)", () => {
    // buildMultimodalUserMessage only constructs a CoreMessage; no fetch/provider involved.
    const fetchSpy = (globalThis as { fetch?: unknown }).fetch;
    const msg = buildMultimodalUserMessage("hi", "https://x/photo.jpg");
    expect(msg.role).toBe("user");
    // fetch reference unchanged / untouched by the builder
    expect((globalThis as { fetch?: unknown }).fetch).toBe(fetchSpy);
  });
});

describe("describeImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deja una URL pública como URL y no la descarga", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const image = await describeImage("https://cdn.example.com/pic.jpg", {
      ZERNIO_API_KEY: "zernio-test-key",
    } as any);
    expect(image).toBe("https://cdn.example.com/pic.jpg");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("baja la foto de Zernio con Bearer y la entrega como bytes", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const image = await describeImage(
      "https://api.zernio.com/v1/whatsapp/media/pic?accountId=acc",
      { ZERNIO_API_KEY: "zernio-test-key" } as any,
    );
    expect(image).toEqual({ bytes: jpeg, mediaType: "image/jpeg" });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer zernio-test-key");
    const msg = buildMultimodalUserMessage("mira", image);
    const part = (msg.content as Array<Record<string, unknown>>)[0];
    expect(part.type).toBe("image");
    expect(part.image).toEqual(jpeg);
    expect(part.mediaType).toBe("image/jpeg");
  });
});
