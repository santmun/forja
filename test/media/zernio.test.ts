import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchInboundMedia, isZernioMediaUrl } from "../../src/media/zernio";
import { captureIncomingMedia } from "../../src/media/boveda";

const KEY = "zernio-test-key";
const env = { ZERNIO_API_KEY: KEY, ZERNIO_API_BASE: "https://proxy.internal.example" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isZernioMediaUrl", () => {
  it("acepta zernio.com y subdominios https", () => {
    expect(isZernioMediaUrl("https://api.zernio.com/v1/whatsapp/media/1?accountId=a", env)).toBe(true);
    expect(isZernioMediaUrl("https://zernio.com/v1/whatsapp/media/1", env)).toBe(true);
  });

  it("acepta el host exacto de ZERNIO_API_BASE", () => {
    expect(isZernioMediaUrl("https://proxy.internal.example/v1/whatsapp/media/1", env)).toBe(true);
  });

  it("rechaza otros hosts, http y lookalikes para no filtrar la llave", () => {
    expect(isZernioMediaUrl("https://cdn.example.com/voice.ogg", env)).toBe(false);
    expect(isZernioMediaUrl("https://api.zernio.com.evil.com/v1/whatsapp/media/1", env)).toBe(false);
    expect(isZernioMediaUrl("https://notzernio.com/v1/whatsapp/media/1", env)).toBe(false);
    expect(isZernioMediaUrl("https://evil.example/steal?next=https://api.zernio.com/v1/x", env)).toBe(false);
    expect(isZernioMediaUrl("http://api.zernio.com/v1/whatsapp/media/1", env)).toBe(false);
    expect(isZernioMediaUrl("https://proxy.internal.example.evil.com/x", env)).toBe(false);
  });
});

describe("fetchInboundMedia", () => {
  it("pone el Bearer solo en el host de Zernio", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, auth: headers.get("Authorization") });
      return new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "audio/ogg" } });
    });

    await captureIncomingMedia("https://api.zernio.com/v1/whatsapp/media/1?accountId=a", env);
    await captureIncomingMedia("https://cdn.example.com/a.ogg", env);

    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    expect(seen[1].auth).toBeNull();
    expect(seen[1].url).toBe("https://cdn.example.com/a.ogg");
  });

  it("sigue un redirect a otro origen sin la llave", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, auth: headers.get("Authorization") });
      if (url.includes("zernio.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/file.ogg" },
        });
      }
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    });

    const got = await fetchInboundMedia("https://api.zernio.com/v1/whatsapp/media/1", env);
    expect(got.ok).toBe(true);
    expect(seen[0].auth).toBe(`Bearer ${KEY}`);
    expect(seen[1].url).toBe("https://cdn.example.com/file.ogg");
    expect(seen[1].auth).toBeNull();
  });
});
