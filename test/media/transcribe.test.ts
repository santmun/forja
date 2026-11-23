import { describe, it, expect, vi } from "vitest";
import { transcribeAudio } from "../../src/media/transcribe";

describe("transcribeAudio", () => {
  it("calls Workers AI Whisper with base64 audio + returns text", async () => {
    const calls: any[] = [];
    const fakeEnv: any = {
      AI: {
        run: async (model: string, input: any) => {
          calls.push({ model, input });
          return { text: "hola que tal" };
        },
      },
    };
    // mock global fetch for the audio download
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as any;
    const result = await transcribeAudio("https://x/audio.ogg", fakeEnv);
    expect(result.text).toBe("hola que tal");
    expect(calls[0].model).toBe("@cf/openai/whisper-large-v3-turbo");
    // whisper-large-v3-turbo expects a base64 STRING (per Cloudflare docs), not bytes.
    expect(typeof calls[0].input.audio).toBe("string");
    // bytes [1,2,3] -> base64 "AQID"
    expect(calls[0].input.audio).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("manda el Bearer de Zernio solo si el host es Zernio", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        auth: headers.get("Authorization"),
      });
      return new Response(new Uint8Array([1, 2, 3]));
    }) as any;
    const env: any = {
      AI: { run: async () => ({ text: "nota" }) },
      ZERNIO_API_KEY: "zernio-test-key",
    };
    await transcribeAudio(
      "https://api.zernio.com/v1/whatsapp/media/abc?accountId=acc",
      env,
    );
    expect(seen[0].auth).toBe("Bearer zernio-test-key");

    seen.length = 0;
    await transcribeAudio("https://cdn.example.com/voice.ogg", env);
    expect(seen[0].auth).toBeNull();
    expect(JSON.stringify(seen[0])).not.toContain("zernio-test-key");
  });

  it("propaga el 401 como audio fetch failed", async () => {
    globalThis.fetch = vi.fn(async () => new Response("no", { status: 401 })) as any;
    const env: any = {
      AI: { run: async () => ({ text: "" }) },
      ZERNIO_API_KEY: "zernio-test-key",
    };
    await expect(
      transcribeAudio("https://api.zernio.com/v1/whatsapp/media/abc?accountId=acc", env),
    ).rejects.toThrow("audio fetch failed: 401");
  });
});
